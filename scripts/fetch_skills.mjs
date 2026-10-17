// Node twin of scripts/fetch_skills.py (no dependencies; built-in fetch).
// Skill damage coefficients from namu.wiki -> data/skills.json, byte-identical to the
// Python script. A patch-note row overwrites a wiki value only when the wiki document
// was last revised before the patch note was posted (host decision). Every request
// (redirect hops included) is checked against robots.txt and spaced >= 1 s apart.
// Content license of namu.wiki: CC BY-NC-SA 2.0 KR.
// Usage: node scripts/fetch_skills.mjs  (characters from data/characters.json)
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  TOKEN_RE, BLOCK_TAGS as PN_BLOCK_TAGS, HEADINGS, ENTITY_RE, SPACE_RE, entity,
  fetchPatch, parsePatch, requestSignal, describeError,
} from "./fetch_patchnote.mjs";

export const WIKI = "https://namu.wiki";
export const ROBOTS_URL = WIKI + "/robots.txt";
const AGENT = "er-damage-efficiency"; // robots.txt product token
const HEADERS = { "User-Agent": AGENT + "/1.0 (skill coefficient fetcher)", "Accept-Language": "ko-KR,ko;q=0.9" };
export const DOC_SUFFIX = "(이터널 리턴)";
export const REQUEST_INTERVAL_MS = 1000; // between namu.wiki request starts
export const PAGE_CONCURRENCY = 3; // namu.wiki requests in flight at once
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const OUT_PATH = path.join(DATA_DIR, "skills.json");
const CHARACTERS_PATH = path.join(DATA_DIR, "characters.json");

// --- page parsing (same patterns as fetch_skills.py) ---------------------------
const REVISED_RE = /최근 수정 시각:[ \t\n\r]*<time datetime=["']([^"']+)["']/;
const ALT_RE = /[ \t\n\r]alt=(?:'([^']*)'|"([^"]*)")/;
const RAW_TEXT_END = { script: "</script", style: "</style" };
const BLOCK_TAGS = new Set([...PN_BLOCK_TAGS, "hr"]);
const HEADING_NUM_RE = /^[0-9]+(?:\.[0-9]+)*\. /;
const EDIT_SUFFIX = "[편집]";
const SKILL_SECTION = "스킬";
const HISTORY_SECTION = "역사";
const SKILL_HEADING_RE = /^(패시브|Q|W|E|R|무기 스킬) - (.+)$/;
const GROUP_KEYS = { "패시브": "P", Q: "Q", W: "W", E: "E", R: "R", "무기 스킬": "D" };
const NUM = "[0-9]+(?:\\.[0-9]+)?";
const ROW_RE = /^(?:\[([^[\]]+)\] )?([^[\]]+?) \[([^[\]]+)\](.*)$/;
const NUM_BODY_RE = new RegExp(`^${NUM}%?(?: / ${NUM}%?)*$`);
const STAT_BODY_RE = new RegExp(`^(.+?)의 (${NUM}%(?: / ${NUM}%)*)$`);
const MULT_RE = /^ ?\* ?\(([^()]*)\)$/;
const DAMAGE_ROW_RE = /피해량[^[]*\[(?![0-9]+\])/;
const FOOTNOTE_RE = /(?<=[)\]])\[[0-9]+\]/g;
const PAREN_RE = /\(([^()]*)\)/g;
const COEF_RE = /^\+(.+?)의? ([0-9]+(?:\.[0-9]+)?%?(?: ?\/ ?[0-9]+(?:\.[0-9]+)?%?)*)$/;
const COEF_PER_RE = new RegExp(`^\\+(.+?) (${NUM})(%?) ?당 (${NUM})(%?)$`);
const COEF_MUL_RE = new RegExp(`^\\+(.+?) ?\\* ?(${NUM}(?: / ${NUM})*)$`);
const COEF_EACH_RE = new RegExp(`^\\+(.+?) 당 (?:피해량 )?(${NUM}(?: / ${NUM})*)$`);
const COEF_NAME_RE = /^\+([^0-9%()]+)$/;
const RATIO_FIELDS = { "공격력": "attackPowerRatio", "스킬 증폭": "skillAmpRatio" };
const LEVEL_FIELDS = ["baseDamage", "attackPowerRatio", "skillAmpRatio"];
const NOT_DAMAGE_RE = /감소|증가/;
const PERCENT_BASE = "기본값(%)";
const KEY_MENTION_RE = /\(([A-Z][A-Z0-9-]*)\)/g;
const HISTORY_KEYS = new Set(["P", "Q", "W", "E", "R", "RQ", "RW", "RE"]);
const HISTORY_RATIO_RE = /(스킬 증폭|스증|공격력|공) ?계수(?:가|는|를|도)? (?:[0-9]+(?:\.[0-9]+)?%에서 )?([0-9]+(?:\.[0-9]+)?)%(?:\([^()]*\))?(?:으로|로)/g;
const HISTORY_BASE_RE = /피해량이 (?:[0-9./]+(?:\([^()]*\))*에서 )?([0-9]+(?:\.[0-9]+)?(?:\/[0-9]+(?:\.[0-9]+)?)+)(?![0-9./]*(?:\([^()]*\))*에서)((?:\([^()]*\))*)/g;
const TAG_PREFIX_RE = /^(?:\[[^[\]]+\] )?/;
const HISTORY_STATS = { "스킬 증폭": "skillAmpRatio", "스증": "skillAmpRatio", "공격력": "attackPowerRatio",
  "공": "attackPowerRatio" };
