// Node twin of scripts/fetch_patchnote.py (no dependencies; built-in fetch).
// Extracts item / character stat changes from the latest official patch note
// (plus later hotfixes). Same rules and output as the Python script.
// Usage: node scripts/fetch_patchnote.mjs  (prints the extracted changes as JSON)
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const LIST_URL = (page) =>
  `https://playeternalreturn.com/api/v1/posts/news?category=patchnote&hl=ko-KR&page=${page}`;
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept-Language": "ko-KR,ko;q=0.9" };
const ITEMS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "items.json");

const TITLE_RE = /([0-9]+\.[0-9]+)[a-z]? ?(패치노트|핫픽스)/;
const DATE_RE = /([0-9]{4})\.([0-9]{2})\.([0-9]{2})/;
const CONTENT_CLASS = "er-article-detail__content";

// Minimal HTML tokenizer (identical to the Python twin).
const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9]*)[^>]*>|([^<]+)|</g;
const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "br", "table", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g;
const NAMED_ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rarr: "→" };
// Includes every line terminator JS regex "." excludes, so both twins match alike.
const SPACE_RE = /[ \t\n\r\f\v\u00a0\u2028\u2029]+/g;

const SECTIONS = { "무기": "item", "방어구": "item", "실험체": "character" };
const NUM = "([0-9]+(?:\\.[0-9]+)?)(%?)";
const CHANGE_RE = new RegExp(`^(.+) ${NUM} → ${NUM}$`);
const NEW_STAT_RE = new RegExp(`^(.+) ${NUM} \\(신규\\)$`);
const VALUE_RE = new RegExp(`^(.+) ${NUM}$`);
const NEW_ITEM_RE = /^(.+) \(신규 [^()]*\)$/;
const MASTERY_RE = /^(.+?) 무기 숙련도 레벨 당(?: (.+))?$/;
const SENTENCE_RE = /[.!?다요]$/;
const ARROW = "→";
const DELETED = "(삭제)"; // "<s>쿨다운 감소 10</s> (삭제)": reported, not applied
const STATS_HEADER = "능력치";
const RECIPE_PREFIX = "조합식"; // "조합식: …" / "조합식 변경: A + B → C + D"
const CHAR_BASE = { "기본 공격력": "attackPower", "레벨 당 공격력": "attackPowerPerLevel" };
const MASTERY_STATS = {
  "스킬 증폭|true": "skillAmpRatio",
  "공격력|true": "attackPowerRatio",
  "공격 속도|true": "attackSpeedRatio",
  "기본 공격 증폭|true": "increaseBasicAttackDamageRatio",
  "공격력|false": "attackPower",
};
const PCT_SUFFIX = "율";

