const minimist = require("minimist");
const { connectBrowser } = require("./browser");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: __dirname + "/.env" });

const argv = minimist(process.argv.slice(2));

// --- Validate CLI args ---
const cookie = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie) {
  console.error(
    "Usage: node IG_collect_followers.js --cookie <sessionid>"
  );
  process.exit(1);
}

const followersFilePath = path.join(__dirname, "followers.json");

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
  const result = { success: true, action: "collect_followers", expectedCount: null, accountsFound: 0, error: null };

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

    await dismissDialogByText(page, ["allow all cookies", "allow essential and optional cookies", "accept"]);
    await randomDelay(1000, 2000);

    const loginForm = await page.$('input[name="username"]');
    if (loginForm) {
      throw new Error("Session cookie appears invalid — login form is still visible. Get a fresh sessionid from your browser.");
    }
    console.log("Logged in via session cookie.");

    // --- Get profile URL from the sidebar/nav ---
    console.log("Finding profile link...");
    const profilePath = await page.evaluate(() => {
      const knownPaths = ["/explore/", "/reels/", "/direct/", "/accounts/", "/p/", "/reel/", "/stories/"];
      const links = [...document.querySelectorAll("a[href]")];
      for (const a of links) {
        const href = a.getAttribute("href");
        if (href && /^\/[a-zA-Z0-9._]+\/$/.test(href)) {
          const isKnown = knownPaths.some((p) => href.startsWith(p));
          if (!isKnown) return href;
        }
      }
      return null;
    });

    if (!profilePath) {
      throw new Error("Could not find profile link in navigation. Are you logged in?");
    }
    console.log(`Found profile: ${profilePath}`);

    // --- Navigate to profile page ---
    await page.goto(`https://www.instagram.com${profilePath}`, { waitUntil: "networkidle2" });
    await randomDelay(2000, 3000);

    // --- Read the expected followers count from the profile page ---
    const expectedCount = await page.evaluate((profPath) => {
      const link = document.querySelector(`a[href="${profPath}followers/"]`);
      if (!link) return null;
      const text = link.textContent.replace(/,/g, "").trim();
      const match = text.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    }, profilePath);

    if (expectedCount !== null) {
      console.log(`Profile says you have ${expectedCount} followers.`);
      result.expectedCount = expectedCount;
    } else {
      console.warn("Warning: Could not read followers count from profile page.");
    }

    // --- Click the "followers" count link ---
    console.log("Opening followers list...");
    const followersLink = await page.$(`a[href="${profilePath}followers/"]`);
    if (!followersLink) {
      throw new Error("Could not find the 'followers' link on the profile page.");
    }
    await followersLink.click();
    await randomDelay(2000, 3000);

    // Wait for the followers list dialog to appear
    await page.waitForFunction(
      () => {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
          const links = d.querySelectorAll('a[href*="/"]');
          if (links.length > 0) return true;
        }
        return false;
      },
      { timeout: 15000 }
    );
    console.log("Followers list opened. Collecting usernames...");

    // --- Scroll through the entire followers list and collect usernames ---
    const collectedUsernames = new Set();
    let scrollStallCount = 0;
    const STALL_LIMIT = 8;

    while (scrollStallCount < STALL_LIMIT) {
      const usernames = await page.evaluate(() => {
        const results = [];
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const dialog of dialogs) {
          const links = dialog.querySelectorAll('a[href*="/"]');
          for (const link of links) {
            const href = link.getAttribute("href");
            const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
            if (match) {
              results.push(match[1]);
            }
          }
        }
        return results;
      });

      const prevSize = collectedUsernames.size;
      for (const u of usernames) {
        collectedUsernames.add(u.toLowerCase());
      }

      if (collectedUsernames.size > prevSize) {
        const newCount = collectedUsernames.size - prevSize;
        console.log(`  Found ${newCount} new usernames (total: ${collectedUsernames.size})`);
        scrollStallCount = 0;
      } else {
        scrollStallCount++;
        console.log(`  No new usernames after scroll (stall ${scrollStallCount}/${STALL_LIMIT})`);
      }

      if (expectedCount !== null && collectedUsernames.size >= expectedCount) {
        console.log(`  Reached expected followers count (${expectedCount}).`);
        break;
      }

      // Scroll the dialog
      const scrollResult = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const dialog of dialogs) {
          const allDivs = [...dialog.querySelectorAll("div")];
          let bestScrollable = null;
          let bestScrollHeight = 0;
          for (const div of allDivs) {
            const style = window.getComputedStyle(div);
            const overflowY = style.overflowY;
            const isScrollable = (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay");
            if (isScrollable && div.scrollHeight > div.clientHeight) {
              if (div.scrollHeight > bestScrollHeight) {
                bestScrollHeight = div.scrollHeight;
                bestScrollable = div;
              }
            }
          }
          if (bestScrollable) {
            const prevTop = bestScrollable.scrollTop;
            bestScrollable.scrollTop = bestScrollable.scrollHeight;
            return {
              scrolled: true,
              prevTop: prevTop,
              newTop: bestScrollable.scrollTop,
            };
          }
        }
        return { scrolled: false };
      });

      if (scrollResult.scrolled) {
        const didMove = scrollResult.newTop > scrollResult.prevTop;
        if (!didMove && scrollStallCount >= 3) {
          console.log(`  Scroll position did not change — likely at end of list.`);
        }
      } else {
        console.log("  Warning: Could not find scrollable container in dialog.");
      }

      await randomDelay(1500, 2500);
    }

    // Remove own username from the list
    const ownUsername = profilePath.replace(/\//g, "").toLowerCase();
    collectedUsernames.delete(ownUsername);

    console.log(`\nFinished collecting. Found ${collectedUsernames.size} followers.`);
    if (expectedCount !== null && collectedUsernames.size < expectedCount) {
      console.warn(`Warning: Expected ${expectedCount} but only found ${collectedUsernames.size}. Some accounts may have been missed.`);
    }

    // --- Write to followers.json ---
    const sortedFollowers = [...collectedUsernames].sort();
    fs.writeFileSync(followersFilePath, JSON.stringify(sortedFollowers, null, 2) + "\n", "utf-8");

    result.accountsFound = sortedFollowers.length;
    console.log(`Wrote ${sortedFollowers.length} followers to followers.json`);
  } catch (err) {
    result.success = false;
    result.error = err.message;
  } finally {
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