const PATCH_VALUES_RE = /^([0-9]+(?:\.[0-9]+)?(?:\/[0-9]+(?:\.[0-9]+)?)*)((?:\([^()]*\))*)$/;
const TIME_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const HEX = /^[0-9a-fA-F]$/;

const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);
const strip = (s) => s.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");
const parens = (s) => [...s.matchAll(PAREN_RE)];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Decimal text -> number, or null outside 1e-4..1e15 (except 0). */
function number(text) {
  const v = Number(text);
  if (v === 0) return /[1-9]/.test(text.split("e")[0]) ? null : 0; // underflow is not zero
  return v >= 1e-4 && v < 1e15 ? v : null;
}
const ratio = (text) => number(text + "e-2");

/** Document as [[kind, text, inTable]] (see fetch_skills.py page_lines). */
export function pageLines(html) {
  const out = [];
  let buf = [];
  let kind = "p";
  let tables = 0;
  const flush = () => {
    const text = buf.join("").replace(SPACE_RE, " ").replace(/^ +| +$/g, "");
    if (text) out.push([kind, text, tables > 0]);
    buf = [];
  };
  const re = new RegExp(TOKEN_RE.source, "y");
  let pos = 0;
  while (pos < html.length) {
    re.lastIndex = pos;
    const m = re.exec(html);
    pos = re.lastIndex;
    if (m[2] === undefined) {
      if (!m[0].startsWith("<!--")) buf.push(m[0].replace(ENTITY_RE, entity));
      continue;
    }
    const tag = m[2].toLowerCase();
    const closing = m[1] === "/";
    if (Object.hasOwn(RAW_TEXT_END, tag) && !closing) {
      const end = new RegExp(RAW_TEXT_END[tag], "gi");
      end.lastIndex = pos;
      const e = end.exec(html);
      pos = e ? e.index : html.length;
      continue;
    }
    if (tag === "img" && tables > 0) {
      const a = ALT_RE.exec(m[0]);
      if (a) {
        flush();
        out.push(["img", (a[1] ?? a[2]).replace(ENTITY_RE, entity), true]);
      }
    }
    if (tag === "table") {
      flush();
      tables = Math.max(0, tables + (closing ? -1 : 1));
    }
    if (BLOCK_TAGS.has(tag)) {
      flush();
      kind = HEADINGS.has(tag) && !closing ? tag : "p";
    }
  }
  flush();
  return out;
}

export function headingTitle(text) {
  if (text.endsWith(EDIT_SUFFIX)) text = text.slice(0, -EDIT_SUFFIX.length);
  return strip(text.replace(HEADING_NUM_RE, ""));
}

function sections(lines, title) {
  const found = [];
  lines.forEach(([kind, text], i) => {
    if (!HEADINGS.has(kind) || headingTitle(text) !== title) return;
    let j = i + 1;
    while (j < lines.length && !(HEADINGS.has(lines[j][0]) && lines[j][0] <= kind)) j += 1;
    found.push(lines.slice(i + 1, j));
  });
  return found;
}

function coefValues(text) {
  const values = text.split("/").map((v) => ratio(strip(v).replace(/%+$/, "")));
  return values.includes(null) ? null : values;
}

