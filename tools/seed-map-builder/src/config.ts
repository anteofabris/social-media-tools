import path from "path";
import dotenv from "dotenv";

const TOOL_ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
}

export const config = {
  igAccessToken: process.env.IG_ACCESS_TOKEN || "",
  igUserId: process.env.IG_USER_ID || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",

  dbPath: path.resolve(
    process.env.SEEDMAP_DB_PATH || path.join(TOOL_ROOT, "data", "seedmap.sqlite"),
  ),

  followerMin: envInt("SEEDMAP_FOLLOWER_MIN", 500),
  followerMax: envInt("SEEDMAP_FOLLOWER_MAX", 15_000),
  confidenceMin: envFloat("SEEDMAP_CONFIDENCE_MIN", 0.7),
  concurrency: envInt("SEEDMAP_CONCURRENCY", 3),
  topMediaPerTag: envInt("SEEDMAP_TOP_MEDIA_PER_TAG", 30),
  recentMediaPerTag: envInt("SEEDMAP_RECENT_MEDIA_PER_TAG", 30),
  geminiCacheDays: envInt("SEEDMAP_GEMINI_CACHE_DAYS", 30),

  hashtagsFile: path.join(TOOL_ROOT, "hashtags.txt"),
  outputDir: path.join(TOOL_ROOT, "output"),
};
