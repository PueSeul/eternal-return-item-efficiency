import copy
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_harness import ROOT, fs, replay, run_node, wiki_page  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
# Trimmed real page (revision time, 스킬 and 역사 sections; see the comment in the file).
ARDA_HTML = (FIXTURES / "namu_arda.html").read_text(encoding="utf-8")
NAMU_ROBOTS = (
    "User-agent: *\nDisallow: /\nAllow: /$\nAllow: /ads.txt\nAllow: /w/\nAllow: /history/\n"
    "Allow: /_nuxt/\nAllow: /cdn-cgi/\n")
NODE_PARSE = 'const m = await imp("fetch_skills.mjs"); return m.parsePage(env.ID, env.NAME, env.HTML);'


def by_key(entry):
    return {s["key"]: s for s in entry["skills"]}


class ArdaPageTests(unittest.TestCase):
    """Fixed values from the real 아르다 document (2026-10-16 revision)."""

    @classmethod
    def setUpClass(cls):
        cls.entry = fs.parse_page("66", "아르다", ARDA_HTML)

    def test_q_and_e(self):
        skills = by_key(self.entry)
        q = skills["Q"]
        self.assertEqual((q["name"], q["sourceLabel"]), ("샤마쉬의 두루마리", "피해량"))
        self.assertEqual(q["levels"][4], {"level": 5, "baseDamage": 230, "attackPowerRatio": 0, "skillAmpRatio": 0.8})
        self.assertEqual(q["raw"], "피해량 [70 / 110 / 150 / 190 / 230] (+스킬 증폭의 80%)")
        self.assertEqual({l["skillAmpRatio"] for l in skills["E"]["levels"]}, {0.65})
        self.assertEqual([l["baseDamage"] for l in skills["E"]["levels"]], [80, 110, 140, 170, 200])

    def test_keys_and_entries(self):
        self.assertEqual(self.entry["wikiRevisedAt"], "2026-10-16T14:01:59.000Z")
        self.assertEqual([s["key"] for s in self.entry["skills"]], ["P", "Q", "RQ", "W", "RW", "E", "RE", "R"])
        self.assertEqual(self.entry["needsReview"], [])
        skills = by_key(self.entry)
        rq = skills["RQ"]
        self.assertEqual(rq["name"], "샤마쉬의 법전")
        self.assertEqual([e["label"] for e in rq["entries"]], ["[샤마쉬의 법전] 주문 피해량"])
        self.assertEqual(rq["entries"][0]["levels"], [
            {"level": n, "baseDamage": b, "attackPowerRatio": 0, "skillAmpRatio": 0.8}
            for n, b in enumerate([160, 240, 320], 1)])
        self.assertEqual((rq["levels"], rq["raw"], rq["sourceLabel"]),
                         (rq["entries"][0]["levels"], rq["entries"][0]["raw"], "[샤마쉬의 법전] 주문 피해량"))
        self.assertEqual([e["label"] for e in skills["W"]["entries"]], ["피해량", "추가 피해량"])
        self.assertEqual([e["label"] for e in skills["RW"]["entries"]], ["[바빌론의 주사위] 장벽 피해량"])
        self.assertEqual(skills["P"]["sourceLabel"], "체력 회복량")  # heal rows are entries too
        # 역사: last W record "12.2 … 스킬 증폭 계수가 50%로" vs box 55%/65% -> marked, box value kept;
        # last E record "12.5 … 65%로" matches the box -> not marked.
        marked = [(s["key"], e["label"]) for s in self.entry["skills"] for e in s["entries"] if "historyMismatch" in e]
        self.assertEqual(marked, [("W", "피해량"), ("W", "추가 피해량")])
        self.assertIn("12.2 패치로 바빌론의 입방체(W)의 1타 피해량 스킬 증폭 계수가 50%로 증가했다.",
                      skills["W"]["entries"][0]["historyMismatch"]["text"])
        self.assertEqual(skills["W"]["entries"][0]["levels"][0]["skillAmpRatio"], 0.55)

    def test_node_identical(self):
        self.assertEqual(run_node({}, NODE_PARSE, ID="66", NAME="아르다", HTML=ARDA_HTML), self.entry)