/** [stat, ratios, isPercent, null] or [null, null, null, reason] (see fetch_skills.py parse_coef). */
export function parseCoef(coef) {
  const fail = (reason) => [null, null, null, reason];
  let m = COEF_PER_RE.exec(coef);
  if (m) {
    if (m[3] !== m[5]) return fail(`계수 형식 미해석: (${coef})`);
    const a = number(m[2]);
    const b = number(m[4]);
    const v = a !== null && a !== 0 && b !== null ? b / a : null;
    if (v === null || !(v === 0 || (v >= 1e-4 && v < 1e15))) return fail("수치 범위");
    return [m[1], [v], false, null];
  }
  for (const rx of [COEF_MUL_RE, COEF_EACH_RE]) {
    m = rx.exec(coef);
    if (m) {
      const values = m[2].split(" / ").map(number);
      const stat = m[1].endsWith(" 당") ? m[1].slice(0, -2) : m[1];
      return values.includes(null) ? fail("수치 범위") : [stat, values, false, null];
    }
  }
  m = COEF_RE.exec(coef);
  if (m && m[2].endsWith("%")) {
    const values = coefValues(m[2]);
    return values === null ? fail("수치 범위") : [m[1], values, true, null];
  }
  m = COEF_NAME_RE.exec(coef);
  if (m) return [strip(m[1]), [null], false, null];
  return fail(`계수 형식 미해석: (${coef})`);
}

/** [outer, inners] or null (see fetch_skills.py _split_nested). */
function splitNested(coef) {
  const outer = [];
  const inners = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < coef.length; i++) {
    const ch = coef[i];
    if (ch === "(") {
      depth += 1;
      if (depth === 1) { start = i + 1; continue; }
    } else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) { inners.push(coef.slice(start, i)); continue; }
    }
    if (depth === 0) outer.push(ch);
  }
  return depth === 0 ? [outer.join(""), inners] : null;
}

/** [stat, ratios, isPercent, nested, null] or [null, null, null, null, reason] (see fetch_skills.py coef_tree). */
export function coefTree(coef) {
  const fail = (reason) => [null, null, null, null, reason];
  let [stat, vals, isPct, reason] = parseCoef(coef);
  if (reason === null) return [stat, vals, isPct, [], null];
  const split = splitNested(coef);
  if (split === null || !split[1].length) return fail(reason);
  [stat, vals, isPct, reason] = parseCoef(split[0]);
  if (reason) return fail(reason);
  const nested = [];
  for (const inner of split[1]) {
    const [s, v, , n, r] = coefTree(inner);
    if (r) return fail(r);
    nested.push([s, v, n]);
  }
  return [stat, vals, isPct, nested, null];
}

const nestedLists = (nested) => nested.flatMap(([, v, n]) => [v, ...nestedLists(n)]);

function ratioEntry(stat, vals, nested, pick, i) {
  const entry = { stat, ratio: pick(vals, i) };
  if (nested.length) entry.nested = nested.map(([s, v, n]) => ratioEntry(s, v, n, pick, i));
  return entry;
}

/** [levels, null] or [null, reason] for one value row (see fetch_skills.py levels_from). */
export function levelsFrom(values, coefs, label = PERCENT_BASE) {
  const pct = values.map((v) => v.endsWith("%"));
  if (pct.some(Boolean) && !pct.every(Boolean)) return [null, "형식 미해석"];
  const percent = values.length > 0 && pct.every(Boolean);
  let base = values.map((v) => (percent ? ratio : number)(v.replace(/%+$/, "")));
  if (!base.length) base = [0];
  if (base.includes(null)) return [null, "수치 범위"];
  const ratios = new Map();
  const extras = percent ? [[label, base, []]] : [];
  if (percent) base = [0];
  for (const coef of coefs) {
    const [stat, vals, isPct, nested, reason] = coefTree(coef);
    if (reason) return [null, reason];
    const field = isPct && !nested.length ? own(RATIO_FIELDS, stat) : undefined;
    if (field === undefined) extras.push([stat, vals, nested]);
    else if (ratios.has(field)) return [null, `계수 중복: ${stat}`];
    else ratios.set(field, vals);
  }
  const lists = [base, ...ratios.values(), ...nestedLists(extras)];
  const n = Math.max(...lists.map((x) => x.length));
  if (lists.some((x) => x.length !== 1 && x.length !== n)) return [null, "레벨 수 불일치"];
  const pick = (xs, i) => (xs.length > 1 ? xs[i] : xs[0]);
  const levels = [];
  for (let i = 0; i < n; i++) {
    const level = { level: i + 1, baseDamage: pick(base, i),
      attackPowerRatio: pick(ratios.get("attackPowerRatio") ?? [0], i),
      skillAmpRatio: pick(ratios.get("skillAmpRatio") ?? [0], i) };
    if (extras.length) level.extraRatios = extras.map(([stat, v, n]) => ratioEntry(stat, v, n, pick, i));
    levels.push(level);
  }
  return [levels, null];
}

