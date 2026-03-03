const minimist = require("minimist");
const { connectBrowser, createPage } = require("./browser");
const { loadAccountsProcessed, saveAccountsProcessed } = require("./accounts_processed");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: __dirname + "/.env" });

const argv = minimist(process.argv.slice(2));

// --- Validate CLI args ---
const { count = 50 } = argv;
const cookie = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie) {
  console.error(
    "Usage: node IG_autounfollow.js --cookie <sessionid> [--count 50]"
  );
  process.exit(1);
}

const unfollowCount = Number(count);

// --- Load accounts_processed.json ---
let accountsList = loadAccountsProcessed();
if (accountsList.length === 0) {
  console.error("Error: accounts_processed.json is missing or empty. Run IG_collect_following.js first.");
  process.exit(1);
}

// --- Load skip list ---
let skipSet = new Set();
try {
  const skipFilePath = path.join(__dirname, "skip_accounts.json");
  const raw = fs.readFileSync(skipFilePath, "utf-8");
  const fileSkipList = JSON.parse(raw);
  if (Array.isArray(fileSkipList)) {
    for (const u of fileSkipList) skipSet.add(String(u).toLowerCase());
  }
} catch (err) {
  if (err.code === "ENOENT") {
    console.warn("Warning: skip_accounts.json not found. No skip list loaded.");
  } else {
    console.warn(`Warning: Could not parse skip_accounts.json: ${err.message}.`);
  }
}

console.log(`Loaded ${accountsList.length} accounts from accounts_processed.json, ${skipSet.size} skip accounts.`);

// --- Filter and sort candidates ---
const candidates = accountsList
  .filter((e) => e.following === true && !skipSet.has(e.accountName.toLowerCase()))
  .sort((a, b) => new Date(a.dateFollowed) - new Date(b.dateFollowed))
  .slice(0, unfollowCount);

if (candidates.length === 0) {
  console.error("No eligible accounts to unfollow (all are skipped or already unfollowed).");
  process.exit(0);
}

console.log(`Selected ${candidates.length} candidates (oldest followed first).`);

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
      const el = await page.evaluateHandle((t) => {
        const lower = t.toLowerCase();
        // Try <button> elements first
        for (const b of document.querySelectorAll("button")) {
          if (b.textContent.trim().toLowerCase().includes(lower)) return b;
        }
        // Fall back to any leaf element (Instagram uses <div>/<span> for some actions)
        for (const node of document.querySelectorAll('[role="dialog"] div, [role="dialog"] span')) {
          if (node.childElementCount === 0 && node.textContent.trim().toLowerCase() === lower) {
            return node.closest('[role="button"]') || node;
          }
        }
        return null;
      }, text);
      if (el && el.asElement()) {
        await el.asElement().click();
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

// --- Main ---
(async () => {
  let browser, page;
  let totalUnfollowed = 0;
  const result = { success: true, action: "autounfollow", requested: unfollowCount, totalUnfollowed: 0, unfollowed: [], skippedFollowsBack: [], skippedInvalid: [], error: null };

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

    // --- Visit each candidate's profile ---
    let consecutiveFailures = 0;
    const FAILURE_LIMIT = 10;

    for (let i = 0; i < candidates.length && totalUnfollowed < unfollowCount; i++) {
      const entry = candidates[i];
      const accountName = entry.accountName;

      // Double-check skip list (safety net)
      if (skipSet.has(accountName.toLowerCase())) {
        console.log(`\n[${i + 1}/${candidates.length}] @${accountName} is in skip list, skipping.`);
        continue;
      }

      try {
        console.log(`\n[${i + 1}/${candidates.length}] Visiting @${accountName}...`);

        await page.goto(`https://www.instagram.com/${accountName}/`, { waitUntil: "networkidle2" });
        await randomDelay(2000, 3000);

        await dismissDialogByText(page, ["not now", "cancel"]);

        // Check if page is valid (not 404/suspended)
        const pageStatus = await page.evaluate(() => {
          // Check for "Sorry, this page isn't available" or similar
          const body = document.body.innerText;
          if (body.includes("Sorry, this page isn't available") || body.includes("this page isn't available")) {
            return "not_found";
          }
          // Check for suspended/restricted
          if (body.includes("This account has been suspended") || body.includes("Restricted account")) {
            return "suspended";
          }
          return "ok";
        });

        if (pageStatus !== "ok") {
          console.log(`  @${accountName}: profile ${pageStatus}, skipping.`);
          result.skippedInvalid.push(accountName);
          consecutiveFailures = 0;
          await randomDelay(1000, 2000);
          continue;
        }

        // Check for "Follows you" indicator
        const followsBack = await page.evaluate(() => {
          const texts = document.querySelectorAll("span, div");
          for (const el of texts) {
            if (el.childElementCount === 0 && el.textContent.trim().toLowerCase() === "follows you") {
              return true;
            }
          }
          return false;
        });

        if (followsBack) {
          console.log(`  @${accountName}: follows back, skipping.`);
          result.skippedFollowsBack.push(accountName);
          consecutiveFailures = 0;
          await randomDelay(1000, 2000);
          continue;
        }

        // Find and click the "Following" button on the profile
        const clickedFollowing = await page.evaluate(() => {
          // The "Following" text lives in a <div> inside a <button>, with dynamic class names.
          // Find any element whose trimmed text is exactly "Following", then click its closest <button>.
          const allEls = document.querySelectorAll("button, button *");
          for (const el of allEls) {
            if (el.childElementCount === 0 && el.textContent.trim() === "Following") {
              const btn = el.closest("button") || el;
              btn.click();
              return true;
            }
          }
          return false;
        });

        if (!clickedFollowing) {
          console.log(`  @${accountName}: no "Following" button found, skipping.`);
          result.skippedInvalid.push(accountName);
          consecutiveFailures = 0;
          await randomDelay(1000, 2000);
          continue;
        }

        await randomDelay(1000, 2000);

        // Confirm unfollow in the dialog
        const confirmed = await dismissDialogByText(page, ["unfollow"]);

        if (!confirmed) {
          console.log(`  @${accountName}: unfollow confirmation dialog not found, skipping.`);
          consecutiveFailures++;
          if (consecutiveFailures >= FAILURE_LIMIT) {
            throw new Error(`Reached ${FAILURE_LIMIT} consecutive failures`);
          }
          await randomDelay(1000, 2000);
          continue;
        }

        // Update accounts_processed.json
        entry.following = false;
        entry.dateUnfollowed = new Date().toISOString();
        saveAccountsProcessed(accountsList);

        totalUnfollowed++;
        consecutiveFailures = 0;
        result.unfollowed.push(accountName);
        console.log(`  @${accountName}: unfollowed (${totalUnfollowed}/${unfollowCount})`);

        await randomDelay();
      } catch (err) {
        consecutiveFailures++;
        console.log(`  @${accountName}: error — ${err.message}. (${consecutiveFailures}/${FAILURE_LIMIT})`);

        if (consecutiveFailures >= FAILURE_LIMIT) {
          throw new Error(`Reached ${FAILURE_LIMIT} consecutive failures`);
        }

        try {
          ({ browser, page } = await ensureConnection(browser, page, cookie));
        } catch (reconnErr) {
          console.log(`  Cannot recover connection: ${reconnErr.message}. Stopping.`);
          break;
        }

        await randomDelay(2000, 3000);
      }
    }
  } catch (err) {
    result.success = false;
    result.error = err.message;
  } finally {
    result.totalUnfollowed = totalUnfollowed;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
