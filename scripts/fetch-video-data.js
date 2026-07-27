#!/usr/bin/env node
/*
 * Pulls real titles, view counts, publish dates, and thumbnail orientation
 * from YouTube and writes them into CONFIG.videos in index.html. Two things
 * it can do:
 *
 *   1. Refresh every video already listed in CONFIG.videos (title/views/date/
 *      orientation only — role/creator are left alone, those need your
 *      judgment). Orientation (vertical/horizontal) is auto-detected from
 *      the real thumbnail dimensions, so vertical Shorts and horizontal
 *      long-form videos both display with the correct aspect ratio.
 *   2. Optionally pull in NEW videos straight from a channel (e.g. your own
 *      long-form uploads) with --channel, skipping anything under 60s
 *      (Shorts) and anything already in the list.
 *
 * ---- ONE-TIME SETUP (~2 min) ----
 *   1. Go to https://console.cloud.google.com/apis/credentials
 *   2. Create a project (or pick an existing one), enable the
 *      "YouTube Data API v3", then create an API key.
 *   3. Save it so you don't have to paste it in your terminal every time:
 *      create a file named `.env` in the repo root (same folder as this
 *      script's parent) containing one line:
 *
 *          YT_API_KEY=your_key_here
 *
 *      `.env` is git-ignored, so it never gets committed or pushed.
 *
 * ---- USAGE ----
 *   Refresh existing videos:
 *     node scripts/fetch-video-data.js
 *
 *   Also pull in your long-form uploads from a channel:
 *     node scripts/fetch-video-data.js --channel=@JakeRetich
 *     node scripts/fetch-video-data.js --channel=@JakeRetich --max=15 --creator="My Channel" --role=Creator
 *
 *   No .env file? Pass the key directly (works, just avoid pasting it
 *   anywhere it'll get logged/shared):
 *     node scripts/fetch-video-data.js --key=YOUR_API_KEY
 *
 * Requires Node 18+ (uses the built-in fetch). Safe to re-run any time.
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const indexPath = path.join(repoRoot, "index.html");

// ---- tiny .env loader (no dependency) ----
(function loadDotEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// ---- args ----
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
  const m = a.match(/^--([\w-]+)=(.*)$/);
  if (m) flags[m[1]] = m[2];
  else positional.push(a);
}

const apiKey = flags.key || positional[0] || process.env.YT_API_KEY;
if (!apiKey) {
  console.error(
    "Missing API key. Either create a .env file with YT_API_KEY=... (see comment at the top of this script), " +
    "or run with --key=YOUR_API_KEY."
  );
  process.exit(1);
}

const channelHandle = flags.channel || "";
const maxNew = Number(flags.max || 25);
const newCreator = flags.creator || "My Channel";
const newRole = flags.role || "Creator";

const html = fs.readFileSync(indexPath, "utf8");

// Matches one video entry line, e.g.:
// { id: "abc123", title: "", role: "Editor", views: "", date: "", creator: "", orientation: "vertical" },
const entryLineRe = /^([ \t]*)\{\s*id:\s*"([^"]+)",\s*title:\s*"([^"]*)",\s*role:\s*"([^"]*)",\s*views:\s*"([^"]*)",\s*date:\s*"([^"]*)",\s*creator:\s*"([^"]*)",\s*orientation:\s*"([^"]*)"\s*\},?[ \t]*$/gm;

function formatViews(n) {
  n = Number(n);
  if (n >= 1e9) return trimZero((n / 1e9).toFixed(1)) + "B";
  if (n >= 1e6) return trimZero((n / 1e6).toFixed(1)) + "M";
  if (n >= 1e3) return trimZero((n / 1e3).toFixed(1)) + "K";
  return String(n);
}
function trimZero(s) { return s.replace(/\.0$/, ""); }
function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function parseISODuration(iso) {
  const m = String(iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}
function detectOrientation(item, fallback) {
  const t = item.snippet?.thumbnails || {};
  const pick = t.maxres || t.standard || t.high || t.medium || t.default;
  if (!pick || !pick.width || !pick.height) return fallback;
  return pick.height > pick.width ? "vertical" : "horizontal";
}

async function apiGet(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error ${res.status} on ${endpoint}: ${body}`);
  }
  return res.json();
}

async function fetchVideosByIds(ids) {
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await apiGet("videos", { part: "snippet,statistics,contentDetails", id: batch.join(",") });
    for (const item of data.items || []) byId.set(item.id, item);
  }
  return byId;
}

async function resolveUploadsPlaylist(handle) {
  const clean = handle.replace(/^@/, "");
  const data = await apiGet("channels", { part: "contentDetails", forHandle: clean });
  const item = data.items && data.items[0];
  if (!item) throw new Error(`No channel found for handle "${handle}"`);
  return item.contentDetails.relatedPlaylists.uploads;
}

async function fetchPlaylistVideoIds(playlistId, max) {
  const ids = [];
  let pageToken = "";
  while (ids.length < max) {
    const data = await apiGet("playlistItems", {
      part: "contentDetails",
      maxResults: 50,
      playlistId,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of data.items || []) ids.push(item.contentDetails.videoId);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return ids.slice(0, max);
}

(async () => {
  const entries = [...html.matchAll(entryLineRe)];
  if (entries.length === 0) {
    console.error("No video entries found in CONFIG.videos — has the format in index.html changed?");
    process.exit(1);
  }
  const existingIds = new Set(entries.map(m => m[2]));

  // ---- 1. refresh existing entries ----
  const byId = await fetchVideosByIds([...existingIds]);
  let updated = html;
  let changedCount = 0;
  const missing = [];

  for (const match of entries) {
    const [full, indent, id, oldTitle, role, oldViews, oldDate, creator, oldOrientation] = match;
    const item = byId.get(id);
    if (!item) { missing.push(id); continue; }

    const title = item.snippet?.title || oldTitle;
    const views = item.statistics?.viewCount ? formatViews(item.statistics.viewCount) : oldViews;
    const date = item.snippet?.publishedAt ? item.snippet.publishedAt.slice(0, 7) : oldDate;
    const orientation = detectOrientation(item, oldOrientation || "vertical");

    const newLine = `${indent}{ id: "${id}", title: "${esc(title)}", role: "${esc(role)}", views: "${esc(views)}", date: "${esc(date)}", creator: "${esc(creator)}", orientation: "${esc(orientation)}" },`;
    if (newLine !== full) changedCount++;
    updated = updated.replace(full, newLine);
  }

  console.log(`Updated ${changedCount} of ${entries.length} existing video entries.`);
  if (missing.length) {
    console.log(`Could not find data for ${missing.length} video(s) (private, deleted, or wrong ID): ${missing.join(", ")}`);
  }

  // ---- 2. optionally pull in new videos from a channel ----
  if (channelHandle) {
    console.log(`Looking up channel ${channelHandle}...`);
    const uploadsPlaylist = await resolveUploadsPlaylist(channelHandle);
    const candidateIds = await fetchPlaylistVideoIds(uploadsPlaylist, maxNew + existingIds.size);
    const freshIds = candidateIds.filter(id => !existingIds.has(id)).slice(0, maxNew);
    const freshById = await fetchVideosByIds(freshIds);

    const newEntries = [];
    let skippedShorts = 0;
    for (const id of freshIds) {
      const item = freshById.get(id);
      if (!item) continue;
      const seconds = parseISODuration(item.contentDetails?.duration);
      if (seconds > 0 && seconds <= 60) { skippedShorts++; continue; }
      newEntries.push({
        id,
        title: item.snippet?.title || "",
        views: item.statistics?.viewCount ? formatViews(item.statistics.viewCount) : "",
        date: item.snippet?.publishedAt ? item.snippet.publishedAt.slice(0, 7) : "",
        orientation: detectOrientation(item, "horizontal"),
      });
    }

    if (newEntries.length) {
      const freshEntries = [...updated.matchAll(entryLineRe)];
      const last = freshEntries[freshEntries.length - 1];
      const indent = last[1];
      const insertPos = last.index + last[0].length;
      const lines = newEntries
        .map(v => `\n${indent}{ id: "${v.id}", title: "${esc(v.title)}", role: "${esc(newRole)}", views: "${esc(v.views)}", date: "${esc(v.date)}", creator: "${esc(newCreator)}", orientation: "${esc(v.orientation)}" },`)
        .join("");
      updated = updated.slice(0, insertPos) + lines + updated.slice(insertPos);
    }

    console.log(`Added ${newEntries.length} new video(s) from ${channelHandle} (creator: "${newCreator}", role: "${newRole}").`);
    if (skippedShorts) console.log(`Skipped ${skippedShorts} video(s) under 60s (Shorts).`);
  }

  fs.writeFileSync(indexPath, updated);
  console.log("index.html updated.");
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
