import minimist from "minimist";
import { connectBrowser } from "./browser";
import {
  randomDelay, injectCookie, dismissDialogByText, ensureConnection,
  getPostOwner, loadExplorePage, getLikeCount, PROJECT_ROOT,
} from "./helpers";
import type { AutolikeHashtagResult } from "./types";
import dotenv from "dotenv";

dotenv.config({ path: `${PROJECT_ROOT}/.env` });

const argv = minimist(process.argv.slice(2), { string: ["hashtags", "cookie"] });

const { hashtags, count = 50 } = argv;
const cookie: string = argv.cookie || process.env.IG_SESSION_COOKIE || "";

if (!cookie || typeof hashtags !== "string" || !hashtags) {
  console.error(
    "Usage: node IG_autolike_hashtags.js --cookie <sessionid> --hashtags tag1,tag2 [--count 50]"
  );
  process.exit(1);
}

const hashtagList = String(hashtags).split(",").map((t) => t.trim()).filter(Boolean);
const likeCount = Number(count);

if (hashtagList.length === 0) {
  console.error("Error: provide at least one hashtag");
  process.exit(1);
}

(async () => {
  let browser, page;
  let totalLiked = 0;
  const result: AutolikeHashtagResult = { success: true, action: "autolike_hashtags", hashtags: hashtagList, requested: likeCount, totalLiked: 0, details: [], error: null };

  try {
    ({ browser, page } = await connectBrowser());

    console.log("Setting session cookie...");
    await injectCookie(page, cookie);

    console.log("Navigating to Instagram...");
    await page.goto("https://www.instagram.com/", { waitUntil: "networkidle2" });
    await randomDelay(2000, 3000);

    await dismissDialogByText(page, ["allow all cookies", "allow essential and optional cookies", "accept"]);
    await randomDelay(1000, 2000);

    const loginForm = await page.$('input[name="username"]');
    if (loginForm) {
      throw new Error("Session cookie appears invalid — login form is still visible. Get a fresh sessionid from your browser.");
    }
    console.log("Logged in via session cookie.");

    for (const hashtag of hashtagList) {
      console.log(`\n--- Hashtag: #${hashtag} ---`);
      let hashtagLiked = 0;

      try {
        const visitedPaths = new Set<string>();
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;
        const MAX_ROUNDS = 5;

        for (let round = 1; round <= MAX_ROUNDS && hashtagLiked < likeCount; round++) {
          const postPaths = await loadExplorePage(page, hashtag, "explore/tags");

          if (postPaths.length === 0) {
            console.log(`  No posts found for #${hashtag}.`);
            break;
          }

          const startIndex = postPaths.length > 4 ? 4 : 0;
          const paths = postPaths.slice(startIndex).filter((p) => !visitedPaths.has(p));

          if (paths.length === 0) {
            console.log(`  No new posts to process for #${hashtag}.`);
            break;
          }

          console.log(
            `  Round ${round}: found ${postPaths.length} posts (${paths.length} new), need ${likeCount - hashtagLiked} more likes.`
          );

          let onExplorePage = true;

          for (let i = 0; i < paths.length && hashtagLiked < likeCount; i++) {
            const postPath = paths[i];
            visitedPaths.add(postPath);

          try {
            if (!onExplorePage) {
              await page.goto(
                `https://www.instagram.com/explore/tags/${hashtag}/`,
                { waitUntil: "networkidle2" }
              );
              await randomDelay(2000, 3000);
              onExplorePage = true;
            }

            const navPromise = page
              .waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 })
              .catch(() => null);

            const clicked = await page.evaluate((path: string) => {
              const link = document.querySelector(`a[href="${path}"]`);
              if (!link) return false;
              (link as HTMLElement).click();
              return true;
            }, postPath);

            if (!clicked) {
              console.log(`  Post ${visitedPaths.size}: link not found on page, skipping.`);
              onExplorePage = true;
              continue;
            }

            let usedLightbox = false;
            try {
              await page.waitForFunction(
                () => !!document.querySelector('[role="dialog"] article'),
                { timeout: 8000 }
              );
              usedLightbox = true;
            } catch {
              await navPromise;
              onExplorePage = false;
            }
            await randomDelay(1000, 2000);

            await dismissDialogByText(page, ["not now", "cancel"]);

            const owner = await getPostOwner(page);

            const alreadyLiked = await page.evaluate(() => {
              const likeSvg = document.querySelector('section svg[aria-label="Like"]');
              return !likeSvg;
            });

            if (alreadyLiked) {
              console.log(`  Post ${visitedPaths.size}: already liked @${owner || "unknown"}, advancing.`);
            } else {
              const postLikes = await getLikeCount(page);
              if (postLikes !== null && postLikes >= 100) {
                console.log(`  Post ${visitedPaths.size}: @${owner || "unknown"} has ${postLikes} likes (>=100), skipping.`);
              } else {
                await page.evaluate(() => {
                  const likeSvg = document.querySelector('section svg[aria-label="Like"]');
                  if (likeSvg) {
                    const btn = likeSvg.closest("button") || likeSvg.parentElement;
                    (btn as HTMLElement).click();
                  }
                });
                hashtagLiked++;
                totalLiked++;
                consecutiveFailures = 0;
                console.log(`  Post ${visitedPaths.size}: liked @${owner || "unknown"} (${hashtagLiked}/${likeCount} for #${hashtag})`);
              }
            }

            if (usedLightbox) {
              await page.keyboard.press("Escape");
              await randomDelay(1000, 2000);
              try {
                await page.waitForFunction(
                  () => !document.querySelector('[role="dialog"] article'),
                  { timeout: 5000 }
                );
              } catch {
                onExplorePage = false;
              }
            } else {
              onExplorePage = false;
            }

            await randomDelay();
          } catch (err: unknown) {
            consecutiveFailures++;
            const msg = err instanceof Error ? err.message : String(err);
            console.log(
              `  Post ${visitedPaths.size}: error — ${msg}. (${consecutiveFailures}/${FAILURE_LIMIT})`
            );

            if (consecutiveFailures >= FAILURE_LIMIT) {
              throw new Error(`Reached ${FAILURE_LIMIT} consecutive failures`);
            }

            try {
              ({ browser, page } = await ensureConnection(browser, page, cookie));
              onExplorePage = false;
            } catch (reconnErr: unknown) {
              const reconnMsg = reconnErr instanceof Error ? reconnErr.message : String(reconnErr);
              console.log(`  Cannot recover connection: ${reconnMsg}. Moving on.`);
              break;
            }

            await randomDelay(2000, 3000);
          }
        }
        }

        console.log(`  Finished #${hashtag}: ${hashtagLiked} posts liked.`);
        result.details.push({ hashtag, liked: hashtagLiked });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Error processing #${hashtag}: ${msg}. Skipping.`);
        result.details.push({ hashtag, liked: hashtagLiked, error: msg });
      }
    }
  } catch (err: unknown) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.totalLiked = totalLiked;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
