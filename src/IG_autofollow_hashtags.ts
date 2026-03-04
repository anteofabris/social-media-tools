import minimist from "minimist";
import { connectBrowser } from "./browser";
import { loadAccountsProcessed, saveAccountsProcessed } from "./accounts_processed";
import {
  randomDelay, injectCookie, dismissDialogByText, ensureConnection,
  getPostOwner, loadExplorePage, getFollowerCount, PROJECT_ROOT,
} from "./helpers";
import type { AccountEntry, AutofollowHashtagResult } from "./types";
import dotenv from "dotenv";

dotenv.config({ path: `${PROJECT_ROOT}/.env` });

const argv = minimist(process.argv.slice(2));

const { hashtags, count = 50 } = argv;
const cookie: string = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie || !hashtags) {
  console.error(
    "Usage: node IG_autofollow_hashtags.js --cookie <sessionid> --hashtags tag1,tag2 [--count 50]"
  );
  process.exit(1);
}

const hashtagList = String(hashtags).split(",").map((t) => t.trim()).filter(Boolean);
const followCount = Number(count);

if (hashtagList.length === 0) {
  console.error("Error: provide at least one hashtag");
  process.exit(1);
}

const MS_PER_DAY = 86400000;
const COOLDOWN_DAYS = 180;
const MAX_FOLLOWERS = 10000;
let accountsList = loadAccountsProcessed();
const accountsMap = new Map<string, AccountEntry>();
for (const entry of accountsList) {
  accountsMap.set(entry.accountName.toLowerCase(), entry);
}

(async () => {
  let browser, page;
  let totalFollowed = 0;
  const result: AutofollowHashtagResult = { success: true, action: "autofollow_hashtags", hashtags: hashtagList, requested: followCount, totalFollowed: 0, details: [], error: null };

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
      let hashtagFollowed = 0;

      try {
        const visitedPaths = new Set<string>();
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;
        const MAX_ROUNDS = 5;

        for (let round = 1; round <= MAX_ROUNDS && hashtagFollowed < followCount; round++) {
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
            `  Round ${round}: found ${postPaths.length} posts (${paths.length} new), need ${followCount - hashtagFollowed} more follows.`
          );

          let onExplorePage = true;

          for (let i = 0; i < paths.length && hashtagFollowed < followCount; i++) {
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

            if (owner) {
              const key = owner.toLowerCase();
              const existing = accountsMap.get(key);
              if (existing && existing.following) {
                console.log(`  Post ${visitedPaths.size}: @${owner} already in our records as following, skipping.`);
                if (usedLightbox) {
                  await page.keyboard.press("Escape");
                  await randomDelay(1000, 2000);
                  try { await page.waitForFunction(() => !document.querySelector('[role="dialog"] article'), { timeout: 5000 }); } catch { onExplorePage = false; }
                } else { onExplorePage = false; }
                await randomDelay();
                continue;
              }
              if (existing && !existing.following && existing.dateUnfollowed) {
                const daysSinceUnfollow = (Date.now() - new Date(existing.dateUnfollowed).getTime()) / MS_PER_DAY;
                if (daysSinceUnfollow < COOLDOWN_DAYS) {
                  console.log(`  Post ${visitedPaths.size}: @${owner} unfollowed ${Math.floor(daysSinceUnfollow)}d ago (cooldown ${COOLDOWN_DAYS}d), skipping.`);
                  if (usedLightbox) {
                    await page.keyboard.press("Escape");
                    await randomDelay(1000, 2000);
                    try { await page.waitForFunction(() => !document.querySelector('[role="dialog"] article'), { timeout: 5000 }); } catch { onExplorePage = false; }
                  } else { onExplorePage = false; }
                  await randomDelay();
                  continue;
                }
              }
            }

            if (owner) {
              const followerCount = await getFollowerCount(page, owner);
              if (followerCount !== null && followerCount >= MAX_FOLLOWERS) {
                console.log(`  Post ${visitedPaths.size}: @${owner} has ${followerCount.toLocaleString()} followers (>= ${MAX_FOLLOWERS.toLocaleString()}), skipping.`);
                if (usedLightbox) {
                  await page.keyboard.press("Escape");
                  await randomDelay(1000, 2000);
                  try { await page.waitForFunction(() => !document.querySelector('[role="dialog"] article'), { timeout: 5000 }); } catch { onExplorePage = false; }
                } else { onExplorePage = false; }
                await randomDelay();
                continue;
              }
            }

            const followResult = await page.evaluate(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const container = dialog || document;
              const buttons = [...container.querySelectorAll("button")];
              const followBtn = buttons.find((b) => b.textContent!.trim() === "Follow");
              if (followBtn) {
                followBtn.click();
                return { found: true };
              }
              return { found: false };
            });

            if (followResult.found) {
              hashtagFollowed++;
              totalFollowed++;
              consecutiveFailures = 0;
              console.log(`  Post ${visitedPaths.size}: followed @${owner || "unknown"} (${hashtagFollowed}/${followCount} for #${hashtag})`);

              if (owner) {
                const key = owner.toLowerCase();
                const existing = accountsMap.get(key);
                if (existing) {
                  existing.following = true;
                  existing.dateFollowed = new Date().toISOString();
                  existing.dateUnfollowed = null;
                } else {
                  const entry: AccountEntry = { accountName: key, following: true, dateFollowed: new Date().toISOString(), dateUnfollowed: null };
                  accountsList.push(entry);
                  accountsMap.set(key, entry);
                }
                saveAccountsProcessed(accountsList);
              }
            } else {
              console.log(`  Post ${visitedPaths.size}: already following @${owner || "unknown"}, skipping.`);
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

        console.log(`  Finished #${hashtag}: ${hashtagFollowed} users followed.`);
        result.details.push({ hashtag, followed: hashtagFollowed });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Error processing #${hashtag}: ${msg}. Skipping.`);
        result.details.push({ hashtag, followed: hashtagFollowed, error: msg });
      }
    }
  } catch (err: unknown) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.totalFollowed = totalFollowed;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
