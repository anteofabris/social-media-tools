const minimist = require("minimist");
const { connectBrowser, createPage } = require("./browser");
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

async function injectCookie(page, cookieValue) {
  await page.setCookie({
    name: "sessionid",
    value: String(cookieValue),
    domain: ".instagram.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "None",
  });
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

async function ensureConnection(browser, page, cookieValue) {
  try {
    await page.evaluate(() => true);
    return { browser, page };
  } catch {
    console.log("  Page is dead, attempting recovery...");
  }

  try {
    try { await page.close(); } catch {}
    const newPage = await createPage(browser);
    await injectCookie(newPage, cookieValue);
    console.log("  Created new page on existing browser.");
    return { browser, page: newPage };
  } catch {
    console.log("  Browser connection lost, reconnecting...");
  }

  try { await browser.close(); } catch {}
  const conn = await connectBrowser();
  await injectCookie(conn.page, cookieValue);
  console.log("  Reconnected to browser.");
  return conn;
}

async function postComment(page, text) {
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
  if (!textarea) throw new Error("Comment textarea not found");

  await textarea.click();
  await randomDelay(500, 1000);

  textarea = null;
  for (const sel of selectors) {
    textarea = await page.$(sel);
    if (textarea) break;
  }
  if (!textarea) throw new Error("Comment textarea not found after focus");

  await textarea.type(text, { delay: 60 });
  await randomDelay(500, 1000);

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
    await textarea.press("Enter");
  }

  await randomDelay(2000, 3000);
}

async function loadExplorePage(page, locationId) {
  await page.goto(
    `https://www.instagram.com/explore/locations/${locationId}/`,
    { waitUntil: "networkidle2" }
  );
  await randomDelay(3000, 5000);

  await page.waitForFunction(
    () => document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length > 0,
    { timeout: 15000 }
  );

  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
    return links.map((a) => new URL(a.href).pathname);
  });
}

// --- Main ---
(async () => {
  let browser, page;
  let totalCommented = 0;
  const result = {
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

    // --- Process each location ---
    for (const locationId of locationList) {
      console.log(`\n--- Location: ${locationId} ---`);
      let locationCommented = 0;
      const comments = [];

      try {
        const postPaths = await loadExplorePage(page, locationId);

        if (postPaths.length === 0) {
          console.log(`  No posts found for location ${locationId}, skipping.`);
          result.details.push({ location: locationId, commented: 0, comments });
          continue;
        }

        const startIndex = postPaths.length > 9 ? 9 : 0;
        const paths = postPaths.slice(startIndex);
        console.log(
          `  Found ${postPaths.length} posts, will comment on up to ${commentCount} starting from post ${startIndex + 1}.`
        );

        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;
        let onExplorePage = true;

        for (let i = 0; i < paths.length && locationCommented < commentCount; i++) {
          const postPath = paths[i];

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

            const clicked = await page.evaluate((path) => {
              const link = document.querySelector(`a[href="${path}"]`);
              if (!link) return false;
              link.click();
              return true;
            }, postPath);

            if (!clicked) {
              console.log(`  Post ${startIndex + i + 1}: link not found on page, skipping.`);
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

            const commentText = await getAIComment(page);
            await postComment(page, commentText);

            locationCommented++;
            totalCommented++;
            consecutiveFailures = 0;
            comments.push(commentText);
            console.log(
              `  Post ${startIndex + i + 1}: commented "${commentText}" (${locationCommented}/${commentCount} for location ${locationId})`
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
          } catch (err) {
            consecutiveFailures++;
            console.log(
              `  Post ${startIndex + i + 1}: error — ${err.message}. (${consecutiveFailures}/${FAILURE_LIMIT})`
            );

            if (consecutiveFailures >= FAILURE_LIMIT) {
              throw new Error(
                `Reached ${FAILURE_LIMIT} consecutive failures`
              );
            }

            try {
              ({ browser, page } = await ensureConnection(browser, page, cookie));
              onExplorePage = false;
            } catch (reconnErr) {
              console.log(
                `  Cannot recover connection: ${reconnErr.message}. Moving on.`
              );
              break;
            }

            await randomDelay(2000, 3000);
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
      } catch (err) {
        console.log(
          `  Error processing location ${locationId}: ${err.message}. Skipping.`
        );
        result.details.push({
          location: locationId,
          commented: locationCommented,
          comments,
          error: err.message,
        });
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
