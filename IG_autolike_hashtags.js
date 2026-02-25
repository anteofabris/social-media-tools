const minimist = require("minimist");
const { connectBrowser } = require("./browser");
require("dotenv").config({ path: __dirname + "/.env" });

const argv = minimist(process.argv.slice(2));

// --- Validate CLI args ---
const { hashtags, count = 50 } = argv;
const cookie = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie || !hashtags) {
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
  const { browser, page } = await connectBrowser();

  let totalLiked = 0;
  const result = { success: true, action: "autolike_hashtags", hashtags: hashtagList, requested: likeCount, totalLiked: 0, details: [], error: null };

  try {
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
      let hashtagLiked = 0;

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
        await postLinks[targetIndex].click();

        await randomDelay(2000, 3000);

        // --- Like-and-advance loop ---
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;

        for (let i = 0; i < likeCount; i++) {
          try {
            // Check if already liked by looking at the like button SVG's aria-label or fill
            const alreadyLiked = await page.evaluate(() => {
              // The like button is an SVG inside the post modal. When liked, the svg has
              // aria-label="Unlike" and fill="red"; when not liked, aria-label="Like".
              const likeSvg = document.querySelector(
                'section svg[aria-label="Like"]'
              );
              // If we find an svg with aria-label="Like", the post is NOT yet liked
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
                  // Click the closest button ancestor
                  const btn = likeSvg.closest("button") || likeSvg.parentElement;
                  btn.click();
                }
              });
              hashtagLiked++;
              totalLiked++;
              consecutiveFailures = 0;
              console.log(`  Post ${i + 1}: liked! (${hashtagLiked} for #${hashtag})`);
            }

            await randomDelay();

            // Click "Next" arrow — the post-navigation arrow in the lightbox overlay.
            // This is an SVG button with aria-label="Next" that lives in the modal overlay,
            // NOT inside the photo carousel. We target the one inside the overlay div
            // that sits outside the post content area.
            const hasNext = await page.evaluate(() => {
              // Look for all "Next" buttons, pick the one in the modal overlay
              // (the post navigation arrow, not the carousel arrow).
              // The modal overlay arrow is typically a direct child of the overlay container
              // and is a <button> with a nested SVG with aria-label="Next".
              const allNextButtons = [
                ...document.querySelectorAll('button svg[aria-label="Next"]'),
              ].map((svg) => svg.closest("button"));

              // The post-navigation "Next" is in the top-level overlay (role="dialog" parent).
              // The carousel "Next" is nested deeper inside the post media section.
              // We pick the one whose closest role="dialog" ancestor is the outermost dialog.
              for (const btn of allNextButtons) {
                const dialog = btn.closest('[role="dialog"]');
                if (dialog) {
                  // Check if this button is a direct child area of the dialog overlay
                  // (not nested inside the post article/content)
                  const article = btn.closest("article");
                  if (!article) {
                    // This "Next" is outside the article = post-navigation arrow
                    btn.click();
                    return true;
                  }
                }
              }

              // Fallback: if all Next buttons are inside an article, try the last one
              // (the overlay arrow is often appended after the article)
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

            await randomDelay();
          } catch (err) {
            consecutiveFailures++;
            console.log(`  Post ${i + 1}: error — ${err.message}. Skipping... (${consecutiveFailures}/${FAILURE_LIMIT})`);
            if (consecutiveFailures >= FAILURE_LIMIT) {
              throw new Error(`Reached ${FAILURE_LIMIT} consecutive failures`);
            }
            await randomDelay(1000, 2000);
          }
        }

        console.log(`  Finished #${hashtag}: ${hashtagLiked} posts liked.`);
        result.details.push({ hashtag, liked: hashtagLiked });
      } catch (err) {
        console.log(`  Error processing #${hashtag}: ${err.message}. Skipping.`);
        result.details.push({ hashtag, liked: hashtagLiked, error: err.message });
      }
    }
  } catch (err) {
    result.success = false;
    result.error = err.message;
  } finally {
    result.totalLiked = totalLiked;
    console.log(JSON.stringify(result));
    await browser.close();
  }
})();
