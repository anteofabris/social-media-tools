import fs from "fs";
import path from "path";
import type { AccountEntry } from "./types";

const FILE_PATH = path.resolve(__dirname, "..", "accounts_processed.json");

export function loadAccountsProcessed(): AccountEntry[] {
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function saveAccountsProcessed(list: AccountEntry[]): void {
  fs.writeFileSync(FILE_PATH, JSON.stringify(list, null, 2) + "\n", "utf-8");
}
