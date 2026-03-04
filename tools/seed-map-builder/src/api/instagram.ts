import { config } from "../config";
import { withBackoff, ApiError } from "../util/backoff";
import { logger } from "../util/logger";

const API_BASE = "https://graph.facebook.com/v21.0";

async function graphGet<T>(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${API_BASE}${endpoint}`);
  url.searchParams.set("access_token", config.igAccessToken);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  // Facebook Graph API needs un-encoded parentheses in the fields parameter
  let urlStr = url.toString();
  urlStr = urlStr.replace(/%28/g, "(").replace(/%29/g, ")").replace(/%40/g, "@");

  return withBackoff(
    async () => {
      const res = await fetch(urlStr);
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Graph API ${res.status}: ${body}`) as ApiError;
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    },
    { label: `GET ${endpoint}` },
  );
}

// ── hashtag search ──────────────────────────────────────────────────────────

export async function searchHashtag(name: string): Promise<string | null> {
  try {
    const data = await graphGet<{ data: Array<{ id: string }> }>(
      "/ig_hashtag_search",
      { q: name, user_id: config.igUserId },
    );
    return data.data?.[0]?.id ?? null;
  } catch (err) {
    logger.error(`Hashtag search failed for "${name}":`, (err as Error).message);
    return null;
  }
}

// ── media ───────────────────────────────────────────────────────────────────

export interface MediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  username?: string;
}

const MEDIA_FIELDS =
  "id,caption,media_type,permalink,timestamp,like_count,comments_count,username";

export async function getTopMedia(
  hashtagId: string,
  limit: number,
): Promise<MediaItem[]> {
  try {
    const data = await graphGet<{ data: MediaItem[] }>(
      `/${hashtagId}/top_media`,
      { user_id: config.igUserId, fields: MEDIA_FIELDS, limit: String(limit) },
    );
    return data.data || [];
  } catch (err) {
    logger.error(
      `Top media fetch failed for hashtag ${hashtagId}:`,
      (err as Error).message,
    );
    return [];
  }
}

export async function getRecentMedia(
  hashtagId: string,
  limit: number,
): Promise<MediaItem[]> {
  try {
    const data = await graphGet<{ data: MediaItem[] }>(
      `/${hashtagId}/recent_media`,
      { user_id: config.igUserId, fields: MEDIA_FIELDS, limit: String(limit) },
    );
    return data.data || [];
  } catch (err) {
    logger.error(
      `Recent media fetch failed for hashtag ${hashtagId}:`,
      (err as Error).message,
    );
    return [];
  }
}

// ── business discovery ──────────────────────────────────────────────────────

export interface AccountInfo {
  ig_id?: string;
  username: string;
  name?: string;
  biography?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  website?: string;
}

const BD_FIELDS = [
  "ig_id",
  "username",
  "name",
  "biography",
  "followers_count",
  "follows_count",
  "media_count",
  "website",
].join(",");

export async function getAccountInfo(
  username: string,
): Promise<AccountInfo | null> {
  try {
    const fieldsValue = `business_discovery.fields(${BD_FIELDS}).username(${username})`;
    const data = await graphGet<{ business_discovery?: AccountInfo }>(
      `/${config.igUserId}`,
      { fields: fieldsValue },
    );
    return data.business_discovery ?? null;
  } catch (err) {
    logger.debug(
      `Business discovery failed for @${username}: ${(err as Error).message}`,
    );
    return null;
  }
}
