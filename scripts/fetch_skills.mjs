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
  fetchPatch, parsePatch,
} from "./fetch_patchnote.mjs";

export const WIKI = "https://namu.wiki";
export const ROBOTS_URL = WIKI + "/robots.txt";
const AGENT = "er-damage-efficiency"; // robots.txt product token
const HEADERS = { "User-Agent": AGENT + "/1.0 (skill coefficient fetcher)", "Accept-Language": "ko-KR,ko;q=0.9" };
export const DOC_SUFFIX = "(이터널 리턴)";
export const REQUEST_INTERVAL_MS = 1000; // between namu.wiki requests
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
const SKILL_HEADING_RE = /^(패시브|Q|W|E|R) - (.+)$/;
const GROUP_KEYS = { "패시브": "P", Q: "Q", W: "W", E: "E", R: "R" };
const DAMAGE = "피해량";
const NUMV = "[0-9]+(?:\\.[0-9]+)?%?";
const VALUE_LINE_RE = new RegExp(`^(?:\\[([^\\[\\]]+)\\] )?([^\\[\\]]+?) \\[(${NUMV}(?: / ${NUMV})*)\\]((?: ?\\([^()]*\\))*)$`);
const DAMAGE_ROW_RE = /피해량[^[]*\[/;
const FOOTNOTE_RE = /\)(?:\[[0-9]+\])+$/;
const PAREN_RE = /\(([^()]*)\)/g;
const COEF_RE = /^\+(.+?)의? ([0-9]+(?:\.[0-9]+)?%?(?: ?\/ ?[0-9]+(?:\.[0-9]+)?%?)*)$/;
const RATIO_FIELDS = { "공격력": "attackPowerRatio", "스킬 증폭": "skillAmpRatio" };
const LEVEL_FIELDS = ["baseDamage", "attackPowerRatio", "skillAmpRatio"];
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

/** [levels, null] or [null, reason] for one damage row (see fetch_skills.py levels_from). */
export function levelsFrom(values, coefs) {
  if (values.some((v) => v.endsWith("%"))) return [null, "기본 피해량이 % 값"];
  const ratios = new Map();
  for (const coef of coefs) {
    const m = COEF_RE.exec(coef);
    if (!m || !m[2].endsWith("%")) return [null, `계수 형식 미해석: (${coef})`];
    const field = own(RATIO_FIELDS, m[1]);
    if (field === undefined) return [null, `계수 종류: ${m[1]}`];
    if (ratios.has(field)) return [null, `계수 중복: ${m[1]}`];
    const r = coefValues(m[2]);
    if (r === null) return [null, "수치 범위"];
    ratios.set(field, r);
  }
  const base = values.map(number);
  if (base.includes(null)) return [null, "수치 범위"];
  let n = values.length;
  for (const r of ratios.values()) {
    if (r.length !== 1 && r.length !== n) {
      if (n !== 1) return [null, "레벨 수 불일치"];
      n = r.length;
    }
  }
  if ([...ratios.values()].some((r) => r.length !== 1 && r.length !== n)) return [null, "레벨 수 불일치"];
  const pick = (xs, i) => (xs.length > 1 ? xs[i] : xs[0]);
  const levels = [];
  for (let i = 0; i < n; i++) {
    levels.push({ level: i + 1, baseDamage: pick(base, i),
      attackPowerRatio: pick(ratios.get("attackPowerRatio") ?? [0], i),
      skillAmpRatio: pick(ratios.get("skillAmpRatio") ?? [0], i) });
  }
  return [levels, null];
}

function valueLine(text) {
  const m = VALUE_LINE_RE.exec(text.replace(FOOTNOTE_RE, ")"));
  if (!m) return null;
  return { label: m[2], values: m[3].split(" / "), coefs: parens(m[4]).map((p) => p[1]) };
}

const valueish = (text) => valueLine(text) !== null || DAMAGE_ROW_RE.test(text);

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

function parseSkill(key, name, lines) {
  let review = [];
  const confirmed = [];
  const damageRows = [];
  for (const text of lines) {
    if (!text.includes(DAMAGE)) continue;
    const v = valueLine(text);
    if (v === null) {
      if (DAMAGE_ROW_RE.test(text)) review.push({ skill: key, text, reason: "형식 미해석" });
      continue;
    }
    if (!v.label.includes(DAMAGE)) continue;
    damageRows.push(v);
    const [levels, reason] = levelsFrom(v.values, v.coefs);
    if (v.label !== DAMAGE) review.push({ skill: key, text, reason: `피해량 아님: ${v.label}` });
    else if (levels === null) review.push({ skill: key, text, reason });
    else confirmed.push([text, levels]);
  }
  const entry = { key, name, levels: [], raw: null, sourceLabel: null };
  if (confirmed.length === 1) {
    entry.levels = confirmed[0][1];
    entry.raw = confirmed[0][0];
    entry.sourceLabel = DAMAGE;
  } else {
    review = review.concat(confirmed.map(([t]) => ({ skill: key, text: t, reason: "피해량 줄 여러 개" })));
  }
  return [entry, review, damageRows];
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

function historyReview(rowsByKey, lines) {
  const last = new Map();
  for (const [key, field, value, text] of historyRecords(lines)) last.set(`${key}\u0000${field}`, [key, field, value, text]);
  const review = [];
  for (const [key, field, value, text] of last.values()) {
    const known = [];
    for (const v of rowsByKey.get(key) ?? []) {
      if (field === "baseDamage") {
        const base = v.values.some((x) => x.endsWith("%")) ? [null] : v.values.map(number);
        if (!base.includes(null)) known.push(base);
        continue;
      }
      for (const coef of v.coefs) {
        const c = COEF_RE.exec(coef);
        if (c && own(RATIO_FIELDS, c[1]) === field) known.push(...(coefValues(c[2]) ?? []));
      }
    }
    if (known.length && !known.some((k) => same(k, value))) {
      review.push({ skill: key, text,
        reason: `역사 불일치: ${field} 설명란 ${JSON.stringify(known)}, 역사 마지막 ${JSON.stringify(value)}` });
    }
  }
  return review;
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
  entry.needsReview.push(...historyReview(rowsByKey, sections(lines, HISTORY_SECTION).flat()));
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
export async function fetchPage(url) {
  const resp = await fetch(url, { headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(30000) });
  if (resp.status === 404) return { status: 404, body: "", location: null };
  if (REDIRECT_CODES.has(resp.status)) return { status: resp.status, body: "", location: resp.headers.get("location") };
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return { status: resp.status, body: await resp.text(), location: null };
}

function throttle(intervalMs) {
  let last = null;
  return async () => {
    if (last !== null) {
      const left = intervalMs - (performance.now() - last);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    }
    last = performance.now();
  };
}

/** Final page after following redirects (each hop robots-checked and throttled). */
async function getPage(url, rules, wait) {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!robotsAllowed(rules, url)) throw new Error(`robots.txt disallows ${url}`);
    await wait();
    const page = await fetchPage(url);
    if (!REDIRECT_CODES.has(page.status)) return page;
    if (!page.location) throw new Error(`redirect without Location from ${url}`);
    url = new URL(page.location, url).href;
  }
  throw new Error(`too many redirects from ${url}`);
}

/** Map name -> document HTML or null, robots.txt respected, requests intervalMs apart. */
export async function fetchPages(names, intervalMs = REQUEST_INTERVAL_MS) {
  const wait = throttle(intervalMs);
  const robots = await getPage(ROBOTS_URL, [], wait);
  const rules = robots.status === 200 ? parseRobots(robots.body) : [];
  const pages = new Map();
  for (const name of names) {
    pages.set(name, null);
    for (const title of [name + DOC_SUFFIX, name]) {
      const page = await getPage(docUrl(title), rules, wait);
      if (page.status !== 404) {
        pages.set(name, page.body);
        break;
      }
    }
  }
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

const levelKey = (ls) => JSON.stringify(ls.map((l) => [l.level ?? null, ...LEVEL_FIELDS.map((f) => l[f] ?? null)]));
const sameLevels = (a, b) => levelKey(a) === levelKey(b);

function fieldChanges(old, next) {
  const byLevel = new Map(old.map((l) => [l.level, l]));
  const out = [];
  for (const l of next) {
    const o = byLevel.get(l.level);
    for (const f of LEVEL_FIELDS) {
      const ov = o && Object.hasOwn(o, f) ? o[f] : null;
      if (ov !== l[f]) out.push([l.level, f, ov, l[f]]);
    }
  }
  return out;
}

function merge(rows, index, newRows) {
  for (const r of newRows) {
    const k = JSON.stringify([r.characterId, r.skill, r.level, r.field]);
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
    const cands = char ? char.skills.filter((s) => s.key === c.key && s.levels.length) : [];
    if (after !== null && cands.some((s) => sameLevels(s.levels, after))) continue;
    // The wiki has a separate row with the patch row's label (e.g. 추가 피해량).
    const otherRow = char !== undefined && c.label !== DAMAGE && char.needsReview.some(
      (r) => r.skill === c.key && r.text.replace(TAG_PREFIX_RE, "").startsWith(c.label + " "));
    let hit = cands.filter((s) => before !== null && !otherRow && sameLevels(s.levels, before));
    if (!hit.length) hit = cands.filter((s) => s.sourceLabel === c.label);
    if (after === null || hit.length !== 1) {
      unparsed.push({ type: "skill", name: c.name, text: c.text });
      continue;
    }
    const s = hit[0];
    const posted = articles[c.part].createdAt;
    const revised = char.wikiRevisedAt;
    const rows = fieldChanges(s.levels, after).map(([level, field, old, value]) => ({
      type: "skill", characterId: char.characterId, name: c.name, skill: s.key, level, field,
      stat: `${level}레벨 ${field}`, dakgg: old, patchnote: value, text: c.text }));
    if (isBefore(revised, posted)) {
      s.levels = after;
      s.raw = c.text;
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
