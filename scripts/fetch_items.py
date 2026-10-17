"""Fetch Eternal Return equipment items from dak.gg and write data/items.json.

Source: the JSON API that https://dak.gg/er/items?hl=ko calls in the browser.
Values that differ from the latest official patch note (+ later hotfixes) are
replaced by the patch-note value (host decision; see fetch_patchnote.py).
Usage: python scripts/fetch_items.py [--all]
  writes data/items.json, data/characters.json, data/skills.json (namu.wiki,
  see fetch_skills.py; only the patch note's characters are re-read unless --all)
  and data/items.meta.json
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import fetch_patchnote as pn
import fetch_skills as fs

ITEMS_URL = "https://er.dakgg.io/api/v1/data/items?hl=ko"
MASTERIES_URL = "https://er.dakgg.io/api/v1/data/masteries?hl=ko"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUT_PATH = DATA_DIR / "items.json"
ITEMS_FILE, CHARACTERS_FILE, META_FILE = "items.json", "characters.json", "items.meta.json"
SKILLS_FILE = "skills.json"
# dak.gg game-asset version in image paths: .../er/game-assets/12.6.0/...
ASSET_VERSION_RE = re.compile(r"/game-assets/([0-9]+(?:\.[0-9]+)*)/")
# Shared with scripts/fetch_items.mjs: edit these JSON files, not the code.
PRICE_TABLE_PATH = DATA_DIR / "price_table.json"
EXCLUSIONS_PATH = DATA_DIR / "exclusions.json"

# dak.gg grade enum -> schema grade. dak.gg's own Korean label for Mythic is
# "초월", but the agreed schema uses "신화".
GRADES = {
    "Common": "일반",
    "Uncommon": "고급",
    "Rare": "희귀",
    "Epic": "영웅",
    "Legend": "전설",
    "Mythic": "신화",
}
_PRICE_TABLE = json.loads(PRICE_TABLE_PATH.read_text(encoding="utf-8"))
# Grade-based price and source per grade (영웅 = 0, 신화 = 500 per host); overridden by ITEM_PRICE.
GRADE_PRICE = _PRICE_TABLE["gradePrice"]
GRADE_PRICE_SOURCE = _PRICE_TABLE["gradePriceSource"]
# Host prices by exact item name; same-name variants share them. A group's
# "priceSource" overrides the table-wide "itemPriceSource".
ITEM_PRICE = {name: g["price"] for g in _PRICE_TABLE["itemPriceGroups"] for name in g["names"]}
ITEM_PRICE_SOURCE = {
    name: g.get("priceSource", _PRICE_TABLE["itemPriceSource"])
    for g in _PRICE_TABLE["itemPriceGroups"] for name in g["names"]
}
PAGE_GRADES = {"Epic", "Legend", "Mythic"}
ARMOR_SLOTS = {"Head": "머리", "Chest": "옷", "Arm": "팔", "Leg": "다리"}
# 호스트 요청: head items excluded by exact name. "천상의 메아리" has two ids (201516, 201517).
EXCLUDED_NAMES = set(json.loads(EXCLUSIONS_PATH.read_text(encoding="utf-8"))["headNames"])

UNIQUE_PREFIX = "(고유) "
# "<color=..>(고유)</color> 이름 +a", "레벨 당 이름 +a~b%" (a per level, b at max level)
STAT_RE = re.compile(
    r"^(?P<unique><color=[^>]*>\(고유\)</color> )?(?P<name>[^+<>]+?) \+"
    + r"(?P<value>\d+(?:\.\d+)?)(?:~\d+(?:\.\d+)?)?(?P<pct>%)?$",
    re.ASCII,
)
# Explicit whitespace set: str.strip() and JS trim() disagree on exotic characters.
WS = " \t\n\r\v\f"
CHOICE_SEP = " 또는 "
CHOICE_SUFFIX = "(택1)"
PCT_SUFFIX = "율"


def fetch_json(url):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://dak.gg/", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def parse_stat_line(line):
    """Return [(name, value, is_percent)] for one tooltip stat line, or None."""
    parts = line.split(CHOICE_SEP)
    parsed = []
    for part in parts:
        m = STAT_RE.match(part)
        if not m:
            return None
        name = m.group("name").strip(WS)
        if m.group("unique"):
            name = UNIQUE_PREFIX + name
        if len(parts) > 1:
            name += CHOICE_SUFFIX
        pct = m.group("pct") is not None
        # Percent: parse the decimal text shifted by 100 (correctly rounded, same in JS).
        value = float(m.group("value") + ("e-2" if pct else ""))
        parsed.append((name, value, pct))
    return parsed


def parse_stats(tooltip):
    """Raw stats from the tooltip's second block: [(name, value, is_percent)]."""
    blocks = tooltip.split("\n\n")
    if len(blocks) < 2:
        return []
    lines = [l.strip(WS) for l in blocks[1].split("\n") if l.strip(WS)]
    parsed = [parse_stat_line(l) for l in lines]
    if all(p is None for p in parsed):
        return []
    bad = [l for l, p in zip(lines, parsed) if p is None]
    if bad:
        raise ValueError(f"unparsed stat lines: {bad}")
    return [s for p in parsed for s in p]


