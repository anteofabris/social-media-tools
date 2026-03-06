import fs from "fs";
import path from "path";
import { config } from "../config";
import { getEligibleSeeds, type SeedAccount } from "../db/repo";
import { logger } from "../util/logger";

const CATEGORY_FILE_MAP: Record<string, string> = {
  band: "seed_map_bands.csv",
  label: "seed_map_labels.csv",
  venue: "seed_map_venues.csv",
  festival: "seed_map_festivals.csv",
  visual_aesthetic: "seed_map_visual.csv",
};

const COLUMNS = [
  "id",
  "username",
  "followers",
  "category",
  "confidence",
  "sources",
  "last_seen",
] as const;

function escapeCsv(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function seedToCsvRow(seed: SeedAccount): string {
  const sources = seed.sources
    .map((s) => `${s.type}:${s.hashtag}`)
    .join("; ");

  return [
    escapeCsv(seed.id),
    escapeCsv(seed.username),
    seed.followers != null ? String(seed.followers) : "",
    escapeCsv(seed.category),
    seed.confidence.toFixed(2),
    escapeCsv(sources),
    escapeCsv(seed.last_seen),
  ].join(",");
}

export function exportSeedMapsCsv(): void {
  const seeds = getEligibleSeeds(
    config.followerMin,
    config.followerMax,
    config.confidenceMin,
  );

  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }

  const byCategory: Record<string, SeedAccount[]> = {};
  for (const seed of seeds) {
    if (!byCategory[seed.category]) byCategory[seed.category] = [];
    byCategory[seed.category].push(seed);
  }

  const header = COLUMNS.join(",");
  let totalExported = 0;

  for (const [category, filename] of Object.entries(CATEGORY_FILE_MAP)) {
    const items = byCategory[category] || [];
    const rows = [header, ...items.map(seedToCsvRow)];
    const filePath = path.join(config.outputDir, filename);
    fs.writeFileSync(filePath, rows.join("\n") + "\n", "utf-8");
    logger.info(`Exported ${items.length} ${category} accounts -> ${filename}`);
    totalExported += items.length;
  }

  logger.info(
    `Total exported: ${totalExported} accounts across ${Object.keys(CATEGORY_FILE_MAP).length} CSV files`,
  );
}
