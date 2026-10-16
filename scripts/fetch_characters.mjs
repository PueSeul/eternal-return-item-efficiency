// Node twin of scripts/fetch_characters.py (no dependencies; built-in fetch).
// Builds data/characters.json byte-identical to the Python script.
// Values that differ from the latest patch note are replaced by the patch-note value.
// Usage: node scripts/fetch_characters.mjs
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { fetchPatch, parsePatch, applyCharacterChanges } from "./fetch_patchnote.mjs";

export const CHARACTERS_URL = "https://er.dakgg.io/api/v1/data/characters?hl=ko";
export const MASTERIES_URL = "https://er.dakgg.io/api/v1/data/masteries?hl=ko";
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const OUT_PATH = path.join(DATA_DIR, "characters.json");

// masteryStats option key -> output field (value per mastery level). Every
// mastery row carries all fields (0 when absent); an unknown key aborts.
// AttackPower is flat (Lyanh OneHandSword: 1).
const MASTERY_FIELDS = {
  SkillAmpRatio: "skillAmpRatio",
  AttackPowerRatio: "attackPowerRatio",
  AttackSpeedRatio: "attackSpeedRatio",
  IncreaseBasicAttackDamageRatio: "increaseBasicAttackDamageRatio",
  AttackPower: "attackPower",
};

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://dak.gg/", Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

function field(obj, key) {
  if (obj === null || typeof obj !== "object" || !Object.hasOwn(obj, key)) {
    throw new Error(`missing ${key} in ${JSON.stringify(obj)?.slice(0, 80)}`);
  }
  return obj[key];
}

// Python and JS only agree on plain decimal notation, so values that either
// side would print in exponent form (or non-finite ones) abort.
function num(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`not a number: ${value}`);
  const a = Math.abs(value);
  if (a >= 1e15 || (a > 0 && a < 1e-4)) throw new Error(`number out of serializable range: ${value}`);
  return value;
}

function buildMasteries(char, weaponNames) {
  const stats = new Map();
  for (const row of field(char, "masteryStats")) {
    const type = field(row, "type");
    if (stats.has(type)) throw new Error(`duplicate mastery ${type} for ${char.key}`);
    const fields = Object.fromEntries(Object.values(MASTERY_FIELDS).map((f) => [f, 0]));
    const seen = new Set();
    for (const opt of field(row, "options")) {
      const key = field(opt, "key");
      if (!Object.hasOwn(MASTERY_FIELDS, key) || seen.has(key)) {
        throw new Error(`unexpected mastery option ${key} for ${char.key}`);
      }
      seen.add(key);
      fields[MASTERY_FIELDS[key]] = num(field(opt, "value"));
    }
    stats.set(type, fields);
  }
  const order = field(char, "masteries");
  const same = [...stats.keys()].sort().join("\0") === [...order].sort().join("\0");
  if (!same || stats.size !== order.length) throw new Error(`masteryStats/masteries mismatch for ${char.key}`);
  // Order follows the character's own weapon list.
  const out = {};
  for (const t of order) {
    if (!Object.hasOwn(weaponNames, t)) throw new Error(`unknown weapon type ${t}`);
    out[weaponNames[t]] = stats.get(t);
  }
  return out;
}

export function buildCharacters(rawChars, masteries) {
  const weaponNames = Object.create(null);
  for (const m of masteries) weaponNames[field(m, "key")] = field(m, "name");
  const intId = (c) => {
    const n = Number(field(c, "id"));
    if (!Number.isInteger(n)) throw new Error(`non-integer character id ${c.id}`);
    return n;
  };
  return [...rawChars].sort((a, b) => intId(a) - intId(b)).map((c) => {
    const image = field(c, "imageUrl");
    return {
      id: String(c.id),
      name: field(c, "name"),
      imageUrl: image.startsWith("//") ? "https:" + image : image,
      attackPower: num(field(c, "attackPower")),
      attackPowerPerLevel: num(field(field(c, "levelUpStat"), "attackPower")),
      masteries: buildMasteries(c, weaponNames),
    };
  });
}

/** Serialized form of data/characters.json (byte-identical to fetch_characters.py). */
export function dumps(chars) {
  return JSON.stringify(chars, null, 2) + "\n";
}

export async function fetchCharacters() {
  const [chars, masteries, patch] = await Promise.all([
    fetchJson(CHARACTERS_URL), fetchJson(MASTERIES_URL), fetchPatch(),
  ]);
  const out = buildCharacters(chars.characters, masteries.masteries);
  // Item stat names are not needed for character rows.
  applyCharacterChanges(out, parsePatch(patch.bodies, []).changes);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const chars = await fetchCharacters();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_PATH, dumps(chars), "utf8");
  console.log(`wrote ${chars.length} characters to ${OUT_PATH}`);
}
