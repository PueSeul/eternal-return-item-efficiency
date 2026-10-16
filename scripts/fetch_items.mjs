// Node port of scripts/fetch_items.py (no dependencies; Node 22 built-in fetch).
// Fetches Eternal Return equipment from the dak.gg API and builds the same
// item list as the Python script. Usage: node scripts/fetch_items.mjs
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

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
const PRICE_SOURCE = PRICE_TABLE.gradePriceSource;
const ITEM_PRICE_SOURCE = PRICE_TABLE.itemPriceSource;
const ITEM_PRICE = new Map(PRICE_TABLE.itemPriceGroups.flatMap((g) => g.names.map((n) => [n, g.price])));
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

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://dak.gg/", Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
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

export function buildItems(rawItems, masteries) {
  const weaponNames = Object.fromEntries(masteries.map((m) => [m.key, m.name]));
  const equip = rawItems.map((it) => [it, slotOf(it)]).filter(([, slot]) => slot);
  const rawStats = new Map(equip.map(([it]) => [it.id, parseStats(field(it, "tooltip"))]));
  const flatNames = new Set();
  for (const stats of rawStats.values()) for (const [n, , pct] of stats) if (!pct) flatNames.add(n);

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
      price: hostPrice ?? required(GRADE_PRICE, grade, "grade price"),
      priceSource: hostPrice === undefined ? PRICE_SOURCE : ITEM_PRICE_SOURCE,
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

export async function fetchItems() {
  const [items, masteries] = await Promise.all([fetchJson(ITEMS_URL), fetchJson(MASTERIES_URL)]);
  return buildItems(items.items, masteries.masteries);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const items = await fetchItems();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_PATH, dumps(items), "utf8");
  console.log(`wrote ${items.length} items to ${OUT_PATH}`);
}