def listed_on_page(item):
    """Same filter the dak.gg items page applies (pages/items chunk, patch 12.6):
    type Armor/Weapon, grade Epic/Legend/Mythic and a non-empty makeMaterials list."""
    return (
        item["type"] in ("Armor", "Weapon")
        and item["grade"] in PAGE_GRADES
        and isinstance(item.get("makeMaterials"), list)
        and len(item["makeMaterials"]) > 0
    )


def slot_of(item):
    if not listed_on_page(item):
        return None
    if item.get("armorType") == "Head" and item["name"] in EXCLUDED_NAMES:
        return None
    if item["type"] == "Weapon":
        return "무기"
    if item["type"] == "Armor":
        return ARMOR_SLOTS.get(item.get("armorType"))
    return None


def stat_kinds(raw_items):
    """(flat names, percent names) of the listed equipment's tooltip stats."""
    flat, pct = set(), set()
    for it in raw_items:
        if slot_of(it):
            for name, _, is_pct in parse_stats(it["tooltip"]):
                (pct if is_pct else flat).add(name)
    return flat, pct


def build_items(raw_items, masteries):
    weapon_names = {m["key"]: m["name"] for m in masteries}
    equip = [(it, slot_of(it)) for it in raw_items]
    equip = [(it, slot) for it, slot in equip if slot]
    raw_stats = {it["id"]: parse_stats(it["tooltip"]) for it, _ in equip}
    flat_names = stat_kinds(raw_items)[0]

    out = []
    for it, slot in sorted(equip, key=lambda p: int(p[0]["id"])):
        stats = {}
        for name, value, pct in raw_stats[it["id"]]:
            # dak.gg uses one name for flat and % variants (e.g. 이동 속도);
            # the % variant gets the "율" suffix only when both exist.
            key = name + PCT_SUFFIX if pct and name in flat_names else name
            if key in stats:
                raise ValueError(f"duplicate stat {key} in item {it['id']}")
            # Integral values are ints (100% -> 1, not 1.0) so the JSON matches
            # fetch_items.mjs byte for byte.
            stats[key] = int(value) if value.is_integer() else value
        grade = GRADES[it["grade"]]
        row = {
            "id": str(it["id"]),
            "name": it["name"],
            "grade": grade,
            "slot": slot,
            "imageUrl": it["imageUrl"],
            "price": ITEM_PRICE.get(it["name"], GRADE_PRICE[grade]),
            "priceSource": ITEM_PRICE_SOURCE.get(it["name"], GRADE_PRICE_SOURCE[grade]),
            "stats": stats,
        }
        if slot == "무기":
            row["weaponType"] = weapon_names[it["weaponType"]]
        out.append(row)
    return out


def dumps(items):
    """Serialized form of data/items.json (byte-identical to fetch_items.mjs)."""
    return json.dumps(items, ensure_ascii=False, indent=2) + "\n"


def patch_items(items, raw_items, patch):
    """Apply the patch note to built items. Returns (parsed, overrides, unparsed)."""
    flat, pct = stat_kinds(raw_items)
    parsed = pn.parse_patch(patch["bodies"], flat | pct)
    overrides, unparsed = pn.apply_item_changes(items, parsed["changes"], flat, pct)
    return parsed, overrides, unparsed


def fetch_items():
    """Items from dak.gg with patch-note overrides applied (data/items.json content)."""
    raw = fetch_json(ITEMS_URL)["items"]
    items = build_items(raw, fetch_json(MASTERIES_URL)["masteries"])
    patch_items(items, raw, pn.fetch_patch())
    return items