/** [coefficients, multiplier] of the text after the body, or null (see fetch_skills.py _groups). */
function groups(rest) {
  const out = [];
  let pos = 0;
  while (pos < rest.length) {
    const m = MULT_RE.exec(rest.slice(pos));
    if (m) return [out, m[1]];
    if (rest.startsWith(" (", pos)) pos += 1;
    if (!rest.startsWith("(", pos)) return null;
    let depth = 0;
    let end = pos;
    for (; end < rest.length; end++) {
      if (rest[end] === "(") depth += 1;
      else if (rest[end] === ")") depth -= 1;
      if (depth === 0) break;
    }
    if (depth !== 0) return null;
    out.push(rest.slice(pos + 1, end));
    pos = end + 1;
  }
  return [out, null];
}

function valueLine(text) {
  const m = ROW_RE.exec(text.replace(FOOTNOTE_RE, ""));
  if (!m) return null;
  const g = groups(m[4]);
  const body = m[3];
  const row = { tag: m[1] ?? null, label: m[2], values: null, coefs: null, multiplier: null };
  if (g !== null) {
    [row.coefs, row.multiplier] = g;
    const s = STAT_BODY_RE.exec(body);
    if (NUM_BODY_RE.test(body)) row.values = body.split(" / ");
    else if (s) {
      row.values = [];
      row.coefs = [`+${s[1]}의 ${s[2]}`, ...row.coefs];
    }
  }
  return row;
}

function isDamage(row, text) {
  if (row === null) return DAMAGE_ROW_RE.test(text);
  if (text.includes("(+") || (row.values !== null && row.values.length === 0 && row.coefs !== null)) return true;
  return row.label.includes("피해") && !NOT_DAMAGE_RE.test(row.label);
}

const valueish = (text) => {
  const row = valueLine(text);
  return (row !== null && row.values !== null) || isDamage(row, text);
};

function subSkills(groupLines, letter) {
  let subs = [];
  let prevImg = false;
  for (const [kind, text, inTable] of groupLines) {
    if (!inTable || HEADINGS.has(kind)) continue;
    if (kind === "img") {
      if (!prevImg) subs.push({ alts: [], lines: [] });
      subs[subs.length - 1].alts.push(text);
      prevImg = true;
      continue;
    }
    prevImg = false;
    if (!subs.length) {
      if (!valueish(text)) continue;
      subs.push({ alts: [], lines: [] });
    }
    subs[subs.length - 1].lines.push(text);
  }
  // Later image rows without any value row are illustrations (e.g. interaction tables).
  subs = subs.filter((s, i) => i === 0 || s.lines.some(valueish));
  const keys = [];
  const used = new Set();
  for (const s of subs) {
    const ult = "R" + letter;
    const base = "QWE".includes(letter) && s.alts.some((a) => a.split(" ").at(-1).toUpperCase() === ult)
      ? ult : letter;
    let key = base;
    let n = 1;
    while (used.has(key)) {
      n += 1;
      key = `${base}${n}`;
    }
    used.add(key);
    keys.push(key);
  }
  return [subs, keys];
}

/** [skill, needsReview rows, [[entry, value row]]] for one sub-skill (see fetch_skills.py _parse_skill). */
function parseSkill(key, name, lines) {
  const review = [];
  const entries = [];
  const rows = [];
  for (const text of lines) {
    const row = valueLine(text);
    if (!isDamage(row, text)) continue;
    let levels = null;
    if (row === null || row.values === null) {
      review.push({ skill: key, text, reason: "형식 미해석" });
      if (row === null) continue;
    } else {
      let reason;
      [levels, reason] = levelsFrom(row.values, row.coefs, row.label);
      if (levels === null) review.push({ skill: key, text, reason });
    }
    const e = { label: (row.tag ? `[${row.tag}] ` : "") + row.label, levels: levels ?? [], raw: text };
    if (row.multiplier) e.multiplier = row.multiplier;
    entries.push(e);
    if (levels !== null) rows.push([e, row]);
  }
  const first = entries[0] ?? { label: null, levels: [], raw: null };
  const skill = { key, name, levels: first.levels, raw: first.raw, sourceLabel: first.label, entries };
  return [skill, review, rows];
}

