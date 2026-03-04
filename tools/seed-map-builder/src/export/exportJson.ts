import fs from "fs";
import path from "path";
import { config } from "../config";
import { getEligibleSeeds, type SeedAccount } from "../db/repo";
import { logger } from "../util/logger";

const CATEGORY_FILE_MAP: Record<string, string> = {
  band: "seed_map_bands.json",
  label: "seed_map_labels.json",
  venue: "seed_map_venues.json",
  festival: "seed_map_festivals.json",
  visual_aesthetic: "seed_map_visual.json",
};

export function exportSeedMaps(): void {
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

  let totalExported = 0;
  for (const [category, filename] of Object.entries(CATEGORY_FILE_MAP)) {
    const items = byCategory[category] || [];
    const filePath = path.join(config.outputDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2) + "\n", "utf-8");
    logger.info(`Exported ${items.length} ${category} accounts -> ${filename}`);
    totalExported += items.length;
  }

  logger.info(
    `Total exported: ${totalExported} accounts across ${Object.keys(CATEGORY_FILE_MAP).length} files`,
  );
}
