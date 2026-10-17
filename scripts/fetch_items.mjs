// Node port of scripts/fetch_items.py (no dependencies; Node 22 built-in fetch).
// Fetches Eternal Return equipment from the dak.gg API and builds the same
// item list as the Python script; values that differ from the latest patch note
// are replaced by the patch-note value (host decision).
// Usage: node scripts/fetch_items.mjs [--all]  (writes items.json, characters.json, skills.json,
// items.meta.json; only the patch note's characters are re-read from namu.wiki unless --all)
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  fetchPatch, parsePatch, applyItemChanges, applyCharacterChanges, requestSignal, describeError,
} from "./fetch_patchnote.mjs";
import { buildCharacters, CHARACTERS_URL, dumps as dumpsCharacters } from "./fetch_characters.mjs";
import {
  buildSkills, applySkillChanges, fetchPages, planPages, REQUEST_INTERVAL_MS, dumps as dumpsSkills,
} from "./fetch_skills.mjs";

export const ITEMS_URL = "https://er.dakgg.io/api/v1/data/items?hl=ko";
export const MASTERIES_URL = "https://er.dakgg.io/api/v1/data/masteries?hl=ko";
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const OUT_PATH = path.join(DATA_DIR, "items.json");

// dak.gg grade enum -> schema grade (dak.gg labels Mythic "초월"; schema uses "신화").
const GRADES = {
  Common: "일반", Uncommon: "고급", Rare: "희귀", Epic: "영웅", Legend: "전설", Mythic: "신화",
};
// Shared with scripts/fetch_items.py: edit these JSON files, not the code.
const PRICE_TABLE = JSON.parse(readFileSync(path.join(DATA_DIR, "price_table.json"), "utf8"));
const GRADE_PRICE = PRICE_TABLE.gradePrice;
const GRADE_PRICE_SOURCE = PRICE_TABLE.gradePriceSource;
// A group's priceSource overrides the table-wide itemPriceSource.
const ITEM_PRICE = new Map(PRICE_TABLE.itemPriceGroups.flatMap((g) => g.names.map(
  (n) => [n, { price: g.price, source: g.priceSource ?? PRICE_TABLE.itemPriceSource }],
)));
const EXCLUDED_NAMES = new Set(
  JSON.parse(readFileSync(path.join(DATA_DIR, "exclusions.json"), "utf8")).headNames,
);
const PAGE_GRADES = new Set(["Epic", "Legend", "Mythic"]);
const ARMOR_SLOTS = { Head: "머리", Chest: "옷", Arm: "팔", Leg: "다리" };

const UNIQUE_PREFIX = "(고유) ";
// "<color=..>(고유)</color> 이름 +a", "레벨 당 이름 +a~b%" (a per level, b at max level)
const STAT_RE = /^(<color=[^>]*>\(고유\)<\/color> )?([^+<>]+?) \+(\d+(?:\.\d+)?)(?:~\d+(?:\.\d+)?)?(%)?$/;
const CHOICE_SEP = " 또는 ";
const CHOICE_SUFFIX = "(택1)";
const PCT_SUFFIX = "율";

async function fetchJson(url, signal) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://dak.gg/", Accept: "application/json" },
    signal: requestSignal(signal),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

// Explicit whitespace set: JS trim() and Python str.strip() disagree on exotic characters.
const strip = (s) => s.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");

function field(item, key) {
  if (!Object.hasOwn(item, key)) throw new Error(`item ${item.id} has no ${key}`);
  return item[key];
}

/** [[name, value, isPercent]] for one tooltip stat line, or null. */
export function parseStatLine(line) {
  const parts = line.split(CHOICE_SEP);
  const parsed = [];
  for (const part of parts) {
    const m = STAT_RE.exec(part);
    if (!m) return null;
    let name = strip(m[2]);
    if (m[1]) name = UNIQUE_PREFIX + name;
    if (parts.length > 1) name += CHOICE_SUFFIX;
    const pct = m[4] !== undefined;
    // Percent: parse the decimal text shifted by 100 (correctly rounded, same in Python).
    const value = Number(m[3] + (pct ? "e-2" : ""));
    parsed.push([name, value, pct]);
  }
  return parsed;
}

