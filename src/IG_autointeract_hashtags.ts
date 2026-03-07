import minimist from "minimist";
import { connectBrowser } from "./browser";
import { loadAccountsProcessed, saveAccountsProcessed } from "./accounts_processed";
import { getAIComment } from "./gemini_comment";
import {
  randomDelay, injectCookie, dismissDialogByText, ensureConnection,
  getPostOwner, loadExplorePage, getFollowerCount, getLikeCount,
  postComment, PROJECT_ROOT,
} from "./helpers";
import type { AccountEntry, AutointeractHashtagResult } from "./types";
import dotenv from "dotenv";

dotenv.config({ path: `${PROJECT_ROOT}/.env` });

const argv = minimist(process.argv.slice(2), { string: ["hashtags", "cookie"] });

const { hashtags, count = 10 } = argv;
const cookie: string = argv.cookie || process.env.IG_SESSION_COOKIE || "";
const shouldFollow = !!argv.follow;
const numLikes = Number(argv.numLikes) || 0;
const numComments = Number(argv.numComments) || 0;

if (!cookie || typeof hashtags !== "string" || !hashtags) {
  console.error(
    "Usage: node IG_autointeract_hashtags.js --cookie <sessionid> --hashtags tag1,tag2 --count 10 [--follow] [--numLikes 3] [--numComments 1]"
  );
  process.exit(1);
}

if (numComments > numLikes) {
  console.error("Error: --numComments must be <= --numLikes (comments are placed on liked posts)");
  process.exit(1);
}

if (!shouldFollow && numLikes === 0 && numComments === 0) {
  console.error("Error: nothing to do — provide --follow, --numLikes, or --numComments");
  process.exit(1);
}

const hashtagList = String(hashtags).split(",").map((t) => t.trim()).filter(Boolean);
const interactCount = Number(count);

if (hashtagList.length === 0) {
  console.error("Error: provide at least one hashtag");
  process.exit(1);
}

const MS_PER_DAY = 86400000;
const COOLDOWN_DAYS = 180;
const MIN_FOLLOWERS = Number(process.env.AUTOFOLLOW_MIN_FOLLOWERS) || 500;
const MAX_FOLLOWERS = Number(process.env.AUTOFOLLOW_MAX_FOLLOWERS) || 15000;
const MAX_LIKES = 100;

let accountsList = loadAccountsProcessed();
const accountsMap = new Map<string, AccountEntry>();
for (const entry of accountsList) {
  accountsMap.set(entry.accountName.toLowerCase(), entry);
}

console.log(
  `Config: follow=${shouldFollow}, numLikes=${numLikes}, numComments=${numComments}, ` +
  `count=${interactCount}, followers=${MIN_FOLLOWERS.toLocaleString()}–${MAX_FOLLOWERS.toLocaleString()}`
);

