"""Fetch Eternal Return characters (base attack power, growth, weapon mastery
ratios) from the dak.gg API and write data/characters.json.

Source: https://er.dakgg.io/api/v1/data/characters?hl=ko (+ data/masteries for
Korean weapon names, the same names items.json uses for weaponType).
Usage: python scripts/fetch_characters.py
Node twin: scripts/fetch_characters.mjs (byte-identical output).
"""
import json
import math
import sys
from pathlib import Path

from fetch_items import MASTERIES_URL, fetch_json

CHARACTERS_URL = "https://er.dakgg.io/api/v1/data/characters?hl=ko"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "characters.json"

# masteryStats option key -> output field (value per mastery level). Every
# mastery row carries all fields (0 when absent); an unknown key aborts so new
# stats are not silently dropped. AttackPower is flat (Lyanh OneHandSword: 1).
MASTERY_FIELDS = {
    "SkillAmpRatio": "skillAmpRatio",
    "AttackPowerRatio": "attackPowerRatio",
    "AttackSpeedRatio": "attackSpeedRatio",
    "IncreaseBasicAttackDamageRatio": "increaseBasicAttackDamageRatio",
    "AttackPower": "attackPower",
}


def num(value):
    """Integral numbers as int so the JSON matches the Node output byte for byte.
    Python and JS only agree on plain decimal notation, so values that either
    side would print in exponent form (or non-finite ones) abort."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"not a number: {value!r}")
    if not math.isfinite(value) or abs(value) >= 1e15 or 0 < abs(value) < 1e-4:
        raise ValueError(f"number out of serializable range: {value!r}")
    return int(value) if float(value).is_integer() else value


def build_masteries(char, weapon_names):
    stats = {}
    for row in char["masteryStats"]:
        if row["type"] in stats:
            raise ValueError(f"duplicate mastery {row['type']} for {char['key']}")
        fields = dict.fromkeys(MASTERY_FIELDS.values(), 0)
        seen = set()
        for opt in row["options"]:
            if opt["key"] not in MASTERY_FIELDS or opt["key"] in seen:
                raise ValueError(f"unexpected mastery option {opt['key']} for {char['key']}")
            seen.add(opt["key"])
            fields[MASTERY_FIELDS[opt["key"]]] = num(opt["value"])
        stats[row["type"]] = fields
    if sorted(stats) != sorted(char["masteries"]):
        raise ValueError(f"masteryStats/masteries mismatch for {char['key']}")
    # Order follows the character's own weapon list.
    return {weapon_names[t]: stats[t] for t in char["masteries"]}


def build_characters(raw_chars, masteries):
    weapon_names = {m["key"]: m["name"] for m in masteries}
    out = []
    for c in sorted(raw_chars, key=lambda c: int(c["id"])):
        image = c["imageUrl"]
        out.append({
            "id": str(c["id"]),
            "name": c["name"],
            "imageUrl": "https:" + image if image.startswith("//") else image,
            "attackPower": num(c["attackPower"]),
            "attackPowerPerLevel": num(c["levelUpStat"]["attackPower"]),
            "masteries": build_masteries(c, weapon_names),
        })
    return out


def dumps(chars):
    return json.dumps(chars, ensure_ascii=False, indent=2) + "\n"


def main():
    chars = build_characters(
        fetch_json(CHARACTERS_URL)["characters"], fetch_json(MASTERIES_URL)["masteries"]
    )
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(dumps(chars))
    print(f"wrote {len(chars)} characters to {OUT_PATH}")


if __name__ == "__main__":
    sys.exit(main())
