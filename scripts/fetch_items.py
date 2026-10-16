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
# Price table (single place to edit). 호스트 요청: 영웅 = 0; 전설/신화 keep the
# placeholder values until the host supplies real prices.
GRADE_PRICE = {"영웅": 0, "전설": 5, "신화": 6}
PRICE_SOURCE = "등급 기반 대체값"
# 호스트 지정 가격(재료 기준), by exact item name; overrides GRADE_PRICE.
# Same-name variants all get the same price. Weapons not priced yet.
ITEM_PRICE_SOURCE = "호스트 지정 가격(재료 기준)"
_HOST_PRICE_GROUPS = {
    200: [  # 생명의 나무
        "길리 슈트", "불꽃 드레스", "타이탄 아머", "팬텀 자켓", "핏빛 망토",
        "드워프의 투구", "블래스터 헬멧", "스파크 실드", "예언자의 터번", "월계관", "전술 고글", "택티컬 바이저",
        "살라딘의 화살통", "서슬가시 체인", "스카디의 팔찌", "월왕구천", "클라다 반지", "토템", "하트 온 파이어", "호루스의 눈",
        "글레이셜 슈즈", "알렉산드로스", "와일드 워커",
        # 운석
        "고스트", "반역의 의지", "배틀 슈트", "선녀강림", "슈팅스타 자켓", "카바나",
        "빛의 증표", "우주 비행사의 헬멧", "인사이트", "커맨더 헤드셋", "쿤달라", "캡틴 햇", "황야의 별",
        "가시지네 견갑", "달빛 펜던트", "샤를마뉴의 방패", "아흐라만의 손길", "요명월", "큐브 워치", "해적의 증표",
        "갤럭시 스텝", "레이싱 부츠", "미라지 워커", "블레이드 부츠", "아이언 메이든", "EOD 부츠",
    ],
    250: [  # 미스릴
        "레이싱 슈트", "미스릴 갑옷", "미스릴 크롭", "진은 드레스", "현자의 로브",
        "검은 죽음", "다비드 헤드폰", "레이싱 헬멧", "미스릴 투구", "백야의 관", "사이버 스토커", "성기사의 투구",
        "천룡잠", "쿼드 아이", "트와일라잇",
        "미스릴 방패", "미스릴 완장", "미스릴 퀴버", "오르비스", "요술램프", "임세티", "틴달로스의 군주",
        "미스릴 부츠", "스페이스 부츠", "칼날 다리",
    ],
    350: [  # 포스 코어
        "가디언 슈트", "레버넌트", "서리바람 흉갑", "성법의", "스펙터", "아오자이", "엘프 드레스", "오메르타",
        "유령 신부의 드레스", "이단심판관", "쿠튀리에", "택티컬 아머", "화령장",
        "검은 베일", "레가투스", "바니햇", "앙 가르드", "야생의 허기", "오니 가면", "천사의 고리", "페르소나",
        "레이더", "미니어쳐 솔라 시스템", "별 조각", "에메랄드 타블렛", "오토-암즈", "용의 비늘", "운명의 주사위",
        "텔루리안 타임피스", "파초선", "프시케의 칼날", "헬릭스",
        "킬힐", "택티컬 슈즈", "헤르메스의 부츠",
    ],
}
ITEM_PRICE = {name: price for price, names in _HOST_PRICE_GROUPS.items() for name in names}
PAGE_GRADES = {"Epic", "Legend", "Mythic"}
ARMOR_SLOTS = {"Head": "머리", "Chest": "옷", "Arm": "팔", "Leg": "다리"}
# 호스트 요청: head items excluded by exact name. "천상의 메아리" has two ids (201516, 201517).
EXCLUDED_NAMES = {"만개하는 선율", "천상의 메아리"}

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
    if item.get("armorType") == "Head" and item["name"] in EXCLUDED_NAMES:
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
            "price": ITEM_PRICE.get(it["name"], GRADE_PRICE[grade]),
            "priceSource": ITEM_PRICE_SOURCE if it["name"] in ITEM_PRICE else PRICE_SOURCE,
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
