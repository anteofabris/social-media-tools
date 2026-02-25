const minimist = require("minimist");
const { connectBrowser } = require("./browser");
require("dotenv").config({ path: __dirname + "/.env" });

const argv = minimist(process.argv.slice(2));

// --- Validate CLI args ---
const { hashtags, count = 50 } = argv;
const cookie = argv.cookie || process.env.IG_SESSION_COOKIE;

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

// --- Helpers ---
function randomDelay(min = 2000, max = 5000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dismissDialogByText(page, buttonTexts) {
  for (const text of buttonTexts) {
    try {
      const btn = await page.evaluateHandle((t) => {
        const buttons = [...document.querySelectorAll("button")];
        return buttons.find((b) => b.textContent.trim().toLowerCase().includes(t.toLowerCase()));
      }, text);
      if (btn && btn.asElement()) {
        await btn.asElement().click();
        await randomDelay(1000, 2000);
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

async function getPostOwner(page) {
  try {
    return await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog || document;
      const article = container.querySelector('article');
      if (!article) return null;
      const links = article.querySelectorAll('header a[href]');
      for (const link of links) {
        const match = link.getAttribute('href').match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (match) return match[1];
      }
      for (const link of article.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href');
        if (href.includes('/p/') || href.includes('/reel/') || href.includes('/explore/') || href.includes('/accounts/')) continue;
        const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (match) return match[1];
      }
      return null;
    });
  } catch {
    return null;
  }
}

// --- Main ---
(async () => {
  let browser, page;
  let totalFollowed = 0;
  const result = { success: true, action: "autofollow_hashtags", hashtags: hashtagList, requested: followCount, totalFollowed: 0, details: [], error: null };

  try {
    ({ browser, page } = await connectBrowser());

    // --- Inject session cookie and navigate ---
    console.log("Setting session cookie...");
    await page.setCookie({
      name: "sessionid",
      value: String(cookie),
      domain: ".instagram.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
    });

    console.log("Navigating to Instagram...");
    await page.goto("https://www.instagram.com/", { waitUntil: "networkidle2" });
    await randomDelay(2000, 3000);

    // Dismiss cookie consent if present
    await dismissDialogByText(page, ["allow all cookies", "allow essential and optional cookies", "accept"]);
    await randomDelay(1000, 2000);

    // Verify we're logged in (no login form visible)
    const loginForm = await page.$('input[name="username"]');
    if (loginForm) {
      throw new Error("Session cookie appears invalid — login form is still visible. Get a fresh sessionid from your browser.");
    }
    console.log("Logged in via session cookie.");

    // --- Process each hashtag ---
    for (const hashtag of hashtagList) {
      console.log(`\n--- Hashtag: #${hashtag} ---`);
      let hashtagFollowed = 0;

      try {
        await page.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, {
          waitUntil: "networkidle2",
        });
        await randomDelay(3000, 5000);

        // Wait for post links to appear (posts link to /p/ or /reel/)
        await page.waitForFunction(
          () => document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length > 0,
          { timeout: 15000 }
        );

        // Collect all post links and click into "Most recent" section if possible.
        // Top posts are usually the first 9; most recent starts after.
        const postLinks = await page.$$('a[href*="/p/"], a[href*="/reel/"]');
        if (postLinks.length === 0) {
          console.log(`  No posts found for #${hashtag}, skipping.`);
          continue;
        }

        const targetIndex = postLinks.length > 9 ? 9 : 0;
        console.log(`  Found ${postLinks.length} posts, clicking post ${targetIndex + 1}...`);
        // Set up navigation listener before clicking (handles full-page navigation for Reels)
        const navPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => null);

        await postLinks[targetIndex].click();

        // Wait for the post to load — either as a lightbox or after full-page navigation
        console.log("  Waiting for post to load...");
        try {
          await Promise.race([
            navPromise,
            page.waitForFunction(
              () => !!document.querySelector('[role="dialog"] article'),
              { timeout: 10000 }
            ),
          ]);
        } catch {
          // waitForFunction failed (frame detached during navigation) — wait for navigation to finish
          await navPromise;
        }
        await randomDelay(1000, 2000);

        // --- Follow-and-advance loop ---
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;

        for (let i = 0; i < followCount; i++) {
          try {
            // Look for a "Follow" button inside the post dialog (next to the username)
            const result = await page.evaluate(() => {
              const dialog = document.querySelector('[role="dialog"]');
              if (!dialog) return { found: false };
              const buttons = [...dialog.querySelectorAll("button")];
              const followBtn = buttons.find((b) => b.textContent.trim() === "Follow");
              if (followBtn) {
                followBtn.click();
                return { found: true };
              }
              return { found: false };
            });

            const owner = await getPostOwner(page);

            if (result.found) {
              hashtagFollowed++;
              totalFollowed++;
              consecutiveFailures = 0;
              console.log(`  Post ${i + 1}: followed @${owner || "unknown"} (${hashtagFollowed} for #${hashtag})`);
            } else {
              console.log(`  Post ${i + 1}: already following @${owner || "unknown"}, skipping.`);
            }

            await randomDelay();

            // Capture current URL before advancing to detect when the new post loads
            const prevUrl = page.url();

            // Click "Next" arrow to advance to the next post in the lightbox
            const hasNext = await page.evaluate(() => {
              const allNextButtons = [
                ...document.querySelectorAll('button svg[aria-label="Next"]'),
              ].map((svg) => svg.closest("button"));

              for (const btn of allNextButtons) {
                const dialog = btn.closest('[role="dialog"]');
                if (dialog) {
                  const article = btn.closest("article");
                  if (!article) {
                    btn.click();
                    return true;
                  }
                }
              }

              if (allNextButtons.length > 0) {
                allNextButtons[allNextButtons.length - 1].click();
                return true;
              }

              return false;
            });

            if (!hasNext) {
              console.log("  No more posts (Next button not found). Moving on.");
              break;
            }

            // Wait for the new post to fully load before continuing
            console.log("  Waiting for next post to load...");
            try {
              await page.waitForFunction(
                (prev) => window.location.href !== prev && !!document.querySelector('[role="dialog"] article'),
                { timeout: 10000 },
                prevUrl
              );
            } catch {
              // Timeout — continue anyway, the next action will catch if frame is still detached
            }
            await randomDelay(1000, 2000);
          } catch (err) {
            consecutiveFailures++;
            console.log(`  Post ${i + 1}: error — ${err.message}. Skipping... (${consecutiveFailures}/${FAILURE_LIMIT})`);
            if (consecutiveFailures >= FAILURE_LIMIT) {
              throw new Error(`Reached ${FAILURE_LIMIT} consecutive failures`);
            }
            await randomDelay(1000, 2000);
          }
        }

        console.log(`  Finished #${hashtag}: ${hashtagFollowed} users followed.`);
        result.details.push({ hashtag, followed: hashtagFollowed });
      } catch (err) {
        console.log(`  Error processing #${hashtag}: ${err.message}. Skipping.`);
        result.details.push({ hashtag, followed: hashtagFollowed, error: err.message });
      }
    }
  } catch (err) {
    result.success = false;
    result.error = err.message;
  } finally {
    result.totalFollowed = totalFollowed;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
