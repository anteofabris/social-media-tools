import minimist from "minimist";
import { connectBrowser } from "./browser";
import { loadAccountsProcessed, saveAccountsProcessed } from "./accounts_processed";
import { randomDelay, injectCookie, dismissDialogByText, PROJECT_ROOT } from "./helpers";
import type { AccountEntry, CollectFollowingResult } from "./types";
import dotenv from "dotenv";

dotenv.config({ path: `${PROJECT_ROOT}/.env` });

const argv = minimist(process.argv.slice(2));

const cookie: string = argv.cookie || process.env.IG_SESSION_COOKIE;

if (!cookie) {
  console.error(
    "Usage: node IG_collect_following.js --cookie <sessionid>"
  );
  process.exit(1);
}

(async () => {
  let browser, page;
  const result: CollectFollowingResult = { success: true, action: "collect_following", expectedCount: null, accountsFound: 0, accountsWritten: 0, newAccounts: 0, error: null };

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

    await page.goto(`https://www.instagram.com${profilePath}`, { waitUntil: "networkidle2" });
    await randomDelay(2000, 3000);

    const expectedCount = await page.evaluate((profPath: string) => {
      const link = document.querySelector(`a[href="${profPath}following/"]`);
      if (!link) return null;
      const text = link.textContent!.replace(/,/g, "").trim();
      const match = text.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    }, profilePath);

    if (expectedCount !== null) {
      console.log(`Profile says you are following ${expectedCount} accounts.`);
      result.expectedCount = expectedCount;
    } else {
      console.warn("Warning: Could not read following count from profile page.");
    }

    console.log("Opening following list...");
    const followingLink = await page.$(`a[href="${profilePath}following/"]`);
    if (!followingLink) {
      throw new Error("Could not find the 'following' link on the profile page.");
    }
    await followingLink.click();
    await randomDelay(2000, 3000);

    await page.waitForFunction(
      () => {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
          const buttons = [...d.querySelectorAll("button")];
          if (buttons.some((b) => b.textContent!.trim() === "Following")) return true;
        }
        return false;
      },
      { timeout: 15000 }
    );
    console.log("Following list opened. Collecting usernames...");

    const collectedUsernames = new Set<string>();
    let scrollStallCount = 0;
    const STALL_LIMIT = 8;

    while (scrollStallCount < STALL_LIMIT) {
      const usernames = await page.evaluate(() => {
        const results: string[] = [];
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const dialog of dialogs) {
          const links = dialog.querySelectorAll('a[href*="/"]');
          for (const link of links) {
            const href = link.getAttribute("href");
            const match = href?.match(/^\/([a-zA-Z0-9._]+)\/?$/);
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
        console.log(`  Reached expected following count (${expectedCount}).`);
        break;
      }

      const scrollResult = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const dialog of dialogs) {
          const allDivs = [...dialog.querySelectorAll("div")];
          let bestScrollable: HTMLDivElement | null = null;
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
            const prevTop = (bestScrollable as HTMLDivElement).scrollTop;
            (bestScrollable as HTMLDivElement).scrollTop = (bestScrollable as HTMLDivElement).scrollHeight;
            return {
              scrolled: true,
              prevTop: prevTop,
              newTop: (bestScrollable as HTMLDivElement).scrollTop,
            };
          }
        }
        return { scrolled: false, prevTop: 0, newTop: 0 };
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

    const ownUsername = profilePath.replace(/\//g, "").toLowerCase();
    collectedUsernames.delete(ownUsername);

    console.log(`\nFinished collecting. Found ${collectedUsernames.size} followed accounts.`);
    if (expectedCount !== null && collectedUsernames.size < expectedCount) {
      console.warn(`Warning: Expected ${expectedCount} but only found ${collectedUsernames.size}. Some accounts may have been missed.`);
    }

    const existingList = loadAccountsProcessed();
    const existingMap = new Map<string, AccountEntry>();
    for (const entry of existingList) {
      existingMap.set(entry.accountName.toLowerCase(), entry);
    }

    const now = new Date().toISOString();
    let newCount = 0;

    for (const username of collectedUsernames) {
      if (!existingMap.has(username)) {
        existingList.push({
          accountName: username,
          following: true,
          dateFollowed: now,
          dateUnfollowed: null,
        });
        newCount++;
      }
    }

    saveAccountsProcessed(existingList);

    result.accountsFound = collectedUsernames.size;
    result.accountsWritten = existingList.length;
    result.newAccounts = newCount;

    console.log(
      `Wrote ${existingList.length} entries to accounts_processed.json (${existingList.length - newCount} existing + ${newCount} new)`
    );
  } catch (err: unknown) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    console.log(JSON.stringify(result));
    if (browser) await browser.close();
  }
})();