class RowTests(unittest.TestCase):
    def test_levels_from(self):
        levels, _ = fs.levels_from(["40"], ["+공격력의 25% / 35% / 45%"])  # one base, per-level ratio
        self.assertEqual([(l["baseDamage"], l["attackPowerRatio"]) for l in levels], [(40, 0.25), (40, 0.35), (40, 0.45)])
        levels, _ = fs.levels_from(["10", "30"], ["+공격력의 170/175%", "+스킬 증폭의 7%"])  # patch-note form
        self.assertEqual(levels[1], {"level": 2, "baseDamage": 30, "attackPowerRatio": 1.75, "skillAmpRatio": 0.07})
        self.assertEqual(fs.levels_from(["1", "2"], ["+공격력의 1% / 2% / 3%"]), (None, "레벨 수 불일치"))
        self.assertEqual(fs.levels_from(["5%", "6"], []), (None, "형식 미해석"))
        # Other coefficient kinds go to extraRatios (damage per stat unit), level by level.
        levels, _ = fs.levels_from(["10", "20"], [
            "+스킬 증폭의 30%", "+대상 최대 체력의 2% / 3%", "+레니 레벨 * 8", "+스킬 증폭 25 당 1",
            "+치명타 확률 1% 당 0.1%", "+소모한 기력 당 2", "+비명 중첩 당 피해량 2", "+야성 중첩",
            "+배터리 중첩 * 15 / 20", "+남은 탄창 * 스킬 증폭의 3%"])
        self.assertEqual(levels[1], {"level": 2, "baseDamage": 20, "attackPowerRatio": 0, "skillAmpRatio": 0.3,
                                     "extraRatios": [{"stat": "대상 최대 체력", "ratio": 0.03},
                                                     {"stat": "레니 레벨", "ratio": 8}, {"stat": "스킬 증폭", "ratio": 0.04},
                                                     {"stat": "치명타 확률", "ratio": 0.1}, {"stat": "소모한 기력", "ratio": 2},
                                                     {"stat": "비명 중첩", "ratio": 2}, {"stat": "야성 중첩", "ratio": None},
                                                     {"stat": "배터리 중첩", "ratio": 20},
                                                     {"stat": "남은 탄창 * 스킬 증폭", "ratio": 0.03}]})
        self.assertEqual(fs.levels_from(["6%", "10%"], ["+공격력의 5%"], "최대 체력 피해량(%)")[0][1],
                         {"level": 2, "baseDamage": 0, "attackPowerRatio": 0.05, "skillAmpRatio": 0,
                          "extraRatios": [{"stat": "최대 체력 피해량(%)", "ratio": 0.1}]})  # percent base
        self.assertEqual(fs.levels_from(["1"], ["+소모한 기력 당 1 / 2"])[0][1]["extraRatios"],
                         [{"stat": "소모한 기력", "ratio": 2}])
        self.assertEqual(fs.levels_from([], ["+공격력의 55% / 60%"])[0][0],
                         {"level": 1, "baseDamage": 0, "attackPowerRatio": 0.55, "skillAmpRatio": 0})  # stat body
        self.assertEqual(fs.levels_from(["1"], ["+대상 현재 체력의 8%(+스킬 증폭"]),
                         (None, "계수 형식 미해석: (+대상 현재 체력의 8%(+스킬 증폭)"))  # unbalanced
        self.assertEqual(fs.levels_from(["1"], ["+대상 현재 체력의 8%(스킬 증폭의 2%)"]),
                         (None, "계수 형식 미해석: (스킬 증폭의 2%)"))  # nested part without "+"
        self.assertEqual(fs.levels_from(["1"], ["+공격력의 1%", "+공격력의 2%"]), (None, "계수 중복: 공격력"))
        node = run_node({}, 'const m = await imp("fetch_skills.mjs"); return JSON.parse(env.C).map(([v, c]) => m.levelsFrom(v, c));',
                        C=json.dumps([[["10", "20"], ["+스킬 증폭 25 당 1", "+치명타 확률 1% 당 0.1%", "+야성 중첩"]],
                                      [["1"], ["+a 0 당 1"]], [["6%"], []]]))
        self.assertEqual(node, [list(fs.levels_from(["10", "20"], ["+스킬 증폭 25 당 1", "+치명타 확률 1% 당 0.1%",
                                                                   "+야성 중첩"])),
                                list(fs.levels_from(["1"], ["+a 0 당 1"])), list(fs.levels_from(["6%"], []))])

    def test_page_rows(self):
        html = wiki_page("2026-01-01T00:00:00Z", [
            ("패시브 - 단추", [("Yuki T", ["피해량 [40] (+공격력의 25% / 35% / 45%)"])]),
            ("Q - 머리치기!", [("Yuki Q", ["피해량 [20 / 40] (+공격력의 100%) * (기본 공격 증폭)",
                                           "쿨다운 [5 / 4]"])]),
            ("W - 쌍둥이 / 둘째", [("Debi W", ["피해량 [1 / 2] (+공격력의 10%)"]),
                                  ("Marlene W", ["피해량 [3 / 4] (+스킬 증폭의 20%)[2]"]),
                                  ("illustration", ["설명만 있는 줄"])]),
            ("E - 두 번", [("E", ["피해량 [1] (+공격력의 1%)", "[강화] 피해량 [2] (+공격력의 2%)"])]),
            ("R - 궁", [("R", ["최대 체력 피해량(%) [6% / 10%] (+공격력의 5%)"])]),
        ], history=["8.1 패치에서 둘째(W)의 피해량이 1/3에서 5/6으로 감소했다."])
        entry = fs.parse_page("7", "유키", html)
        self.assertEqual([(s["key"], s["name"]) for s in entry["skills"]],
                         [("P", "단추"), ("Q", "머리치기!"), ("W", "쌍둥이"), ("W2", "둘째"), ("E", "두 번"), ("R", "궁")])
        skills = by_key(entry)
        self.assertEqual(len(skills["P"]["levels"]), 3)
        self.assertEqual(skills["W2"]["levels"][1]["skillAmpRatio"], 0.2)  # footnote [2] ignored
        q = skills["Q"]["entries"]
        self.assertEqual([(e["label"], e.get("multiplier"), len(e["levels"])) for e in q], [("피해량", "기본 공격 증폭", 2)])
        self.assertEqual([e["label"] for e in skills["E"]["entries"]], ["피해량", "[강화] 피해량"])  # every row kept
        self.assertEqual(skills["E"]["levels"], skills["E"]["entries"][0]["levels"])
        self.assertEqual(skills["R"]["entries"][0]["levels"][1]["extraRatios"],
                         [{"stat": "최대 체력 피해량(%)", "ratio": 0.1}])
        self.assertEqual(entry["needsReview"], [])
        self.assertEqual([s["key"] for s in entry["skills"] for e in s["entries"] if "historyMismatch" in e], ["W"])
        self.assertEqual(run_node({}, NODE_PARSE, ID="7", NAME="유키", HTML=html), entry)

    def test_edge_rows(self):
        html = wiki_page("2026-01-01T00:00:00Z", [
            ("Q - 하나", [("X RQ", ["피해량 [1 / 2] (+공격력의 10%)"]), ("Y RQ", ["피해량 [3 / 4] (+공격력의 20%)"])]),
            ("W - 고정", [("W", ["피해량 [100]", "추가 피해량 [레벨 × 10]", "받는 피해량 감소(%) [50%]",
                                  "피해량의 일부 회복[1]", "보호막 흡수량 [50] (+스킬 증폭의 30%)", "쿨다운 [8]"])]),
            ("E - 작은 값", [("E", ["피해량 [1] (+공격력의 0.001%)"])]),
            ("R - 언더플로", [("R", ["피해량 [0." + "0" * 330 + "1]"])]),
            ("무기 스킬 - 돌진", [("Blair D", ["총 공격력 계수 [공격력의 70% / 90%]"])]),
        ])
        html = html.replace("<table>", "<table><tr><td>표 머리글</td></tr>", 1)  # text before the first image
        entry = fs.parse_page("1", "t", html)
        skills = by_key(entry)
        self.assertEqual(list(skills), ["RQ", "RQ2", "W", "E", "R", "D"])  # no fake sub-skill, unique keys
        self.assertEqual(skills["W"]["levels"], [{"level": 1, "baseDamage": 100, "attackPowerRatio": 0,
                                                  "skillAmpRatio": 0}])  # "[100]" is not a footnote
        # Unreadable rows stay as entries without levels; 감소 rows, footnotes and 쿨다운 are no entries.
        self.assertEqual([(e["label"], len(e["levels"])) for e in skills["W"]["entries"]],
                         [("피해량", 1), ("추가 피해량", 0), ("보호막 흡수량", 1)])
        self.assertEqual(skills["D"]["levels"][1]["attackPowerRatio"], 0.9)
        self.assertEqual([(r["skill"], r["reason"]) for r in entry["needsReview"]],
                         [("W", "형식 미해석"), ("E", "수치 범위"), ("R", "수치 범위")])
        self.assertEqual(run_node({}, NODE_PARSE, ID="1", NAME="t", HTML=html), entry)
        # A patch row for the unreadable 추가 피해량 row must not overwrite 피해량 by its old value.
        (over, skipped, unparsed) = fs.apply_skill_changes(
            [entry], [change("t", "W", "추가 피해량", "100", "200", part=1)], ApplyTests.ARTICLES)
        self.assertEqual((over, skipped, len(unparsed)), ([], [], 1))

    def test_history_order(self):
        rows = ["피해량 [10 / 20] (+스킬 증폭의 30%)"]
        cases = [
            ["1.0 패치에서 하나(Q)의 피해량이 10/20(+스킬 증폭의 20%)에서 10/20(+스킬 증폭의 30%)로 증가했다."],
            ["1.0 패치에서 하나(Q)의 피해량이 10/20(+스킬 증폭의 20%)로 바뀌고 이후 스킬 증폭 계수가 30%로 증가했다."],
        ]
        def mark(rows, history):
            entry = fs.parse_page("1", "t", wiki_page("2026-01-01T00:00:00Z", [("Q - 하나", [("Q", rows)])], history))
            self.assertEqual(entry["needsReview"], [], history)
            return entry["skills"][0]["entries"][0].get("historyMismatch")
        for history in cases:
            self.assertIsNone(mark(rows, history), history)  # last record is 30% in both
        # A single new value is not read; the old list must not become the last record.
        self.assertIsNone(mark(["피해량 [30]"], ["1.0 패치에서 하나(Q)의 피해량이 10/20에서 30으로 변경됐다."]))
        line = "2.0 패치에서 하나(Q)의 스킬 증폭 계수가 25%로 감소했다."
        self.assertEqual(mark(rows, [line]), {"text": "skillAmpRatio 설명란 [0.3], 역사 마지막 0.25: " + line})

    def test_jackie_q(self):
        # 호스트 지적: 재키 Q "연참" showed "수동 입력". The row parses; the stale value came from
        # an older parser's entry kept in "patched" mode (see PlanPagesTests).
        row = "피해량 [30 / 50 / 70 / 90 / 110] (+공격력의 50%) (+대상 현재 체력의 5%)"
        html = wiki_page("2026-10-16T01:55:50.000Z", [("Q - 연참", [("Jackie Q", [row, "쿨다운 [8 / 7 / 6 / 5 / 4]"])])])
        entry = fs.parse_page("1", "재키", html)
        q = by_key(entry)["Q"]
        self.assertEqual((q["name"], [e["label"] for e in q["entries"]], q["raw"]), ("연참", ["피해량"], row))
        self.assertEqual(q["levels"], [{"level": n, "baseDamage": b, "attackPowerRatio": 0.5, "skillAmpRatio": 0,
                                        "extraRatios": [{"stat": "대상 현재 체력", "ratio": 0.05}]}
                                       for n, b in enumerate([30, 50, 70, 90, 110], 1)])
        self.assertEqual((entry["needsReview"], entry["parser"]), ([], fs.PARSER_VERSION))
        self.assertEqual(run_node({}, NODE_PARSE, ID="1", NAME="재키", HTML=html), entry)

    def test_rows_without_body_and_prose(self):
        html = wiki_page("2026-01-01T00:00:00Z", [
            ("패시브 - 취기", [("P", ["맹호청권 2타 피해량 (+공격력의 30% / 40% / 50%) * (기본 공격 증폭)",
                                     "받는 피해량 감소 (+공격력의 1%)", "체력 회복량 (+공격력의 1%) 증가"])]),
            ("Q - 음파", [("Q", ["음파 공격력 계수 [3% / 6% / 9%] * (기본 공격 증폭)", "공격력 계수 [3 / 6]"])]),
            ("W - 산탄", [("W", ["단궁: 첫 탄환은 공격력의 100% * (기본 공격 증폭)의 기본 공격 피해를 입히고, 이후 "
                                 "탄환은 각각 공격력의 10%의 피해를 입힙니다.", "피해를 입히면 이동 속도가 증가합니다."])]),
            ("E - 윌슨", [("E", ["다음 기본 공격은 30(+스킬 증폭의 45%)(+시셀라 레벨*9)의 추가 스킬 피해를 입히고",
                                 "피해량 [10] (+공격력의 10%)"])]),
            ("R - 하나", [("R", ["다음 기본 공격은 30(+스킬 증폭의 45%)의 피해를 입힙니다."])]),
        ])
        entry = fs.parse_page("1", "t", html)
        s = by_key(entry)
        p = s["P"]["entries"]
        self.assertEqual([(e["label"], e.get("multiplier")) for e in p], [("맹호청권 2타 피해량", "기본 공격 증폭")])
        self.assertEqual([l["attackPowerRatio"] for l in p[0]["levels"]], [0.3, 0.4, 0.5])
        self.assertEqual([(e["label"], [l["attackPowerRatio"] for l in e["levels"]]) for e in s["Q"]["entries"]],
                         [("음파 공격력 계수", [0.03, 0.06, 0.09])])  # "[3 / 6]" without % is no coefficient
        self.assertEqual([(e["label"], e["levels"], e.get("multiplier")) for e in s["W"]["entries"]], [
            ("단궁: 공격력의 100% * (기본 공격 증폭)의 기본 공격 피해",
             [{"level": 1, "baseDamage": 0, "attackPowerRatio": 1, "skillAmpRatio": 0}], "기본 공격 증폭"),
            ("단궁: 공격력의 10%의 피해", [{"level": 1, "baseDamage": 0, "attackPowerRatio": 0.1, "skillAmpRatio": 0}],
             None)])
        self.assertEqual([e["label"] for e in s["E"]["entries"]], ["피해량"])  # sentences only without damage rows
        self.assertEqual(s["R"]["entries"][0]["levels"], [{"level": 1, "baseDamage": 30, "attackPowerRatio": 0,
                                                           "skillAmpRatio": 0.45}])
        self.assertEqual(entry["needsReview"], [])
        self.assertEqual(run_node({}, NODE_PARSE, ID="1", NAME="t", HTML=html), entry)

    def test_missing_document_and_section(self):
        self.assertEqual(fs.parse_page("1", "없음", None)["needsReview"][0]["reason"], "문서 없음")
        entry = fs.parse_page("1", "빈 문서", "<html><h2>1. 개요</h2></html>")
        self.assertEqual([r["reason"] for r in entry["needsReview"]], ["최근 수정 시각 없음", "스킬 문단 없음"])


