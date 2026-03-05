# threeDollarMethod v2

Puppeteer-based Instagram automation scripts. Each script connects to a remote Chromium browser (via [browserless](https://github.com/browserless/chromium)), authenticates via your `sessionid` cookie, and performs a specific action.

## Prerequisites

- Node.js (v18+)
- A running browserless/Chromium container (or any Chromium instance exposing a DevTools WebSocket)
- A valid Instagram `sessionid` cookie (grab it from your browser's dev tools while logged in)

```bash
npm install
```

## Browser connection

Scripts connect to a remote Chromium instance via WebSocket. The endpoint is configured by the `BROWSERLESS_WS` environment variable:

```
BROWSERLESS_WS=ws://browserless:3000
```

| Environment | Value | Notes |
|-------------|-------|-------|
| Docker (default) | `ws://browserless:3000` | Container-to-container via Docker network |
| Local dev | `ws://localhost:3000` | When running browserless locally |

To run browserless locally:
```bash
docker run -p 3000:3000 ghcr.io/browserless/chromium
```

Then run any script:
```bash
BROWSERLESS_WS=ws://localhost:3000 node IG_autolike_hashtags.js --hashtags food --count 5
```

In Docker Compose, the default `ws://browserless:3000` works automatically when the service is named `browserless`.

## Getting your session cookie

1. Log into Instagram in Chrome
2. Open DevTools > Application > Cookies > `https://www.instagram.com`
3. Copy the value of the `sessionid` cookie

You can either pass it via `--cookie` each time, or set it once in a `.env` file:

```
IG_SESSION_COOKIE=your_sessionid_here
```

The `--cookie` flag takes priority if both are provided.

## Scripts

All scripts share these common flags:

| Flag | Description |
|------|-------------|
| `--cookie <sessionid>` | Your Instagram session cookie (falls back to `IG_SESSION_COOKIE` in `.env`) |
| `--count <n>` | Number of actions to perform (default: `50`) |

### Likes

```bash
# Like posts from hashtags
node IG_autolike_hashtags.js --cookie <sessionid> --hashtags tag1,tag2 [--count 50]

# Like posts from locations
node IG_autolike_locations.js --cookie <sessionid> --locations 213385402,12345678 [--count 50]
```

### Comments

Uses Gemini AI (`gemini_comment.js`) to generate contextual comments, with hardcoded fallbacks if the API is unavailable. Requires a `GEMINI_API_KEY` in a `.env` file.

```bash
# Comment on posts from hashtags
node IG_autocomment_hashtags.js --cookie <sessionid> --hashtags tag1,tag2 [--count 50]

# Comment on posts from locations
node IG_autocomment_locations.js --cookie <sessionid> --locations 213385402,12345678 [--count 50]
```

### Follow

```bash
# Follow users from hashtag post feeds
node IG_autofollow_hashtags.js --cookie <sessionid> --hashtags tag1,tag2 [--count 50]

# Follow users from location post feeds
node IG_autofollow_locations.js --cookie <sessionid> --locations 213385402,12345678 [--count 50]
```

### Unfollow

Unfollows accounts from your following list. Supports a **skip list** to protect specific accounts from being unfollowed.

```bash
node IG_autounfollow.js --cookie <sessionid> [--count 50] [--skip user1,user2]
```

The skip list is loaded from two sources (merged, case-insensitive):
1. **`skip_accounts.json`** — a JSON array of usernames in the same directory
2. **`--skip` flag** — comma-separated usernames passed at runtime

### Set current followed accounts

Scrapes your entire following list and writes all usernames into `skip_accounts.json`. Useful for snapshotting who you currently follow before running the unfollow script, so those accounts are protected.

```bash
node IG_set_current_followed_accounts.js --cookie <sessionid>
```

Merges with any existing entries in `skip_accounts.json` (no duplicates).

## Typical workflow

```bash
# 1. Snapshot your current following list into the skip file
node IG_set_current_followed_accounts.js --cookie <sessionid>

# 2. Run engagement scripts (like, comment, follow)
node IG_autolike_hashtags.js --cookie <sessionid> --hashtags food,travel --count 30
node IG_autofollow_hashtags.js --cookie <sessionid> --hashtags food,travel --count 20

# 3. Later, unfollow people who didn't follow back
#    (your original follows from step 1 are protected)
node IG_autounfollow.js --cookie <sessionid> --count 20
```

## Notes

- All scripts connect to a **remote headless** Chromium instance via `browser.js` (shared helper)
- Random delays are built into every action to mimic human behavior
- Scripts will stop after a configurable number of consecutive failures (default: 10)
- Every script outputs a JSON result object as the last line of stdout
- Location IDs can be found in the URL when browsing a location page on Instagram (e.g. `instagram.com/explore/locations/213385402/`)

---

## Seed Map Builder

A CLI tool for building Instagram seed maps for niche music discovery using the **official Instagram Graph API** (no Puppeteer or browser scraping).

Classifies accounts into categories — `band`, `label`, `venue`, `festival`, `visual_aesthetic` — using two-stage classification (keyword heuristics, then Gemini AI fallback). Results are cached in a local SQLite database.

### Environment variables

Add to `.env`:

```
IG_ACCESS_TOKEN=
IG_USER_ID=
GEMINI_API_KEY=
SEEDMAP_DB_PATH=./tools/seed-map-builder/data/seedmap.sqlite
SEEDMAP_FOLLOWER_MIN=500
SEEDMAP_FOLLOWER_MAX=15000
SEEDMAP_CONFIDENCE_MIN=0.7
SEEDMAP_CONCURRENCY=3
SEEDMAP_TOP_MEDIA_PER_TAG=30
SEEDMAP_RECENT_MEDIA_PER_TAG=30
SEEDMAP_GEMINI_CACHE_DAYS=30
```

`IG_ACCESS_TOKEN` and `IG_USER_ID` are required for Graph API calls. Obtain them from the [Meta Developer portal](https://developers.facebook.com/). `GEMINI_API_KEY` is reused from the existing `.env` if already set.

### Setup

```bash
npm install
npm run build:seed-map
```

### Usage

```bash
# Initialize the database
npm run seed-map -- init

# Run with specific hashtags (dry run — no API calls)
npm run seed-map -- run --dryRun --maxHashtags=1

# Run ingestion
npm run seed-map -- run --hashtags=artmusic,psychedelicfunk

# Run with defaults from hashtags.txt
    npm run seed-map -- run --maxHashtags=5 --topN=20 --recentN=20

# Force re-classification (ignore Gemini cache)
npm run seed-map -- run --hashtags=shoegaze --force

# Export seed maps to JSON
npm run seed-map -- export

# View statistics
npm run seed-map -- stats
```

### Output

Exported JSON files are written to `tools/seed-map-builder/output/`:

- `seed_map_bands.json`
- `seed_map_labels.json`
- `seed_map_venues.json`
- `seed_map_festivals.json`
- `seed_map_visual.json`

### Hashtag input

Edit `tools/seed-map-builder/hashtags.txt` (one hashtag per line, `#` for comments) or use `--hashtags=tag1,tag2` at runtime.
