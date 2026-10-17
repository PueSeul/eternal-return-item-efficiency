import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_harness import (ROOT, ROBOTS_TXT, article, fi, fs, pn, patch_bodies, record, replay,  # noqa: F401
                          run_node, wiki_page)

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
    # namu.wiki: 아디나 revised before the patch note (E is overwritten), 루치아 has no
    # document under either title, 라우라 is redirected and revised after the patch.
    bodies[fs.ROBOTS_URL] = ROBOTS_TXT
    bodies[fs.doc_url("아디나(이터널 리턴)")] = wiki_page("2026-10-01T00:00:00.000Z", [
        ("E - 폴 디그니티", [("Adina E", ["피해량 [20 / 30 / 40 / 50] (+스킬 증폭의 6%)"])])])
    bodies[fs.doc_url("루치아(이터널 리턴)")] = {"status": 404}
    bodies[fs.doc_url("루치아")] = {"status": 404}
    bodies[fs.doc_url("라우라(이터널 리턴)")] = {"status": 302, "location": "/w/%EB%9D%BC%EC%9A%B0%EB%9D%BC?from=x"}
    bodies[fs.doc_url("라우라") + "?from=x"] = wiki_page("2026-10-16T00:00:00.000Z", [
        ("Q - 예고장", [("Laura Q", ["피해량 [10 / 20] (+공격력의 50%)"])])])
    return bodies


NODE_FETCH_ALL = ('const m = await imp("fetch_items.mjs");'
                  'return m.fetchAll({ outDir: env.OUT, fetchedAt: env.AT, intervalMs: 0 });')
EDGE_HTML = ('<div class="er-article-detail__content"><h5>방어구</h5>'
             '<ul><li><p>더 문</p><ul><li><p><s>쿨다운 감소 10</s> (삭제)</p></li>'
             '<li><p>공격 속도 1% &rarr; 0.001%</p></li></ul></li></ul>'
             '<ul><li><p>선녀\u2028강림 공격 속도 40% → 42%</p></li></ul>'
             '<h3>코발트 프로토콜</h3><ul><li><p>선녀강림 공격 속도 40% → 80%</p></li></ul></div>')
EDGE_STATS = ["공격 속도", "쿨다운 감소"]


