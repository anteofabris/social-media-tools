import { GoogleGenAI } from "@google/genai";
import { config } from "../config";
import { logger } from "../util/logger";
import type { Category } from "./heuristics";

let ai: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!ai) {
    if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY not set");
    ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return ai;
}

const VALID_CATEGORIES: Category[] = [
  "band", "label", "venue", "festival", "visual_aesthetic", "other",
];

export async function classifyWithGemini(account: {
  username?: string;
  name?: string | null;
  bio?: string | null;
  website?: string | null;
  business_category?: string | null;
  recentCaptions?: string[];
}): Promise<{ category: Category; confidence: number; reasons: string[] }> {
  try {
    const captionBlock = account.recentCaptions?.length
      ? `\nRecent post captions:\n${account.recentCaptions
          .slice(0, 5)
          .map((c, i) => `${i + 1}. ${c.slice(0, 200)}`)
          .join("\n")}`
      : "";

    const prompt = `You are classifying an Instagram account into one of these categories for a music industry seed map:
- band: musicians, bands, solo artists, producers, DJs
- label: record labels, music distributors, imprints
- venue: music venues, clubs, bars with live music, concert halls
- festival: music festivals, multi-day events
- visual_aesthetic: photographers, designers, visual artists who work with music
- other: none of the above

Account data:
- Username: ${account.username || "unknown"}
- Display name: ${account.name || "unknown"}
- Bio: ${account.bio || "none"}
- Website: ${account.website || "none"}
- Business category: ${account.business_category || "none"}${captionBlock}

Respond with ONLY valid JSON (no markdown, no code fences):
{"category": "...", "confidence": 0.0, "reasons": ["...", "..."]}
The confidence should be 0.0 to 1.0 reflecting how certain you are.`;

    const genAI = getAI();
    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const text = response.text?.trim() || "";
    const jsonStr = text
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(jsonStr);

    if (!VALID_CATEGORIES.includes(parsed.category)) {
      logger.warn(
        `Gemini returned invalid category "${parsed.category}" for @${account.username}`,
      );
      return { category: "other", confidence: 0.1, reasons: ["invalid gemini response"] };
    }

    return {
      category: parsed.category,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    };
  } catch (err) {
    logger.error(
      `Gemini classification failed for @${account.username}:`,
      (err as Error).message,
    );
    return { category: "other", confidence: 0.1, reasons: ["gemini error"] };
  }
}
