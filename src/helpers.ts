import path from "path";
import type { Browser, Page } from "puppeteer";
import type { BrowserConnection } from "./types";
import { connectBrowser, createPage } from "./browser";

export const PROJECT_ROOT = path.resolve(__dirname, "..");

export function randomDelay(min = 2000, max = 5000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function injectCookie(page: Page, cookieValue: string): Promise<void> {
  await page.setCookie({
    name: "sessionid",
    value: String(cookieValue),
    domain: ".instagram.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  });
}

export async function dismissDialogByText(page: Page, buttonTexts: string[]): Promise<boolean> {
  for (const text of buttonTexts) {
    try {
      const el = await page.evaluateHandle((t: string) => {
        const lower = t.toLowerCase();
        // Try <button> elements first
        for (const b of document.querySelectorAll("button")) {
          if (b.textContent!.trim().toLowerCase().includes(lower)) return b;
        }
        // Fall back to any leaf element (Instagram uses <div>/<span> for some actions)
        for (const node of document.querySelectorAll('[role="dialog"] div, [role="dialog"] span')) {
          if (node.childElementCount === 0 && node.textContent!.trim().toLowerCase() === lower) {
            return (node as HTMLElement).closest('[role="button"]') || node;
          }
        }
        return null;
      }, text);
      const element = el.asElement();
      if (element) {
        await (element as import("puppeteer").ElementHandle<Element>).click();
        await randomDelay(1000, 2000);
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export async function ensureConnection(
  browser: Browser,
  page: Page,
  cookieValue: string
): Promise<BrowserConnection> {
  try {
    await page.evaluate(() => true);
    return { browser, page };
  } catch {
    console.log("  Page is dead, attempting recovery...");
  }

  try {
    try { await page.close(); } catch { /* ignore */ }
    const newPage = await createPage(browser);
    await injectCookie(newPage, cookieValue);
    console.log("  Created new page on existing browser.");
    return { browser, page: newPage };
  } catch {
    console.log("  Browser connection lost, reconnecting...");
  }

  try { await browser.close(); } catch { /* ignore */ }
  const conn = await connectBrowser();
  await injectCookie(conn.page, cookieValue);
  console.log("  Reconnected to browser.");
  return conn;
}

export async function getPostOwner(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog || document;
      const article = container.querySelector("article");
      if (!article) return null;
      const links = article.querySelectorAll("header a[href]");
      for (const link of links) {
        const match = link.getAttribute("href")!.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (match) return match[1];
      }
      for (const link of article.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href")!;
        if (href.includes("/p/") || href.includes("/reel/") || href.includes("/explore/") || href.includes("/accounts/")) continue;
        const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (match) return match[1];
      }
      return null;
    });
  } catch {
    return null;
  }
}

export async function scrollToLoadPosts(page: Page, targetCount = 100): Promise<void> {
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

export async function loadExplorePage(
  page: Page,
  id: string,
  urlPrefix: "explore/tags" | "explore/locations"
): Promise<string[]> {
  await page.goto(
    `https://www.instagram.com/${urlPrefix}/${id}/`,
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
    return links.map((a) => new URL((a as HTMLAnchorElement).href).pathname);
  });
}

export async function getLikeCount(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog || document;
      const article = container.querySelector("article");
      if (!article) return null;

      const likedByLink = article.querySelector('a[href*="liked_by"]');
      if (likedByLink) {
        const num = likedByLink.textContent!.replace(/[^0-9]/g, "");
        if (num) return parseInt(num, 10);
      }

      const sections = article.querySelectorAll("section");
      for (const sec of sections) {
        const match = sec.textContent!.match(/([\d,]+)\s+likes?\b/i);
        if (match) return parseInt(match[1].replace(/,/g, ""), 10);
      }

      const othersMatch = article.textContent!.match(/and\s+([\d,]+)\s+others?\b/i);
      if (othersMatch) return parseInt(othersMatch[1].replace(/,/g, ""), 10) + 1;

      return null;
    });
  } catch {
    return null;
  }
}

export async function getFollowerCount(page: Page, username: string): Promise<number | null> {
  try {
    return await page.evaluate(async (user: string) => {
      try {
        const resp = await fetch(`https://www.instagram.com/${user}/`, { credentials: "include" });
        const html = await resp.text();
        const match = html.match(/([\d,]+)\s+Followers/i);
        if (match) return parseInt(match[1].replace(/,/g, ""), 10);
      } catch { /* ignore */ }
      return null;
    }, username);
  } catch {
    return null;
  }
}

export async function postComment(page: Page, text: string): Promise<void> {
  const selectors = [
    'textarea[aria-label="Add a comment\u2026"]',
    'textarea[aria-label="Add a comment..."]',
    'textarea[placeholder="Add a comment\u2026"]',
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
      (b) => b.textContent!.trim().toLowerCase() === "post"
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