def dakgg_version(raw_items):
    """Highest game-asset version in the item image paths, or None."""
    found = {m.group(1) for it in raw_items if (m := ASSET_VERSION_RE.search(it.get("imageUrl") or ""))}
    return max(found, key=lambda v: [int(x) for x in v.split(".")]) if found else None


def utc_now():
    """ISO time like JS Date.toISOString(): 2026-10-17T02:30:00.123Z."""
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def build_all(raw_items, masteries, raw_chars, patch, pages, fetched_at, previous=None):
    """{"items", "characters", "skills", "meta"} with patch-note overrides applied.
    pages: {character name: namu.wiki HTML or None} (fetch_skills.fetch_pages); previous:
    {name: skills.json entry} kept for characters not in pages (skills mode "patched")."""
    import fetch_characters as fc  # fetch_characters imports this module

    items = build_items(raw_items, masteries)
    chars = fc.build_characters(raw_chars, masteries)
    parsed, item_overrides, item_unparsed = patch_items(items, raw_items, patch)
    char_overrides, char_unparsed = pn.apply_character_changes(chars, parsed["changes"])
    info = patch["info"]
    skills = fs.build_skills(chars, pages, previous)
    skill_overrides, skill_skipped, skill_unparsed = fs.apply_skill_changes(
        skills, parsed["changes"], info["articles"])
    meta = {
        "fetchedAt": fetched_at,
        "dakggVersion": dakgg_version(raw_items),
        "patch": {k: info[k] for k in ("id", "version", "title", "url", "date", "articles")},
        "overrides": item_overrides + char_overrides + skill_overrides,
        "skipped": skill_skipped,
        "unparsed": parsed["unparsed"] + item_unparsed + char_unparsed + skill_unparsed,
        "skillsFetched": {"mode": "all" if previous is None else "patched", "characters": list(pages),
                          "count": len(pages)},
    }
    return {"items": items, "characters": chars, "skills": skills, "meta": meta}


def previous_skills(out_dir):
    """{name: entry} from out_dir/skills.json, else this repo's data/skills.json, else None."""
    for path in (Path(out_dir) / SKILLS_FILE, DATA_DIR / SKILLS_FILE):
        if path.is_file():
            return {e["name"]: e for e in json.loads(path.read_text(encoding="utf-8"))}
    return None


def fetch_all(out_dir=DATA_DIR, fetched_at=None, interval=None, skills_mode="patched"):
    """Fetch everything, write items.json, characters.json, skills.json, items.meta.json to out_dir.
    interval: seconds between namu.wiki requests (default fetch_skills.REQUEST_INTERVAL).
    skills_mode "patched": re-read only the characters in the latest patch note (fetch_skills.plan_pages);
    "all": every character."""
    import fetch_characters as fc

    raw_chars = fetch_json(fc.CHARACTERS_URL)["characters"]
    raw_items = fetch_json(ITEMS_URL)["items"]
    patch = pn.fetch_patch()
    flat, pct = stat_kinds(raw_items)
    names = [c["name"] for c in sorted(raw_chars, key=lambda c: int(c["id"]))]
    _, read, previous = fs.plan_pages(skills_mode, pn.parse_patch(patch["bodies"], flat | pct), names,
                                      previous_skills(out_dir) if skills_mode == "patched" else None)
    result = build_all(
        raw_items,
        fetch_json(MASTERIES_URL)["masteries"],
        raw_chars,
        patch,
        fs.fetch_pages(read, interval),
        fetched_at or utc_now(),
        previous,
    )
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Write all four to temp files first so a failed write leaves the old set intact.
    files = ((ITEMS_FILE, dumps(result["items"])),
             (CHARACTERS_FILE, fc.dumps(result["characters"])),
             (SKILLS_FILE, fs.dumps(result["skills"])),
             (META_FILE, dumps(result["meta"])))
    for name, text in files:
        with open(out_dir / (name + ".tmp"), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    for name, _ in files:
        os.replace(out_dir / (name + ".tmp"), out_dir / name)
    return result


def main():
    result = fetch_all(skills_mode="all" if "--all" in sys.argv[1:] else "patched")
    meta = result["meta"]
    print(f"wrote {len(result['items'])} items, {len(result['characters'])} characters, "
          f"{len(result['skills'])} skill entries to {DATA_DIR} "
          f"(patch {meta['patch']['version']}: {len(meta['overrides'])} overrides, "
          f"{len(meta['skipped'])} skipped, {len(meta['unparsed'])} unparsed)")


if __name__ == "__main__":
    sys.exit(main())
