import minimist from "minimist";
import fs from "fs";
import path from "path";
import { connectBrowser } from "./browser";
import { loadAccountsProcessed, saveAccountsProcessed } from "./accounts_processed";
import {
  randomDelay, injectCookie, dismissDialogByText, ensureConnection, PROJECT_ROOT,
} from "./helpers";
import type { AutounfollowResult } from "./types";
import dotenv from "dotenv";

dotenv.config({ path: `${PROJECT_ROOT}/.env` });

const argv = minimist(process.argv.slice(2));

const { count = 50 } = argv;
const cookie: string = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie) {
  console.error(
    "Usage: node IG_autounfollow.js --cookie <sessionid> [--count 50]"
  );
  process.exit(1);
}

const unfollowCount = Number(count);

let accountsList = loadAccountsProcessed();
if (accountsList.length === 0) {
  console.error("Error: accounts_processed.json is missing or empty. Run IG_collect_following.js first.");
  process.exit(1);
}

let skipSet = new Set<string>();
try {
  const raw = fs.readFileSync(path.join(PROJECT_ROOT, "skip_accounts.json"), "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    for (const u of parsed) skipSet.add(String(u).toLowerCase());
  }
} catch (err: unknown) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT") {
    console.warn("Warning: skip_accounts.json not found.");
  } else {
    console.warn(`Warning: Could not parse skip_accounts.json: ${e.message}.`);
  }
}
const skipFileCount = skipSet.size;

try {
  const raw = fs.readFileSync(path.join(PROJECT_ROOT, "followers.json"), "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    for (const u of parsed) skipSet.add(String(u).toLowerCase());
  }
} catch (err: unknown) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT") {
    console.warn("Warning: followers.json not found. Run IG_collect_followers.js to populate it.");
  } else {
    console.warn(`Warning: Could not parse followers.json: ${e.message}.`);
  }
}
const followersCount = skipSet.size - skipFileCount;

console.log(`Loaded ${accountsList.length} accounts from accounts_processed.json, ${skipSet.size} protected accounts (${skipFileCount} skip + ${followersCount} followers).`);

const candidates = accountsList
  .filter((e) => e.following === true && !skipSet.has(e.accountName.toLowerCase()))
  .sort((a, b) => new Date(a.dateFollowed).getTime() - new Date(b.dateFollowed).getTime())
  .slice(0, unfollowCount);

if (candidates.length === 0) {
  console.error("No eligible accounts to unfollow (all are skipped or already unfollowed).");
  process.exit(0);
}

console.log(`Selected ${candidates.length} candidates (oldest followed first).`);

(async () => {
  let browser, page;
  let totalUnfollowed = 0;
  const result: AutounfollowResult = { success: true, action: "autounfollow", requested: unfollowCount, totalUnfollowed: 0, unfollowed: [], skippedFollowsBack: [], skippedInvalid: [], error: null };

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

    let consecutiveFailures = 0;
    const FAILURE_LIMIT = 10;

    for (let i = 0; i < candidates.length && totalUnfollowed < unfollowCount; i++) {
      const entry = candidates[i];
      const accountName = entry.accountName;

      if (skipSet.has(accountName.toLowerCase())) {
        console.log(`\n[${i + 1}/${candidates.length}] @${accountName} is in skip list, skipping.`);
        continue;
      }

      try {
        console.log(`\n[${i + 1}/${candidates.length}] Visiting @${accountName}...`);

        await page.goto(`https://www.instagram.com/${accountName}/`, { waitUntil: "networkidle2" });
        await randomDelay(2000, 3000);

        await dismissDialogByText(page, ["not now", "cancel"]);

        const pageStatus = await page.evaluate(() => {
          const body = document.body.innerText;
          if (body.includes("Sorry, this page isn't available") || body.includes("this page isn't available")) {
            return "not_found";
          }
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

        const followsBack = await page.evaluate(() => {
          const texts = document.querySelectorAll("span, div");
          for (const el of texts) {
            if (el.childElementCount === 0 && el.textContent!.trim().toLowerCase() === "follows you") {
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

        const clickedFollowing = await page.evaluate(() => {
          const allEls = document.querySelectorAll("button, button *");
          for (const el of allEls) {
            if (el.childElementCount === 0 && el.textContent!.trim() === "Following") {
              const btn = (el as HTMLElement).closest("button") || el;
              (btn as HTMLElement).click();
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

        entry.following = false;
        entry.dateUnfollowed = new Date().toISOString();
        saveAccountsProcessed(accountsList);

        totalUnfollowed++;
        consecutiveFailures = 0;
        result.unfollowed.push(accountName);
        console.log(`  @${accountName}: unfollowed (${totalUnfollowed}/${unfollowCount})`);

        await randomDelay();
      } catch (err: unknown) {
        consecutiveFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  @${accountName}: error — ${msg}. (${consecutiveFailures}/${FAILURE_LIMIT})`);

        if (consecutiveFailures >= FAILURE_LIMIT) {
          throw new Error(`Reached ${FAILURE_LIMIT} consecutive failures`);
        }

        try {
          ({ browser, page } = await ensureConnection(browser, page, cookie));
        } catch (reconnErr: unknown) {
          const reconnMsg = reconnErr instanceof Error ? reconnErr.message : String(reconnErr);
          console.log(`  Cannot recover connection: ${reconnMsg}. Stopping.`);
          break;
        }

        await randomDelay(2000, 3000);
      }
    }
  } catch (err: unknown) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.totalUnfollowed = totalUnfollowed;
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
