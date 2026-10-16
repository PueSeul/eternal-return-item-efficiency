import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_harness import (ROOT, article, fi, pn, patch_bodies, record, replay,  # noqa: F401
                          run_node)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
PATCH_HTML = (FIXTURES / "patchnote_sample.html").read_text(encoding="utf-8")
HOTFIX_HTML = (FIXTURES / "hotfix_sample.html").read_text(encoding="utf-8")
FETCHED_AT = "2026-10-17T02:30:00.000Z"
IMG = "https://cdn.dak.gg/assets/er/game-assets/12.6.0/{}.png"


def item(id_, name, type_, grade, tooltip, **kw):
    return {"id": id_, "name": name, "type": type_, "grade": grade, "makeMaterials": [1],
            "imageUrl": IMG.format(id_), "tooltip": tooltip, **kw}


RAW_ITEMS = [
    item(1, "선녀강림", "Armor", "Legend", "전설 / 옷\n\n방어력 +20\n공격 속도 +40%", armorType="Chest"),
    item(2, "황야의 별", "Armor", "Legend", "전설 / 머리\n\n공격 속도 +42%", armorType="Head"),
    item(3, "큐브 워치", "Armor", "Legend", "전설 / 팔\n\n공격력 +15\n치명타 확률 +35%", armorType="Arm"),
    item(4, "월왕구천", "Armor", "Legend", "전설 / 팔\n\n공격력 +25\n공격 속도 +30%", armorType="Arm"),
    item(5, "다인슬라이프 - 진홍", "Weapon", "Mythic", "초월 / 양손검\n\n공격력 +84",
         weaponType="TwoHandSword"),
    item(6, "저거너트", "Weapon", "Legend", "전설 / 도끼\n\n공격력 +60", weaponType="Axe"),
    item(7, "치피템", "Armor", "Epic", "영웅 / 다리\n\n치명타 피해량 +5%\n최대 체력 +100", armorType="Leg"),
]
MASTERIES = [{"key": "TwoHandSword", "name": "양손검"}, {"key": "Axe", "name": "도끼"},
             {"key": "Arcana", "name": "아르카나"}, {"key": "SniperRifle", "name": "저격총"}]


def char(id_, name, ap, stats):
    return {"id": id_, "key": "K%d" % id_, "name": name, "imageUrl": "//cdn.dak.gg/%d.png" % id_,
            "attackPower": ap, "levelUpStat": {"attackPower": 4.5},
            "masteries": [s["type"] for s in stats], "masteryStats": stats}


RAW_CHARS = [
    char(1, "아디나", 30, [{"type": "Arcana", "options": [
        {"key": "AttackSpeedRatio", "value": 0.025}, {"key": "SkillAmpRatio", "value": 0.044}]}]),
    char(2, "루치아", 32, [{"type": "SniperRifle", "options": [
        {"key": "AttackSpeedRatio", "value": 0.045}, {"key": "SkillAmpRatio", "value": 0.042}]}]),
    char(3, "라우라", 30, []),
]


def fixture_bodies():
    bodies = patch_bodies((3899, "12.6a 핫픽스", HOTFIX_HTML),
                          (3898, "2026.10.15 - 12.6 패치노트", PATCH_HTML))
    bodies[fi.ITEMS_URL] = json.dumps({"items": RAW_ITEMS}, ensure_ascii=False)
    bodies[fi.MASTERIES_URL] = json.dumps({"masteries": MASTERIES}, ensure_ascii=False)
    bodies["https://er.dakgg.io/api/v1/data/characters?hl=ko"] = json.dumps(
        {"characters": RAW_CHARS}, ensure_ascii=False)
    return bodies


NODE_FETCH_ALL = 'const m = await imp("fetch_items.mjs"); return m.fetchAll({ outDir: env.OUT, fetchedAt: env.AT });'
EDGE_HTML = ('<div class="er-article-detail__content"><h5>방어구</h5>'
             '<ul><li><p>더 문</p><ul><li><p><s>쿨다운 감소 10</s> (삭제)</p></li>'
             '<li><p>공격 속도 1% &rarr; 0.001%</p></li></ul></li></ul>'
             '<ul><li><p>선녀\u2028강림 공격 속도 40% → 42%</p></li></ul>'
             '<h3>코발트 프로토콜</h3><ul><li><p>선녀강림 공격 속도 40% → 80%</p></li></ul></div>')
