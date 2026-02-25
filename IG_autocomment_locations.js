const minimist = require("minimist");
const { connectBrowser } = require("./browser");
const { getAIComment } = require("./gemini_comment");
require("dotenv").config({ path: __dirname + "/.env" });

const argv = minimist(process.argv.slice(2));

// --- Validate CLI args ---
const { locations, count = 50 } = argv;
const cookie = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie || !locations) {
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

async function postComment(page, text) {
  // Try multiple selectors for the comment textarea
  const selectors = [
    'textarea[aria-label="Add a comment…"]',
    'textarea[aria-label="Add a comment..."]',
    'textarea[placeholder="Add a comment…"]',
    'textarea[placeholder="Add a comment..."]',
    "form textarea",
  ];

  let textarea = null;
  for (const sel of selectors) {
    textarea = await page.$(sel);
    if (textarea) break;
  }

  if (!textarea) {
    throw new Error("Comment textarea not found");
  }

  // Click to focus the textarea (Instagram may swap it for a larger one on focus)
  await textarea.click();
  await randomDelay(500, 1000);

  // Re-query after focus — Instagram often replaces the textarea element on click
  textarea = null;
  for (const sel of selectors) {
    textarea = await page.$(sel);
    if (textarea) break;
  }
  if (!textarea) {
    throw new Error("Comment textarea not found after focus");
  }

  // Type the comment
  await textarea.type(text, { delay: 60 });
  await randomDelay(500, 1000);

  // Submit: click the "Post" button that appears next to the textarea
  const posted = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const postBtn = buttons.find(
      (b) => b.textContent.trim().toLowerCase() === "post"
    );
    if (postBtn && !postBtn.disabled) {
      postBtn.click();
      return true;
    }
    return false;
  });

  if (!posted) {
    // Fallback: press Enter
    await textarea.press("Enter");
  }

  // Wait for comment to be submitted
  await randomDelay(2000, 3000);
}

// --- Main ---
(async () => {
  let browser, page;
  let totalCommented = 0;
  const result = { success: true, action: "autocomment_locations", locations: locationList, requested: commentCount, totalCommented: 0, details: [], error: null };

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
      let locationCommented = 0;
      const comments = [];

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

        await randomDelay(2000, 3000);

        // --- Comment-and-advance loop ---
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;
        let postIndex = 0;

        while (locationCommented < commentCount) {
          postIndex++;
          try {
            const commentText = await getAIComment(page);
            await postComment(page, commentText);
            locationCommented++;
            totalCommented++;
            consecutiveFailures = 0;
            comments.push(commentText);
            console.log(`  Post ${postIndex}: commented "${commentText}" (${locationCommented} for location ${locationId})`);

            await randomDelay();
          } catch (err) {
            consecutiveFailures++;
            console.log(`  Post ${postIndex}: error — ${err.message}. Skipping... (${consecutiveFailures}/${FAILURE_LIMIT})`);
            if (consecutiveFailures >= FAILURE_LIMIT) {
              throw new Error(`Reached ${FAILURE_LIMIT} consecutive failures`);
            }
            await randomDelay(1000, 2000);
          }

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
        }

        console.log(`  Finished location ${locationId}: ${locationCommented} posts commented.`);
        result.details.push({ location: locationId, commented: locationCommented, comments });
      } catch (err) {
        console.log(`  Error processing location ${locationId}: ${err.message}. Skipping.`);
        result.details.push({ location: locationId, commented: locationCommented, comments, error: err.message });
      }
    }
  } catch (err) {
    result.success = false;
    result.error = err.message;
  } finally {
    result.totalCommented = totalCommented;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