function historyRecords(lines) {
  const records = [];
  for (const [kind, text] of lines) {
    if (kind !== "p") continue;
    const mentions = [...text.matchAll(KEY_MENTION_RE)];
    mentions.forEach((m, i) => {
      const key = m[1].replaceAll("-", "");
      if (!HISTORY_KEYS.has(key)) return;
      const clause = text.slice(m.index + m[0].length, i + 1 < mentions.length ? mentions[i + 1].index : text.length);
      const found = []; // [position in clause, field, value]
      for (const r of clause.matchAll(HISTORY_RATIO_RE)) found.push([r.index, HISTORY_STATS[r[1]], ratio(r[2])]);
      for (const b of clause.matchAll(HISTORY_BASE_RE)) {
        const base = b[1].split("/").map(number);
        found.push([b.index, "baseDamage", base.includes(null) ? null : base]);
        const coefsAt = b.index + b[0].length - b[2].length;
        for (const p of parens(b[2])) {
          const c = COEF_RE.exec(p[1]);
          if (c && Object.hasOwn(RATIO_FIELDS, c[1]) && !c[2].includes("/")) {
            found.push([coefsAt + p.index, RATIO_FIELDS[c[1]], ratio(c[2].replace(/%+$/, ""))]);
          }
        }
      }
      found.sort((a, b) => a[0] - b[0]);
      for (const [, field, value] of found) if (value !== null) records.push([key, field, value, text]);
    });
  }
  return records;
}

/** [[key, message]] (see fetch_skills.py history_mismatches). */
function historyMismatches(rowsByKey, lines) {
  const last = new Map();
  for (const [key, field, value, text] of historyRecords(lines)) last.set(`${key}\u0000${field}`, [key, field, value, text]);
  const found = [];
  for (const [key, field, value, text] of last.values()) {
    const known = [];
    for (const [, v] of rowsByKey.get(key) ?? []) {
      if (field === "baseDamage") {
        const base = v.values.some((x) => x.endsWith("%")) ? [null] : v.values.map(number);
        if (base.length && !base.includes(null)) known.push(base);
        continue;
      }
      for (const coef of v.coefs) {
        const c = COEF_RE.exec(coef);
        if (c && c[2].endsWith("%") && own(RATIO_FIELDS, c[1]) === field) known.push(...(coefValues(c[2]) ?? []));
      }
    }
    if (known.length && !known.some((k) => same(k, value))) {
      found.push([key, `${field} 설명란 ${JSON.stringify(known)}, 역사 마지막 ${JSON.stringify(value)}: ${text}`]);
    }
  }
  return found;
}

/** skills.json entry for one character (html null: document not found). */
export function parsePage(characterId, name, html) {
  const entry = { characterId, name, skills: [], wikiRevisedAt: null, needsReview: [] };
  if (html === null || html === undefined) {
    entry.needsReview.push({ skill: null, text: docUrl(name + DOC_SUFFIX), reason: "문서 없음" });
    return entry;
  }
  const rev = REVISED_RE.exec(html);
  entry.wikiRevisedAt = rev ? rev[1] : null;
  if (!rev) entry.needsReview.push({ skill: null, text: "", reason: "최근 수정 시각 없음" });
  const lines = pageLines(html);
  const skillSections = sections(lines, SKILL_SECTION);
  if (!skillSections.length) {
    entry.needsReview.push({ skill: null, text: "", reason: "스킬 문단 없음" });
    return entry;
  }
  const rowsByKey = new Map();
  const sec = skillSections[0];
  let i = 0;
  while (i < sec.length) {
    const [kind, text] = sec[i];
    const m = HEADINGS.has(kind) ? SKILL_HEADING_RE.exec(headingTitle(text)) : null;
    if (!m) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < sec.length && !(HEADINGS.has(sec[j][0]) && sec[j][0] <= kind)) j += 1;
    const [subs, keys] = subSkills(sec.slice(i + 1, j), GROUP_KEYS[m[1]]);
    const names = m[2].split(" / ");
    subs.forEach((sub, n) => {
      const [skill, review, rows] = parseSkill(keys[n], names.length === subs.length ? names[n] : m[2], sub.lines);
      entry.skills.push(skill);
      entry.needsReview.push(...review);
      if (!rowsByKey.has(keys[n])) rowsByKey.set(keys[n], []);
      rowsByKey.get(keys[n]).push(...rows);
    });
    i = j;
  }
  for (const [key, message] of historyMismatches(rowsByKey, sections(lines, HISTORY_SECTION).flat())) {
    for (const [e] of rowsByKey.get(key)) {
      e.historyMismatch ??= { text: "" };
      e.historyMismatch.text += (e.historyMismatch.text ? "\n" : "") + message;
    }
  }
  return entry;
}

