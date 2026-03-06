import fs from "fs";
import path from "path";
import { config } from "../config";
import { getEligibleSeeds, type SeedAccount } from "../db/repo";
import { logger } from "../util/logger";

const COLUMNS = [
  "id",
  "username",
  "followers",
  "category",
  "confidence",
  "sources",
  "last_seen",
] as const;

function escapeCsv(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function seedToCsvRow(seed: SeedAccount): string {
  const sources = seed.sources
    .map((s) => `${s.type}:${s.hashtag}`)
    .join("; ");

  return [
    escapeCsv(seed.id),
    escapeCsv(seed.username),
    seed.followers != null ? String(seed.followers) : "",
    escapeCsv(seed.category),
    seed.confidence.toFixed(2),
    escapeCsv(sources),
    escapeCsv(seed.last_seen),
  ].join(",");
}

export function exportMasterCsv(): void {
  const seeds = getEligibleSeeds(
    config.followerMin,
    config.followerMax,
    config.confidenceMin,
  );

  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }

  const header = COLUMNS.join(",");
  const rows = [header, ...seeds.map(seedToCsvRow)];
  const filename = "seed_map_master.csv";
  const filePath = path.join(config.outputDir, filename);
  fs.writeFileSync(filePath, rows.join("\n") + "\n", "utf-8");

  // Category breakdown for the log
  const counts: Record<string, number> = {};
  for (const seed of seeds) {
    counts[seed.category] = (counts[seed.category] || 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .map(([cat, n]) => `${cat}: ${n}`)
    .join(", ");

  logger.info(`Exported ${seeds.length} accounts -> ${filename} (${breakdown || "empty"})`);
}