EDGE_STATS = ["공격 속도", "쿨다운 감소"]


def read_outputs(out_dir):
    return {n: (Path(out_dir) / n).read_bytes() for n in ("items.json", "characters.json", "items.meta.json")}


class ArticleSelectionTests(unittest.TestCase):
    def test_latest_regular_and_later_hotfixes(self):
        arts = [article(3900, "2026.10.29 - 12.7 패치노트", hidden=1), article(3899, "12.6a 핫픽스"),
                article(3898, "2026.10.15 - 12.6 패치노트"), article(3882, "12.5b 핫픽스"),
                article(3867, "2026.10.01 - 12.5 패치노트")]
        parts, hotfixes = pn.select_articles(arts)
        self.assertEqual([a["id"] for a in parts], [3898])
        self.assertEqual(parts[0]["version"], "12.6")
        self.assertEqual([a["id"] for a in hotfixes], [3899])

    def test_multi_part_patch(self):
        arts = [article(3768, "12.0b 핫픽스"), article(3743, "[수정] 12.0 패치노트 Part.2 - 실험체 및 아이템"),
                article(3742, "12.0 패치노트 Part.1 - 메인 (2026.08.06)"), article(3713, "2026.07.23 - 11.7 패치노트")]
        parts, hotfixes = pn.select_articles(arts)
        self.assertEqual([a["id"] for a in parts], [3742, 3743])
        self.assertEqual([a["id"] for a in hotfixes], [3768])
        self.assertIsNone(pn.select_articles([article(1, "12.5b 핫픽스")]))


class ExtractTests(unittest.TestCase):
    def test_lines_depth_and_scope(self):
        lines = pn.extract_lines(PATCH_HTML)
        texts = [t for _, _, t in lines]
        self.assertEqual(lines[1], ("h5", 0, "실험체"))
        self.assertIn(("p", 1, "아르카나 무기 숙련도 레벨 당 스킬 증폭 4.4% → 4.5%"), lines)
        self.assertIn(("p", 2, "공격 속도 4% → 4.5%"), lines)  # &nbsp; + <strong> split
        self.assertIn(("p", 3, "중첩 당 공격 속도 12% → 8%"), lines)
        self.assertNotIn("선녀강림 공격 속도 1% → 2%", texts)  # sidebar after the body
        self.assertNotIn("무기", texts[:3])  # menu before the body
        self.assertEqual(texts[-1], "활 사용 시 받는 피해량 97% → 100%")
        with self.assertRaises(ValueError):
            pn.extract_lines("<html><p>no body</p></html>")

    def test_entities(self):
        lines = pn.extract_lines('<div class="er-article-detail__content"><p>A&amp;B&#44;&#x41;'
                                 '&unknown;&nbsp;&lt;x&gt;</p></div>')
        self.assertEqual(lines, [("p", 0, "A&B,A&unknown; <x>")])


class ParseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        flat, pct = fi.stat_kinds(RAW_ITEMS)
        cls.parsed = pn.parse_patch([PATCH_HTML, HOTFIX_HTML], flat | pct)

    def test_changes(self):
        got = [(c["type"], c["name"], c.get("weapon"), c["stat"], c["value"]) for c in self.parsed["changes"]]
        self.assertEqual(got, [
            ("character", "아디나", "아르카나", "skillAmpRatio", 0.045),
            ("character", "루치아", "저격총", "attackSpeedRatio", 0.045),
            ("character", "루치아", "저격총", "skillAmpRatio", 0.043),
            ("character", "라우라", None, "attackPower", 33),
            ("character", "없는실험체", None, "attackPowerPerLevel", 5),
            ("item", "다인슬라이프 - 진홍", None, "공격력", 84),
            ("item", "선녀강림", None, "공격 속도", 0.42),
            ("item", "황야의 별", None, "공격 속도", 0.42),
            ("item", "큐브 워치", None, "치명타 피해량", 0.04),
            ("item", "큐브 워치", None, "공격력", 10),
            ("item", "월왕구천", None, "공격력", 27),
            ("item", "월왕구천", None, "공격 속도", 0.3),
            ("item", "없는 아이템", None, "방어력", 2),
            ("character", "아디나", "아르카나", "skillAmpRatio", 0.046),
            ("item", "선녀강림", None, "공격 속도", 0.45),
        ])

    def test_unparsed(self):
        self.assertEqual([(u["name"], u["text"]) for u in self.parsed["unparsed"]], [
            ("라우라", "기본 방어력 51 → 52"),
            ("저거너트", "열정 - [고유 장착 효과] > 중첩 당 공격 속도 12% → 8%"),
            ("노바 실드 맞춤형 능력치", "노바 실드 맞춤형 능력치 43 → 45"),  # unknown stat name
            ("분홍신", "분홍신 공격 속도 38 → 33%"),  # old/new units differ
        ])

    def test_edge_rows(self):
        parsed = pn.parse_patch([EDGE_HTML], EDGE_STATS)
        self.assertEqual([(c["name"], c["stat"], c["value"]) for c in parsed["changes"]],
                         [("선녀 강림", "공격 속도", 0.42)])  # h3 ends 방어구: no 0.8
        self.assertEqual([(u["name"], u["text"]) for u in parsed["unparsed"]], [
            ("더 문", "쿨다운 감소 10 (삭제)"),  # deleted stat reported
            ("더 문", "공격 속도 1% → 0.001%"),  # &rarr;; value outside the shared float range
        ])
        node = run_node({}, 'const m = await imp("fetch_patchnote.mjs");'
                        'return m.parsePatch([env.A], JSON.parse(env.S));',
                        A=EDGE_HTML, S=json.dumps(EDGE_STATS))
        self.assertEqual(node, parsed)

    def test_parts_on_later_page(self):
        bodies = {pn.LIST_URL.format(page=1): json.dumps({"total_page": 2, "articles": [
                      article(3743, "12.0 패치노트 Part.2")]}, ensure_ascii=False),
                  pn.LIST_URL.format(page=2): json.dumps({"total_page": 2, "articles": [
                      article(3742, "12.0 패치노트 Part.1"), article(3713, "11.7 패치노트")]}, ensure_ascii=False),
                  "https://playeternalreturn.com/posts/news/3742": "1",
                  "https://playeternalreturn.com/posts/news/3743": "2"}
        with replay(bodies):
            patch = pn.fetch_patch()
        self.assertEqual([a["id"] for a in patch["info"]["articles"]], [3742, 3743])
        self.assertEqual(patch["bodies"], ["1", "2"])
        node = run_node(bodies, 'const m = await imp("fetch_patchnote.mjs"); return m.fetchPatch();')
        self.assertEqual(node, patch)