// --- robots.txt ----------------------------------------------------------------
/** Percent-encode a document title (same bytes as Python quote(safe="")). */
export function encodeTitle(title) {
  return encodeURIComponent(title).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function docUrl(title) {
  return WIKI + "/w/" + encodeTitle(title);
}

const hex2 = (b) => "%" + b.toString(16).toUpperCase().padStart(2, "0");

/** Percent-encoding normal form for robots matching (see fetch_skills.py robots_normalize). */
export function robotsNormalize(s) {
  const chars = [...s];
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "%" && i + 2 < chars.length && HEX.test(chars[i + 1]) && HEX.test(chars[i + 2])) {
      const c = String.fromCharCode(parseInt(chars[i + 1] + chars[i + 2], 16));
      out.push(UNRESERVED.test(c) ? c : "%" + (chars[i + 1] + chars[i + 2]).toUpperCase());
      i += 3;
      continue;
    }
    if (ch.codePointAt(0) > 127) out.push(...[...new TextEncoder().encode(ch)].map(hex2));
    else out.push(ch);
    i += 1;
  }
  return out.join("");
}

/** [[allow, pattern]] of the groups naming `agent`, else of the "User-agent: *" groups. */
export function parseRobots(text, agent = AGENT) {
  const groups = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = strip(raw.split("#", 1)[0]);
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = strip(line.slice(0, colon)).toLowerCase();
    const value = strip(line.slice(colon + 1));
    if (key === "user-agent") {
      if (cur === null || cur.closed) {
        cur = { agents: [], rules: [], closed: false };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && cur !== null) {
      cur.closed = true; // an empty Disallow still ends the user-agent list
      if (value) cur.rules.push([key === "allow", robotsNormalize(value)]);
    }
  }
  const mine = groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  return (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
}

function robotsMatch(pattern, p) {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  if (!p.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  if (parts.length === 1) return !anchored || pos === p.length;
  for (const part of parts.slice(1, -1)) {
    const i = p.indexOf(part, pos);
    if (i < 0) return false;
    pos = i + part.length;
  }
  const last = parts[parts.length - 1];
  if (anchored) return p.length - last.length >= pos && p.endsWith(last);
  return p.indexOf(last, pos) >= 0;
}

/** Longest matching rule wins, Allow on ties; no match = allowed. */
export function robotsAllowed(rules, url) {
  const u = new URL(url);
  // The URL parser already removed dot segments (fetch_skills.py does it explicitly).
  const p = robotsNormalize(u.pathname || "/") + robotsNormalize(u.search);
  let best = null;
  for (const [allow, pattern] of rules) {
    if (!robotsMatch(pattern, p)) continue;
    if (best === null || pattern.length > best[0] || (pattern.length === best[0] && allow && !best[1])) {
      best = [pattern.length, allow];
    }
  }
  return best === null || best[1];
}

// --- fetching ------------------------------------------------------------------
/** One request, redirects not followed: {status, body, location}; 200/404/3xx returned, others throw. */
export async function fetchPage(url, signal) {
  const resp = await fetch(url, { headers: HEADERS, redirect: "manual", signal: requestSignal(signal) });
  if (resp.status === 404) return { status: 404, body: "", location: null };
  if (REDIRECT_CODES.has(resp.status)) return { status: resp.status, body: "", location: resp.headers.get("location") };
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return { status: resp.status, body: await resp.text(), location: null };
}

// Callers are served one at a time and each turn is measured from the previous turn's actual
// start, so concurrent callers (and late timers) never start requests less than intervalMs apart.
function throttle(intervalMs, signal) {
  let chain = Promise.resolve();
  let last = null;
  return () => {
    const turn = chain.then(async () => {
      signal?.throwIfAborted();
      for (let left = last === null ? 0 : intervalMs - (performance.now() - last); left > 0;
        left = intervalMs - (performance.now() - last)) {
        await new Promise((r) => setTimeout(r, left));
      }
      signal?.throwIfAborted();
      last = performance.now();
    });
    chain = turn.catch(() => {});
    return turn;
  };
}

/** Final page after following redirects (each hop robots-checked and throttled). */
async function getPage(url, rules, wait, signal) {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!robotsAllowed(rules, url)) throw new Error(`robots.txt disallows ${url}`);
    await wait();
    const page = await fetchPage(url, signal);
    if (!REDIRECT_CODES.has(page.status)) return page;
    if (!page.location) throw new Error(`redirect without Location from ${url}`);
    url = new URL(page.location, url).href;
  }
  throw new Error(`too many redirects from ${url}`);
}

