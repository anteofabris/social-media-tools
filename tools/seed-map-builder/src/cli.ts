import minimist from "minimist";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "./config";
import {
  initDb,
  createRun,
  finishRun,
  getStats,
  upsertAccount,
  addSource,
  upsertClassification,
  hasRecentGeminiClassification,
  upsertHashtag,
  getAllHashtags,
} from "./db/repo";
import {
  searchHashtag,
  getTopMedia,
  getRecentMedia,
  resolveUsernameFromPermalink,
  getAccountInfo,
  scrapeFollowerCount,
} from "./api/instagram";
import { classifyHeuristic } from "./classify/heuristics";
import { classifyWithGemini } from "./classify/gemini";
import { exportSeedMaps } from "./export/exportJson";
import { exportSeedMapsCsv } from "./export/exportCsv";
import { exportMasterCsv } from "./export/exportMasterCsv";
import { logger } from "./util/logger";
import { pLimit, waitForSleepWindowEnd } from "./util/time";

const argv = minimist(process.argv.slice(2));
const command = argv._[0];

// ── helpers ─────────────────────────────────────────────────────────────────

function loadHashtags(): string[] {
  if (argv.hashtags) {
    return String(argv.hashtags)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!fs.existsSync(config.hashtagsFile)) {
    logger.error(`Hashtags file not found: ${config.hashtagsFile}`);
    process.exit(1);
  }
  return fs
    .readFileSync(config.hashtagsFile, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// ── run command ─────────────────────────────────────────────────────────────

async function runIngest(): Promise<void> {
  const hashtags = loadHashtags();
  const maxHashtags = argv.maxHashtags ? Number(argv.maxHashtags) : hashtags.length;
  const topN = argv.topN ? Number(argv.topN) : config.topMediaPerTag;
  const recentN = argv.recentN ? Number(argv.recentN) : config.recentMediaPerTag;
  const dryRun = !!argv.dryRun;
  const force = !!argv.force;

  const tagsToProcess = hashtags.slice(0, maxHashtags);
  logger.info(
    `Processing ${tagsToProcess.length} hashtag(s): ${tagsToProcess.join(", ")}`,
  );

  if (dryRun) {
    logger.info(
      "[DRY RUN] Would fetch top and recent media for each hashtag, classify accounts, and store in DB.",
    );
    logger.info(`Top media per tag: ${topN}, Recent media per tag: ${recentN}`);
    logger.info(`Follower range: ${config.followerMin}–${config.followerMax}`);
    logger.info(`Confidence threshold: ${config.confidenceMin}`);
    logger.info(`Concurrency: ${config.concurrency}`);
    return;
  }

  if (!config.igAccessToken || !config.igUserId) {
    logger.error("IG_ACCESS_TOKEN and IG_USER_ID must be set in .env");
    process.exit(1);
  }

  const runId = crypto.randomUUID();
  createRun(runId);

  const limit = pLimit(config.concurrency);
  let totalAccounts = 0;
  let totalClassified = 0;
  let totalGemini = 0;

  for (const tag of tagsToProcess) {
    await waitForSleepWindowEnd();

    logger.info(`\n--- Hashtag: #${tag} ---`);

    const hashtagId = await searchHashtag(tag);
    if (!hashtagId) {
      logger.warn(`Could not find hashtag ID for #${tag}, skipping.`);
      continue;
    }
    logger.info(`Hashtag ID for #${tag}: ${hashtagId}`);
    upsertHashtag(tag, hashtagId);

    const [topMedia, recentMedia] = await Promise.all([
      getTopMedia(hashtagId, topN),
      getRecentMedia(hashtagId, recentN),
    ]);

    logger.info(
      `Found ${topMedia.length} top + ${recentMedia.length} recent media`,
    );

    // Resolve usernames by scraping permalink pages
    const allMedia = [...topMedia, ...recentMedia];
    const mediaToResolve = allMedia.filter((m) => !m.username && m.permalink);
    if (mediaToResolve.length > 0) {
      logger.info(`Resolving usernames for ${mediaToResolve.length} media items via permalinks...`);
      await Promise.all(
        mediaToResolve.map((media) =>
          limit(async () => {
            const owner = await resolveUsernameFromPermalink(media.permalink!);
            if (owner) media.username = owner;
          }),
        ),
      );
      const resolved = allMedia.filter((m) => m.username).length;
      const unresolved = allMedia.length - resolved;
      logger.info(`Username resolution: ${resolved} resolved, ${unresolved} failed`);
    }

    // Extract unique usernames with their source info
    const usernameMap = new Map<
      string,
      { sources: Array<{ type: string; hashtag: string }> }
    >();

    for (const media of topMedia) {
      if (!media.username) continue;
      const entry = usernameMap.get(media.username) || { sources: [] };
      entry.sources.push({ type: "hashtag_top", hashtag: tag });
      usernameMap.set(media.username, entry);
    }
    for (const media of recentMedia) {
      if (!media.username) continue;
      const entry = usernameMap.get(media.username) || { sources: [] };
      entry.sources.push({ type: "hashtag_recent", hashtag: tag });
      usernameMap.set(media.username, entry);
    }

    logger.info(`Unique candidate accounts: ${usernameMap.size}`);

    let skippedNoFollowers = 0;
    let skippedOutOfRange = 0;

    const tasks = [...usernameMap.entries()].map(([username, meta]) =>
      limit(async () => {
        await waitForSleepWindowEnd();

        // Fetch account metadata (may fail for non-business accounts)
        const info = await getAccountInfo(username);
        const accountId = info?.ig_id || username;

        // Resolve follower count: business_discovery first, profile scrape fallback
        let followers = info?.followers_count ?? null;
        if (followers == null) {
          followers = await scrapeFollowerCount(username);
        }

        // Skip accounts where we couldn't determine follower count
        if (followers == null) {
          logger.info(`@${username}: skipped — could not determine follower count`);
          skippedNoFollowers++;
          return;
        }

        // Skip accounts outside the configured follower range
        if (followers < config.followerMin || followers > config.followerMax) {
          logger.info(
            `@${username}: skipped — ${followers.toLocaleString()} followers (outside ${config.followerMin.toLocaleString()}–${config.followerMax.toLocaleString()} range)`,
          );
          skippedOutOfRange++;
          return;
        }

        upsertAccount({
          id: accountId,
          username,
          name: info?.name,
          followers,
          bio: info?.biography,
          website: info?.website,
        });
        totalAccounts++;

        // Record unique sources
        const seenSources = new Set<string>();
        for (const src of meta.sources) {
          const key = `${src.type}:${src.hashtag}`;
          if (!seenSources.has(key)) {
            addSource(accountId, src.type, src.hashtag);
            seenSources.add(key);
          }
        }

        // Stage 1: heuristic classification
        const hResult = classifyHeuristic({
          username,
          name: info?.name,
          bio: info?.biography,
          website: info?.website,
          business_category: null,
        });

        upsertClassification(
          accountId,
          hResult.category,
          hResult.confidence,
          JSON.stringify(hResult.evidence),
          "heuristic",
        );
        totalClassified++;

        // Stage 2: Gemini fallback when heuristic is uncertain
        if (hResult.confidence < config.confidenceMin) {
          if (
            force ||
            !hasRecentGeminiClassification(accountId, config.geminiCacheDays)
          ) {
            const gResult = await classifyWithGemini({
              username,
              name: info?.name,
              bio: info?.biography,
              website: info?.website,
              business_category: null,
            });

            upsertClassification(
              accountId,
              gResult.category,
              gResult.confidence,
              JSON.stringify({ reasons: gResult.reasons }),
              "gemini",
            );
            totalGemini++;
            logger.debug(
              `@${username}: Gemini -> ${gResult.category} (${gResult.confidence.toFixed(2)})`,
            );
          } else {
            logger.debug(`@${username}: Gemini cache hit, skipping`);
          }
        }

        logger.debug(
          `@${username}: ${hResult.category} (${hResult.confidence.toFixed(2)})`,
        );
      }),
    );

    await Promise.all(tasks);

    if (skippedNoFollowers > 0 || skippedOutOfRange > 0) {
      logger.info(
        `Skipped: ${skippedNoFollowers} (no follower count) + ${skippedOutOfRange} (outside range)`,
      );
    }
  }

  const stats = {
    totalAccounts,
    totalClassified,
    totalGemini,
    hashtags: tagsToProcess.length,
  };
  finishRun(runId, JSON.stringify(stats));
  logger.info(
    `\nRun complete. Accounts: ${totalAccounts}, Classified: ${totalClassified}, Gemini calls: ${totalGemini}`,
  );
}

// ── stats command ───────────────────────────────────────────────────────────

function exportHashtagsCsv(): void {
  const hashtags = getAllHashtags();

  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }

  const header = "name,ig_id,first_seen,last_used";
  const rows = [
    header,
    ...hashtags.map((h) =>
      [h.name, h.ig_id, h.first_seen, h.last_used].join(","),
    ),
  ];

  const filePath = path.join(config.outputDir, "hashtags.csv");
  fs.writeFileSync(filePath, rows.join("\n") + "\n", "utf-8");
  logger.info(`Exported ${hashtags.length} hashtags -> hashtags.csv`);
}

function printStats(): void {
  const stats = getStats();
  console.log("\n=== Seed Map Statistics ===\n");
  console.log(`Total accounts: ${stats.totalAccounts}`);

  console.log("\nBy category:");
  for (const [cat, count] of Object.entries(stats.categoryCounts)) {
    console.log(`  ${cat}: ${count}`);
  }

  console.log("\nConfidence distribution:");
  console.log(`  High (>=0.8): ${stats.confidenceDistribution.high}`);
  console.log(`  Medium (0.5-0.8): ${stats.confidenceDistribution.medium}`);
  console.log(`  Low (<0.5): ${stats.confidenceDistribution.low}`);

  if (stats.lastRun) {
    console.log(`\nLast run: ${stats.lastRun.started_at}`);
    if (stats.lastRun.finished_at)
      console.log(`  Finished: ${stats.lastRun.finished_at}`);
    if (stats.lastRun.stats_json)
      console.log(`  Stats: ${stats.lastRun.stats_json}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    switch (command) {
      case "init":
        initDb();
        logger.info("Database initialized.");
        break;

      case "run":
        initDb();
        await runIngest();
        break;

      case "export":
        initDb();
        exportSeedMaps();
        break;

      case "export-csv":
        initDb();
        exportSeedMapsCsv();
        break;

      case "export-master":
        initDb();
        exportMasterCsv();
        break;

      case "export-hashtags":
        initDb();
        exportHashtagsCsv();
        break;

      case "stats":
        initDb();
        printStats();
        break;

      default:
        console.error("Usage: npm run seed-map -- <command>\n");
        console.error("Commands:");
        console.error("  init     Create SQLite DB and tables");
        console.error("  run      Ingest hashtags, fetch media, classify accounts");
        console.error("  export       Write JSON seed maps to output/");
        console.error("  export-csv    Write CSV seed maps to output/");
        console.error("  export-master    Write master CSV (all categories) to output/");
        console.error("  export-hashtags  Write hashtag ID lookup table to output/");
        console.error("  stats            Print counts and confidence summary\n");
        console.error("Run flags:");
        console.error("  --hashtags=tag1,tag2   Comma-separated hashtags");
        console.error("  --maxHashtags=N        Limit hashtags to process");
        console.error("  --topN=N               Top media per hashtag");
        console.error("  --recentN=N            Recent media per hashtag");
        console.error("  --dryRun               Show plan without API calls");
        console.error("  --force                Re-classify even if cached");
        process.exit(1);
    }
  } catch (err) {
    logger.error("Fatal error:", (err as Error).message);
    process.exit(1);
  }
})();