class RobotsAndFetchTests(unittest.TestCase):
    def check_robots(self, text, cases):
        rules = fs.parse_robots(text)
        self.assertEqual({u: fs.robots_allowed(rules, u) for u in cases}, cases)
        node = run_node({}, 'const m = await imp("fetch_skills.mjs"); const r = m.parseRobots(env.R);'
                        'return Object.fromEntries(JSON.parse(env.U).map((u) => [u, m.robotsAllowed(r, u)]));',
                        R=text, U=json.dumps(list(cases)))
        self.assertEqual(node, cases)

    def test_robots(self):
        self.check_robots(NAMU_ROBOTS, {
            "https://namu.wiki/w/%EC%95%84": True, "https://namu.wiki/raw/x": False,
            "https://namu.wiki/": True, "https://namu.wiki/edit/x": False,
            "https://namu.wiki/w/a?from=b": True, "https://namu.wiki/history/x": True})
        self.assertTrue(fs._robots_match("/a*b$", "/axxb"))
        self.assertFalse(fs._robots_match("/a*b$", "/axxbc"))

    def test_robots_own_group_and_encoding(self):
        text = ("User-agent: *\nAllow: /\n\nUser-agent: Other\nUser-agent: ER-Damage-Efficiency\n"
                "Disallow: /w/아\nDisallow: /w/a\n")
        self.check_robots(text, {"https://namu.wiki/w/%EC%95%84%EB%A5%B4": False,
                                 "https://namu.wiki/w/%61b": False, "https://namu.wiki/w/b": True})
        self.assertEqual(fs.robots_normalize("/w/%7e%2f아"), "/w/~%2F%EC%95%84")
        # An empty Disallow ends the group; dot segments are resolved before matching.
        self.check_robots("User-agent: er-damage-efficiency\nDisallow:\n\nUser-agent: OtherBot\nDisallow: /\n",
                          {"https://namu.wiki/w/x": True})
        self.check_robots(NAMU_ROBOTS, {"https://namu.wiki/w/%2e%2e/raw/x": False,
                                        "https://namu.wiki/w/./a/../b": True})

    def test_encode_title(self):
        title = "데비&마를렌(이터널 리턴)"
        self.assertEqual(fs.doc_url(title), "https://namu.wiki/w/%EB%8D%B0%EB%B9%84%26%EB%A7%88%EB%A5%BC%EB%A0%8C"
                                            "%28%EC%9D%B4%ED%84%B0%EB%84%90%20%EB%A6%AC%ED%84%B4%29")
        node = run_node({}, 'const m = await imp("fetch_skills.mjs"); return m.docUrl(env.T);', T=title)
        self.assertEqual(node, fs.doc_url(title))

    def test_fetch_pages_fallback_and_robots(self):
        bodies = {fs.ROBOTS_URL: NAMU_ROBOTS, fs.doc_url("슈린(이터널 리턴)"): {"status": 404},
                  fs.doc_url("슈린"): "<html>슈린</html>", fs.doc_url("아르다(이터널 리턴)"): ARDA_HTML}
        with replay(bodies):
            pages = fs.fetch_pages(["슈린", "아르다"])
        self.assertEqual(pages, {"슈린": "<html>슈린</html>", "아르다": ARDA_HTML})
        node = run_node(bodies, 'const m = await imp("fetch_skills.mjs");'
                        'return Object.fromEntries(await m.fetchPages(["슈린", "아르다"], 0));')
        self.assertEqual(node, pages)
        # Redirects are followed hop by hop; a hop robots.txt disallows is never requested.
        redirect = dict(bodies)
        redirect[fs.doc_url("아르다(이터널 리턴)")] = {"status": 302, "location": "/w/%EC%95%84?from=x"}
        redirect["https://namu.wiki/w/%EC%95%84?from=x"] = ARDA_HTML
        with replay(redirect):
            self.assertEqual(fs.fetch_pages(["아르다"]), {"아르다": ARDA_HTML})
        bad = dict(bodies)
        bad[fs.doc_url("아르다(이터널 리턴)")] = {"status": 302, "location": "https://namu.wiki/raw/x"}
        with replay(bad), self.assertRaises(ValueError):
            fs.fetch_pages(["아르다"])  # /raw/x is not in `bad`: a request would raise KeyError
        with self.assertRaises(AssertionError):
            run_node(bad, 'const m = await imp("fetch_skills.mjs"); return await m.fetchPages(["아르다"], 0);')

    def test_instant_and_order(self):
        for text in ("2026-10-14T08:00:00.000000Z", "2026-10-16T14:01:59.000Z", "2024-02-29T23:59:59+09:00"):
            expected = int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp())
            self.assertEqual(fs.instant(text)[0], expected, text)
        for bad in ("2026-10-14", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T25:00:00Z",
                    "2026-01-01T00:00:00+99:99"):
            self.assertIsNone(fs.instant(bad), bad)
        cases = [("2026-10-16T14:01:59.000Z", "2026-10-14T08:00:00.000000Z", False),
                 ("2026-10-01T00:00:00Z", "2026-10-14T08:00:00.000000Z", True),
                 ("2026-10-14T08:00:00.000001Z", "2026-10-14T08:00:00.000002Z", True),  # below a millisecond
                 ("2026-10-14T17:00:00+09:00", "2026-10-14T08:00:00Z", False),  # same instant
                 ("2026-02-30T00:00:00Z", "2026-03-03T00:00:00Z", False), (None, "2026-03-03T00:00:00Z", False)]
        self.assertEqual([fs.is_before(a, b) for a, b, _ in cases], [e for _, _, e in cases])
        node = run_node({}, 'const m = await imp("fetch_skills.mjs");'
                        'return JSON.parse(env.C).map(([a, b]) => m.isBefore(a, b));', C=json.dumps(cases))
        self.assertEqual(node, [e for _, _, e in cases])