/** Map name -> document HTML or null, robots.txt respected, request starts intervalMs apart,
 * at most `concurrency` documents in flight. onPage(done, total, name) after each document;
 * a failure names the document and aborts the requests in flight and the remaining ones. */
export async function fetchPages(names, intervalMs = REQUEST_INTERVAL_MS,
  { concurrency = PAGE_CONCURRENCY, onPage, signal } = {}) {
  const stop = new AbortController();
  const stopped = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const wait = throttle(intervalMs, stopped);
  const robots = await getPage(ROBOTS_URL, [], wait, stopped);
  const rules = robots.status === 200 ? parseRobots(robots.body) : [];
  const pages = new Map(names.map((name) => [name, null]));
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (!stopped.aborted && next < names.length) {
      const name = names[next++];
      try {
        for (const title of [name + DOC_SUFFIX, name]) {
          const page = await getPage(docUrl(title), rules, wait, stopped);
          if (page.status !== 404) {
            pages.set(name, page.body);
            break;
          }
        }
      } catch (err) {
        if (stopped.aborted) throw err; // another document failed first, or the caller stopped
        const failure = new Error(`나무위키 문서 "${name}": ${describeError(err)}`, { cause: err });
        stop.abort(failure);
        throw failure;
      }
      done += 1;
      if (onPage) onPage(done, names.length, name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return pages;
}

/** skills.json content (wiki values only) for the built characters. */
export function buildSkills(chars, pages) {
  return chars.map((c) => parsePage(c.id, c.name, pages.get(c.name) ?? null));
}

// --- patch-note overrides --------------------------------------------------------
/** ISO time -> [epoch seconds, fraction digits], or null (see fetch_skills.py instant). */
export function instant(text) {
  const m = TIME_RE.exec(text ?? "");
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i]));
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= monthDays[mo - 1] && h < 24 && mi < 60 && s < 60)) return null;
  let off = 0;
  if (m[8] !== "Z") {
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) return null;
    off = (m[8][0] === "+" ? 1 : -1) * (oh * 60 + om);
  }
  const yy = y - (mo <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const days = era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  return [((days * 24 + h) * 60 + mi - off) * 60 + s, m[7] ?? ""];
}

/** True when ISO time a is strictly earlier than b (false if either is unreadable). */
export function isBefore(a, b) {
  const ia = instant(a);
  const ib = instant(b);
  if (ia === null || ib === null) return false;
  if (ia[0] !== ib[0]) return ia[0] < ib[0];
  const n = Math.max(ia[1].length, ib[1].length);
  return ia[1].padEnd(n, "0") < ib[1].padEnd(n, "0");
}

export function patchLevels(text) {
  const m = PATCH_VALUES_RE.exec(text);
  if (!m) return [null, "형식 미해석"];
  return levelsFrom(m[1].split("/"), parens(m[2]).map((p) => p[1]));
}

/** Level row as [[field, value]] (see fetch_skills.py _flat). */
function flat(level) {
  const val = (f) => (Object.hasOwn(level, f) ? level[f] : null);
  const out = LEVEL_FIELDS.map((f) => [f, val(f)]);
  const walk = (prefix, xs) => {
    for (const x of xs) {
      out.push([`${prefix}${x.stat}`, x.ratio ?? null]);
      walk(`${prefix}${x.stat}.`, x.nested ?? []);
    }
  };
  walk("extraRatios.", level.extraRatios ?? []);
  return out;
}
const levelKey = (ls) => JSON.stringify(ls.map((l) => [l.level ?? null, flat(l)]));
const sameLevels = (a, b) => levelKey(a) === levelKey(b);
const plain = (label) => (label ?? "").replace(TAG_PREFIX_RE, "");
/** Wiki key under the patch-note key: "Q" itself or a numbered sub-skill "Q2". */
const keyOf = (wikiKey, patchKey) => wikiKey.startsWith(patchKey) && /^[0-9]*$/.test(wikiKey.slice(patchKey.length));
const startsWithLabel = (text, label) => text.startsWith(label)
  && (text.length === label.length || " [(".includes(text[label.length]));

