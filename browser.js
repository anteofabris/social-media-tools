const puppeteer = require("puppeteer");

const BROWSER_WS = process.env.BROWSERLESS_WS || "ws://browserless:3000";

async function connectBrowser() {
  const browser = await puppeteer.connect({
    browserWSEndpoint: BROWSER_WS,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  return { browser, page };
}

module.exports = { connectBrowser };
