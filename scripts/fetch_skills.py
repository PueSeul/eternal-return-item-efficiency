"""Fetch skill damage coefficients from namu.wiki and write data/skills.json.

Host decision: namu.wiki is the source. A patch-note row that differs from the
wiki value overwrites it only when the wiki document was last revised before
the patch note was posted (a wiki edited after the patch keeps its value).
Node twin: scripts/fetch_skills.mjs (same rules, byte-identical output).

Source: https://namu.wiki/w/<실험체명>(이터널 리턴) (falls back to /w/<실험체명>
when that title does not exist), server-rendered HTML. Every request (redirect
hops included) is checked against https://namu.wiki/robots.txt and spaced at
least REQUEST_INTERVAL seconds apart. Content license: CC BY-NC-SA 2.0 KR.
Usage: python scripts/fetch_skills.py  (characters from data/characters.json,
latest patch note applied; writes data/skills.json)
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import fetch_patchnote as pn

WIKI = "https://namu.wiki"
ROBOTS_URL = WIKI + "/robots.txt"
AGENT = "er-damage-efficiency"  # robots.txt product token
HEADERS = {"User-Agent": AGENT + "/1.0 (skill coefficient fetcher)", "Accept-Language": "ko-KR,ko;q=0.9"}
DOC_SUFFIX = "(이터널 리턴)"
REQUEST_INTERVAL = 1.0  # seconds between namu.wiki requests
MAX_REDIRECTS = 5
REDIRECT_CODES = {301, 302, 303, 307, 308}
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUT_PATH = DATA_DIR / "skills.json"
CHARACTERS_PATH = DATA_DIR / "characters.json"
WS = " \t\n\r\v\f"

# --- page parsing -----------------------------------------------------------
REVISED_RE = re.compile("최근 수정 시각:[ \t\n\r]*<time datetime=[\"']([^\"']+)[\"']")
ALT_RE = re.compile("[ \t\n\r]alt=(?:'([^']*)'|\"([^\"]*)\")")
RAW_TEXT_END = {"script": re.compile("</script", re.I), "style": re.compile("</style", re.I)}
BLOCK_TAGS = pn.BLOCK_TAGS | {"hr"}
HEADING_NUM_RE = re.compile(r"^[0-9]+(?:\.[0-9]+)*\. ")
EDIT_SUFFIX = "[편집]"
SKILL_SECTION, HISTORY_SECTION = "스킬", "역사"
SKILL_HEADING_RE = re.compile("^(패시브|Q|W|E|R|무기 스킬) - (.+)$")
GROUP_KEYS = {"패시브": "P", "Q": "Q", "W": "W", "E": "E", "R": "R", "무기 스킬": "D"}
NUM = "[0-9]+(?:\\.[0-9]+)?"
# Value row: "[샤마쉬의 법전] 주문 피해량 [160 / 240 / 320] (+스킬 증폭의 80%)",
# "2타 피해량 [공격력의 55% / 60% / 65%] * (기본 공격 증폭)". Groups: tag, label, body, rest.
ROW_RE = re.compile(r"^(?:\[([^\[\]]+)\] )?([^\[\]]+?) \[([^\[\]]+)\](.*)$")
NUM_BODY_RE = re.compile("^" + NUM + "%?(?: / " + NUM + "%?)*$")
STAT_BODY_RE = re.compile("^(.+?)의 (" + NUM + "%(?: / " + NUM + "%)*)$")
MULT_RE = re.compile(r"^ ?\* ?\(([^()]*)\)$")
DAMAGE_ROW_RE = re.compile(r"피해량[^\[]*\[(?![0-9]+\])")  # damage row the row pattern may not read
FOOTNOTE_RE = re.compile(r"(?<=[)\]])\[[0-9]+\]")  # "… (+스킬 증폭의 60%)[3]"
PAREN_RE = re.compile(r"\(([^()]*)\)")
# Coefficients (text inside the parentheses); ratio = damage per stat unit:
# "+스킬 증폭의 80%", "+공격력의 14% / 16% / 18%" (wiki), "+공격력의 170/175/180%" (patch note)
COEF_RE = re.compile("^\\+(.+?)의? ([0-9]+(?:\\.[0-9]+)?%?(?: ?/ ?[0-9]+(?:\\.[0-9]+)?%?)*)$")
COEF_PER_RE = re.compile("^\\+(.+?) (" + NUM + ")(%?) ?당 (" + NUM + ")(%?)$")  # "+스킬 증폭 25 당 1"
COEF_MUL_RE = re.compile("^\\+(.+?) ?\\* ?(" + NUM + "(?: / " + NUM + ")*)$")  # "+레니 레벨 * 8", "+펠릭스 레벨*3"
COEF_EACH_RE = re.compile("^\\+(.+?) 당 (?:피해량 )?(" + NUM + "(?: / " + NUM + ")*)$")  # "+소모한 기력 당 2"
COEF_NAME_RE = re.compile(r"^\+([^0-9%()]+)$")  # "+야성 중첩" (amount not given)
RATIO_FIELDS = {"공격력": "attackPowerRatio", "스킬 증폭": "skillAmpRatio"}
LEVEL_FIELDS = ("baseDamage", "attackPowerRatio", "skillAmpRatio")
NOT_DAMAGE_RE = re.compile("감소|증가")  # "받는 피해량 감소(%)" without a coefficient is no damage
PERCENT_BASE = "기본값(%)"  # extra-ratio name of a percent base without a row label
# History: "님루드의 비석(E)의 스킬 증폭 계수가 60%로 증가했다", "(W)의 피해량이 60/80/100(+스킬 증폭의 45%)로"
KEY_MENTION_RE = re.compile(r"\(([A-Z][A-Z0-9-]*)\)")
HISTORY_KEYS = {"P", "Q", "W", "E", "R", "RQ", "RW", "RE"}
HISTORY_RATIO_RE = re.compile("(스킬 증폭|스증|공격력|공) ?계수(?:가|는|를|도)? (?:[0-9]+(?:\\.[0-9]+)?%에서 )?"
                              "([0-9]+(?:\\.[0-9]+)?)%(?:\\([^()]*\\))?(?:으로|로)")
# The new list must not itself be followed by "에서" (then it is the old value).
HISTORY_BASE_RE = re.compile("피해량이 (?:[0-9./]+(?:\\([^()]*\\))*에서 )?"
                             "([0-9]+(?:\\.[0-9]+)?(?:/[0-9]+(?:\\.[0-9]+)?)+)(?![0-9./]*(?:\\([^()]*\\))*에서)"
                             "((?:\\([^()]*\\))*)")
TAG_PREFIX_RE = re.compile(r"^(?:\[[^\[\]]+\] )?")
HISTORY_STATS = {"스킬 증폭": "skillAmpRatio", "스증": "skillAmpRatio", "공격력": "attackPowerRatio",
                 "공": "attackPowerRatio"}
# Patch-note side: "70/110/150(+스킬 증폭의 80%)"
PATCH_VALUES_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)?(?:/[0-9]+(?:\.[0-9]+)?)*)((?:\([^()]*\))*)$")
TIME_RE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?"
                     r"(Z|[+-][0-9]{2}:[0-9]{2})$")
UNRESERVED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
HEX = set("0123456789abcdefABCDEF")


def _strip(s):
    return s.strip(WS)


def _number(text):
    """Decimal text -> int/float, or None outside 1e-4..1e15 (except 0), where
    Python and JS print floats differently."""
    v = float(text)
    if v == 0:
        return None if re.search("[1-9]", text.split("e")[0]) else 0  # underflow is not zero
    return pn.num(v) if 1e-4 <= v < 1e15 else None


def _ratio(text):
    """'80' -> 0.8 (percent text shifted by 100, correctly rounded like the JS twin), or None."""
    return _number(text + "e-2")


def page_lines(html):
    """Document as [(kind, text, in_table)]: kind "h1".."h6" (heading), "img" (image
    inside a table, text = alt) or "p" (text line); script/style bodies skipped."""
    out, buf = [], []
    state = {"kind": "p", "tables": 0}

    def flush():
        text = pn.SPACE_RE.sub(" ", "".join(buf)).strip(" ")
        if text:
            out.append((state["kind"], text, state["tables"] > 0))
        buf.clear()

    pos = 0
    while pos < len(html):
        m = pn.TOKEN_RE.match(html, pos)
        pos = m.end()
        if m.group(2) is None:
            if not m.group(0).startswith("<!--"):
                buf.append(pn.ENTITY_RE.sub(pn._entity, m.group(0)))
            continue
        tag, closing = m.group(2).lower(), m.group(1) == "/"
        if tag in RAW_TEXT_END and not closing:
            end = RAW_TEXT_END[tag].search(html, pos)
            pos = end.start() if end else len(html)
            continue
        if tag == "img" and state["tables"] > 0:
            a = ALT_RE.search(m.group(0))
            if a:
                flush()
                alt = a.group(1) if a.group(1) is not None else a.group(2)
                out.append(("img", pn.ENTITY_RE.sub(pn._entity, alt), True))
        if tag == "table":
            flush()
            state["tables"] = max(0, state["tables"] + (-1 if closing else 1))
        if tag in BLOCK_TAGS:
            flush()
            state["kind"] = tag if tag in pn.HEADINGS and not closing else "p"
    flush()
    return out


def heading_title(text):
    """'4.2. Q - 샤마쉬의 두루마리[편집]' -> 'Q - 샤마쉬의 두루마리'"""
    if text.endswith(EDIT_SUFFIX):
        text = text[: -len(EDIT_SUFFIX)]
    return _strip(HEADING_NUM_RE.sub("", text, count=1))


def sections(lines, title):
    """[lines] under every heading titled `title` (until the next heading of the same or higher level)."""
    found = []
    for i, (kind, text, _) in enumerate(lines):
        if kind in pn.HEADINGS and heading_title(text) == title:
            j = i + 1
            while j < len(lines) and not (lines[j][0] in pn.HEADINGS and lines[j][0] <= kind):
                j += 1
            found.append(lines[i + 1: j])
    return found


def _coef_values(text):
    """'25% / 35%' or '170/175%' -> [0.25, 0.35] / [1.7, 1.75], or None (out of range)."""
    values = [_ratio(_strip(v).rstrip("%")) for v in text.split("/")]
    return None if None in values else values


def parse_coef(coef):
    """(stat, [ratio per level], is_percent, None) or (None, None, None, reason) for one
    coefficient. ratio is damage per stat unit (None: amount not given, "+야성 중첩")."""
    m = COEF_PER_RE.match(coef)
    if m:
        if m.group(3) != m.group(5):
            return None, None, None, f"계수 형식 미해석: ({coef})"
        a, b = _number(m.group(2)), _number(m.group(4))
        v = pn.num(b / a) if a and b is not None else None
        if v is None or not (v == 0 or 1e-4 <= v < 1e15):
            return None, None, None, "수치 범위"
        return m.group(1), [v], False, None
    for rx in (COEF_MUL_RE, COEF_EACH_RE):
        m = rx.match(coef)
        if m:
            values = [_number(v) for v in m.group(2).split(" / ")]
            stat = m.group(1)[:-2] if m.group(1).endswith(" 당") else m.group(1)  # "+고통 중첩 당 * 8"
            return (stat, values, False, None) if None not in values else (None, None, None, "수치 범위")
    m = COEF_RE.match(coef)
    if m and m.group(2).endswith("%"):
        values = _coef_values(m.group(2))
        return (m.group(1), values, True, None) if values is not None else (None, None, None, "수치 범위")
    m = COEF_NAME_RE.match(coef)
    if m:
        return _strip(m.group(1)), [None], False, None
    return None, None, None, f"계수 형식 미해석: ({coef})"


def _split_nested(coef):
    """'+A의 4 / 7(+B의 2%)%' -> ('+A의 4 / 7%', ['+B의 2%']), or None (unbalanced)."""
    outer, inners, depth, start = [], [], 0, 0
    for i, ch in enumerate(coef):
        if ch == "(":
            depth += 1
            if depth == 1:
                start = i + 1
                continue
        elif ch == ")":
            depth -= 1
            if depth < 0:
                return None
            if depth == 0:
                inners.append(coef[start:i])
                continue
        if depth == 0:
            outer.append(ch)
    return ("".join(outer), inners) if depth == 0 else None


def coef_tree(coef):
    """(stat, ratios, is_percent, nested, None) or (None, None, None, None, reason). A
    coefficient parse_coef cannot read may carry nested coefficients that scale its amount
    ("+대상 현재 체력의 8%(+스킬 증폭의 2%)"): nested is [(stat, ratios, nested)], read recursively."""
    stat, vals, is_pct, reason = parse_coef(coef)
    if reason is None:
        return stat, vals, is_pct, [], None
    split = _split_nested(coef)
    if split is None or not split[1]:
        return None, None, None, None, reason
    stat, vals, is_pct, reason = parse_coef(split[0])
    if reason:
        return None, None, None, None, reason
    nested = []
    for inner in split[1]:
        s, v, _, n, r = coef_tree(inner)
        if r:
            return None, None, None, None, r
        nested.append((s, v, n))
    return stat, vals, is_pct, nested, None


def _nested_lists(nested):
    return [x for _, v, n in nested for x in [v] + _nested_lists(n)]


def _ratio_entry(stat, vals, nested, pick, i):
    entry = {"stat": stat, "ratio": pick(vals, i)}
    if nested:
        entry["nested"] = [_ratio_entry(s, v, n, pick, i) for s, v, n in nested]
    return entry


def levels_from(values, coefs, label=PERCENT_BASE):
    """(levels, None) or (None, reason) for one value row: values ['70', '110', …] (or
    ['6%', …]: percent base, or []: no base), coefs ['+스킬 증폭의 80%', …] (text inside the
    parentheses). 공격력/스킬 증폭 percentages fill attackPowerRatio/skillAmpRatio; every
    other coefficient goes to the level's extraRatios [{stat, ratio, nested?}] (nested: the
    coefficients inside it, "(+대상 최대 체력의 4 / 7(+추가 공격력의 4%)%)"). A percent base
    ("최대 체력 피해량(%) [6% / 10%]") is baseDamage 0 plus a first extra ratio named by the
    row label (the calculator shows extra ratios and fills baseDamage)."""
    pct = [v.endswith("%") for v in values]
    if any(pct) and not all(pct):
        return None, "형식 미해석"
    percent = bool(values) and all(pct)
    base = [(_ratio if percent else _number)(v.rstrip("%")) for v in values] or [0]
    if None in base:
        return None, "수치 범위"
    ratios, extras = {}, [(label, base, [])] if percent else []
    if percent:
        base = [0]
    for coef in coefs:
        stat, vals, is_pct, nested, reason = coef_tree(coef)
        if reason:
            return None, reason
        field = RATIO_FIELDS.get(stat) if is_pct and not nested else None
        if field is None:
            extras.append((stat, vals, nested))
        elif field in ratios:
            return None, f"계수 중복: {stat}"
        else:
            ratios[field] = vals
    lists = [base] + list(ratios.values()) + _nested_lists(extras)
    n = max(len(x) for x in lists)
    if any(len(x) not in (1, n) for x in lists):
        return None, "레벨 수 불일치"
    pick = lambda xs, i: xs[i] if len(xs) > 1 else xs[0]  # noqa: E731
    levels = []
    for i in range(n):
        level = {"level": i + 1, "baseDamage": pick(base, i),
                 "attackPowerRatio": pick(ratios.get("attackPowerRatio", [0]), i),
                 "skillAmpRatio": pick(ratios.get("skillAmpRatio", [0]), i)}
        if extras:
            level["extraRatios"] = [_ratio_entry(s, v, n, pick, i) for s, v, n in extras]
        levels.append(level)
    return levels, None


def _groups(rest):
    """' (+a) (+b(+c)) * (m)' -> (['+a', '+b(+c)'], 'm'), or None when not of that form."""
    groups, pos = [], 0
    while pos < len(rest):
        m = MULT_RE.match(rest[pos:])
        if m:
            return groups, m.group(1)
        if rest.startswith(" (", pos):
            pos += 1
        if not rest.startswith("(", pos):
            return None
        depth, end = 0, pos
        while end < len(rest):
            depth += {"(": 1, ")": -1}.get(rest[end], 0)
            if depth == 0:
                break
            end += 1
        if depth != 0:
            return None
        groups.append(rest[pos + 1: end])
        pos = end + 1
    return groups, None


def _value_line(text):
    """Value row as {tag, label, body, values, coefs, multiplier} (values [] and the body as
    the first coefficient for "[공격력의 55% / 60%]"), or None (no row / unreadable rest:
    then "unreadable" is True when it still looks like a damage row)."""
    m = ROW_RE.match(FOOTNOTE_RE.sub("", text))
    if not m:
        return None
    g = _groups(m.group(4))
    body = m.group(3)
    row = {"tag": m.group(1), "label": m.group(2), "values": None, "coefs": None, "multiplier": None}
    if g is not None:
        row["coefs"], row["multiplier"] = g
        s = STAT_BODY_RE.match(body)
        if NUM_BODY_RE.match(body):
            row["values"] = body.split(" / ")
        elif s:
            row["values"], row["coefs"] = [], ["+" + s.group(1) + "의 " + s.group(2)] + row["coefs"]
    return row


def _is_damage(row, text):
    """Damage entry: a value row with a "+" coefficient, a damage label (not 감소/증가 alone)
    or a stat body."""
    plus = "(+" in text
    if row is None:
        return DAMAGE_ROW_RE.search(text) is not None
    if plus or (row["values"] == [] and row["coefs"] is not None):
        return True
    return "피해" in row["label"] and not NOT_DAMAGE_RE.search(row["label"])


def _valueish(text):
    row = _value_line(text)
    return (row is not None and row["values"] is not None) or _is_damage(row, text)


def _sub_skills(group_lines, letter):
    """Split a skill heading's table rows into sub-skills: a run of images starts one.
    Value rows before the first image form an unnamed first sub-skill."""
    subs, prev_img = [], False
    for kind, text, in_table in group_lines:
        if not in_table or kind in pn.HEADINGS:
            continue
        if kind == "img":
            if not prev_img:
                subs.append({"alts": [], "lines": []})
            subs[-1]["alts"].append(text)
            prev_img = True
            continue
        prev_img = False
        if not subs:
            if not _valueish(text):
                continue
            subs.append({"alts": [], "lines": []})
        subs[-1]["lines"].append(text)
    # Later image rows without any value row are illustrations (e.g. interaction tables).
    subs = [s for i, s in enumerate(subs) if i == 0 or any(_valueish(t) for t in s["lines"])]
    keys, used = [], set()
    for s in subs:
        ult = "R" + letter
        base = ult if letter in "QWE" and any(a.split(" ")[-1].upper() == ult for a in s["alts"]) else letter
        key, n = base, 1
        while key in used:
            n += 1
            key = f"{base}{n}"
        used.add(key)
        keys.append(key)
    return subs, keys


def _parse_skill(key, name, lines):
    """(skill, needsReview rows, [(entry, value row)]) for one sub-skill. Every damage row
    becomes an entry {label ("[태그] 라벨" as written), levels, raw, multiplier?}; an
    unreadable one keeps levels [] and goes to needsReview. levels/raw/sourceLabel of the
    skill repeat the first entry (earlier schema)."""
    review, entries, rows = [], [], []
    for text in lines:
        row = _value_line(text)
        if not _is_damage(row, text):
            continue
        if row is None or row["values"] is None:
            review.append({"skill": key, "text": text, "reason": "형식 미해석"})
            if row is None:
                continue
            levels = None
        else:
            levels, reason = levels_from(row["values"], row["coefs"], row["label"])
            if levels is None:
                review.append({"skill": key, "text": text, "reason": reason})
        e = {"label": (f"[{row['tag']}] " if row["tag"] else "") + row["label"], "levels": levels or [], "raw": text}
        if row["multiplier"]:
            e["multiplier"] = row["multiplier"]
        entries.append(e)
        if levels is not None:
            rows.append((e, row))
    first = entries[0] if entries else {"label": None, "levels": [], "raw": None}
    skill = {"key": key, "name": name, "levels": first["levels"], "raw": first["raw"],
             "sourceLabel": first["label"], "entries": entries}
    return skill, review, rows


def _history_records(lines):
    """[(key, field or "baseDamage", value, line)] in document order (out-of-range values dropped)."""
    records = []
    for kind, text, _ in lines:
        if kind != "p":
            continue
        mentions = list(KEY_MENTION_RE.finditer(text))
        for i, m in enumerate(mentions):
            key = m.group(1).replace("-", "")
            if key not in HISTORY_KEYS:
                continue
            clause = text[m.end(): mentions[i + 1].start() if i + 1 < len(mentions) else len(text)]
            found = []  # (position in clause, field, value)
            for r in HISTORY_RATIO_RE.finditer(clause):
                found.append((r.start(), HISTORY_STATS[r.group(1)], _ratio(r.group(2))))
            for b in HISTORY_BASE_RE.finditer(clause):
                base = [_number(x) for x in b.group(1).split("/")]
                found.append((b.start(), "baseDamage", None if None in base else base))
                coefs_at = b.end() - len(b.group(2))
                for p in PAREN_RE.finditer(b.group(2)):
                    c = COEF_RE.match(p.group(1))
                    if c and c.group(1) in RATIO_FIELDS and "/" not in c.group(2):
                        found.append((coefs_at + p.start(), RATIO_FIELDS[c.group(1)], _ratio(c.group(2).rstrip("%"))))
            found.sort(key=lambda f: f[0])
            records += [(key, field, value, text) for _, field, value in found if value is not None]
    return records


def _fmt(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def history_mismatches(rows_by_key, lines):
    """[(key, message)] where the latest history record disagrees with every value of the
    skill box (the box value is kept; the entries get a historyMismatch mark)."""
    last = {}
    for key, field, value, text in _history_records(lines):
        last[(key, field)] = (value, text)
    found = []
    for (key, field), (value, text) in last.items():
        known = []
        for _, v in rows_by_key.get(key, []):
            if field == "baseDamage":
                base = [_number(x) for x in v["values"]] if not any(x.endswith("%") for x in v["values"]) else [None]
                if base and None not in base:
                    known.append(base)
                continue
            for coef in v["coefs"]:
                c = COEF_RE.match(coef)
                if c and c.group(2).endswith("%") and RATIO_FIELDS.get(c.group(1)) == field:
                    known += _coef_values(c.group(2)) or []
        if known and value not in known:
            found.append((key, f"{field} 설명란 {_fmt(known)}, 역사 마지막 {_fmt(value)}: {text}"))
    return found


def parse_page(character_id, name, html):
    """skills.json entry for one character (html None: document not found)."""
    entry = {"characterId": character_id, "name": name, "skills": [], "wikiRevisedAt": None, "needsReview": []}
    if html is None:
        entry["needsReview"].append({"skill": None, "text": doc_url(name + DOC_SUFFIX), "reason": "문서 없음"})
        return entry
    rev = REVISED_RE.search(html)
    entry["wikiRevisedAt"] = rev.group(1) if rev else None
    if rev is None:
        entry["needsReview"].append({"skill": None, "text": "", "reason": "최근 수정 시각 없음"})
    lines = page_lines(html)
    skill_sections = sections(lines, SKILL_SECTION)
    if not skill_sections:
        entry["needsReview"].append({"skill": None, "text": "", "reason": "스킬 문단 없음"})
        return entry
    rows_by_key = {}
    sec = skill_sections[0]
    i = 0
    while i < len(sec):
        kind, text, _ = sec[i]
        m = SKILL_HEADING_RE.match(heading_title(text)) if kind in pn.HEADINGS else None
        if not m:
            i += 1
            continue
        j = i + 1
        while j < len(sec) and not (sec[j][0] in pn.HEADINGS and sec[j][0] <= kind):
            j += 1
        subs, keys = _sub_skills(sec[i + 1: j], GROUP_KEYS[m.group(1)])
        names = m.group(2).split(" / ")
        for n, (sub, key) in enumerate(zip(subs, keys)):
            skill, review, rows = _parse_skill(key, names[n] if len(names) == len(subs) else m.group(2), sub["lines"])
            entry["skills"].append(skill)
            entry["needsReview"] += review
            rows_by_key.setdefault(key, []).extend(rows)
        i = j
    for key, message in history_mismatches(rows_by_key, [l for s in sections(lines, HISTORY_SECTION) for l in s]):
        for e, _ in rows_by_key[key]:
            mark = e.setdefault("historyMismatch", {"text": ""})
            mark["text"] += ("\n" if mark["text"] else "") + message
    return entry


# --- robots.txt ---------------------------------------------------------------
def encode_title(title):
    """Percent-encode a document title (same bytes as the JS twin)."""
    return urllib.parse.quote(title, safe="")


def doc_url(title):
    return WIKI + "/w/" + encode_title(title)


def robots_normalize(s):
    """Percent-encoding normal form for robots matching (RFC 9309 2.2.2): non-ASCII
    as UTF-8 %XX, %XX of unreserved characters decoded, hex upper-case."""
    chars, out, i = list(s), [], 0
    while i < len(chars):
        ch = chars[i]
        if ch == "%" and i + 2 < len(chars) and chars[i + 1] in HEX and chars[i + 2] in HEX:
            c = chr(int(chars[i + 1] + chars[i + 2], 16))
            out.append(c if c in UNRESERVED else "%" + (chars[i + 1] + chars[i + 2]).upper())
            i += 3
            continue
        if ord(ch) > 127:
            out += ["%%%02X" % b for b in ch.encode("utf-8")]
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def parse_robots(text, agent=AGENT):
    """[(allow, pattern)] of the groups naming `agent` (case-insensitive), else of the
    "User-agent: *" groups. Patterns are percent-normalized."""
    groups, cur = [], None
    for raw in text.split("\n"):
        line = _strip(raw.split("#", 1)[0])
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = _strip(key).lower(), _strip(value)
        if key == "user-agent":
            if cur is None or cur["closed"]:
                cur = {"agents": [], "rules": [], "closed": False}
                groups.append(cur)
            cur["agents"].append(value.lower())
        elif key in ("allow", "disallow") and cur is not None:
            cur["closed"] = True  # an empty Disallow still ends the user-agent list
            if value:
                cur["rules"].append((key == "allow", robots_normalize(value)))
    own = [g for g in groups if agent.lower() in g["agents"]]
    return [r for g in (own or [g for g in groups if "*" in g["agents"]]) for r in g["rules"]]


def _robots_match(pattern, path):
    anchored = pattern.endswith("$")
    parts = (pattern[:-1] if anchored else pattern).split("*")
    if not path.startswith(parts[0]):
        return False
    pos = len(parts[0])
    if len(parts) == 1:
        return not anchored or pos == len(path)
    for part in parts[1:-1]:
        i = path.find(part, pos)
        if i < 0:
            return False
        pos = i + len(part)
    last = parts[-1]
    if anchored:
        return len(path) - len(last) >= pos and path.endswith(last)
    return path.find(last, pos) >= 0


def _remove_dot_segments(path):
    """RFC 3986 5.2.4 on a normalized path (what the JS URL parser does for the twin)."""
    out = []
    segs = path.split("/")
    for i, seg in enumerate(segs[1:], 1):
        last = i == len(segs) - 1
        if seg == "..":
            if out:
                out.pop()
            if last:
                out.append("")
        elif seg == ".":
            if last:
                out.append("")
        else:
            out.append(seg)
    return "/" + "/".join(out)


def robots_allowed(rules, url):
    """Longest matching rule wins, Allow on ties; no match = allowed."""
    u = urllib.parse.urlsplit(url)
    path = _remove_dot_segments(robots_normalize(u.path or "/")) + robots_normalize("?" + u.query if u.query else "")
    best = None
    for allow, pattern in rules:
        if _robots_match(pattern, path):
            cand = (len(pattern), allow)
            if best is None or cand > best:
                best = cand
    return best is None or best[1]


# --- fetching -----------------------------------------------------------------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # fetch_pages follows redirects itself (robots check + interval per hop)


_OPENER = urllib.request.build_opener(_NoRedirect)


def fetch_page(url):
    """One request, redirects not followed: {"status", "body", "location"}.
    200, 404 and redirects are returned; other errors raise."""
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with _OPENER.open(req, timeout=30) as resp:
            return {"status": resp.status, "body": resp.read().decode("utf-8"), "location": None}
    except urllib.error.HTTPError as e:
        with e:
            if e.code == 404:
                return {"status": 404, "body": "", "location": None}
            if e.code in REDIRECT_CODES:
                return {"status": e.code, "body": "", "location": e.headers.get("Location")}
            raise


class _Throttle:
    def __init__(self, interval):
        self.interval, self.last = interval, None

    def wait(self):
        if self.last is not None:
            left = self.interval - (time.monotonic() - self.last)
            if left > 0:
                time.sleep(left)
        self.last = time.monotonic()


def _resolve(base, location):
    """Absolute ASCII URL of a redirect target."""
    return urllib.parse.quote(urllib.parse.urljoin(base, location), safe=":/?#[]@!$&'()*+,;=%")


def _get(url, rules, throttle):
    """Final page after following redirects (each hop robots-checked and throttled)."""
    for _ in range(MAX_REDIRECTS + 1):
        if not robots_allowed(rules, url):
            raise ValueError(f"robots.txt disallows {url}")
        throttle.wait()
        page = fetch_page(url)
        if page["status"] not in REDIRECT_CODES:
            return page
        if not page["location"]:
            raise ValueError(f"redirect without Location from {url}")
        url = _resolve(url, page["location"])
    raise ValueError(f"too many redirects from {url}")


def fetch_pages(names, interval=None):
    """{name: document HTML or None} for the characters, robots.txt respected."""
    throttle = _Throttle(REQUEST_INTERVAL if interval is None else interval)
    robots = _get(ROBOTS_URL, [], throttle)
    rules = parse_robots(robots["body"]) if robots["status"] == 200 else []
    pages = {}
    for name in names:
        pages[name] = None
        for title in (name + DOC_SUFFIX, name):
            page = _get(doc_url(title), rules, throttle)
            if page["status"] != 404:
                pages[name] = page["body"]
                break
    return pages


def build_skills(chars, pages, previous=None):
    """skills.json content (wiki values only) for the built characters. With previous
    ({name: earlier skills.json entry}), characters missing from pages keep that entry."""
    return [parse_page(c["id"], c["name"], pages.get(c["name"]))
            if previous is None or c["name"] in pages else previous[c["name"]] for c in chars]


def patched_names(parsed, names):
    """Characters (in names order) with a section in the parsed patch note, whether or not
    its rows are read (e.g. a cooldown-only change)."""
    mentioned = set(parsed["characters"])
    return [n for n in names if n in mentioned]


def plan_pages(mode, parsed, names, previous):
    """(mode, names to read, previous or None). "patched" reads only characters the patch
    note mentions plus ones missing from previous; it falls back to "all" without previous
    skills.json or without any character in the patch note."""
    patched = patched_names(parsed, names) if mode == "patched" and previous is not None else []
    if not patched:
        return "all", list(names), None
    return "patched", [n for n in names if n in patched or n not in previous], previous


# --- patch-note overrides ---------------------------------------------------
def instant(text):
    """ISO time -> (epoch seconds, fraction digits), or None when malformed/out of range."""
    m = TIME_RE.match(text or "")
    if not m:
        return None
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    leap = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    month_days = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if not (1 <= mo <= 12 and 1 <= d <= month_days[mo - 1] and h < 24 and mi < 60 and s < 60):
        return None
    off = 0
    if m.group(8) != "Z":
        oh, om = int(m.group(8)[1:3]), int(m.group(8)[4:6])
        if oh > 23 or om > 59:
            return None
        off = (1 if m.group(8)[0] == "+" else -1) * (oh * 60 + om)
    yy = y - (mo <= 2)  # days from civil (proleptic Gregorian)
    era = yy // 400
    yoe = yy - era * 400
    doy = (153 * (mo + (-3 if mo > 2 else 9)) + 2) // 5 + d - 1
    days = era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468
    return ((days * 24 + h) * 60 + mi - off) * 60 + s, m.group(7) or ""


def is_before(a, b):
    """True when ISO time a is strictly earlier than b (False if either is unreadable)."""
    ia, ib = instant(a), instant(b)
    if ia is None or ib is None:
        return False
    if ia[0] != ib[0]:
        return ia[0] < ib[0]
    n = max(len(ia[1]), len(ib[1]))
    return ia[1].ljust(n, "0") < ib[1].ljust(n, "0")


def patch_levels(text):
    """(levels, reason) for one side of a patch-note row: '70/110/150(+스킬 증폭의 80%)'."""
    m = PATCH_VALUES_RE.match(text)
    if not m:
        return None, "형식 미해석"
    return levels_from(m.group(1).split("/"), PAREN_RE.findall(m.group(2)))


def _flat(level):
    """Level row as [(field, value)]: the three level fields, then "extraRatios.<stat>"
    per extra coefficient ("extraRatios.<stat>.<nested stat>" per nested one)."""
    out = [(f, level.get(f)) for f in LEVEL_FIELDS]

    def walk(prefix, xs):
        for x in xs:
            out.append((prefix + str(x.get("stat")), x.get("ratio")))
            walk(prefix + str(x.get("stat")) + ".", x.get("nested", []))
    walk("extraRatios.", level.get("extraRatios", []))
    return out


def _same_levels(a, b):
    key = lambda ls: [(l.get("level"), _flat(l)) for l in ls]  # noqa: E731
    return key(a) == key(b)


def _field_changes(old, new):
    """[(level, field, old value, new value)] where the level rows differ (levels compared by number)."""
    by_level = {l["level"]: l for l in old}
    out = []
    for l in new:
        o = dict(_flat(by_level.get(l["level"], {})))
        n = _flat(l)
        for f, v in n:
            if o.get(f) != v:
                out.append((l["level"], f, o.get(f), v))
        out += [(l["level"], f, v, None) for f, v in o.items() if f not in dict(n) and v is not None]
    return out


def _plain(label):
    return TAG_PREFIX_RE.sub("", label or "", count=1)


def _key_of(wiki_key, patch_key):
    """Wiki key under the patch-note key: "Q" itself or a numbered sub-skill "Q2"."""
    rest = wiki_key[len(patch_key):] if wiki_key.startswith(patch_key) else None
    return rest is not None and (rest == "" or re.fullmatch("[0-9]+", rest) is not None)


def _starts_with_label(text, label):
    """'추가 피해량 [레벨 × 10]' / '추가 피해량[…]' start with the label '추가 피해량'."""
    return text.startswith(label) and (len(text) == len(label) or text[len(label)] in " [(")


def _merge(rows, index, new_rows):
    """Append rows; a later row for the same character/skill/entry/level/field updates the
    earlier one (dakgg stays the original wiki value)."""
    for r in new_rows:
        k = (r["characterId"], r["skill"], r["label"], r["level"], r["field"])
        if k in index:
            index[k].update({f: v for f, v in r.items() if f != "dakgg"})
        else:
            index[k] = r
            rows.append(r)


def apply_skill_changes(skills, changes, articles):
    """Overwrite wiki levels with patch-note rows posted after the wiki revision.
    Returns (overrides, skipped, unparsed); skills are modified in place.
    One override / skipped row per changed level field, in the calculator's shape
    (src/skills.js patchNotes, src/meta.js overrideLines): {type:"skill", characterId,
    name, skill (key), level, field, stat "<label> <level>레벨 <field>", dakgg (wiki value before
    the patch note), patchnote, text, label (entry label)}. A row is matched to a damage
    entry of the skill with the same key: the entry with the same label (tag ignored; several
    -> the one equal to the row's old value), else - when no entry or unreadable row has that
    label - the entry equal to the row's old value."""
    by_name = {s["name"]: s for s in skills}
    overrides, skipped, unparsed = [], [], []
    over_index, skip_index = {}, {}
    for c in changes:
        if c["type"] != "skill":
            continue
        char = by_name.get(c["name"])
        after, _ = patch_levels(c["after"])
        before, _ = patch_levels(c["before"])
        same_key = [(s, e) for s in char["skills"] if _key_of(s["key"], c["key"])
                    for e in s["entries"]] if char else []
        is_old = lambda e: before is not None and _same_levels(e["levels"], before)  # noqa: E731
        label = _plain(c["label"])
        hit = [x for x in same_key if x[1]["label"] == c["label"]] or \
              [x for x in same_key if _plain(x[1]["label"]) == label]
        # An unreadable wiki row with that label: never fall back to another entry by value.
        labelled = bool(hit) or char is not None and any(
            _key_of(r["skill"] or "", c["key"]) and _starts_with_label(_plain(r["text"]), label)
            for r in char["needsReview"])
        if len(hit) > 1:
            hit = [x for x in hit if is_old(x[1])]
        if not labelled:
            cands = [(s, e) for s, e in same_key if e["levels"]]
            hit = [x for x in cands if is_old(x[1])]
            if not hit and after is not None and any(_same_levels(e["levels"], after) for _, e in cands):
                continue  # the wiki already shows the patched value (row under another label)
        if after is None or len(hit) != 1 or not hit[0][1]["levels"]:
            unparsed.append({"type": "skill", "name": c["name"], "text": c["text"]})
            continue
        s, e = hit[0]
        if _same_levels(e["levels"], after):
            continue  # the wiki already shows the patched value
        posted = articles[c["part"]]["createdAt"]
        revised = char["wikiRevisedAt"]
        rows = [{"type": "skill", "characterId": char["characterId"], "name": c["name"], "skill": s["key"],
                 "level": level, "field": f, "stat": f"{e['label']} {level}레벨 {f}", "dakgg": old, "patchnote": new,
                 "text": c["text"], "label": e["label"]} for level, f, old, new in _field_changes(e["levels"], after)]
        if is_before(revised, posted):
            e["levels"], e["raw"] = after, c["text"]
            if s["entries"][0] is e:
                s["levels"], s["raw"] = after, c["text"]
            _merge(overrides, over_index, rows)
        else:
            _merge(skipped, skip_index, [{**r, "wikiRevisedAt": revised, "patchPostedAt": posted,
                                          "reason": "나무위키 최근 수정이 패치노트 게시 이후(또는 시각 미확인)"}
                                         for r in rows])
    return overrides, skipped, unparsed


def dumps(skills):
    return json.dumps(skills, ensure_ascii=False, indent=2) + "\n"


def fetch_skills(chars, interval=None):
    """skills.json content with patch-note overrides applied."""
    skills = build_skills(chars, fetch_pages([c["name"] for c in chars], interval))
    patch = pn.fetch_patch()
    apply_skill_changes(skills, pn.parse_patch(patch["bodies"], set())["changes"], patch["info"]["articles"])
    return skills


def main():
    chars = json.loads(CHARACTERS_PATH.read_text(encoding="utf-8"))
    skills = fetch_skills(chars)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(dumps(skills))
    print(f"wrote {len(skills)} characters to {OUT_PATH} "
          f"({sum(len(c['needsReview']) for c in skills)} needsReview)")


if __name__ == "__main__":
    sys.exit(main())
