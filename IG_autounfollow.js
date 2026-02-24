const puppeteer = require("puppeteer");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

// --- Validate CLI args ---
const { cookie, count = 50 } = argv;

if (!cookie) {
  console.error(
    "Usage: node IG_autounfollow.js --cookie <sessionid> [--count 50]"
  );
  process.exit(1);
}

const unfollowCount = Number(count);

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
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 900 },
    args: ["--window-size=1280,900"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  let totalUnfollowed = 0;

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

    // --- Get profile URL from the sidebar/nav ---
    console.log("Finding profile link...");
    const profilePath = await page.evaluate(() => {
      const knownPaths = ["/explore/", "/reels/", "/direct/", "/accounts/", "/p/", "/reel/", "/stories/"];
      const links = [...document.querySelectorAll("a[href]")];
      for (const a of links) {
        const href = a.getAttribute("href");
        // Profile links look like /username/ — a single path segment
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

    // --- Click the "following" count link ---
    console.log("Opening following list...");
    const followingLink = await page.$(`a[href="${profilePath}following/"]`);
    if (!followingLink) {
      throw new Error("Could not find the 'following' link on the profile page.");
    }
    await followingLink.click();
    await randomDelay(2000, 3000);

    // Wait for the following list dialog to appear
    await page.waitForFunction(
      () => {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
          const buttons = [...d.querySelectorAll("button")];
          if (buttons.some((b) => b.textContent.trim() === "Following")) return true;
        }
        return false;
      },
      { timeout: 15000 }
    );
    console.log("Following list opened.");

    // --- Unfollow loop ---
    let consecutiveFailures = 0;
    const FAILURE_LIMIT = 10;

    for (let i = 0; i < unfollowCount; i++) {
      try {
        // Find a "Following" button inside the dialog's list
        const foundFollowing = await page.evaluate(() => {
          const dialogs = document.querySelectorAll('[role="dialog"]');
          for (const dialog of dialogs) {
            const buttons = [...dialog.querySelectorAll("button")];
            const followingBtn = buttons.find((b) => b.textContent.trim() === "Following");
            if (followingBtn) {
              followingBtn.click();
              return true;
            }
          }
          return false;
        });

        if (!foundFollowing) {
          // Try scrolling the dialog's scrollable container to load more
          console.log("  No 'Following' buttons visible, scrolling to load more...");
          await page.evaluate(() => {
            const dialogs = document.querySelectorAll('[role="dialog"]');
            for (const dialog of dialogs) {
              // The scrollable container is usually a div with overflow
              const scrollable = dialog.querySelector("div[style*='overflow']") ||
                dialog.querySelector("div[class] > div > div");
              if (scrollable) {
                scrollable.scrollTop = scrollable.scrollHeight;
              }
            }
          });
          await randomDelay(2000, 3000);

          // Retry finding a "Following" button after scroll
          const retryFound = await page.evaluate(() => {
            const dialogs = document.querySelectorAll('[role="dialog"]');
            for (const dialog of dialogs) {
              const buttons = [...dialog.querySelectorAll("button")];
              const followingBtn = buttons.find((b) => b.textContent.trim() === "Following");
              if (followingBtn) {
                followingBtn.click();
                return true;
              }
            }
            return false;
          });

          if (!retryFound) {
            console.log("  No more 'Following' buttons found after scrolling. End of list.");
            break;
          }
        }

        await randomDelay(1000, 2000);

        // Click the "Unfollow" confirmation button in the popup
        const confirmed = await dismissDialogByText(page, ["unfollow"]);
        if (!confirmed) {
          console.log(`  Unfollow ${i + 1}: confirmation dialog not found. Skipping.`);
          consecutiveFailures++;
          if (consecutiveFailures >= FAILURE_LIMIT) {
            console.log(`  Reached ${FAILURE_LIMIT} consecutive failures. Exiting.`);
            await browser.close();
            process.exit(1);
          }
          continue;
        }

        totalUnfollowed++;
        consecutiveFailures = 0;
        console.log(`  Unfollowed ${totalUnfollowed}/${unfollowCount}`);

        await randomDelay();
      } catch (err) {
        console.log(`  Unfollow ${i + 1}: error — ${err.message}. Continuing...`);
        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_LIMIT) {
          console.log(`  Reached ${FAILURE_LIMIT} consecutive failures. Exiting.`);
          await browser.close();
          process.exit(1);
        }
        await randomDelay(1000, 2000);
      }
    }
  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
  } finally {
    console.log(`\nDone. Total users unfollowed: ${totalUnfollowed}.`);
    await browser.close();
  }
})();