/** Raw stats from the tooltip's second block: [[name, value, isPercent]]. */
export function parseStats(tooltip) {
  const blocks = tooltip.split("\n\n");
  if (blocks.length < 2) return [];
  const lines = blocks[1].split("\n").map(strip).filter(Boolean);
  const parsed = lines.map(parseStatLine);
  if (parsed.every((p) => p === null)) return [];
  const bad = lines.filter((_, i) => parsed[i] === null);
  if (bad.length) throw new Error(`unparsed stat lines: ${JSON.stringify(bad)}`);
  return parsed.flat();
}

/** Same filter the dak.gg items page applies (type Armor/Weapon, Epic+ grade, has makeMaterials). */
export function listedOnPage(item) {
  const type = field(item, "type");
  return (type === "Armor" || type === "Weapon")
    && PAGE_GRADES.has(field(item, "grade"))
    && Array.isArray(item.makeMaterials) && item.makeMaterials.length > 0;
}

function slotOf(item) {
  if (!listedOnPage(item)) return null;
  if (item.armorType === "Head" && EXCLUDED_NAMES.has(field(item, "name"))) return null;
  if (item.type === "Weapon") return "무기";
  return Object.hasOwn(ARMOR_SLOTS, item.armorType) ? ARMOR_SLOTS[item.armorType] : null;
}

function required(map, key, what) {
  if (!Object.hasOwn(map, key)) throw new Error(`unknown ${what}: ${key}`);
  return map[key];
}

/** [flat names, percent names] of the listed equipment's tooltip stats. */
export function statKinds(rawItems) {
  const flat = new Set();
  const pct = new Set();
  for (const it of rawItems) {
    if (!slotOf(it)) continue;
    for (const [name, , isPct] of parseStats(field(it, "tooltip"))) (isPct ? pct : flat).add(name);
  }
  return [flat, pct];
}

export function buildItems(rawItems, masteries) {
  const weaponNames = Object.fromEntries(masteries.map((m) => [m.key, m.name]));
  const equip = rawItems.map((it) => [it, slotOf(it)]).filter(([, slot]) => slot);
  const rawStats = new Map(equip.map(([it]) => [it.id, parseStats(field(it, "tooltip"))]));
  const flatNames = statKinds(rawItems)[0];

  const intId = (it) => {
    const n = Number(field(it, "id"));
    if (!Number.isInteger(n)) throw new Error(`non-integer item id ${it.id}`);
    return n;
  };
  equip.sort((a, b) => intId(a[0]) - intId(b[0]));
  return equip.map(([it, slot]) => {
    const stats = Object.create(null); // "__proto__" stays an ordinary key
    for (const [name, value, pct] of rawStats.get(it.id)) {
      // One dak.gg name for flat and % variants: % gets "율" only when both exist.
      const key = pct && flatNames.has(name) ? name + PCT_SUFFIX : name;
      if (Object.hasOwn(stats, key)) throw new Error(`duplicate stat ${key} in item ${it.id}`);
      stats[key] = value;
    }
    const grade = required(GRADES, it.grade, "grade");
    const hostPrice = ITEM_PRICE.get(it.name);
    const row = {
      id: String(it.id),
      name: field(it, "name"),
      grade,
      slot,
      imageUrl: field(it, "imageUrl"),
      price: hostPrice === undefined ? required(GRADE_PRICE, grade, "grade price") : hostPrice.price,
      priceSource: hostPrice === undefined ? required(GRADE_PRICE_SOURCE, grade, "grade price source") : hostPrice.source,
      stats,
    };
    if (slot === "무기") row.weaponType = required(weaponNames, it.weaponType, "weaponType");
    return row;
  });
}

