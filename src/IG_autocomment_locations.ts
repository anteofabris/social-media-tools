import minimist from "minimist";
import { connectBrowser } from "./browser";
import { getAIComment } from "./gemini_comment";
import {
  randomDelay, injectCookie, dismissDialogByText, ensureConnection,
  getPostOwner, loadExplorePage, postComment, PROJECT_ROOT,
} from "./helpers";
import type { AutocommentLocationResult } from "./types";
import dotenv from "dotenv";

dotenv.config({ path: `${PROJECT_ROOT}/.env` });

const argv = minimist(process.argv.slice(2), { string: ["locations", "cookie"] });

const { locations, count = 50 } = argv;
const cookie: string = argv.cookie || process.env.IG_SESSION_COOKIE || "";

if (!cookie || typeof locations !== "string" || !locations) {
  console.error(
    "Usage: node IG_autocomment_locations.js --cookie <sessionid> --locations 213385402,12345678 [--count 50]"
  );
  process.exit(1);
}

const locationList = String(locations).split(",").map((t) => t.trim()).filter(Boolean);
const commentCount = Number(count);

if (locationList.length === 0) {
  console.error("Error: provide at least one location ID");
  process.exit(1);
}

(async () => {
  let browser, page;
  let totalCommented = 0;
  const result: AutocommentLocationResult = {
    success: true,
    action: "autocomment_locations",
    locations: locationList,
    requested: commentCount,
    totalCommented: 0,
    details: [],
    error: null,
  };

  try {
    ({ browser, page } = await connectBrowser());

    console.log("Setting session cookie...");
    await injectCookie(page, cookie);

    console.log("Navigating to Instagram...");
    await page.goto("https://www.instagram.com/", { waitUntil: "networkidle2" });
    await randomDelay(2000, 3000);

    await dismissDialogByText(page, [
      "allow all cookies",
      "allow essential and optional cookies",
      "accept",
    ]);
    await randomDelay(1000, 2000);

    const loginForm = await page.$('input[name="username"]');
    if (loginForm) {
      throw new Error(
        "Session cookie appears invalid — login form is still visible. Get a fresh sessionid from your browser."
      );
    }
    console.log("Logged in via session cookie.");

    for (const locationId of locationList) {
      console.log(`\n--- Location: ${locationId} ---`);
      let locationCommented = 0;
      const comments: string[] = [];

      try {
        const visitedPaths = new Set<string>();
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;
        const MAX_ROUNDS = 5;

        for (let round = 1; round <= MAX_ROUNDS && locationCommented < commentCount; round++) {
          const postPaths = await loadExplorePage(page, locationId, "explore/locations");

          if (postPaths.length === 0) {
            console.log(`  No posts found for location ${locationId}.`);
            break;
          }

          const startIndex = postPaths.length > 4 ? 4 : 0;
          const paths = postPaths.slice(startIndex).filter((p) => !visitedPaths.has(p));

          if (paths.length === 0) {
            console.log(`  No new posts to process for location ${locationId}.`);
            break;
          }

          console.log(
            `  Round ${round}: found ${postPaths.length} posts (${paths.length} new), need ${commentCount - locationCommented} more comments.`
          );

          let onExplorePage = true;

          for (let i = 0; i < paths.length && locationCommented < commentCount; i++) {
            const postPath = paths[i];
            visitedPaths.add(postPath);

          try {
            if (!onExplorePage) {
              await page.goto(
                `https://www.instagram.com/explore/locations/${locationId}/`,
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
            const commentText = await getAIComment(page);
            await postComment(page, commentText);

            locationCommented++;
            totalCommented++;
            consecutiveFailures = 0;
            comments.push(commentText);
            console.log(
              `  Post ${visitedPaths.size}: commented on @${owner || "unknown"} "${commentText}" (${locationCommented}/${commentCount} for location ${locationId})`
            );

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
              throw new Error(
                `Reached ${FAILURE_LIMIT} consecutive failures`
              );
            }

            try {
              ({ browser, page } = await ensureConnection(browser, page, cookie));
              onExplorePage = false;
            } catch (reconnErr: unknown) {
              const reconnMsg = reconnErr instanceof Error ? reconnErr.message : String(reconnErr);
              console.log(
                `  Cannot recover connection: ${reconnMsg}. Moving on.`
              );
              break;
            }

            await randomDelay(2000, 3000);
          }
        }
        }

        console.log(
          `  Finished location ${locationId}: ${locationCommented} posts commented.`
        );
        result.details.push({
          location: locationId,
          commented: locationCommented,
          comments,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `  Error processing location ${locationId}: ${msg}. Skipping.`
        );
        result.details.push({
          location: locationId,
          commented: locationCommented,
          comments,
          error: msg,
        });
      }
    }
  } catch (err: unknown) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.totalCommented = totalCommented;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
