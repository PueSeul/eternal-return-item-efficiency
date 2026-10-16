import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_items as fi  # noqa: E402

SLOTS = {"무기", "머리", "옷", "팔", "다리"}
GRADES = {"일반", "고급", "희귀", "영웅", "전설", "신화"}
REQUIRED = {"id", "name", "grade", "slot", "imageUrl", "price", "priceSource", "stats"}


class ParseTests(unittest.TestCase):
    def test_tooltip_stats(self):
        tip = ("전설 / 옷\n\n방어력 +30\n스킬 증폭 +30\n레벨 당 스킬 증폭 +5~100\n"
               "<color=#FFFF00>(고유)</color> 스킬 증폭 +25%\n\n설명")
        self.assertEqual(fi.parse_stats(tip), [
            ("방어력", 30.0, False), ("스킬 증폭", 30.0, False),
            ("레벨 당 스킬 증폭", 5.0, False), ("(고유) 스킬 증폭", 0.25, True),
        ])

    def test_choice_line_and_no_stats(self):
        self.assertEqual(fi.parse_stat_line("공격력 +57 또는 스킬 증폭 +114"),
                         [("공격력(택1)", 57.0, False), ("스킬 증폭(택1)", 114.0, False)])
        self.assertEqual(fi.parse_stats("고급 / VF의수"), [])
        self.assertEqual(fi.parse_stats("일반 / 재료\n\n발견 장소 : 항구(18)"), [])

    def test_mixed_block_raises(self):
        with self.assertRaises(ValueError):
            fi.parse_stats("일반 / 단검\n\n공격력 +4\n이상한 줄")

    def test_build_items(self):
        raw = [
            {"id": 1, "name": "칼", "type": "Weapon", "weaponType": "Pistol", "grade": "Mythic",
             "imageUrl": "https://x/1.png", "tooltip": "초월 / 권총\n\n이동 속도 +0.04\n공격 속도 +40%"},
            {"id": 2, "name": "신발", "type": "Armor", "armorType": "Leg", "grade": "Epic",
             "imageUrl": "https://x/2.png", "tooltip": "영웅 / 다리\n\n이동 속도 +2%"},
            {"id": 3, "name": "장식", "type": "Armor", "armorType": "Trinket", "grade": "Epic",
             "imageUrl": "https://x/3.png", "tooltip": "영웅 / 장식\n\n공격력 +1"},
            # Hidden on the dak.gg page: below Epic, or no makeMaterials.
            {"id": 4, "name": "모자", "type": "Armor", "armorType": "Head", "grade": "Rare",
             "imageUrl": "https://x/4.png", "tooltip": "희귀 / 머리\n\n방어력 +1"},
            {"id": 5, "name": "Mk2", "type": "Weapon", "weaponType": "Pistol", "grade": "Legend",
             "imageUrl": "https://x/5.png", "tooltip": "전설 / 권총\n\n공격력 +1"},
            {"id": 6, "name": "빈 재료", "type": "Armor", "armorType": "Head", "grade": "Epic",
             "makeMaterials": [], "imageUrl": "https://x/6.png", "tooltip": "영웅 / 머리\n\n방어력 +1"},
            {"id": 7, "name": "재료1만", "type": "Armor", "armorType": "Head", "grade": "Legend",
             "makeMaterial1": 1, "makeMaterial2": 2,
             "imageUrl": "https://x/7.png", "tooltip": "전설 / 머리\n\n방어력 +1"},
            {"id": 8, "name": "투구", "type": "Armor", "armorType": "Head", "grade": "Legend",
             "makeMaterials": [1, 2], "imageUrl": "https://x/8.png", "tooltip": "전설 / 머리\n\n방어력 +9"},
            {"id": 9, "name": "갑옷", "type": "Armor", "armorType": "Chest", "grade": "Mythic",
             "makeMaterials": [1], "imageUrl": "https://x/9.png", "tooltip": "초월 / 옷\n\n방어력 +9"},
            {"id": 10, "name": "팔찌", "type": "Armor", "armorType": "Arm", "grade": "Epic",
             "makeMaterials": [1], "imageUrl": "https://x/10.png", "tooltip": "영웅 / 팔\n\n방어력 +9"},
            {"id": 11, "name": "재료", "type": "Misc", "grade": "Epic",
             "makeMaterials": [1], "imageUrl": "https://x/11.png", "tooltip": "영웅 / 재료\n\n방어력 +9"},
        ]
        for r in raw[:4]:
            r["makeMaterials"] = [1, 2]
        out = fi.build_items(raw, [{"key": "Pistol", "name": "권총"}])
        self.assertEqual([r["id"] for r in out], ["1", "2", "8", "9", "10"])
        self.assertEqual([r["slot"] for r in out[2:]], ["머리", "옷", "팔"])
        self.assertEqual(out[0]["grade"], "신화")
        self.assertEqual(out[0]["price"], 6)
        self.assertEqual(out[0]["weaponType"], "권총")
        self.assertEqual(out[0]["stats"], {"이동 속도": 0.04, "공격 속도": 0.4})
        self.assertEqual(out[1]["stats"], {"이동 속도율": 0.02})
        self.assertNotIn("weaponType", out[1])


class DataFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.items = json.loads((ROOT / "data" / "items.json").read_text(encoding="utf-8"))

    def test_schema(self):
        self.assertTrue(self.items)
        self.assertEqual(len({i["id"] for i in self.items}), len(self.items))
        self.assertEqual({i["slot"] for i in self.items}, SLOTS)
        for it in self.items:
            with self.subTest(id=it.get("id")):
                self.assertTrue(REQUIRED <= it.keys())
                self.assertIsInstance(it["id"], str)
                self.assertTrue(it["name"])
                self.assertIn(it["slot"], SLOTS)
                self.assertIn(it["grade"], GRADES)
                self.assertTrue(it["imageUrl"].startswith("https://"))
                self.assertEqual(it["price"], fi.GRADE_PRICE[it["grade"]])
                self.assertNotIsInstance(it["price"], bool)
                self.assertEqual(it["priceSource"], fi.PRICE_SOURCE)
                if it["slot"] == "무기":
                    self.assertIsInstance(it["weaponType"], str)
                    self.assertTrue(it["weaponType"])
                else:
                    self.assertNotIn("weaponType", it)
                for k, v in it["stats"].items():
                    self.assertIsInstance(v, (int, float))
                    self.assertNotIsInstance(v, bool)
                    self.assertGreater(v, 0)

    def test_slot_counts_match_page(self):
        counts = {s: sum(i["slot"] == s for i in self.items) for s in SLOTS}
        self.assertEqual(counts, PAGE_SLOT_COUNTS)
        weapon_counts = {}
        for i in self.items:
            if i["slot"] == "무기":
                weapon_counts[i["weaponType"]] = weapon_counts.get(i["weaponType"], 0) + 1
        self.assertEqual(weapon_counts, PAGE_WEAPON_TYPE_COUNTS)
        self.assertTrue(all(i["stats"] for i in self.items))

    def test_only_epic_legend_mythic(self):
        for it in self.items:
            with self.subTest(id=it["id"]):
                self.assertIn(it["grade"], {"영웅", "전설", "신화"})
                self.assertNotIn(it["grade"], {"일반", "고급", "희귀"})

    def test_known_items(self):
        by_id = {i["id"]: i for i in self.items}
        # Values copied from the dak.gg tooltips (patch 12.6).
        self.assertEqual(by_id["101405"]["name"], "프라가라흐")
        self.assertEqual(by_id["101405"]["weaponType"], "단검")
        self.assertEqual(by_id["101405"]["stats"], {"공격력": 73, "공격 속도": 0.4, "이동 속도율": 0.02})
        self.assertEqual(by_id["201403"]["stats"], {"방어력": 15, "레벨 당 최대 체력": 20, "쿨다운 감소": 15})
        self.assertEqual(by_id["201411"]["stats"], {
            "방어력": 8, "공격력(택1)": 45, "스킬 증폭(택1)": 90, "이동 속도율": 0.03,
            "쿨다운 감소": 20, "방어 관통": 10,
        })
        # Crafting intermediates / base items are not listed on the page.
        for hidden in ("101104", "201101", "201111", "201202", "201301"):
            self.assertNotIn(hidden, by_id)

    def test_stat_keys_known_and_percent_fractions(self):
        for it in self.items:
            for k, v in it["stats"].items():
                with self.subTest(id=it["id"], key=k):
                    self.assertIn(k, PERCENT_KEYS | FLAT_KEYS)
                    if k in PERCENT_KEYS:
                        self.assertLessEqual(v, 1)


# Rows counted on https://dak.gg/er/items?hl=ko per filter after scrolling the
# table to the end (patch 12.6, 2026-10-16). The page has no single "무기"
# filter; 무기 = sum of the weapon-type filters (291 = "모든 아이템" 490 - armor).
PAGE_SLOT_COUNTS = {"무기": 291, "머리": 57, "옷": 51, "팔": 57, "다리": 34}
PAGE_WEAPON_TYPE_COUNTS = {
    "글러브": 14, "단검": 13, "도끼": 12, "레이피어": 15, "망치": 12, "방망이": 13, "쌍검": 13,
    "쌍절곤": 11, "양손검": 15, "창": 11, "채찍": 10, "톤파": 11, "VF의수": 21, "권총": 12,
    "기타": 13, "돌격 소총": 12, "석궁": 11, "아르카나": 11, "암기": 13, "저격총": 12,
    "카메라": 11, "투척": 13, "활": 12,
}

# Stat keys observed in dak.gg tooltips (12.6); "%" lines are stored as 0~1.
PERCENT_KEYS = {
    "공격 속도", "치명타 확률", "치명타 피해량", "생명력 흡수", "모든 피해 흡혈", "체력 재생",
    "주는 회복 증가", "레벨 당 기본 공격 증폭", "(고유) 방해 효과 저항", "(고유) 스킬 증폭",
    "방어 관통율", "이동 속도율", "스킬 증폭율",
}
FLAT_KEYS = {
    "공격력", "스킬 증폭", "방어력", "최대 체력", "방어 관통", "이동 속도", "쿨다운 감소", "시야",
    "레벨 당 공격력", "레벨 당 스킬 증폭", "레벨 당 최대 체력", "공격력(택1)", "스킬 증폭(택1)",
    "궁극기 쿨다운 감소", "전술스킬 쿨다운 감소", "(고유) 기본 공격 사거리",
}


if __name__ == "__main__":
    unittest.main()