def read_outputs(out_dir):
    return {n: (Path(out_dir) / n).read_bytes()
            for n in ("items.json", "characters.json", "skills.json", "items.meta.json")}


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

    def test_skill_changes(self):
        skills = [c for c in self.parsed["changes"] if c["type"] == "skill"]
        self.assertEqual(skills, [{
            "type": "skill", "name": "아디나", "key": "E", "skill": "폴 디그니티", "label": "피해량",
            "before": "20/30/40/50(+스킬 증폭의 6%)", "after": "26/36/46/56(+스킬 증폭의 7%)",
            "text": "폴 디그니티(E) > 피해량 20/30/40/50(+스킬 증폭의 6%) → 26/36/46/56(+스킬 증폭의 7%)",
            "part": 0}])

    def test_skill_rows_and_name_ending_in_da(self):
        # "아르다" ends in 다 but is a name row (it used to be read as a description,
        # so its rows went to the previous character).
        html = ('<div class="er-article-detail__content"><h5>실험체</h5>'
                '<p>아디나</p><p>상향합니다</p>'
                '<ul><li><p>아르카나 무기 숙련도 레벨 당 스킬 증폭 4.4% → 4.5%</p></li></ul>'
                '<p>아르다</p><p>아르다는 낮은 피해량 지표를 기록하고 있다</p><ul>'
                '<li><p>바빌론의 입방체(W)</p><ul>'
                '<li><p>1타 피해량 60/80(+스킬 증폭의 50%) → 70/90(+스킬 증폭의 55%)</p></li>'
                '<li><p>바빌론의 주사위(RW)도 적용됩니다.</p></li></ul></li>'
                '<li><p>오버클럭(R)</p><ul>'
                '<li><p>광자력 수류탄(RE) 지속 피해량 30/40(+스킬 증폭의 15%) → 30/40(+스킬 증폭의 18%)</p></li>'
                '<li><p>2타 피해량 공격력의 50/55% → 55/60%</p></li></ul></li>'
                '<li><p>휠 댄스(데비 W)</p><ul><li><p>피해량 40(+공격력의 5%) → 40(+공격력의 6%)</p></li>'
                '</ul></li></ul></div>')
        parsed = pn.parse_patch([html], [])
        got = [(c["name"], c["key"], c["label"]) for c in parsed["changes"] if c["type"] == "skill"]
        self.assertEqual(got, [("아르다", "W", "1타 피해량"), ("아르다", "RE", "지속 피해량")])
        self.assertEqual([c["name"] for c in parsed["changes"] if c["type"] == "character"], ["아디나"])
        self.assertEqual([(u["type"], u["name"], u["text"]) for u in parsed["unparsed"]], [
            ("skill", "아르다", "오버클럭(R) > 2타 피해량 공격력의 50/55% → 55/60%"),
            ("skill", "아르다", "휠 댄스(데비 W) > 피해량 40(+공격력의 5%) → 40(+공격력의 6%)")])
        node = run_node({}, 'const m = await imp("fetch_patchnote.mjs"); return m.parsePatch([env.A], []);', A=html)
        self.assertEqual(node, parsed)

    def test_changes(self):
        got = [(c["type"], c["name"], c.get("weapon"), c["stat"], c["value"])
               for c in self.parsed["changes"] if c["type"] != "skill"]
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
        got = [(o["type"], o["name"], o["stat"], o["dakgg"], o["patchnote"])
               for o in self.result["meta"]["overrides"] if o["type"] != "skill"]
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

    def test_skills(self):
        skills = {c["name"]: c for c in json.loads(self.files["skills.json"])}
        self.assertEqual(list(skills), ["아디나", "루치아", "라우라"])  # character id order
        adina = skills["아디나"]
        self.assertEqual(adina["characterId"], "1")
        self.assertEqual([(l["level"], l["baseDamage"], l["skillAmpRatio"]) for l in adina["skills"][0]["levels"]],
                         [(1, 26, 0.07), (2, 36, 0.07), (3, 46, 0.07), (4, 56, 0.07)])  # wiki older: patch wins
        self.assertEqual(skills["루치아"]["needsReview"], [
            {"skill": None, "text": fs.doc_url("루치아(이터널 리턴)"), "reason": "문서 없음"}])
        self.assertEqual(skills["라우라"]["wikiRevisedAt"], "2026-10-16T00:00:00.000Z")  # redirected page
        self.assertEqual(skills["라우라"]["skills"][0]["levels"][1],
                         {"level": 2, "baseDamage": 20, "attackPowerRatio": 0.5, "skillAmpRatio": 0})
        meta = self.result["meta"]
        rows = [o for o in meta["overrides"] if o["type"] == "skill"]
        self.assertEqual(len(rows), 8)  # 4 levels × (baseDamage, skillAmpRatio)
        self.assertEqual(rows[0], {
            "type": "skill", "characterId": "1", "name": "아디나", "skill": "E", "level": 1, "field": "baseDamage",
            "stat": "1레벨 baseDamage", "dakgg": 20, "patchnote": 26,
            "text": "폴 디그니티(E) > 피해량 20/30/40/50(+스킬 증폭의 6%) → 26/36/46/56(+스킬 증폭의 7%)"})
        self.assertEqual((rows[1]["field"], rows[1]["dakgg"], rows[1]["patchnote"]), ("skillAmpRatio", 0.06, 0.07))
        self.assertEqual(meta["skipped"], [])

    def test_meta(self):
        meta = json.loads(self.files["items.meta.json"])
        self.assertEqual(meta["fetchedAt"], FETCHED_AT)
        self.assertEqual(meta["dakggVersion"], "12.6.0")
        self.assertEqual({k: meta["patch"][k] for k in ("id", "version", "title", "url", "date")}, {
            "id": 3898, "version": "12.6", "title": "2026.10.15 - 12.6 패치노트",
            "url": "https://playeternalreturn.com/posts/news/3898", "date": "2026-10-15"})
        self.assertEqual([a["id"] for a in meta["patch"]["articles"]], [3898, 3899])
        self.assertEqual(meta["patch"]["articles"][0]["createdAt"], "2026-10-14T08:00:00.000000Z")
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
                result = fi.fetch_all(py_dir, FETCHED_AT)  # includes ~91 namu.wiki pages, 1 s apart
            node_result = run_node(bodies, NODE_FETCH_ALL, OUT=js_dir, AT=FETCHED_AT)
            self.assertEqual(read_outputs(js_dir), read_outputs(py_dir))
        self.assertEqual(node_result, json.loads(json.dumps(result, ensure_ascii=False)))
        self.assertGreater(len(result["items"]), 400)
        self.assertEqual(len(result["skills"]), len(result["characters"]))
        self.assertTrue(result["meta"]["patch"]["version"])


if __name__ == "__main__":
    unittest.main()