def change(name, key, label, before, after, part=0):
    return {"type": "skill", "name": name, "key": key, "skill": "s", "label": label, "before": before,
            "after": after, "text": f"s({key}) > {label} {before} → {after}", "part": part}


class ApplyTests(unittest.TestCase):
    ARTICLES = [{"id": 1, "createdAt": "2026-10-14T08:00:00.000000Z"},
                {"id": 2, "createdAt": "2026-10-20T08:00:00.000000Z"}]

    def skills(self):
        return [fs.parse_page("66", "아르다", ARDA_HTML)]

    def run_both(self, skills, changes):
        py_skills = copy.deepcopy(skills)
        result = fs.apply_skill_changes(py_skills, changes, self.ARTICLES)
        node = run_node({}, 'const m = await imp("fetch_skills.mjs"); const s = JSON.parse(env.S);'
                        'const r = m.applySkillChanges(s, JSON.parse(env.C), JSON.parse(env.A)); return [r, s];',
                        S=json.dumps(skills), C=json.dumps(changes), A=json.dumps(self.ARTICLES))
        self.assertEqual(node, json.loads(json.dumps([list(result), py_skills])))
        return result, py_skills

    def test_wiki_revised_after_patch_is_kept(self):
        # Wiki 2026-10-16 > patch 2026-10-14: wiki value stays, row goes to skipped.
        e = "80/110/140/170/200(+스킬 증폭의 65%)"
        (over, skipped, unparsed), skills = self.run_both(self.skills(), [
            change("아르다", "E", "피해량", e, "90/120/150/180/210(+스킬 증폭의 65%)")])
        self.assertEqual((over, unparsed), ([], []))
        self.assertEqual([(s["skill"], s["level"], s["field"], s["dakgg"], s["patchnote"]) for s in skipped],
                         [("E", n, "baseDamage", b, b + 10) for n, b in enumerate([80, 110, 140, 170, 200], 1)])
        self.assertEqual(skipped[0]["wikiRevisedAt"], "2026-10-16T14:01:59.000Z")
        self.assertEqual(skipped[0]["patchPostedAt"], "2026-10-14T08:00:00.000000Z")
        self.assertEqual(by_key(skills[0])["E"]["levels"][0]["baseDamage"], 80)

    def test_wiki_revised_before_patch_is_overwritten(self):
        (over, skipped, _), skills = self.run_both(self.skills(), [
            change("아르다", "E", "피해량", "80/110/140/170/200(+스킬 증폭의 60%)",
                   "80/110/140/170/200(+스킬 증폭의 70%)", part=1)])  # matched by label, posted 10-20
        self.assertEqual(skipped, [])
        self.assertEqual([(o["level"], o["field"], o["dakgg"], o["patchnote"]) for o in over],
                         [(n, "skillAmpRatio", 0.65, 0.7) for n in range(1, 6)])
        self.assertEqual(over[0]["characterId"], "66")
        self.assertEqual((over[0]["stat"], over[0]["label"]), ("피해량 1레벨 skillAmpRatio", "피해량"))
        e = by_key(skills[0])["E"]
        self.assertEqual({l["skillAmpRatio"] for l in e["levels"]}, {0.7})
        self.assertTrue(e["raw"].startswith("s(E) > 피해량"))

    def test_label_wins_over_value(self):
        # Wiki W: 피해량 70/90/… and 추가 피해량 50/80/…. A 추가 피해량 row whose old value happens
        # to equal the 피해량 row overwrites the 추가 피해량 entry, not 피해량.
        w = "70/90/110/130/150(+스킬 증폭의 55%)"
        (over, skipped, unparsed), skills = self.run_both(self.skills(), [
            change("아르다", "W", "추가 피해량", w, "1/2/3/4/5(+스킬 증폭의 55%)", part=1)])
        self.assertEqual((skipped, unparsed), ([], []))
        self.assertEqual({o["label"] for o in over}, {"추가 피해량"})
        w_entries = by_key(skills[0])["W"]["entries"]
        self.assertEqual([l["baseDamage"] for l in w_entries[0]["levels"]], [70, 90, 110, 130, 150])
        self.assertEqual([l["baseDamage"] for l in w_entries[1]["levels"]], [1, 2, 3, 4, 5])
        self.assertEqual(by_key(skills[0])["W"]["levels"], w_entries[0]["levels"])  # first entry untouched

    def synthetic(self, key, rows):
        page = wiki_page("2026-01-01T00:00:00Z", [(f"{key} - 하나", [(key, rows)])])
        return [fs.parse_page("9", "t", page)]

    def test_entry_matching_edges(self):
        cases = [
            # Another entry already shows the new value: 피해량 is still overwritten.
            (["피해량 [10]", "추가 피해량 [20]"], change("t", "Q", "피해량", "10", "20", part=1), "피해량"),
            # Tagged patch label: matched to the tagged entry, never to 피해량 by its old value.
            (["피해량 [10]", "[강화] 추가 피해량 [20]"], change("t", "Q", "[강화] 추가 피해량", "20", "30", part=1),
             "[강화] 추가 피해량"),
            # Two entries with the label (one unreadable) and an old value that matches neither.
            (["[일반] 피해량 [10]", "[강화] 피해량 [레벨 × 2]"], change("t", "Q", "피해량", "5", "30", part=1), None),
            # Unreadable row "추가 피해량[…]" without a space protects 피해량 from the value fallback.
            (["피해량 [10]", "추가 피해량[레벨 × 2]"], change("t", "Q", "추가 피해량", "10", "30", part=1), None),
        ]
        for rows, ch, label in cases:
            (over, _, unparsed), _ = self.run_both(self.synthetic("Q", rows), [ch])
            self.assertEqual(({o["label"] for o in over}, len(unparsed)), (({label}, 0) if label else (set(), 1)), rows)
        # A numbered sub-skill (Q2) is found under the patch-note key Q.
        skills = [fs.parse_page("9", "t", wiki_page("2026-01-01T00:00:00Z", [("Q - 하나 / 둘", [
            ("A", ["피해량 [1]"]), ("B", ["피해량 [7]"])])]))]
        (over, _, unparsed), _ = self.run_both(skills, [change("t", "Q", "피해량", "7", "8", part=1)])
        self.assertEqual(([(o["skill"], o["patchnote"]) for o in over], unparsed), ([("Q2", 8)], []))

    def test_spell_entry_rq(self):
        # RQ "[샤마쉬의 법전] 주문 피해량" is an entry: a patch row is matched by its label (tag ignored).
        (over, skipped, unparsed), skills = self.run_both(self.skills(), [
            change("아르다", "RQ", "주문 피해량", "160/240/320(+스킬 증폭의 70%)", "170/250/330(+스킬 증폭의 80%)",
                   part=1)])
        self.assertEqual((skipped, unparsed), ([], []))
        self.assertEqual([(o["level"], o["field"], o["dakgg"], o["patchnote"]) for o in over],
                         [(n, "baseDamage", b, b + 10) for n, b in enumerate([160, 240, 320], 1)])
        rq = by_key(skills[0])["RQ"]
        self.assertEqual((rq["levels"], rq["raw"]), (rq["entries"][0]["levels"], rq["entries"][0]["raw"]))
        self.assertEqual(rq["levels"][2]["baseDamage"], 330)

    def test_patch_then_hotfix_rows_merge(self):
        e0 = "80/110/140/170/200(+스킬 증폭의 65%)"
        e1 = "80/110/140/170/200(+스킬 증폭의 70%)"
        e2 = "80/110/140/170/200(+스킬 증폭의 75%)"
        (over, _, _), skills = self.run_both(self.skills(), [
            change("아르다", "E", "피해량", e0, e1, part=1), change("아르다", "E", "피해량", e1, e2, part=1)])
        self.assertEqual([(o["level"], o["dakgg"], o["patchnote"]) for o in over], [(n, 0.65, 0.75) for n in range(1, 6)])
        self.assertTrue(over[0]["text"].endswith(e2))
        # Skipped rows merge the same way and carry the later article's posting time.
        (_, skipped, _), _ = self.run_both(self.skills(), [
            change("아르다", "E", "피해량", e0, e1, part=0), change("아르다", "E", "피해량", e1, e2, part=0)])
        self.assertEqual([(s["dakgg"], s["patchnote"]) for s in skipped], [(0.65, 0.75)] * 5)

    def test_current_unmatched_and_unreadable(self):
        changes = [
            change("아르다", "W", "1타 피해량", "60/80/100/120/140(+스킬 증폭의 50%)",
                   "70/90/110/130/150(+스킬 증폭의 55%)"),  # wiki already shows the new value
            change("아르다", "RQ", "주문 피해량", "160/240/320(+스킬 증폭의 70%)",
                   "160/240/320(+스킬 증폭의 80%)"),  # wiki already shows the new value
            change("아르다", "Q", "피해량", "1", "2(+대상 현재 체력의 8%(+스킬 증폭의 2%))"),  # unreadable
            change("아르다", "E", "보호막 흡수량", "1", "2"),  # no such entry
            change("없는실험체", "Q", "피해량", "1", "2"),
        ]
        (over, skipped, unparsed), _ = self.run_both(self.skills(), changes)
        self.assertEqual((over, skipped), ([], []))
        self.assertEqual([u["text"] for u in unparsed], [c["text"] for c in changes[2:]])


