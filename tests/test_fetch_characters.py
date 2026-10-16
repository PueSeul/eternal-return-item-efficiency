import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_characters as fc  # noqa: E402
import fetch_items as fi  # noqa: E402

MASTERY_FIELDS = {"skillAmpRatio", "attackPowerRatio", "attackSpeedRatio",
                  "increaseBasicAttackDamageRatio", "attackPower"}
WEAPONS = [{"key": "Arcana", "name": "아르카나"}, {"key": "Bow", "name": "활"},
           {"key": "OneHandSword", "name": "단검"}]


def char(i, masteries, stats, ap=30, growth=4.5):
    return {"id": i, "key": "K%s" % i, "name": "실험체%s" % i,
            "imageUrl": "//cdn.dak.gg/%s.png" % i, "attackPower": ap,
            "levelUpStat": {"attackPower": growth, "maxHp": 70}, "masteries": masteries,
            "masteryStats": stats}


class BuildTests(unittest.TestCase):
    def test_build(self):
        raw = [
            char(2, ["Bow", "Arcana"], [
                {"type": "Arcana", "options": [{"key": "SkillAmpRatio", "value": 0.047}]},
                {"type": "Bow", "options": [{"key": "AttackSpeedRatio", "value": 0.03},
                                            {"key": "IncreaseBasicAttackDamageRatio", "value": 0.02}]},
            ], growth=4.0),
            char(1, ["OneHandSword"], [{"type": "OneHandSword", "options": [
                {"key": "AttackPower", "value": 1}, {"key": "AttackSpeedRatio", "value": 0.031}]}]),
        ]
        out = fc.build_characters(raw, WEAPONS)
        self.assertEqual([c["id"] for c in out], ["1", "2"])
        self.assertEqual(out[1]["imageUrl"], "https://cdn.dak.gg/2.png")
        self.assertEqual(out[1]["attackPowerPerLevel"], 4)
        self.assertEqual(list(out[1]["masteries"]), ["활", "아르카나"])  # character's weapon order
        self.assertEqual(out[1]["masteries"]["아르카나"], {
            "skillAmpRatio": 0.047, "attackPowerRatio": 0, "attackSpeedRatio": 0,
            "increaseBasicAttackDamageRatio": 0, "attackPower": 0})
        self.assertEqual(out[0]["masteries"]["단검"]["attackPower"], 1)

    def test_rejects_unknown_or_inconsistent(self):
        bad_key = char(1, ["Bow"], [{"type": "Bow", "options": [{"key": "NewRatio", "value": 1}]}])
        mismatch = char(1, ["Bow", "Arcana"], [{"type": "Bow", "options": []}])
        for raw in (bad_key, mismatch):
            with self.assertRaises(ValueError):
                fc.build_characters([raw], WEAPONS)


NODE_BUILD = """
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { FC_MODULE: mod, FC_INPUT: input } = process.env;
const { fetchCharacters, dumps, CHARACTERS_URL, MASTERIES_URL } = await import(pathToFileURL(mod).href);
const raw = JSON.parse(readFileSync(input, "utf8"));
const bodies = { [CHARACTERS_URL]: { characters: raw.characters }, [MASTERIES_URL]: { masteries: raw.masteries } };
globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => bodies[url] });
process.stdout.write(Buffer.from(dumps(await fetchCharacters()), "utf8"));
"""


class NodePortTests(unittest.TestCase):
    """scripts/fetch_characters.mjs must produce byte-identical output to the Python script."""

    def node_dumps(self, raw):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "input.json"
            src.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            proc = subprocess.run(
                ["node", "--input-type=module", "-e", NODE_BUILD],
                capture_output=True, check=True,
                env={**os.environ, "FC_MODULE": str(ROOT / "scripts" / "fetch_characters.mjs"),
                     "FC_INPUT": str(src)},
            )
        return proc.stdout.decode("utf-8")

    def test_same_output_on_live_api(self):
        raw = {"characters": fi.fetch_json(fc.CHARACTERS_URL)["characters"],
               "masteries": fi.fetch_json(fi.MASTERIES_URL)["masteries"]}
        expected = fc.dumps(fc.build_characters(raw["characters"], raw["masteries"]))
        self.assertGreater(len(json.loads(expected)), 80)
        self.assertEqual(self.node_dumps(raw), expected)

    def test_same_output_on_edge_cases(self):
        raw = {"masteries": WEAPONS, "characters": [
            char("10", ["Arcana"], [{"type": "Arcana", "options": [{"key": "SkillAmpRatio", "value": 0.1}]}],
                 ap=30.0, growth=2.9999999999999996),
            char(9, ["Bow"], [{"type": "Bow", "options": [{"key": "AttackPower", "value": 1.0}]}], growth=5.0),
        ]}
        expected = fc.dumps(fc.build_characters(raw["characters"], raw["masteries"]))
        self.assertEqual([c["id"] for c in json.loads(expected)], ["9", "10"])
        self.assertEqual(self.node_dumps(raw), expected)


class DataFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chars = json.loads((ROOT / "data" / "characters.json").read_text(encoding="utf-8"))
        items = json.loads((ROOT / "data" / "items.json").read_text(encoding="utf-8"))
        cls.weapon_types = {i["weaponType"] for i in items if i["slot"] == "무기"}

    def test_schema(self):
        self.assertGreater(len(self.chars), 80)
        self.assertEqual(len({c["id"] for c in self.chars}), len(self.chars))
        for c in self.chars:
            self.assertEqual(set(c), {"id", "name", "imageUrl", "attackPower",
                                      "attackPowerPerLevel", "masteries"}, c["name"])
            self.assertIsInstance(c["id"], str)
            self.assertTrue(c["name"])
            self.assertTrue(c["imageUrl"].startswith("https://"), c["name"])
            for k in ("attackPower", "attackPowerPerLevel"):
                self.assertIsInstance(c[k], (int, float))
                self.assertGreater(c[k], 0)
            self.assertTrue(c["masteries"], c["name"])
            for weapon, m in c["masteries"].items():
                self.assertIn(weapon, self.weapon_types)  # same spelling as items.json weaponType
                self.assertEqual(set(m), MASTERY_FIELDS)
                for k, v in m.items():
                    self.assertIsInstance(v, (int, float))
                    if k.endswith("Ratio"):
                        self.assertTrue(0 <= v < 1, (c["name"], weapon, k, v))

    def test_arda_arcana(self):
        arda = next(c for c in self.chars if c["name"] == "아르다")
        self.assertEqual(arda["masteries"]["아르카나"]["skillAmpRatio"], 0.047)


if __name__ == "__main__":
    unittest.main()
