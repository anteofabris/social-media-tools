import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { CREATE_TABLES } from "./schema";
import { config } from "../config";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

export function initDb(): void {
  getDb().exec(CREATE_TABLES);
}

// ── accounts ────────────────────────────────────────────────────────────────

export function upsertAccount(account: {
  id: string;
  username: string;
  name?: string | null;
  followers?: number | null;
  bio?: string | null;
  website?: string | null;
  business_category?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO accounts (id, username, name, followers, bio, website, business_category, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         name = COALESCE(excluded.name, accounts.name),
         followers = COALESCE(excluded.followers, accounts.followers),
         bio = COALESCE(excluded.bio, accounts.bio),
         website = COALESCE(excluded.website, accounts.website),
         business_category = COALESCE(excluded.business_category, accounts.business_category),
         last_seen = excluded.last_seen`,
    )
    .run(
      account.id,
      account.username,
      account.name ?? null,
      account.followers ?? null,
      account.bio ?? null,
      account.website ?? null,
      account.business_category ?? null,
      new Date().toISOString(),
    );
}

export function getAccountById(id: string): {
  id: string;
  username: string;
  name: string | null;
  followers: number | null;
  bio: string | null;
  website: string | null;
  business_category: string | null;
} | undefined {
  return getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as ReturnType<typeof getAccountById>;
}

// ── hashtags ────────────────────────────────────────────────────────────────

export function upsertHashtag(name: string, igId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO hashtags (name, ig_id, first_seen, last_used)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         ig_id = excluded.ig_id,
         last_used = excluded.last_used`,
    )
    .run(name, igId, now, now);
}

export function getAllHashtags(): Array<{
  name: string;
  ig_id: string;
  first_seen: string;
  last_used: string;
}> {
  return getDb()
    .prepare("SELECT name, ig_id, first_seen, last_used FROM hashtags ORDER BY name")
    .all() as Array<{ name: string; ig_id: string; first_seen: string; last_used: string }>;
}

// ── sources ─────────────────────────────────────────────────────────────────

export function addSource(accountId: string, sourceType: string, hashtag: string): void {
  getDb()
    .prepare(
      `INSERT INTO sources (account_id, source_type, hashtag, collected_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(accountId, sourceType, hashtag, new Date().toISOString());
}

// ── classifications ─────────────────────────────────────────────────────────

export function upsertClassification(
  accountId: string,
  category: string,
  confidence: number,
  evidenceJson: string,
  model: string,
): void {
  const d = getDb();
  d.prepare(`DELETE FROM classifications WHERE account_id = ? AND model = ?`).run(
    accountId,
    model,
  );
  d.prepare(
    `INSERT INTO classifications (account_id, category, confidence, evidence_json, model, classified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(accountId, category, confidence, evidenceJson, model, new Date().toISOString());
}

export function hasRecentGeminiClassification(
  accountId: string,
  cacheDays: number,
): boolean {
  const cutoff = new Date(Date.now() - cacheDays * 86_400_000).toISOString();
  const row = getDb()
    .prepare(
      `SELECT 1 FROM classifications
       WHERE account_id = ? AND model = 'gemini' AND classified_at > ?
       LIMIT 1`,
    )
    .get(accountId, cutoff);
  return !!row;
}

// ── runs ────────────────────────────────────────────────────────────────────

export function createRun(runId: string): void {
  getDb()
    .prepare(`INSERT INTO runs (run_id, started_at) VALUES (?, ?)`)
    .run(runId, new Date().toISOString());
}

export function finishRun(runId: string, statsJson: string): void {
  getDb()
    .prepare(`UPDATE runs SET finished_at = ?, stats_json = ? WHERE run_id = ?`)
    .run(new Date().toISOString(), statsJson, runId);
}

// ── queries ─────────────────────────────────────────────────────────────────

export interface SeedAccount {
  id: string;
  username: string;
  followers: number | null;
  category: string;
  confidence: number;
  evidence: Record<string, unknown>;
  sources: Array<{ type: string; hashtag: string; collected_at: string }>;
  last_seen: string;
}

export function getEligibleSeeds(
  followerMin: number,
  followerMax: number,
  confidenceMin: number,
): SeedAccount[] {
  const d = getDb();

  const rows = d
    .prepare(
      `SELECT a.id, a.username, a.followers, a.last_seen,
              c.category, c.confidence, c.evidence_json
       FROM accounts a
       JOIN classifications c ON c.account_id = a.id
       WHERE c.category != 'other'
         AND c.confidence >= ?
         AND a.followers IS NOT NULL
         AND a.followers >= ? AND a.followers <= ?
         AND c.classified_at = (
           SELECT MAX(c2.classified_at) FROM classifications c2 WHERE c2.account_id = a.id
         )
       ORDER BY c.confidence DESC`,
    )
    .all(confidenceMin, followerMin, followerMax) as Array<{
    id: string;
    username: string;
    followers: number | null;
    last_seen: string;
    category: string;
    confidence: number;
    evidence_json: string;
  }>;

  return rows.map((row) => {
    const sources = d
      .prepare(
        `SELECT source_type AS type, hashtag, collected_at
         FROM sources WHERE account_id = ?`,
      )
      .all(row.id) as Array<{ type: string; hashtag: string; collected_at: string }>;

    return {
      id: row.id,
      username: row.username,
      followers: row.followers,
      category: row.category,
      confidence: row.confidence,
      evidence: JSON.parse(row.evidence_json || "{}"),
      sources,
      last_seen: row.last_seen,
    };
  });
}

export function getStats(): {
  totalAccounts: number;
  categoryCounts: Record<string, number>;
  confidenceDistribution: { low: number; medium: number; high: number };
  lastRun: {
    run_id: string;
    started_at: string;
    finished_at: string | null;
    stats_json: string | null;
  } | null;
} {
  const d = getDb();

  const totalAccounts = (
    d.prepare("SELECT COUNT(*) AS cnt FROM accounts").get() as { cnt: number }
  ).cnt;

  const catRows = d
    .prepare(
      `SELECT c.category, COUNT(DISTINCT c.account_id) AS cnt
       FROM classifications c
       WHERE c.classified_at = (
         SELECT MAX(c2.classified_at) FROM classifications c2 WHERE c2.account_id = c.account_id
       )
       GROUP BY c.category`,
    )
    .all() as Array<{ category: string; cnt: number }>;

  const categoryCounts: Record<string, number> = {};
  for (const row of catRows) categoryCounts[row.category] = row.cnt;

  const confRows = d
    .prepare(
      `SELECT c.confidence
       FROM classifications c
       WHERE c.classified_at = (
         SELECT MAX(c2.classified_at) FROM classifications c2 WHERE c2.account_id = c.account_id
       )`,
    )
    .all() as Array<{ confidence: number }>;

  const confidenceDistribution = { low: 0, medium: 0, high: 0 };
  for (const row of confRows) {
    if (row.confidence < 0.5) confidenceDistribution.low++;
    else if (row.confidence < 0.8) confidenceDistribution.medium++;
    else confidenceDistribution.high++;
  }

  const lastRun =
    (d.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get() as {
      run_id: string;
      started_at: string;
      finished_at: string | null;
      stats_json: string | null;
    }) || null;

  return { totalAccounts, categoryCounts, confidenceDistribution, lastRun };
}
