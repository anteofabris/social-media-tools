const minimist = require("minimist");
const { connectBrowser, createPage } = require("./browser");
const { getAIComment } = require("./gemini_comment");
require("dotenv").config({ path: __dirname + "/.env" });

const argv = minimist(process.argv.slice(2));

// --- Validate CLI args ---
const { hashtags, count = 50 } = argv;
const cookie = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie || !hashtags) {
  console.error(
    "Usage: node IG_autocomment_hashtags.js --cookie <sessionid> --hashtags tag1,tag2 [--count 50]"
  );
  process.exit(1);
}

const hashtagList = String(hashtags).split(",").map((t) => t.trim()).filter(Boolean);
const commentCount = Number(count);

if (hashtagList.length === 0) {
  console.error("Error: provide at least one hashtag");
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

/**
 * Tiered recovery: restore a working page/browser connection.
 *   Tier 1 — page is still alive (no-op).
 *   Tier 2 — page died, but browser WS is alive → create new page.
 *   Tier 3 — browser WS died → full reconnect.
 */
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

/**
 * Navigate to the explore page and return fresh post paths.
 */
async function scrollToLoadPosts(page, targetCount = 100) {
  let lastCount = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const count = await page.evaluate(
      () => document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length
    );
    if (count >= targetCount) break;
    if (count === lastCount && attempt > 0) break;
    lastCount = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 2500);
  }
}

async function loadExplorePage(page, hashtag) {
  await page.goto(
    `https://www.instagram.com/explore/tags/${hashtag}/`,
    { waitUntil: "networkidle2" }
  );
  await randomDelay(3000, 5000);

  await page.waitForFunction(
    () => document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length > 0,
    { timeout: 15000 }
  );

  await scrollToLoadPosts(page);

  // Return post link pathnames as plain strings (immune to stale handles)
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
    action: "autocomment_hashtags",
    hashtags: hashtagList,
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

    // --- Process each hashtag ---
    for (const hashtag of hashtagList) {
      console.log(`\n--- Hashtag: #${hashtag} ---`);
      let hashtagCommented = 0;
      const comments = [];

      try {
        const visitedPaths = new Set();
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;
        const MAX_ROUNDS = 5;

        for (let round = 1; round <= MAX_ROUNDS && hashtagCommented < commentCount; round++) {
          const postPaths = await loadExplorePage(page, hashtag);

          if (postPaths.length === 0) {
            console.log(`  No posts found for #${hashtag}.`);
            break;
          }

          const startIndex = postPaths.length > 99 ? 99 : 0;
          const paths = postPaths.slice(startIndex).filter((p) => !visitedPaths.has(p));

          if (paths.length === 0) {
            console.log(`  No new posts to process for #${hashtag}.`);
            break;
          }

          console.log(
            `  Round ${round}: found ${postPaths.length} posts (${paths.length} new), need ${commentCount - hashtagCommented} more comments.`
          );

          let onExplorePage = true;

          for (let i = 0; i < paths.length && hashtagCommented < commentCount; i++) {
            const postPath = paths[i];
            visitedPaths.add(postPath);

          try {
            // --- 1. Ensure we're on the explore page ---
            if (!onExplorePage) {
              await page.goto(
                `https://www.instagram.com/explore/tags/${hashtag}/`,
                { waitUntil: "networkidle2" }
              );
              await randomDelay(2000, 3000);
              onExplorePage = true;
            }

            // --- 2. Click the post link (SPA navigation → lightbox) ---
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
              console.log(`  Post ${visitedPaths.size}: link not found on page, skipping.`);
              onExplorePage = true; // still on explore page
              continue;
            }

            // --- 3. Wait for lightbox or full-page navigation (Reels) ---
            let usedLightbox = false;
            try {
              await page.waitForFunction(
                () => !!document.querySelector('[role="dialog"] article'),
                { timeout: 8000 }
              );
              usedLightbox = true;
            } catch {
              // Reel or other full-page nav — wait for it to settle
              await navPromise;
              onExplorePage = false;
            }
            await randomDelay(1000, 2000);

            // Dismiss overlay dialogs ("Turn on notifications", etc.)
            await dismissDialogByText(page, ["not now", "cancel"]);

            // --- 4. Comment ---
            const owner = await getPostOwner(page);
            const commentText = await getAIComment(page);
            await postComment(page, commentText);

            hashtagCommented++;
            totalCommented++;
            consecutiveFailures = 0;
            comments.push(commentText);
            console.log(
              `  Post ${visitedPaths.size}: commented on @${owner || "unknown"} "${commentText}" (${hashtagCommented}/${commentCount} for #${hashtag})`
            );

            // --- 5. Close lightbox (or flag for re-nav) ---
            if (usedLightbox) {
              await page.keyboard.press("Escape");
              await randomDelay(1000, 2000);
              // Verify lightbox closed
              try {
                await page.waitForFunction(
                  () => !document.querySelector('[role="dialog"] article'),
                  { timeout: 5000 }
                );
              } catch {
                // Lightbox stuck — will re-navigate next iteration
                onExplorePage = false;
              }
            } else {
              onExplorePage = false;
            }

            await randomDelay();
          } catch (err) {
            consecutiveFailures++;
            console.log(
              `  Post ${visitedPaths.size}: error — ${err.message}. (${consecutiveFailures}/${FAILURE_LIMIT})`
            );

            if (consecutiveFailures >= FAILURE_LIMIT) {
              throw new Error(
                `Reached ${FAILURE_LIMIT} consecutive failures`
              );
            }

            // Ensure connection and flag to re-navigate to explore page
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
        }

        console.log(
          `  Finished #${hashtag}: ${hashtagCommented} posts commented.`
        );
        result.details.push({ hashtag, commented: hashtagCommented, comments });
      } catch (err) {
        console.log(
          `  Error processing #${hashtag}: ${err.message}. Skipping.`
        );
        result.details.push({
          hashtag,
          commented: hashtagCommented,
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
