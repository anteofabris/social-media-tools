require("dotenv").config({ path: __dirname + "/.env" });
const { GoogleGenAI } = require("@google/genai");

const FALLBACKS = [
  "Yeah!",
  "Yummy",
  "why so good",
  "fluffy n round",
  "gosh fuck!",
];

function randomFallback() {
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function extractPostData(page) {
  let imageBase64 = null;
  let captionText = null;

  try {
    // Find the post image inside the dialog
    const imgHandle = await page.evaluateHandle(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog || document;
      const images = [...container.querySelectorAll("article img[srcset], article img")];
      // Filter to main post image (skip small profile pics)
      const big = images.find(
        (img) => img.naturalWidth > 200 || img.width > 200
      );
      return big || null;
    });

    if (imgHandle && imgHandle.asElement()) {
      const imgEl = imgHandle.asElement();
      const screenshot = await imgEl.screenshot({ type: "jpeg", quality: 70 });
      imageBase64 = screenshot.toString("base64");
    }
  } catch (err) {
    console.log(`  [Gemini] Image extraction failed: ${err.message}`);
  }

  try {
    captionText = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog || document;
      // Caption is usually in a span inside the first ul, or in an h1
      const spans = container.querySelectorAll("ul span");
      for (const span of spans) {
        const text = span.textContent.trim();
        if (text.length > 10) return text;
      }
      const h1 = container.querySelector("h1");
      if (h1) return h1.textContent.trim();
      return null;
    });
  } catch (err) {
    console.log(`  [Gemini] Caption extraction failed: ${err.message}`);
  }

  return { imageBase64, captionText };
}

async function generateComment(imageBase64, captionText) {
  const prompt =
    "Write a very short, casual Instagram comment (2 to 3 words). Relate it to the image and/or caption. No hashtags. Do not use exclamation points, quotation marks or apostrophes. Keep it friendly, and make it vague yet intriguing. Reply with ONLY the comment.";

  const parts = [];

  if (imageBase64) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: imageBase64,
      },
    });
  }

  let textPart = prompt;
  if (captionText) {
    textPart += `\n\nCaption: "${captionText}"`;
  }
  parts.push({ text: textPart });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
  });

  let comment = response.text.trim();
  // Strip wrapping quotes if present
  if (
    (comment.startsWith('"') && comment.endsWith('"')) ||
    (comment.startsWith("'") && comment.endsWith("'"))
  ) {
    comment = comment.slice(1, -1).trim();
  }

  if (!comment || comment.length > 300) {
    return null;
  }

  return comment;
}

async function getAIComment(page) {
  try {
    const { imageBase64, captionText } = await extractPostData(page);

    // If we got nothing to analyze, skip the API call
    if (!imageBase64 && !captionText) {
      console.log("  [Gemini] No image or caption found, using fallback.");
      return randomFallback();
    }

    const comment = await generateComment(imageBase64, captionText);
    if (!comment) {
      console.log("  [Gemini] Empty or too-long response, using fallback.");
      return randomFallback();
    }

    return comment;
  } catch (err) {
    console.log(`  [Gemini] Error: ${err.message}. Using fallback.`);
    return randomFallback();
  }
}

module.exports = { getAIComment };
