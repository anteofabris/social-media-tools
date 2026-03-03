const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "accounts_processed.json");

function loadAccountsProcessed() {
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveAccountsProcessed(list) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(list, null, 2) + "\n", "utf-8");
}

module.exports = { loadAccountsProcessed, saveAccountsProcessed };