def row_levels(text):
    row = fs._value_line(text)
    return fs.levels_from(row["values"], row["coefs"], row["label"])


class NestedCoefTests(unittest.TestCase):
    """Nested coefficients "(+A의 X(+B의 Y%)%)" from the real documents (host-checked)."""

    def test_abigail_w(self):
        levels, reason = row_levels("피해량 [80 / 110 / 140 / 170 / 200] (+대상 현재 체력의 8%(+스킬 증폭의 2%))")
        self.assertIsNone(reason)
        self.assertEqual(levels[0], {"level": 1, "baseDamage": 80, "attackPowerRatio": 0, "skillAmpRatio": 0,
                                     "extraRatios": [{"stat": "대상 현재 체력", "ratio": 0.08,
                                                      "nested": [{"stat": "스킬 증폭", "ratio": 0.02}]}]})
        self.assertEqual([l["baseDamage"] for l in levels], [80, 110, 140, 170, 200])

    def test_tsubame_p(self):
        levels, reason = row_levels(
            "추가 피해량 [30] (+추가 공격력의 25%)(+대상 최대 체력의 4 / 7 / 10(+추가 공격력의 4%)%)")
        self.assertIsNone(reason)
        self.assertEqual([l["extraRatios"] for l in levels], [
            [{"stat": "추가 공격력", "ratio": 0.25},
             {"stat": "대상 최대 체력", "ratio": r, "nested": [{"stat": "추가 공격력", "ratio": 0.04}]}]
            for r in (0.04, 0.07, 0.1)])
        self.assertEqual({l["baseDamage"] for l in levels}, {30})

    def test_blair_q(self):
        levels, reason = row_levels("1타 피해량 [20 / 40 / 60 / 80 / 100] (+추가 공격력의 90% / 100% / 110% / 120% / "
                                    "130%) (+대상 최대 체력의 1 / 1.5 / 2 / 2.5 / 3(+추가 공격력의 4%)%)")
        self.assertIsNone(reason)
        self.assertEqual(levels[4], {"level": 5, "baseDamage": 100, "attackPowerRatio": 0, "skillAmpRatio": 0,
                                     "extraRatios": [{"stat": "추가 공격력", "ratio": 1.3},
                                                     {"stat": "대상 최대 체력", "ratio": 0.03,
                                                      "nested": [{"stat": "추가 공격력", "ratio": 0.04}]}]})
        self.assertEqual([l["extraRatios"][1]["ratio"] for l in levels], [0.01, 0.015, 0.02, 0.025, 0.03])

    def test_data_file(self):
        skills = {c["name"]: by_key(c) for c in json.loads((ROOT / "data" / "skills.json").read_text(encoding="utf-8"))}
        w = skills["아비게일"]["W"]["entries"]
        self.assertEqual([(e["label"], len(e["levels"])) for e in w], [("피해량", 5), ("보호막 흡수량", 5)])
        self.assertEqual(w[1]["levels"][0]["skillAmpRatio"], 0.4)
        self.assertEqual(len(skills["츠바메"]["P"]["levels"]), 3)
        blair = skills["블레어"]
        self.assertEqual((blair["Q"]["name"], blair["Q2"]["name"]), ("이중 참격", "이중 휩쓸기"))
        self.assertEqual([e["label"] for e in blair["Q2"]["entries"]], ["1타 피해량", "2타 피해량", "체력 회복량"])
        self.assertEqual(blair["Q2"]["levels"][0]["attackPowerRatio"], 0.75)
        node = run_node({}, 'const m = await imp("fetch_skills.mjs");'
                        ' return m.levelsFrom(["80"], ["+대상 현재 체력의 8%(+스킬 증폭의 2%)"])[0];')
        self.assertEqual(node, [{"level": 1, "baseDamage": 80, "attackPowerRatio": 0, "skillAmpRatio": 0,
                                 "extraRatios": [{"stat": "대상 현재 체력", "ratio": 0.08,
                                                  "nested": [{"stat": "스킬 증폭", "ratio": 0.02}]}]}])


