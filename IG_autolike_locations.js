const minimist = require("minimist");
const { connectBrowser, createPage } = require("./browser");
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

async function getLikeCount(page) {
  try {
    return await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog || document;
      const article = container.querySelector('article');
      if (!article) return null;

      const likedByLink = article.querySelector('a[href*="liked_by"]');
      if (likedByLink) {
        const num = likedByLink.textContent.replace(/[^0-9]/g, '');
        if (num) return parseInt(num, 10);
      }

      const sections = article.querySelectorAll('section');
      for (const sec of sections) {
        const match = sec.textContent.match(/([\d,]+)\s+likes?\b/i);
        if (match) return parseInt(match[1].replace(/,/g, ''), 10);
      }

      const othersMatch = article.textContent.match(/and\s+([\d,]+)\s+others?\b/i);
      if (othersMatch) return parseInt(othersMatch[1].replace(/,/g, ''), 10) + 1;

      return null;
    });
  } catch {
    return null;
  }
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

  await scrollToLoadPosts(page);

  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
    return links.map((a) => new URL(a.href).pathname);
  });
}

// --- Main ---
(async () => {
  let browser, page;
  let totalLiked = 0;
  const result = { success: true, action: "autolike_locations", locations: locationList, requested: likeCount, totalLiked: 0, details: [], error: null };

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

    // --- Process each location ---
    for (const locationId of locationList) {
      console.log(`\n--- Location: ${locationId} ---`);
      let locationLiked = 0;

      try {
        const visitedPaths = new Set();
        let consecutiveFailures = 0;
        const FAILURE_LIMIT = 10;
        const MAX_ROUNDS = 5;

        for (let round = 1; round <= MAX_ROUNDS && locationLiked < likeCount; round++) {
          const postPaths = await loadExplorePage(page, locationId);

          if (postPaths.length === 0) {
            console.log(`  No posts found for location ${locationId}.`);
            break;
          }

          const startIndex = postPaths.length > 99 ? 99 : 0;
          const paths = postPaths.slice(startIndex).filter((p) => !visitedPaths.has(p));

          if (paths.length === 0) {
            console.log(`  No new posts to process for location ${locationId}.`);
            break;
          }

          console.log(
            `  Round ${round}: found ${postPaths.length} posts (${paths.length} new), need ${likeCount - locationLiked} more likes.`
          );

          let onExplorePage = true;

          for (let i = 0; i < paths.length && locationLiked < likeCount; i++) {
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

            const clicked = await page.evaluate((path) => {
              const link = document.querySelector(`a[href="${path}"]`);
              if (!link) return false;
              link.click();
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
                    btn.click();
                  }
                });
                locationLiked++;
                totalLiked++;
                consecutiveFailures = 0;
                console.log(`  Post ${visitedPaths.size}: liked @${owner || "unknown"} (${locationLiked}/${likeCount} for location ${locationId})`);
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
          } catch (err) {
            consecutiveFailures++;
            console.log(
              `  Post ${visitedPaths.size}: error — ${err.message}. (${consecutiveFailures}/${FAILURE_LIMIT})`
            );

            if (consecutiveFailures >= FAILURE_LIMIT) {
              throw new Error(`Reached ${FAILURE_LIMIT} consecutive failures`);
            }

            try {
              ({ browser, page } = await ensureConnection(browser, page, cookie));
              onExplorePage = false;
            } catch (reconnErr) {
              console.log(`  Cannot recover connection: ${reconnErr.message}. Moving on.`);
              break;
            }

            await randomDelay(2000, 3000);
          }
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