(async () => {
  let browser, page;
  let totalInteracted = 0;
  const result: AutointeractHashtagResult = {
    success: true,
    action: "autointeract_hashtags",
    hashtags: hashtagList,
    requested: interactCount,
    totalInteracted: 0,
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

    await dismissDialogByText(page, ["allow all cookies", "allow essential and optional cookies", "accept"]);
    await randomDelay(1000, 2000);

    const loginForm = await page.$('input[name="username"]');
    if (loginForm) {
      throw new Error("Session cookie appears invalid — login form is still visible. Get a fresh sessionid from your browser.");
    }
    console.log("Logged in via session cookie.");

    for (const hashtag of hashtagList) {
      console.log(`\n--- Hashtag: #${hashtag} ---`);
      let hashtagInteracted = 0;
      const accountDetails: AutointeractHashtagResult["details"][0]["accounts"] = [];
      const HASHTAG_RETRIES = 3;
      let lastHashtagError: string | undefined;

      for (let attempt = 1; attempt <= HASHTAG_RETRIES; attempt++) {
        if (attempt > 1) {
          console.log(`  Retry ${attempt}/${HASHTAG_RETRIES} for #${hashtag}...`);
          try {
            ({ browser, page } = await ensureConnection(browser, page, cookie));
          } catch (reconnErr: unknown) {
            const reconnMsg = reconnErr instanceof Error ? reconnErr.message : String(reconnErr);
            console.log(`  Cannot recover connection: ${reconnMsg}. Giving up on #${hashtag}.`);
            break;
          }
          await randomDelay(2000, 4000);
        }

      try {
        const visitedPaths = new Set<string>();
        const processedOwners = new Set<string>();
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;
        const MAX_ROUNDS = 5;

        for (let round = 1; round <= MAX_ROUNDS && hashtagInteracted < interactCount; round++) {
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
            `  Round ${round}: found ${postPaths.length} posts (${paths.length} new), need ${interactCount - hashtagInteracted} more accounts.`
          );

          let onExplorePage = true;

          for (let i = 0; i < paths.length && hashtagInteracted < interactCount; i++) {
            const postPath = paths[i];
            visitedPaths.add(postPath);

            try {
              // Navigate to explore page if needed
              if (!onExplorePage) {
                await page.goto(
                  `https://www.instagram.com/explore/tags/${hashtag}/`,
                  { waitUntil: "networkidle2" }
                );
                await randomDelay(2000, 3000);
                onExplorePage = true;
              }

              // Click the post to open lightbox
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

              // Get the post owner
              const owner = await getPostOwner(page);

              if (!owner) {
                console.log(`  Post ${visitedPaths.size}: could not determine owner, skipping.`);
                if (usedLightbox) {
                  await page.keyboard.press("Escape");
                  await randomDelay(1000, 2000);
                  try { await page.waitForFunction(() => !document.querySelector('[role="dialog"] article'), { timeout: 5000 }); } catch { onExplorePage = false; }
                } else { onExplorePage = false; }
                await randomDelay();
                continue;
              }

              // Skip if we already interacted with this owner in this session
              if (processedOwners.has(owner.toLowerCase())) {
                console.log(`  Post ${visitedPaths.size}: @${owner} already processed this session, skipping.`);
                if (usedLightbox) {
                  await page.keyboard.press("Escape");
                  await randomDelay(1000, 2000);
                  try { await page.waitForFunction(() => !document.querySelector('[role="dialog"] article'), { timeout: 5000 }); } catch { onExplorePage = false; }
                } else { onExplorePage = false; }
                await randomDelay();
                continue;
              }

              // Skip if already following and in cooldown
              if (shouldFollow) {
                const key = owner.toLowerCase();
                const existing = accountsMap.get(key);
                if (existing && existing.following) {
                  console.log(`  Post ${visitedPaths.size}: @${owner} already following, skipping.`);
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

              // Close lightbox before navigating to profile
              if (usedLightbox) {
                await page.keyboard.press("Escape");
                await randomDelay(1000, 2000);
                try { await page.waitForFunction(() => !document.querySelector('[role="dialog"] article'), { timeout: 5000 }); } catch { /* ignore */ }
              }
              onExplorePage = false;

              // Check follower count
              const followerCount = await getFollowerCount(page, owner);
              if (followerCount !== null && (followerCount < MIN_FOLLOWERS || followerCount > MAX_FOLLOWERS)) {
                console.log(`  Post ${visitedPaths.size}: @${owner} has ${followerCount.toLocaleString()} followers (outside ${MIN_FOLLOWERS.toLocaleString()}–${MAX_FOLLOWERS.toLocaleString()} range), skipping.`);
                processedOwners.add(owner.toLowerCase());
                await randomDelay();
                continue;
              }

              // Navigate to profile
              console.log(`  Post ${visitedPaths.size}: navigating to @${owner}'s profile${followerCount !== null ? ` (${followerCount.toLocaleString()} followers)` : ""}...`);
              await page.goto(`https://www.instagram.com/${owner}/`, { waitUntil: "networkidle2" });
              await randomDelay(2000, 3000);

              await dismissDialogByText(page, ["not now", "cancel"]);

              // ── Interact with profile posts ──────────────────────────

              let postsLiked = 0;
              let postsCommented = 0;
              const comments: string[] = [];

              if (numLikes > 0) {
                // Gather post links from profile
                const profilePosts = await page.evaluate(() => {
                  const links = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
                  return links.map((a) => new URL((a as HTMLAnchorElement).href).pathname);
                });

                if (profilePosts.length === 0) {
                  console.log(`    @${owner}: no posts found on profile.`);
                } else {
                  const postsToVisit = profilePosts.slice(0, numLikes + 5); // extra buffer for skips

                  for (let j = 0; j < postsToVisit.length && postsLiked < numLikes; j++) {
                    const profilePostPath = postsToVisit[j];

                    try {
                      // Click post to open lightbox
                      const postClicked = await page.evaluate((pp: string) => {
                        const link = document.querySelector(`a[href="${pp}"]`);
                        if (!link) return false;
                        (link as HTMLElement).click();
                        return true;
                      }, profilePostPath);

                      if (!postClicked) continue;

                      try {
                        await page.waitForFunction(
                          () => !!document.querySelector('[role="dialog"] article'),
                          { timeout: 8000 }
                        );
                      } catch {
                        // Might have navigated instead of lightbox
                        await page.goto(`https://www.instagram.com/${owner}/`, { waitUntil: "networkidle2" });
                        await randomDelay(1000, 2000);
                        continue;
                      }
                      await randomDelay(1000, 2000);

                      await dismissDialogByText(page, ["not now", "cancel"]);

                      // Check if post has too many likes
                      const postLikes = await getLikeCount(page);
                      if (postLikes !== null && postLikes >= MAX_LIKES) {
                        console.log(`    @${owner} post ${j + 1}: ${postLikes} likes (>=${MAX_LIKES}), skipping.`);
                        await page.keyboard.press("Escape");
                        await randomDelay(1000, 2000);
                        try { await page.waitForFunction(() => !document.querySelector('[role="dialog"] article'), { timeout: 5000 }); } catch { /* ignore */ }
                        await randomDelay();
                        continue;
                      }

                      // Like the post
                      const alreadyLiked = await page.evaluate(() => {
                        const likeSvg = document.querySelector('section svg[aria-label="Like"]');
                        return !likeSvg;
                      });

                      if (alreadyLiked) {
                        console.log(`    @${owner} post ${j + 1}: already liked, skipping.`);
                      } else {
                        await page.evaluate(() => {
                          const likeSvg = document.querySelector('section svg[aria-label="Like"]');
                          if (likeSvg) {
                            const btn = likeSvg.closest("button") || likeSvg.parentElement;
                            (btn as HTMLElement).click();
                          }
                        });
                        postsLiked++;
                        console.log(`    @${owner} post ${j + 1}: liked (${postsLiked}/${numLikes})`);

                        // Comment on this post if within numComments budget
                        if (postsCommented < numComments) {
                          try {
                            const commentText = await getAIComment(page);
                            await postComment(page, commentText);
                            postsCommented++;
                            comments.push(commentText);
                            console.log(`    @${owner} post ${j + 1}: commented "${commentText}" (${postsCommented}/${numComments})`);
                          } catch (commentErr: unknown) {
                            const cmsg = commentErr instanceof Error ? commentErr.message : String(commentErr);
                            console.log(`    @${owner} post ${j + 1}: comment failed — ${cmsg}`);
                          }
                        }
                      }

                      // Close lightbox
                      await page.keyboard.press("Escape");
                      await randomDelay(1000, 2000);
                      try {
                        await page.waitForFunction(
                          () => !document.querySelector('[role="dialog"] article'),
                          { timeout: 5000 }
                        );
                      } catch { /* ignore */ }

                      await randomDelay();
                    } catch (postErr: unknown) {
                      const pmsg = postErr instanceof Error ? postErr.message : String(postErr);
                      console.log(`    @${owner} post ${j + 1}: error — ${pmsg}`);
                      // Try to recover to profile page
                      try {
                        await page.goto(`https://www.instagram.com/${owner}/`, { waitUntil: "networkidle2" });
                        await randomDelay(1000, 2000);
                      } catch { /* ignore */ }
                    }
                  }
                }
              }

              // ── Follow ────────────────────────────────────────────────

              let didFollow = false;

              if (shouldFollow) {
                // Navigate back to profile if we were on a post page
                const currentUrl = page.url();
                if (!currentUrl.includes(`/${owner}`)) {
                  await page.goto(`https://www.instagram.com/${owner}/`, { waitUntil: "networkidle2" });
                  await randomDelay(1000, 2000);
                }

                const followResult = await page.evaluate(() => {
                  const buttons = [...document.querySelectorAll("button")];
                  const followBtn = buttons.find((b) => b.textContent!.trim() === "Follow");
                  if (followBtn) {
                    followBtn.click();
                    return true;
                  }
                  return false;
                });

                if (followResult) {
                  didFollow = true;
                  console.log(`    @${owner}: followed`);

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
                } else {
                  console.log(`    @${owner}: already following or Follow button not found`);
                }
              }

              // ── Count this account as interacted ──────────────────────

              processedOwners.add(owner.toLowerCase());
              hashtagInteracted++;
              totalInteracted++;
              consecutiveFailures = 0;

              accountDetails.push({
                username: owner,
                followed: didFollow,
                postsLiked,
                postsCommented,
                comments,
              });

              console.log(
                `  @${owner}: done — liked ${postsLiked}, commented ${postsCommented}, followed ${didFollow} (${hashtagInteracted}/${interactCount} for #${hashtag})`
              );

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

        console.log(`  Finished #${hashtag}: ${hashtagInteracted} accounts interacted.`);
        lastHashtagError = undefined;
        break; // success — exit retry loop
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lastHashtagError = msg;

        if (attempt < HASHTAG_RETRIES) {
          console.log(`  Error processing #${hashtag}: ${msg}. Will retry...`);
        } else {
          console.log(`  Error processing #${hashtag}: ${msg}. No retries left, skipping.`);
        }
      }
      } // end retry loop

      result.details.push({
        hashtag,
        interacted: hashtagInteracted,
        accounts: accountDetails,
        ...(lastHashtagError ? { error: lastHashtagError } : {}),
      });
    }
  } catch (err: unknown) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.totalInteracted = totalInteracted;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
