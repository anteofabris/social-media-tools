const minimist = require("minimist");
const { connectBrowser } = require("./browser");
require("dotenv").config({ path: __dirname + "/.env" });

const argv = minimist(process.argv.slice(2));

// --- Validate CLI args ---
const { locations, count = 50 } = argv;
const cookie = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie || !locations) {
  console.error(
    "Usage: node IG_autolike_locations.js --cookie <sessionid> --locations 213385402,12345678 [--count 50]"
  );
  process.exit(1);
}

const locationList = String(locations).split(",").map((t) => t.trim()).filter(Boolean);
const likeCount = Number(count);

if (locationList.length === 0) {
  console.error("Error: provide at least one location ID");
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

// --- Main ---
(async () => {
  let browser, page;
  let totalLiked = 0;
  const result = { success: true, action: "autolike_locations", locations: locationList, requested: likeCount, totalLiked: 0, details: [], error: null };

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

    // --- Process each location ---
    for (const locationId of locationList) {
      console.log(`\n--- Location: ${locationId} ---`);
      let locationLiked = 0;

      try {
        await page.goto(`https://www.instagram.com/explore/locations/${locationId}/`, {
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
          console.log(`  No posts found for location ${locationId}, skipping.`);
          continue;
        }

        const targetIndex = postLinks.length > 9 ? 9 : 0;
        console.log(`  Found ${postLinks.length} posts, clicking post ${targetIndex + 1}...`);
        await postLinks[targetIndex].click();

        // Wait for the post lightbox to fully load
        console.log("  Waiting for post to load...");
        try {
          await page.waitForFunction(
            () => !!document.querySelector('[role="dialog"] article'),
            { timeout: 10000 }
          );
        } catch {
          // Timeout — continue anyway
        }
        await randomDelay(1000, 2000);

        // --- Like-and-advance loop ---
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;

        for (let i = 0; i < likeCount; i++) {
          try {
            // Check if already liked by looking at the like button SVG's aria-label or fill
            const alreadyLiked = await page.evaluate(() => {
              const likeSvg = document.querySelector(
                'section svg[aria-label="Like"]'
              );
              return !likeSvg;
            });

            if (alreadyLiked) {
              console.log(`  Post ${i + 1}: already liked, advancing.`);
            } else {
              // Click the Like button
              await page.evaluate(() => {
                const likeSvg = document.querySelector(
                  'section svg[aria-label="Like"]'
                );
                if (likeSvg) {
                  const btn = likeSvg.closest("button") || likeSvg.parentElement;
                  btn.click();
                }
              });
              locationLiked++;
              totalLiked++;
              consecutiveFailures = 0;
              console.log(`  Post ${i + 1}: liked! (${locationLiked} for location ${locationId})`);
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

        console.log(`  Finished location ${locationId}: ${locationLiked} posts liked.`);
        result.details.push({ location: locationId, liked: locationLiked });
      } catch (err) {
        console.log(`  Error processing location ${locationId}: ${err.message}. Skipping.`);
        result.details.push({ location: locationId, liked: locationLiked, error: err.message });
      }
    }
  } catch (err) {
    result.success = false;
    result.error = err.message;
  } finally {
    result.totalLiked = totalLiked;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
