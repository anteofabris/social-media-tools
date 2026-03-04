import puppeteer, { Browser, Page } from "puppeteer";
import path from "path";
import dotenv from "dotenv";
import type { BrowserConnection } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MODE = (process.env.MODE || "prod").toLowerCase();
const BROWSER_WS = process.env.BROWSERLESS_WS || "ws://browserless:3000";

export async function connectBrowser(): Promise<BrowserConnection> {
  let browser: Browser;

  if (MODE === "dev") {
    try {
      browser = await puppeteer.launch({
        headless: false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to launch local browser: ${msg}`);
    }
  } else {
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: BROWSER_WS,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to browserless at ${BROWSER_WS}: ${msg}`);
    }
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  return { browser, page };
}

export async function createPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  return page;
}