/** Serialized form of data/items.json (byte-identical to fetch_items.py). */
export function dumps(items) {
  return JSON.stringify(items, null, 2) + "\n";
}

/** Apply the patch note to built items; returns [parsed, overrides, unparsed]. */
function patchItems(items, rawItems, patch) {
  const [flat, pct] = statKinds(rawItems);
  const parsed = parsePatch(patch.bodies, [...flat, ...pct]);
  const [overrides, unparsed] = applyItemChanges(items, parsed.changes, flat, pct);
  return [parsed, overrides, unparsed];
}

/** Items from dak.gg with patch-note overrides applied (data/items.json content). */
export async function fetchItems() {
  const [items, masteries, patch] = await Promise.all([
    fetchJson(ITEMS_URL), fetchJson(MASTERIES_URL), fetchPatch(),
  ]);
  const out = buildItems(items.items, masteries.masteries);
  patchItems(out, items.items, patch);
  return out;
}

const ASSET_VERSION_RE = /\/game-assets\/([0-9]+(?:\.[0-9]+)*)\//;

/** Highest game-asset version in the item image paths, or null. */
export function dakggVersion(rawItems) {
  const found = new Set();
  for (const it of rawItems) {
    const m = ASSET_VERSION_RE.exec(it.imageUrl || "");
    if (m) found.add(m[1]);
  }
  const cmp = (a, b) => {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };
  let best = null;
  for (const v of found) if (best === null || cmp(v, best) > 0) best = v;
  return best;
}

/** {items, characters, skills, meta} with patch-note overrides applied (see fetch_items.py build_all).
 * pages: Map character name -> namu.wiki HTML or null (fetch_skills.mjs fetchPages); previous:
 * Map name -> skills.json entry kept for characters not in pages (skills mode "patched"). */
export function buildAll(rawItems, masteries, rawChars, patch, pages, fetchedAt, previous = null) {
  const items = buildItems(rawItems, masteries);
  const characters = buildCharacters(rawChars, masteries);
  const [parsed, itemOverrides, itemUnparsed] = patchItems(items, rawItems, patch);
  const [charOverrides, charUnparsed] = applyCharacterChanges(characters, parsed.changes);
  const { id, version, title, url, date, articles } = patch.info;
  const skills = buildSkills(characters, pages, previous);
  const [skillOverrides, skillSkipped, skillUnparsed] = applySkillChanges(skills, parsed.changes, articles);
  const meta = {
    fetchedAt,
    dakggVersion: dakggVersion(rawItems),
    patch: { id, version, title, url, date, articles },
    overrides: [...itemOverrides, ...charOverrides, ...skillOverrides],
    skipped: skillSkipped,
    unparsed: [...parsed.unparsed, ...itemUnparsed, ...charUnparsed, ...skillUnparsed],
    skillsFetched: { mode: previous === null ? "all" : "patched", characters: [...pages.keys()], count: pages.size },
  };
  return { items, characters, skills, meta };
}

/** Map name -> entry from outDir/skills.json, else this repo's data/skills.json, else null. */
export function previousSkills(outDir) {
  for (const file of [path.join(outDir, "skills.json"), path.join(DATA_DIR, "skills.json")]) {
    if (existsSync(file)) return new Map(JSON.parse(readFileSync(file, "utf8")).map((e) => [e.name, e]));
  }
  return null;
}

/**
 * Fetch dak.gg + the latest patch note + namu.wiki skill pages and write items.json,
 * characters.json, skills.json and items.meta.json to outDir (default: this repo's
 * data/; an app should pass a writable directory). Returns {items, characters, skills, meta}.
 * intervalMs: pause between namu.wiki request starts (default 1000).
 * skillsMode "patched" (default): re-read only the characters the latest patch note (+ hotfixes)
 * mentions and keep the others from the existing skills.json (outDir's, else this repo's); falls
 * back to "all" without one or without any character in the patch note. "all": every character.
 * meta.skillsFetched = {mode, characters, count} of the documents actually read.
 * onProgress({stage: "items"|"characters"|"patchnotes"|"skills", done, total, message}) at each stage
 * (stage names as src/updater.js progressText reads them; "characters" falls back to message)
 * start/end and after each namu.wiki document. A failure names its stage ("<stage> 단계 실패: <reason>")
 * and aborts the other downloads; signal (AbortSignal) stops all requests and keeps outDir untouched.
 */