class ApplyTests(unittest.TestCase):
    """Offline: dak.gg fixture + patch-note fixtures through fetch_all."""

    @classmethod
    def setUpClass(cls):
        cls.bodies = fixture_bodies()
        with tempfile.TemporaryDirectory() as tmp, replay(cls.bodies):
            cls.result = fi.fetch_all(tmp, FETCHED_AT)
            cls.files = read_outputs(tmp)

    def test_overrides_only_where_values_differ(self):
        got = [(o["type"], o["name"], o["stat"], o["dakgg"], o["patchnote"]) for o in self.result["meta"]["overrides"]]
        self.assertEqual(got, [
            ("item", "선녀강림", "공격 속도", 0.4, 0.45),  # hotfix after the patch wins
            ("item", "큐브 워치", "치명타 피해량", None, 0.04),  # (신규) stat
            ("item", "큐브 워치", "공격력", 15, 10),
            ("item", "월왕구천", "공격력", 25, 27),  # new item 능력치
            ("character", "아디나", "masteries.아르카나.skillAmpRatio", 0.044, 0.046),
            ("character", "루치아", "masteries.저격총.skillAmpRatio", 0.042, 0.043),
            ("character", "라우라", "attackPower", 30, 33),
        ])
        # Same value on dak.gg and in the patch note: no override (황야의 별, 다인슬라이프, 루치아 공속).
        names = {(o["name"], o["stat"]) for o in self.result["meta"]["overrides"]}
        self.assertNotIn(("황야의 별", "공격 속도"), names)
        self.assertNotIn(("다인슬라이프 - 진홍", "공격력"), names)
        self.assertNotIn(("루치아", "masteries.저격총.attackSpeedRatio"), names)

    def test_values_written(self):
        items = {i["name"]: i for i in json.loads(self.files["items.json"])}
        self.assertEqual(items["선녀강림"]["stats"], {"방어력": 20, "공격 속도": 0.45})
        self.assertEqual(items["큐브 워치"]["stats"], {"공격력": 10, "치명타 확률": 0.35, "치명타 피해량": 0.04})
        self.assertEqual(items["황야의 별"]["stats"], {"공격 속도": 0.42})
        chars = {c["name"]: c for c in json.loads(self.files["characters.json"])}
        self.assertEqual(chars["아디나"]["masteries"]["아르카나"]["skillAmpRatio"], 0.046)
        self.assertEqual(chars["라우라"]["attackPower"], 33)

    def test_meta(self):
        meta = json.loads(self.files["items.meta.json"])
        self.assertEqual(meta["fetchedAt"], FETCHED_AT)
        self.assertEqual(meta["dakggVersion"], "12.6.0")
        self.assertEqual({k: meta["patch"][k] for k in ("id", "version", "title", "url", "date")}, {
            "id": 3898, "version": "12.6", "title": "2026.10.15 - 12.6 패치노트",
            "url": "https://playeternalreturn.com/posts/news/3898", "date": "2026-10-15"})
        self.assertEqual([a["id"] for a in meta["patch"]["articles"]], [3898, 3899])
        unparsed = [(u["type"], u["name"]) for u in meta["unparsed"]]
        self.assertIn(("item", "없는 아이템"), unparsed)  # in the patch note, not in the data
        self.assertIn(("character", "없는실험체"), unparsed)
        self.assertEqual(len(unparsed), 6)

    def test_node_output_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            node_result = run_node(self.bodies, NODE_FETCH_ALL, OUT=tmp, AT=FETCHED_AT)
            self.assertEqual(read_outputs(tmp), self.files)
            self.assertEqual(sorted(Path(tmp).iterdir()), sorted(Path(tmp) / n for n in self.files))  # no .tmp left
        self.assertEqual(node_result, json.loads(json.dumps(self.result, ensure_ascii=False)))
        node = run_node(self.bodies, 'const m = await imp("fetch_patchnote.mjs");'
                        'return m.parsePatch([env.A, env.B], ["공격력", "공격 속도", "치명타 피해량", "방어력"]);',
                        A=PATCH_HTML, B=HOTFIX_HTML)
        py = pn.parse_patch([PATCH_HTML, HOTFIX_HTML], ["공격력", "공격 속도", "치명타 피해량", "방어력"])
        self.assertEqual(json.dumps(node, ensure_ascii=False), json.dumps(py, ensure_ascii=False))


class LiveTests(unittest.TestCase):
    def test_fetch_all_python_and_node_identical(self):
        bodies = {}
        with tempfile.TemporaryDirectory() as py_dir, tempfile.TemporaryDirectory() as js_dir:
            with record(bodies):
                result = fi.fetch_all(py_dir, FETCHED_AT)
            node_result = run_node(bodies, NODE_FETCH_ALL, OUT=js_dir, AT=FETCHED_AT)
            self.assertEqual(read_outputs(js_dir), read_outputs(py_dir))
        self.assertEqual(node_result, json.loads(json.dumps(result, ensure_ascii=False)))
        self.assertGreater(len(result["items"]), 400)
        self.assertTrue(result["meta"]["patch"]["version"])


if __name__ == "__main__":
    unittest.main()
