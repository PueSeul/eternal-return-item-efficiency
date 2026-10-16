"""Fetch Eternal Return equipment items from dak.gg and write data/items.json.

Source: the JSON API that https://dak.gg/er/items?hl=ko calls in the browser.
Usage: python scripts/fetch_items.py
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ITEMS_URL = "https://er.dakgg.io/api/v1/data/items?hl=ko"
MASTERIES_URL = "https://er.dakgg.io/api/v1/data/masteries?hl=ko"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "items.json"

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
GRADE_PRICE = {"일반": 1, "고급": 2, "희귀": 3, "영웅": 4, "전설": 5, "신화": 6}
PRICE_SOURCE = "등급 기반 대체값"
PAGE_GRADES = {"Epic", "Legend", "Mythic"}
ARMOR_SLOTS = {"Head": "머리", "Chest": "옷", "Arm": "팔", "Leg": "다리"}

UNIQUE_PREFIX = "(고유) "
# "<color=..>(고유)</color> 이름 +a", "레벨 당 이름 +a~b%" (a per level, b at max level)
STAT_RE = re.compile(
    r"^(?P<unique><color=[^>]*>\(고유\)</color> )?(?P<name>[^+<>]+?) \+"
    + r"(?P<value>\d+(?:\.\d+)?)(?:~\d+(?:\.\d+)?)?(?P<pct>%)?$"
)
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
        name = m.group("name").strip()
        if m.group("unique"):
            name = UNIQUE_PREFIX + name
        if len(parts) > 1:
            name += CHOICE_SUFFIX
        value = float(m.group("value"))
        pct = m.group("pct") is not None
        if pct:
            value = round(value / 100, 6)
        parsed.append((name, value, pct))
    return parsed


def parse_stats(tooltip):
    """Raw stats from the tooltip's second block: [(name, value, is_percent)]."""
    blocks = tooltip.split("\n\n")
    if len(blocks) < 2:
        return []
    lines = [l.strip() for l in blocks[1].split("\n") if l.strip()]
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
        and bool(item.get("makeMaterials"))
    )


def slot_of(item):
    if not listed_on_page(item):
        return None
    if item["type"] == "Weapon":
        return "무기"
    if item["type"] == "Armor":
        return ARMOR_SLOTS.get(item.get("armorType"))
    return None


def build_items(raw_items, masteries):
    weapon_names = {m["key"]: m["name"] for m in masteries}
    equip = [(it, slot_of(it)) for it in raw_items]
    equip = [(it, slot) for it, slot in equip if slot]
    raw_stats = {it["id"]: parse_stats(it["tooltip"]) for it, _ in equip}
    flat_names = {n for stats in raw_stats.values() for n, _, pct in stats if not pct}

    out = []
    for it, slot in sorted(equip, key=lambda p: p[0]["id"]):
        stats = {}
        for name, value, pct in raw_stats[it["id"]]:
            # dak.gg uses one name for flat and % variants (e.g. 이동 속도);
            # the % variant gets the "율" suffix only when both exist.
            key = name + PCT_SUFFIX if pct and name in flat_names else name
            if key in stats:
                raise ValueError(f"duplicate stat {key} in item {it['id']}")
            stats[key] = int(value) if not pct and value.is_integer() else value
        grade = GRADES[it["grade"]]
        row = {
            "id": str(it["id"]),
            "name": it["name"],
            "grade": grade,
            "slot": slot,
            "imageUrl": it["imageUrl"],
            "price": GRADE_PRICE[grade],
            "priceSource": PRICE_SOURCE,
            "stats": stats,
        }
        if slot == "무기":
            row["weaponType"] = weapon_names[it["weaponType"]]
        out.append(row)
    return out


def main():
    items = build_items(fetch_json(ITEMS_URL)["items"], fetch_json(MASTERIES_URL)["masteries"])
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {len(items)} items to {OUT_PATH}")


if __name__ == "__main__":
    sys.exit(main())
