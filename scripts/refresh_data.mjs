// Daily data refresh (.github/workflows/data-refresh.yml): fetch all four data files (every
// character's skills from namu.wiki, 1 s between requests), update data/ only when something other
// than meta.fetchedAt changed, and write the release assets (the four files + data-manifest.json)
// to <releaseDir> for the fixed release "data-latest" (electron/update.js downloadLatest).
// Usage: node scripts/refresh_data.mjs <releaseDir>
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAll } from "./fetch_items.mjs";
import { isMain } from "./is_main.mjs";

export const FILES = ["items.json", "characters.json", "skills.json", "items.meta.json"];
export const MANIFEST_NAME = "data-manifest.json";
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const readOrNull = (file) => (existsSync(file) ? readFileSync(file) : null);

/** True when the fresh files in newDir equal those in oldDir apart from items.meta.json's fetchedAt. */
export function sameData(oldDir, newDir) {
  for (const name of FILES.filter((n) => n !== "items.meta.json")) {
    const old = readOrNull(path.join(oldDir, name));
    if (!old || !old.equals(readFileSync(path.join(newDir, name)))) return false;
  }
  const oldMeta = readOrNull(path.join(oldDir, "items.meta.json"));
  if (!oldMeta) return false;
  const strip = (buf) => {
    const { fetchedAt, ...rest } = JSON.parse(buf.toString("utf8"));
    return JSON.stringify(rest);
  };
  return strip(oldMeta) === strip(readFileSync(path.join(newDir, "items.meta.json")));
}

/** data-manifest.json content for the four files in dir (generatedAt = items.meta.json fetchedAt). */
export function buildManifest(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, "items.meta.json"), "utf8"));
  return {
    generatedAt: meta.fetchedAt,
    sha256: Object.fromEntries(FILES.map((n) => [n, sha256(readFileSync(path.join(dir, n)))])),
    dakggVersion: meta.dakggVersion ?? null,
    patch: meta.patch ?? null,
  };
}

/** Copy fresh files from newDir into dataDir unless only fetchedAt changed; then write the release
 * assets of dataDir to releaseDir. Returns {changed, manifest}. */
export function publish(newDir, dataDir, releaseDir) {
  // Never publish an empty or malformed set (a source answering with empty lists would otherwise
  // replace data/ and the release and still pass).
  for (const n of ["items.json", "characters.json", "skills.json"]) {
    const list = JSON.parse(readFileSync(path.join(newDir, n), "utf8"));
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${n} is empty or not a list; keeping data/ and the release`);
  }
  const changed = !sameData(dataDir, newDir);
  if (changed) for (const n of FILES) copyFileSync(path.join(newDir, n), path.join(dataDir, n));
  mkdirSync(releaseDir, { recursive: true });
  for (const n of FILES) copyFileSync(path.join(dataDir, n), path.join(releaseDir, n));
  const manifest = buildManifest(dataDir);
  writeFileSync(path.join(releaseDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { changed, manifest };
}

if (isMain(import.meta.url)) {
  const releaseDir = process.argv[2];
  if (!releaseDir) throw new Error("usage: node scripts/refresh_data.mjs <releaseDir>");
  const work = mkdtempSync(path.join(tmpdir(), "er-refresh-"));
  try {
    const { items, characters, skills, meta } = await fetchAll({ outDir: work, skillsMode: "all" });
    const { changed, manifest } = publish(work, DATA_DIR, releaseDir);
    console.log(`${items.length} items, ${characters.length} characters, ${skills.length} skill entries `
      + `(patch ${meta.patch.version}); data/ ${changed ? "updated" : "unchanged"}; manifest generatedAt ${manifest.generatedAt}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
