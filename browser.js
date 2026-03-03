const puppeteer = require("puppeteer");
require("dotenv").config({ path: __dirname + "/.env" });

const MODE = (process.env.MODE || "prod").toLowerCase();
const BROWSER_WS = process.env.BROWSERLESS_WS || "ws://browserless:3000";

async function connectBrowser() {
  let browser;

  if (MODE === "dev") {
    try {
      browser = await puppeteer.launch({
        headless: false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(`Failed to launch local browser: ${msg}`);
    }
  } else {
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: BROWSER_WS,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
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

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  return page;
}

module.exports = { connectBrowser, createPage };