function fieldChanges(old, next) {
  const byLevel = new Map(old.map((l) => [l.level, l]));
  const out = [];
  for (const l of next) {
    const o = new Map(flat(byLevel.get(l.level) ?? {}));
    const n = flat(l);
    const nKeys = new Set(n.map(([f]) => f));
    for (const [f, v] of n) {
      const ov = o.has(f) ? o.get(f) : null;
      if (ov !== v) out.push([l.level, f, ov, v]);
    }
    for (const [f, v] of o) if (!nKeys.has(f) && v !== null) out.push([l.level, f, v, null]);
  }
  return out;
}

function merge(rows, index, newRows) {
  for (const r of newRows) {
    const k = JSON.stringify([r.characterId, r.skill, r.label, r.level, r.field]);
    if (index.has(k)) {
      const { dakgg, ...rest } = r; // dakgg stays the original wiki value
      Object.assign(index.get(k), rest);
    } else {
      index.set(k, r);
      rows.push(r);
    }
  }
}

/** [overrides, skipped, unparsed] (see fetch_skills.py apply_skill_changes); skills modified in place. */
export function applySkillChanges(skills, changes, articles) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const overrides = [];
  const skipped = [];
  const unparsed = [];
  const overIndex = new Map();
  const skipIndex = new Map();
  for (const c of changes) {
    if (c.type !== "skill") continue;
    const char = byName.get(c.name);
    const [after] = patchLevels(c.after);
    const [before] = patchLevels(c.before);
    const sameKey = char
      ? char.skills.filter((s) => keyOf(s.key, c.key)).flatMap((s) => s.entries.map((e) => [s, e])) : [];
    const isOld = (e) => before !== null && sameLevels(e.levels, before);
    const label = plain(c.label);
    let hit = sameKey.filter(([, e]) => e.label === c.label);
    if (!hit.length) hit = sameKey.filter(([, e]) => plain(e.label) === label);
    // An unreadable wiki row with that label: never fall back to another entry by value.
    const labelled = hit.length > 0 || (char !== undefined && char.needsReview.some(
      (r) => keyOf(r.skill ?? "", c.key) && startsWithLabel(plain(r.text), label)));
    if (hit.length > 1) hit = hit.filter(([, e]) => isOld(e));
    if (!labelled) {
      const cands = sameKey.filter(([, e]) => e.levels.length);
      hit = cands.filter(([, e]) => isOld(e));
      if (!hit.length && after !== null && cands.some(([, e]) => sameLevels(e.levels, after))) continue;
    }
    if (after === null || hit.length !== 1 || !hit[0][1].levels.length) {
      unparsed.push({ type: "skill", name: c.name, text: c.text });
      continue;
    }
    const [s, e] = hit[0];
    if (sameLevels(e.levels, after)) continue;
    const posted = articles[c.part].createdAt;
    const revised = char.wikiRevisedAt;
    const rows = fieldChanges(e.levels, after).map(([level, field, old, value]) => ({
      type: "skill", characterId: char.characterId, name: c.name, skill: s.key, level, field,
      stat: `${e.label} ${level}레벨 ${field}`, dakgg: old, patchnote: value, text: c.text, label: e.label }));
    if (isBefore(revised, posted)) {
      e.levels = after;
      e.raw = c.text;
      if (s.entries[0] === e) {
        s.levels = after;
        s.raw = c.text;
      }
      merge(overrides, overIndex, rows);
    } else {
      merge(skipped, skipIndex, rows.map((r) => ({ ...r, wikiRevisedAt: revised, patchPostedAt: posted,
        reason: "나무위키 최근 수정이 패치노트 게시 이후(또는 시각 미확인)" })));
    }
  }
  return [overrides, skipped, unparsed];
}

export function dumps(skills) {
  return JSON.stringify(skills, null, 2) + "\n";
}

/** skills.json content with patch-note overrides applied. */
export async function fetchSkills(chars, intervalMs = REQUEST_INTERVAL_MS) {
  const skills = buildSkills(chars, await fetchPages(chars.map((c) => c.name), intervalMs));
  const patch = await fetchPatch();
  applySkillChanges(skills, parsePatch(patch.bodies, []).changes, patch.info.articles);
  return skills;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const skills = await fetchSkills(JSON.parse(readFileSync(CHARACTERS_PATH, "utf8")));
  writeFileSync(OUT_PATH, dumps(skills), "utf8");
  const review = skills.reduce((n, c) => n + c.needsReview.length, 0);
  console.log(`wrote ${skills.length} characters to ${OUT_PATH} (${review} needsReview)`);
}
