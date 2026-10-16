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
            {"id": 2, "name": "신발", "type": "Armor", "armorType": "Leg", "grade": "Common",
             "imageUrl": "https://x/2.png", "tooltip": "일반 / 다리\n\n이동 속도 +2%"},
            {"id": 3, "name": "장식", "type": "Armor", "armorType": "Trinket", "grade": "Common",
             "imageUrl": "https://x/3.png", "tooltip": "일반 / 장식\n\n공격력 +1"},
        ]
        out = fi.build_items(raw, [{"key": "Pistol", "name": "권총"}])
        self.assertEqual([r["id"] for r in out], ["1", "2"])
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

    def test_completeness_and_known_items(self):
        by_id = {i["id"]: i for i in self.items}
        counts = {s: sum(i["slot"] == s for i in self.items) for s in SLOTS}
        for slot, n in counts.items():
            self.assertGreaterEqual(n, 30, slot)
        self.assertGreaterEqual(sum(bool(i["stats"]) for i in self.items), len(self.items) * 0.95)
        # Values copied from the dak.gg tooltips (patch 12.6).
        self.assertEqual(by_id["101104"]["name"], "식칼")
        self.assertEqual(by_id["101104"]["stats"], {"공격력": 4})
        self.assertEqual(by_id["101104"]["weaponType"], "단검")
        self.assertEqual(by_id["101405"]["stats"], {"공격력": 73, "공격 속도": 0.4, "이동 속도율": 0.02})

    def test_stat_keys_known_and_percent_fractions(self):
        for it in self.items:
            for k, v in it["stats"].items():
                with self.subTest(id=it["id"], key=k):
                    self.assertIn(k, PERCENT_KEYS | FLAT_KEYS)
                    if k in PERCENT_KEYS:
                        self.assertLessEqual(v, 1)


# Stat keys observed in dak.gg tooltips (12.6); "%" lines are stored as 0~1.
PERCENT_KEYS = {
    "공격 속도", "치명타 확률", "치명타 피해량", "생명력 흡수", "모든 피해 흡혈", "체력 재생",
    "주는 회복 증가", "레벨 당 기본 공격 증폭", "(고유) 방해 효과 저항", "(고유) 스킬 증폭",
    "방어 관통율", "이동 속도율", "쿨다운 감소율", "스킬 증폭율",
}
FLAT_KEYS = {
    "공격력", "스킬 증폭", "방어력", "최대 체력", "방어 관통", "이동 속도", "쿨다운 감소", "시야",
    "레벨 당 공격력", "레벨 당 스킬 증폭", "레벨 당 최대 체력", "공격력(택1)", "스킬 증폭(택1)",
    "궁극기 쿨다운 감소", "전술스킬 쿨다운 감소", "(고유) 기본 공격 사거리",
}


if __name__ == "__main__":
    unittest.main()
