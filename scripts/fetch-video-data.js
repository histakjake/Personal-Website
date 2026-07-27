#!/usr/bin/env node
/*
 * Pulls real titles, view counts, and publish dates for every video listed
 * in CONFIG.videos in index.html, using the YouTube Data API v3, and
 * writes them straight back into index.html (role/creator are left alone —
 * those need your judgment, not YouTube's).
 *
 * Setup (one-time, ~2 min):
 *   1. Go to https://console.cloud.google.com/apis/credentials
 *   2. Create a project (or pick an existing one), enable the
 *      "YouTube Data API v3", then create an API key.
 *   3. Run this script with that key:
 *
 *        node scripts/fetch-video-data.js YOUR_API_KEY
 *
 *      or set it as an env var:
 *
 *        YT_API_KEY=YOUR_API_KEY node scripts/fetch-video-data.js
 *
 * Requires Node 18+ (uses the built-in fetch). Re-run any time you add
 * new videos to CONFIG.videos — it only touches title/views/date.
 */

const fs = require("fs");
const path = require("path");

const apiKey = process.argv[2] || process.env.YT_API_KEY;
if (!apiKey) {
  console.error("Missing API key. Usage: node scripts/fetch-video-data.js YOUR_API_KEY");
  process.exit(1);
}

const indexPath = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(indexPath, "utf8");

// Matches one video entry line, e.g.:
// { id: "abc123", title: "", role: "Editor", views: "", date: "", creator: "" },
const entryRe = /\{\s*id:\s*"([^"]+)",\s*title:\s*"([^"]*)",\s*role:\s*"([^"]*)",\s*views:\s*"([^"]*)",\s*date:\s*"([^"]*)",\s*creator:\s*"([^"]*)"\s*\},?/g;

const entries = [...html.matchAll(entryRe)];
if (entries.length === 0) {
  console.error("No video entries found in CONFIG.videos — has the format in index.html changed?");
  process.exit(1);
}
const ids = entries.map(m => m[1]);

function formatViews(n) {
  n = Number(n);
  if (n >= 1e9) return trimZero((n / 1e9).toFixed(1)) + "B";
  if (n >= 1e6) return trimZero((n / 1e6).toFixed(1)) + "M";
  if (n >= 1e3) return trimZero((n / 1e3).toFixed(1)) + "K";
  return String(n);
}
function trimZero(s) { return s.replace(/\.0$/, ""); }
function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

async function fetchBatch(batchIds) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${batchIds.join(",")}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.items || [];
}

(async () => {
  const byId = new Map();
  // videos.list accepts up to 50 ids per call
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const items = await fetchBatch(batch);
    for (const item of items) byId.set(item.id, item);
  }

  let updated = html;
  let changedCount = 0;
  const missing = [];

  for (const match of entries) {
    const [full, id, oldTitle, role, oldViews, oldDate, creator] = match;
    const item = byId.get(id);
    if (!item) { missing.push(id); continue; }

    const title = item.snippet?.title || oldTitle;
    const views = item.statistics?.viewCount ? formatViews(item.statistics.viewCount) : oldViews;
    const date = item.snippet?.publishedAt ? item.snippet.publishedAt.slice(0, 7) : oldDate;

    const newEntry = `{ id: "${id}", title: "${esc(title)}", role: "${esc(role)}", views: "${esc(views)}", date: "${esc(date)}", creator: "${esc(creator)}" },`;
    if (newEntry !== full) changedCount++;
    updated = updated.replace(full, newEntry);
  }

  fs.writeFileSync(indexPath, updated);

  console.log(`Updated ${changedCount} of ${entries.length} video entries in index.html.`);
  if (missing.length) {
    console.log(`Could not find data for ${missing.length} video(s) (private, deleted, or wrong ID): ${missing.join(", ")}`);
  }
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
