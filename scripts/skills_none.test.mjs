import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keptSkills, skillRowsOf } from "./fetch_items.mjs";

test("skillRowsOf: previous skill rows minus the parser's own rows (each once), order kept", () => {
  const p = { type: "skill", name: "A", text: "parser" };
  const s1 = { type: "skill", name: "B", text: "apply" };
  const s2 = { type: "skill", name: "C", text: "apply" };
  const item = { type: "item", name: "I", text: "x" };
  assert.deepEqual(skillRowsOf([p, item, s1, s2], [p]), [s1, s2]);
  assert.deepEqual(skillRowsOf([p, item, p, s1], [p]), [p, s1]); // 같은 행이 applySkillChanges 쪽에도 있으면 남긴다
  assert.deepEqual(skillRowsOf([], [p]), []);
});

test('keptSkills: skills.json + items.meta.json from outDir; missing meta is an error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), "er-none-"));
  writeFileSync(path.join(dir, "skills.json"), JSON.stringify([{ name: "아르다", skills: [] }]));
  assert.throws(() => keptSkills(dir), /skills mode "none" needs .*items\.meta\.json/);
  writeFileSync(path.join(dir, "items.meta.json"), JSON.stringify({ patch: { id: 1 } }));
  const [prev, meta] = keptSkills(dir);
  assert.deepEqual([...prev.keys()], ["아르다"]);
  assert.deepEqual(meta, { patch: { id: 1 } });
});
