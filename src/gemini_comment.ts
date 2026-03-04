import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import type { Page } from "puppeteer";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const FALLBACKS = [
  "Yeah!",
  "Yummy",
  "why so good",
  "fluffy n round",
  "gosh fuck!",
];

function randomFallback(): string {
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function extractPostData(page: Page): Promise<{ imageBase64: string | null; captionText: string | null }> {
  let imageBase64: string | null = null;
  let captionText: string | null = null;

  try {
    const imgHandle = await page.evaluateHandle(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog || document;
      const images = [...container.querySelectorAll("article img[srcset], article img")] as HTMLImageElement[];
      const big = images.find(
        (img) => img.naturalWidth > 200 || img.width > 200
      );
      return big || null;
    });

    if (imgHandle && imgHandle.asElement()) {
      const imgEl = imgHandle.asElement()!;
      const screenshot = await imgEl.screenshot({ type: "jpeg", quality: 70 });
      imageBase64 = (screenshot as Buffer).toString("base64");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [Gemini] Image extraction failed: ${msg}`);
  }

  try {
    captionText = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog || document;
      const spans = container.querySelectorAll("ul span");
      for (const span of spans) {
        const text = span.textContent!.trim();
        if (text.length > 10) return text;
      }
      const h1 = container.querySelector("h1");
      if (h1) return h1.textContent!.trim();
      return null;
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [Gemini] Caption extraction failed: ${msg}`);
  }

  return { imageBase64, captionText };
}

async function generateComment(imageBase64: string | null, captionText: string | null): Promise<string | null> {
  const prompt =
    "Write a very short, casual Instagram comment (3 to 7 words). Relate it to the image and/or caption. No hashtags. Do not use exclamation points, quotation marks or apostrophes. Keep it friendly, and make it vague yet intriguing. Reply with ONLY the comment.";

  const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];

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

  let comment = response.text!.trim();
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

export async function getAIComment(page: Page): Promise<string> {
  try {
    const { imageBase64, captionText } = await extractPostData(page);

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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [Gemini] Error: ${msg}. Using fallback.`);
    return randomFallback();
  }
}