class DataFileTests(unittest.TestCase):
    """data/skills.json is generated by `python scripts/fetch_items.py` (or fetch_skills.py)."""

    @classmethod
    def setUpClass(cls):
        cls.skills = json.loads((ROOT / "data" / "skills.json").read_text(encoding="utf-8"))
        cls.chars = json.loads((ROOT / "data" / "characters.json").read_text(encoding="utf-8"))

    def test_schema(self):
        self.assertEqual([(c["characterId"], c["name"]) for c in self.skills],
                         [(c["id"], c["name"]) for c in self.chars])
        for c in self.skills:
            self.assertEqual(list(c), ["characterId", "name", "skills", "wikiRevisedAt", "needsReview", "parser"])
            self.assertEqual(c["parser"], fs.PARSER_VERSION)
            for s in c["skills"]:
                self.assertEqual(list(s), ["key", "name", "levels", "raw", "sourceLabel", "entries"])
                first = s["entries"][0] if s["entries"] else {"label": None, "levels": [], "raw": None}
                self.assertEqual((s["levels"], s["raw"], s["sourceLabel"]), (first["levels"], first["raw"], first["label"]))
                for e in s["entries"]:
                    self.assertLessEqual(set(e), {"label", "levels", "raw", "multiplier", "historyMismatch"})
                    for l in e["levels"]:
                        self.assertLessEqual({"level", "baseDamage", "attackPowerRatio", "skillAmpRatio"}, set(l))
                        self.assertLessEqual(set(l), {"level", "baseDamage", "attackPowerRatio", "skillAmpRatio",
                                                      "extraRatios"})
                        self.assertIsInstance(l["baseDamage"], (int, float))
                        for x in l.get("extraRatios", []):
                            self.assertIn(list(x), (["stat", "ratio"], ["stat", "ratio", "nested"]))
            for r in c["needsReview"]:
                self.assertEqual(list(r), ["skill", "text", "reason"])
        self.assertLessEqual(sum(len(c["needsReview"]) for c in self.skills), 50)

    def test_arda(self):
        arda = by_key(next(c for c in self.skills if c["name"] == "아르다"))
        self.assertEqual(arda["Q"]["levels"][4], {"level": 5, "baseDamage": 230, "attackPowerRatio": 0,
                                                 "skillAmpRatio": 0.8})
        self.assertEqual({l["skillAmpRatio"] for l in arda["E"]["levels"]}, {0.65})
        self.assertEqual(arda["RQ"]["entries"][0]["label"], "[샤마쉬의 법전] 주문 피해량")

    def test_jackie_q(self):
        q = by_key(next(c for c in self.skills if c["name"] == "재키"))["Q"]
        self.assertEqual((q["name"], q["raw"]), ("연참", "피해량 [30 / 50 / 70 / 90 / 110] (+공격력의 50%) (+대상 현재 체력의 5%)"))
        self.assertEqual([(l["baseDamage"], l["attackPowerRatio"]) for l in q["entries"][0]["levels"]],
                         [(30, 0.5), (50, 0.5), (70, 0.5), (90, 0.5), (110, 0.5)])


if __name__ == "__main__":
    unittest.main()