export async function fetchText(url) {
  const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

/** Row that states a change (must be applied or reported). */
const marked = (text) => text.includes(ARROW) || text.includes("(신규)") || text.includes(DELETED);

const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

function articleInfo(article) {
  const title = article.i18ns.ko_KR.title;
  if (typeof title !== "string") throw new Error(`article ${article.id} has no Korean title`);
  const m = TITLE_RE.exec(title);
  return {
    id: Number(article.id),
    title,
    url: article.url,
    kind: m ? m[2] : null,
    version: m ? m[1] : null,
    createdAt: article.created_at,
  };
}

/** [regular parts, hotfixes] to apply in order, or null without a regular note. */
export function selectArticles(articles) {
  const infos = articles.filter((a) => !a.is_hidden).map(articleInfo);
  const regular = infos.filter((i) => i.kind === "패치노트");
  if (!regular.length) return null;
  const latest = regular.reduce((a, b) => (b.id > a.id ? b : a));
  const byId = (a, b) => a.id - b.id;
  const parts = regular.filter((i) => i.version === latest.version).sort(byId);
  const last = parts[parts.length - 1].id;
  const hotfixes = infos.filter((i) => i.kind === "핫픽스" && i.id > last).sort(byId);
  return [parts, hotfixes];
}

/** {info: patch metadata, bodies: [article HTML in application order]} */
export async function fetchPatch() {
  const articles = [];
  let page = 1;
  let selected;
  for (;;) {
    const data = JSON.parse(await fetchText(LIST_URL(page)));
    articles.push(...data.articles);
    selected = selectArticles(articles);
    // Stop once an older regular note is listed: all parts of the latest are loaded.
    if (page >= data.total_page || (selected && articles.map(articleInfo).some(
      (i) => i.kind === "패치노트" && i.version !== selected[0][0].version))) break;
    page += 1;
  }
  if (!selected) throw new Error("no regular patch note in the patch-note list");
  const [parts, hotfixes] = selected;
  const applied = [...parts, ...hotfixes];
  const latest = parts[parts.length - 1];
  const d = DATE_RE.exec(latest.title);
  const info = {
    id: latest.id,
    version: latest.version,
    title: latest.title,
    url: latest.url,
    date: d ? `${d[1]}-${d[2]}-${d[3]}` : latest.createdAt.slice(0, 10),
    articles: applied.map((a) => ({ id: a.id, title: a.title, url: a.url })),
  };
  const bodies = [];
  for (const a of applied) bodies.push(await fetchText(a.url));
  return { info, bodies };
}

function entity(match, e) {
  if (e[0] === "#") {
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : match;
  }
  return own(NAMED_ENTITIES, e) ?? match;
}

/** Article body as [[kind, depth, text]] (see fetch_patchnote.py extract_lines). */
export function extractLines(html) {
  const pos = html.indexOf(CONTENT_CLASS);
  if (pos < 0) throw new Error("patch note body not found");
  const lines = [];
  let buf = [];
  let kind = "p";
  let depth = 0;
  let lineDepth = 0;
  const flush = () => {
    const text = buf.join("").replace(SPACE_RE, " ").replace(/^ +| +$/g, "");
    if (text) lines.push([kind, lineDepth, text]);
    buf = [];
  };
  let divs = 0;
  const re = new RegExp(TOKEN_RE.source, "g");
  re.lastIndex = html.lastIndexOf("<", pos);
  for (let m; (m = re.exec(html)) !== null;) {
    if (m[2] === undefined) {
      if (m[0].startsWith("<!--")) continue;
      if (!buf.length) lineDepth = depth;
      buf.push(m[0].replace(ENTITY_RE, entity));
      continue;
    }
    const tag = m[2].toLowerCase();
    const closing = m[1] === "/";
    if (tag === "div") {
      divs += closing ? -1 : 1;
      if (divs === 0) break;
    }
    if (BLOCK_TAGS.has(tag)) {
      flush();
      if (tag === "ul" || tag === "ol") depth += closing ? -1 : 1;
      kind = HEADINGS.has(tag) && !closing ? tag : "p";
    }
  }
  flush();
  return lines;
}

/** [value, isPercent] from NUM groups starting at `first`; percent as 0~1.
 * null outside 1e-4..1e15 (except 0), where Python and JS print floats differently. */
function value(m, first) {
  const pct = m[first + 1] === "%";
  const v = Number(m[first] + (pct ? "e-2" : ""));
  if (v !== 0 && !(v >= 1e-4 && v < 1e15)) return null;
  return [v, pct];
}

/** New value of a CHANGE_RE match, or null when old/new units differ. */
function changeValue(m) {
  return m[3] !== m[5] ? null : value(m, 4);
}

function splitStat(pre, statNames) {
  for (const s of statNames) {
    if (pre.length > s.length + 1 && pre.endsWith(" " + s)) return [pre.slice(0, pre.length - s.length - 1), s];
  }
  return null;
}

class Parser {
  constructor(statNames) {
    this.nameSet = new Set(statNames);
    this.names = [...this.nameSet].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    this.changes = [];
    this.unparsed = [];
  }

  skip(type, name, text) {
    this.unparsed.push({ type, name, text });
  }

  item(name, stat, vp, text) {
    if (vp === null) this.skip("item", name, text);
    else this.changes.push({ type: "item", name, stat, pct: vp[1], value: vp[0], text });
  }

  mastery(name, weapon, rest, text) {
    const m = CHANGE_RE.exec(rest);
    const vp = m ? changeValue(m) : null;
    const field = vp ? own(MASTERY_STATS, `${m[1]}|${vp[1]}`) : undefined;
    if (field === undefined) this.skip("character", name, text);
    else this.changes.push({ type: "character", name, weapon, stat: field, value: vp[0], text });
  }

  parse(html) {
    this.section = this.owner = this.sub = null;
    this.ownerDepth = 0;
    for (const [kind, depth, text] of extractLines(html)) {
      if (kind !== "p") {
        // Any other heading ends the section (e.g. h2 "강화", h3 mode notes).
        this.section = own(SECTIONS, text) ?? null;
        this.owner = this.sub = null;
      } else if (this.section === "item") {
        this.itemLine(depth, text);
      } else if (this.section === "character") {
        this.charLine(depth, text);
      }
    }
  }

  itemLine(depth, text) {
    if (this.owner === null || depth <= this.ownerDepth) {
      this.sub = null;
      if (depth === 0 && !text.includes(ARROW) && !text.includes("(신규") && !text.includes(DELETED)) {
        this.owner = null; // group row
        return;
      }
      this.ownerDepth = depth;
      const m = CHANGE_RE.exec(text);
      const n = m ? null : NEW_STAT_RE.exec(text);
      if (m || n) {
        const pre = (m || n)[1];
        const split = splitStat(pre, this.names);
        if (split === null) {
          this.owner = pre;
          this.skip("item", pre, text);
        } else {
          this.owner = split[0];
          this.item(split[0], split[1], m ? changeValue(m) : value(n, 2), text);
        }
        return;
      }
      if (text.includes(ARROW) || text.includes(DELETED)) {
        this.owner = text;
        this.skip("item", "", text);
        return;
      }
      const ni = NEW_ITEM_RE.exec(text);
      this.owner = ni ? ni[1] : text;
      return;
    }
    const rel = depth - this.ownerDepth;
    if (rel === 1) {
      this.sub = null;
      const m = CHANGE_RE.exec(text);
      const n = m ? null : NEW_STAT_RE.exec(text);
      if ((m || n) && this.nameSet.has((m || n)[1])) {
        this.item(this.owner, (m || n)[1], m ? changeValue(m) : value(n, 2), text);
      } else if (text === STATS_HEADER) {
        this.sub = STATS_HEADER;
      } else if (text.startsWith(RECIPE_PREFIX)) {
        this.sub = text; // recipe changes are not stats
      } else if (marked(text)) {
        this.skip("item", this.owner, text);
      } else {
        this.sub = text;
      }
      return;
    }
    if (this.sub === STATS_HEADER && rel === 2) {
      const m = VALUE_RE.exec(text);
      if (m && this.nameSet.has(m[1])) this.item(this.owner, m[1], value(m, 2), text);
      else this.skip("item", this.owner, text);
      return;
    }
    if (marked(text)) {
      this.skip("item", this.owner, this.sub !== null ? `${this.sub} > ${text}` : text);
    }
  }

  charLine(depth, text) {
    if (depth === 0) {
      this.sub = null;
      if (!SENTENCE_RE.test(text)) {
        this.owner = text;
        this.ownerDepth = 0;
      }
      return;
    }
    if (this.owner === null) return;
    const rel = depth - this.ownerDepth;
    if (rel === 1) {
      this.sub = null;
      // Rows sometimes repeat the name: "아이솔 기본 체력 900 → 920".
      const body = text.startsWith(this.owner + " ") ? text.slice(this.owner.length + 1) : text;
      const mm = MASTERY_RE.exec(body);
      if (mm && mm[2] === undefined) {
        this.sub = mm[1];
      } else if (mm) {
        this.mastery(this.owner, mm[1], mm[2], text);
      } else {
        const m = CHANGE_RE.exec(body);
        const vp = m ? changeValue(m) : null;
        if (vp && !vp[1] && Object.hasOwn(CHAR_BASE, m[1])) {
          this.changes.push({ type: "character", name: this.owner, weapon: null, stat: CHAR_BASE[m[1]],
            value: vp[0], text });
        } else if (text.includes(ARROW) || text.includes(DELETED)) {
          this.skip("character", this.owner, text);
        }
      }
      return;
    }
    if (rel === 2 && this.sub !== null) {
      this.mastery(this.owner, this.sub, text, `${this.sub} 무기 숙련도 레벨 당 > ${text}`);
    }
  }
}

/** {changes, unparsed} over the article bodies in order. */
export function parsePatch(bodies, statNames) {
  const p = new Parser(statNames);
  for (const html of bodies) p.parse(html);
  return { changes: p.changes, unparsed: p.unparsed };
}

function groupByName(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.name)) map.set(r.name, []);
    map.get(r.name).push(r);
  }
  return map;
}

