"""Extract item / character stat changes from the latest official patch note.

Host decision: dak.gg is the data source, but where a value differs from the
latest patch note (plus the hotfixes posted after it) the patch note wins.
fetch_items / fetch_characters apply the result; this module only fetches and
parses. Node twin: scripts/fetch_patchnote.mjs (same rules, same output).

Source: https://playeternalreturn.com/posts/news?categoryPath=patchnote
  list  GET LIST_URL (JSON; hl=ko-KR for Korean titles)
  body  GET article url (server-rendered HTML, div.er-article-detail__content)
Usage: python scripts/fetch_patchnote.py  (prints the extracted changes as JSON;
stat names for splitting one-line item rows come from data/items.json)
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

LIST_URL = "https://playeternalreturn.com/api/v1/posts/news?category=patchnote&hl=ko-KR&page={page}"
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept-Language": "ko-KR,ko;q=0.9"}
ITEMS_PATH = Path(__file__).resolve().parent.parent / "data" / "items.json"

# "2026.10.15 - 12.6 패치노트", "[수정] 12.0 패치노트 Part.2 - …", "12.5b 핫픽스"
TITLE_RE = re.compile(r"([0-9]+\.[0-9]+)[a-z]? ?(패치노트|핫픽스)")
DATE_RE = re.compile(r"([0-9]{4})\.([0-9]{2})\.([0-9]{2})")
CONTENT_CLASS = "er-article-detail__content"

# Minimal HTML tokenizer (identical in the .mjs twin; no HTML library there).
TOKEN_RE = re.compile(r"<!--[\s\S]*?-->|<(/?)([A-Za-z][A-Za-z0-9]*)[^>]*>|([^<]+)|<")
BLOCK_TAGS = {"p", "div", "li", "ul", "ol", "br", "table", "tr", "td", "th",
              "h1", "h2", "h3", "h4", "h5", "h6"}
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
ENTITY_RE = re.compile(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z]+);")
NAMED_ENTITIES = {"nbsp": " ", "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "rarr": "→"}
# Includes every line terminator JS regex "." excludes, so both twins match alike.
SPACE_RE = re.compile("[ \t\n\r\f\v\u00a0\u2028\u2029]+")

# Patch-note sections whose rows are parsed; other sections are ignored.
SECTIONS = {"무기": "item", "방어구": "item", "실험체": "character"}
NUM = r"([0-9]+(?:\.[0-9]+)?)(%?)"
CHANGE_RE = re.compile(r"^(.+) " + NUM + " → " + NUM + "$")  # 스탯 이전값 → 새값
NEW_STAT_RE = re.compile(r"^(.+) " + NUM + r" \(신규\)$")  # 치명타 피해량 4% (신규)
VALUE_RE = re.compile(r"^(.+) " + NUM + "$")  # new item "능력치" rows: 공격력 27
NEW_ITEM_RE = re.compile(r"^(.+) \(신규 [^()]*\)$")  # 월왕구천 (신규 전설 등급)
MASTERY_RE = re.compile(r"^(.+?) 무기 숙련도 레벨 당(?: (.+))?$")
SENTENCE_RE = re.compile(r"[.!?다요]$")  # character description paragraphs
ARROW = "→"
DELETED = "(삭제)"  # "<s>쿨다운 감소 10</s> (삭제)": reported, not applied
STATS_HEADER = "능력치"
RECIPE_PREFIX = "조합식"  # "조합식: …" / "조합식 변경: A + B → C + D"
CHAR_BASE = {"기본 공격력": "attackPower", "레벨 당 공격력": "attackPowerPerLevel"}
# (patch-note stat, is percent) -> characters.json mastery field
MASTERY_STATS = {
    ("스킬 증폭", True): "skillAmpRatio",
    ("공격력", True): "attackPowerRatio",
    ("공격 속도", True): "attackSpeedRatio",
    ("기본 공격 증폭", True): "increaseBasicAttackDamageRatio",
    ("공격력", False): "attackPower",
}
PCT_SUFFIX = "율"  # same rule as fetch_items: % variant of a flat stat name


def fetch_text(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def num(value):
    """Integral floats as int so the JSON matches the Node output byte for byte."""
    return int(value) if value.is_integer() else value


def _marked(text):
    """Row that states a change (must be applied or reported)."""
    return ARROW in text or "(신규)" in text or DELETED in text


def article_info(article):
    title = article["i18ns"]["ko_KR"]["title"]
    m = TITLE_RE.search(title)
    return {
        "id": int(article["id"]),
        "title": title,
        "url": article["url"],
        "kind": m.group(2) if m else None,
        "version": m.group(1) if m else None,
        "createdAt": article["created_at"],
    }


def select_articles(articles):
    """(regular parts, hotfixes) to apply in order, or None without a regular note.
    Latest regular = highest id titled "패치노트" (all parts of that version);
    hotfixes = "핫픽스" posts with a higher id, applied oldest first."""
    infos = [article_info(a) for a in articles if not a.get("is_hidden")]
    regular = [i for i in infos if i["kind"] == "패치노트"]
    if not regular:
        return None
    latest = max(regular, key=lambda i: i["id"])
    parts = sorted((i for i in regular if i["version"] == latest["version"]), key=lambda i: i["id"])
    last = parts[-1]["id"]
    hotfixes = sorted((i for i in infos if i["kind"] == "핫픽스" and i["id"] > last), key=lambda i: i["id"])
    return parts, hotfixes


def fetch_patch():
    """{"info": patch metadata, "bodies": [article HTML in application order]}"""
    articles, page = [], 1
    while True:
        data = json.loads(fetch_text(LIST_URL.format(page=page)))
        articles += data["articles"]
        selected = select_articles(articles)
        # Stop once an older regular note is listed: all parts of the latest are loaded.
        if page >= data["total_page"] or selected and any(
                i["kind"] == "패치노트" and i["version"] != selected[0][0]["version"]
                for i in map(article_info, articles)):
            break
        page += 1
    if not selected:
        raise ValueError("no regular patch note in the patch-note list")
    parts, hotfixes = selected
    applied = parts + hotfixes
    latest = parts[-1]
    d = DATE_RE.search(latest["title"])
    info = {
        "id": latest["id"],
        "version": latest["version"],
        "title": latest["title"],
        "url": latest["url"],
        "date": f"{d.group(1)}-{d.group(2)}-{d.group(3)}" if d else latest["createdAt"][:10],
        "articles": [{"id": a["id"], "title": a["title"], "url": a["url"]} for a in applied],
    }
    return {"info": info, "bodies": [fetch_text(a["url"]) for a in applied]}


def _entity(m):
    e = m.group(1)
    if e[0] == "#":
        n = int(e[2:], 16) if e[1] in "xX" else int(e[1:])
        return chr(n) if 0 < n <= 0x10FFFF and not 0xD800 <= n <= 0xDFFF else m.group(0)
    return NAMED_ENTITIES.get(e, m.group(0))


def extract_lines(html):
    """Article body as [(kind, depth, text)]: kind "h1".."h6" or "p",
    depth = <ul>/<ol> nesting, text with entities decoded and spaces collapsed."""
    pos = html.find(CONTENT_CLASS)
    if pos < 0:
        raise ValueError("patch note body not found")
    lines, buf = [], []
    state = {"kind": "p", "depth": 0, "line_depth": 0}

    def flush():
        text = SPACE_RE.sub(" ", "".join(buf)).strip(" ")
        if text:
            lines.append((state["kind"], state["line_depth"], text))
        buf.clear()

    divs = 0
    for m in TOKEN_RE.finditer(html, html.rfind("<", 0, pos)):
        if m.group(2) is None:
            if m.group(0).startswith("<!--"):
                continue
            if not buf:
                state["line_depth"] = state["depth"]
            buf.append(ENTITY_RE.sub(_entity, m.group(0)))
            continue
        tag, closing = m.group(2).lower(), m.group(1) == "/"
        if tag == "div":
            divs += -1 if closing else 1
            if divs == 0:
                break
        if tag in BLOCK_TAGS:
            flush()
            if tag in ("ul", "ol"):
                state["depth"] += -1 if closing else 1
            state["kind"] = tag if tag in HEADINGS and not closing else "p"
    flush()
    return lines


def _value(m, first):
    """(value, is_percent) from NUM groups starting at `first`; percent as 0~1.
    None outside 1e-4..1e15 (except 0), where Python and JS print floats differently."""
    text, pct = m.group(first), m.group(first + 1) == "%"
    v = float(text + ("e-2" if pct else ""))
    if v != 0 and not 1e-4 <= v < 1e15:
        return None
    return num(v), pct


def _change_value(m):
    """New value of a CHANGE_RE match, or None when old/new units differ."""
    if m.group(3) != m.group(5):
        return None
    return _value(m, 4)


def _split_stat(pre, stat_names):
    """'선녀강림 공격 속도' -> ('선녀강림', '공격 속도') using the longest known stat suffix."""
    for s in stat_names:
        if len(pre) > len(s) + 1 and pre.endswith(" " + s):
            return pre[: len(pre) - len(s) - 1], s
    return None


class _Parser:
    def __init__(self, stat_names):
        self.names = sorted(set(stat_names), key=lambda s: (-len(s), s))
        self.name_set = set(stat_names)
        self.changes, self.unparsed = [], []

    def skip(self, kind, name, text):
        self.unparsed.append({"type": kind, "name": name, "text": text})

    def item(self, name, stat, vp, text):
        if vp is None:
            self.skip("item", name, text)
        else:
            self.changes.append({"type": "item", "name": name, "stat": stat, "pct": vp[1],
                                 "value": vp[0], "text": text})

    def mastery(self, name, weapon, rest, text):
        m = CHANGE_RE.match(rest)
        vp = _change_value(m) if m else None
        field = MASTERY_STATS.get((m.group(1), vp[1])) if vp else None
        if field is None:
            self.skip("character", name, text)
        else:
            self.changes.append({"type": "character", "name": name, "weapon": weapon, "stat": field,
                                 "value": vp[0], "text": text})

    def parse(self, html):
        self.section = self.owner = self.sub = None
        self.owner_depth = 0
        for kind, depth, text in extract_lines(html):
            if kind != "p":
                # Any other heading ends the section (e.g. h2 "강화", h3 mode notes).
                self.section = SECTIONS.get(text)
                self.owner = self.sub = None
            elif self.section == "item":
                self.item_line(depth, text)
            elif self.section == "character":
                self.char_line(depth, text)

    def item_line(self, depth, text):
        if self.owner is None or depth <= self.owner_depth:
            self.sub = None
            if depth == 0 and ARROW not in text and "(신규" not in text and DELETED not in text:
                self.owner = None  # group row: 옷 / 머리 / 팔 / 장식 / 도끼 …
                return
            self.owner_depth = depth
            m = CHANGE_RE.match(text)
            n = None if m else NEW_STAT_RE.match(text)
            if m or n:  # one-line row: 아이템명 스탯 이전값 → 새값
                pre = (m or n).group(1)
                split = _split_stat(pre, self.names)
                if split is None:
                    self.owner = pre
                    self.skip("item", pre, text)
                else:
                    self.owner = split[0]
                    self.item(split[0], split[1], _change_value(m) if m else _value(n, 2), text)
                return
            if ARROW in text or DELETED in text:
                self.owner = text
                self.skip("item", "", text)
                return
            n = NEW_ITEM_RE.match(text)
            self.owner = n.group(1) if n else text  # item header row
            return
        rel = depth - self.owner_depth
        if rel == 1:
            self.sub = None
            m = CHANGE_RE.match(text)
            n = None if m else NEW_STAT_RE.match(text)
            if (m or n) and (m or n).group(1) in self.name_set:
                self.item(self.owner, (m or n).group(1), _change_value(m) if m else _value(n, 2), text)
            elif text == STATS_HEADER:
                self.sub = STATS_HEADER
            elif text.startswith(RECIPE_PREFIX):
                self.sub = text  # recipe changes are not stats
            elif _marked(text):
                self.skip("item", self.owner, text)
            else:
                self.sub = text  # e.g. "부패 - [고유 장착 효과]", "조합식: …"
            return
        if self.sub == STATS_HEADER and rel == 2:
            m = VALUE_RE.match(text)
            if m and m.group(1) in self.name_set:
                self.item(self.owner, m.group(1), _value(m, 2), text)
            else:
                self.skip("item", self.owner, text)
            return
        if _marked(text):
            self.skip("item", self.owner, f"{self.sub} > {text}" if self.sub else text)

    def char_line(self, depth, text):
        if depth == 0:
            self.sub = None
            if not SENTENCE_RE.search(text):
                self.owner, self.owner_depth = text, 0  # character name row
            return
        if self.owner is None:
            return
        rel = depth - self.owner_depth
        if rel == 1:
            self.sub = None
            # Rows sometimes repeat the name: "아이솔 기본 체력 900 → 920".
            body = text[len(self.owner) + 1:] if text.startswith(self.owner + " ") else text
            mm = MASTERY_RE.match(body)
            if mm and mm.group(2) is None:
                self.sub = mm.group(1)  # "<무기> 무기 숙련도 레벨 당" header
            elif mm:
                self.mastery(self.owner, mm.group(1), mm.group(2), text)
            else:
                m = CHANGE_RE.match(body)
                vp = _change_value(m) if m else None
                if vp and not vp[1] and m.group(1) in CHAR_BASE:
                    self.changes.append({"type": "character", "name": self.owner, "weapon": None,
                                         "stat": CHAR_BASE[m.group(1)], "value": vp[0], "text": text})
                elif ARROW in text or DELETED in text:
                    self.skip("character", self.owner, text)
            return  # other rows are skill headers; their details are not stats
        if rel == 2 and self.sub is not None:
            self.mastery(self.owner, self.sub, text, f"{self.sub} 무기 숙련도 레벨 당 > {text}")


def parse_patch(bodies, stat_names):
    """{"changes": [...], "unparsed": [...]} over the article bodies in order.
    stat_names: dak.gg item stat names (split one-line item rows, validate rows)."""
    p = _Parser(stat_names)
    for html in bodies:
        p.parse(html)
    return {"changes": p.changes, "unparsed": p.unparsed}


def apply_item_changes(items, changes, flat, pct):
    """Overwrite item stats with patch-note values (later rows win).
    Returns (overrides, unparsed); items are modified in place."""
    rows = {}
    for r in items:
        rows.setdefault(r["name"], []).append(r)
    final, unparsed = {}, []
    for c in changes:
        if c["type"] != "item":
            continue
        if c["name"] not in rows or c["stat"] not in (pct if c["pct"] else flat):
            unparsed.append({"type": "item", "name": c["name"], "text": c["text"]})
            continue
        key = c["stat"] + PCT_SUFFIX if c["pct"] and c["stat"] in flat else c["stat"]
        final[(c["name"], key)] = c["value"]
    overrides = []
    for (name, key), value in final.items():
        for r in rows[name]:
            old = r["stats"].get(key)
            if old != value:
                r["stats"][key] = value
                overrides.append({"type": "item", "id": r["id"], "name": name, "stat": key,
                                  "dakgg": old, "patchnote": value})
    return overrides, unparsed


def apply_character_changes(chars, changes):
    """Overwrite character base attack power / mastery ratios (later rows win)."""
    rows = {}
    for r in chars:
        rows.setdefault(r["name"], []).append(r)
    final, unparsed = {}, []
    for c in changes:
        if c["type"] != "character":
            continue
        w = c["weapon"]
        if c["name"] not in rows or (w is not None and any(w not in r["masteries"] for r in rows[c["name"]])):
            unparsed.append({"type": "character", "name": c["name"], "text": c["text"]})
            continue
        final[(c["name"], w, c["stat"])] = c["value"]
    overrides = []
    for (name, w, stat), value in final.items():
        for r in rows[name]:
            target = r if w is None else r["masteries"][w]
            if target[stat] != value:
                overrides.append({"type": "character", "id": r["id"], "name": name,
                                  "stat": stat if w is None else f"masteries.{w}.{stat}",
                                  "dakgg": target[stat], "patchnote": value})
                target[stat] = value
    return overrides, unparsed


def local_stat_names():
    """Stat names from data/items.json keys (CLI only; the fetchers use dak.gg raw names)."""
    names = set()
    for it in json.loads(ITEMS_PATH.read_text(encoding="utf-8")):
        for k in it["stats"]:
            names.add(k)
            if k.endswith(PCT_SUFFIX):
                names.add(k[: -len(PCT_SUFFIX)])
    return names


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def main():
    patch = fetch_patch()
    parsed = parse_patch(patch["bodies"], local_stat_names())
    sys.stdout.buffer.write(dumps({"patch": patch["info"], **parsed}).encode("utf-8"))


if __name__ == "__main__":
    sys.exit(main())