export async function fetchAll({
  outDir = DATA_DIR, fetchedAt, intervalMs = REQUEST_INTERVAL_MS, onProgress, signal, skillsMode = "patched",
} = {}) {
  const progress = (stage, done, total, message) => {
    if (onProgress) onProgress({ stage, done, total, message });
  };
  const stop = new AbortController();
  const stopped = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const failure = (label, err) => new Error(`${label} 단계 실패: ${describeError(err)}`, { cause: err });
  // Download stage: progress at start/end; the first failure is named and cancels the sibling stages.
  const step = async (stage, label, run, total = 1) => {
    progress(stage, 0, total, `${label} 중`);
    try {
      const value = await run();
      progress(stage, total, total, `${label} 완료`);
      return value;
    } catch (err) {
      if (stopped.aborted) throw err;
      const named = failure(label, err);
      stop.abort(named);
      throw named;
    }
  };
  // Local stage (no requests): only failures are named.
  const local = (label, run) => {
    stopped.throwIfAborted();
    try {
      return run();
    } catch (err) {
      throw failure(label, err);
    }
  };
  const [[items, masteries], chars, patch] = await Promise.all([
    step("items", "아이템 수집(dak.gg)",
      () => Promise.all([fetchJson(ITEMS_URL, stopped), fetchJson(MASTERIES_URL, stopped)])),
    step("characters", "실험체 수집(dak.gg)", () => fetchJson(CHARACTERS_URL, stopped)),
    step("patchnotes", "패치노트 확인", () => fetchPatch(stopped)),
  ]);
  const [, read, previous] = local("데이터 처리", () => {
    const names = [...chars.characters].sort((a, b) => Number(a.id) - Number(b.id)).map((c) => c.name);
    const [flat, pct] = statKinds(items.items);
    return planPages(skillsMode, parsePatch(patch.bodies, [...flat, ...pct]), names,
      skillsMode === "patched" ? previousSkills(outDir) : null);
  });
  const label = "스킬 수집(나무위키)";
  const pages = await step("skills", label, () => fetchPages(read, intervalMs, {
    signal: stopped, onPage: (done, total, name) => progress("skills", done, total, `${label} 중: ${name}`),
  }), read.length);
  const result = local("데이터 처리", () => buildAll(items.items, masteries.masteries, chars.characters,
    patch, pages, fetchedAt ?? new Date().toISOString(), previous));
  local("파일 저장", () => {
    mkdirSync(outDir, { recursive: true });
    // Write all four to temp files first so a failed write leaves the old set intact.
    const files = [["items.json", dumps(result.items)], ["characters.json", dumpsCharacters(result.characters)],
      ["skills.json", dumpsSkills(result.skills)], ["items.meta.json", dumps(result.meta)]];
    for (const [name, text] of files) writeFileSync(path.join(outDir, name + ".tmp"), text, "utf8");
    for (const [name] of files) renameSync(path.join(outDir, name + ".tmp"), path.join(outDir, name));
  });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { items, characters, skills, meta } = await fetchAll({
    skillsMode: process.argv.slice(2).includes("--all") ? "all" : "patched" });
  console.log(`wrote ${items.length} items, ${characters.length} characters, ${skills.length} skill entries `
    + `to ${DATA_DIR} (patch ${meta.patch.version}: ${meta.overrides.length} overrides, `
    + `${meta.skipped.length} skipped, ${meta.unparsed.length} unparsed)`);
}