/** Overwrite item stats with patch-note values (later rows win); returns [overrides, unparsed]. */
export function applyItemChanges(items, changes, flat, pct) {
  const rows = groupByName(items);
  const final = new Map();
  const unparsed = [];
  for (const c of changes) {
    if (c.type !== "item") continue;
    if (!rows.has(c.name) || !(c.pct ? pct : flat).has(c.stat)) {
      unparsed.push({ type: "item", name: c.name, text: c.text });
      continue;
    }
    const key = c.pct && flat.has(c.stat) ? c.stat + PCT_SUFFIX : c.stat;
    final.set(JSON.stringify([c.name, key]), c.value);
  }
  const overrides = [];
  for (const [k, value] of final) {
    const [name, key] = JSON.parse(k);
    for (const r of rows.get(name)) {
      const old = Object.hasOwn(r.stats, key) ? r.stats[key] : null;
      if (old !== value) {
        r.stats[key] = value;
        overrides.push({ type: "item", id: r.id, name, stat: key, dakgg: old, patchnote: value });
      }
    }
  }
  return [overrides, unparsed];
}

/** Overwrite character base attack power / mastery ratios (later rows win). */
export function applyCharacterChanges(chars, changes) {
  const rows = groupByName(chars);
  const final = new Map();
  const unparsed = [];
  for (const c of changes) {
    if (c.type !== "character") continue;
    const w = c.weapon;
    if (!rows.has(c.name) || (w !== null && rows.get(c.name).some((r) => !Object.hasOwn(r.masteries, w)))) {
      unparsed.push({ type: "character", name: c.name, text: c.text });
      continue;
    }
    final.set(JSON.stringify([c.name, w, c.stat]), c.value);
  }
  const overrides = [];
  for (const [k, value] of final) {
    const [name, w, stat] = JSON.parse(k);
    for (const r of rows.get(name)) {
      const target = w === null ? r : r.masteries[w];
      if (target[stat] !== value) {
        overrides.push({ type: "character", id: r.id, name,
          stat: w === null ? stat : `masteries.${w}.${stat}`, dakgg: target[stat], patchnote: value });
        target[stat] = value;
      }
    }
  }
  return [overrides, unparsed];
}

/** Stat names from data/items.json keys (CLI only). */
function localStatNames() {
  const names = new Set();
  for (const it of JSON.parse(readFileSync(ITEMS_PATH, "utf8"))) {
    for (const k of Object.keys(it.stats)) {
      names.add(k);
      if (k.endsWith(PCT_SUFFIX)) names.add(k.slice(0, -PCT_SUFFIX.length));
    }
  }
  return names;
}

export function dumps(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const patch = await fetchPatch();
  const parsed = parsePatch(patch.bodies, localStatNames());
  process.stdout.write(Buffer.from(dumps({ patch: patch.info, ...parsed }), "utf8"));
}
