'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/skills');
const V2 = require('../src/formula_v2');
const U = require('../src/updater');
const H = require('../src/history');
const Meta = require('../src/meta');

const FIXTURE = S.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'skills.sample.json'), 'utf8')));
const item = (id, slot, name, price, stats) => ({ id, slot, name, price, grade: '전설', imageUrl: '', stats });
// tests/formula_v2.test.js의 379 검산과 같은 구성·입력.
const MEASURED = [
  { ...item('130501', '무기', '여제', 5, { '공격력': 40, '스킬 증폭': 93, '쿨다운 감소': 15 }), weaponType: '아르카나' },
  item('205503', '머리', '쿤달라', 200, { '스킬 증폭': 82, '이동 속도율': 0.03, '쿨다운 감소': 20 }),
  item('202526', '옷', '이단심판관', 350, { '방어력': 30, '스킬 증폭': 30, '레벨 당 스킬 증폭': 5, '쿨다운 감소': 15 }),
  item('705608', '팔', '임세티', 250, { '스킬 증폭': 92, '(고유) 스킬 증폭': 0.15 }),
  item('204410', '다리', '글레이셜 슈즈', 200, { '스킬 증폭': 33, '이동 속도': 0.25, '쿨다운 감소': 15 }),
];
const BASE = { ...V2.DEFAULT_INPUTS, level: 20, defense: 150, extraSkillAmp: 351 };

test('아르다 Q 5레벨 → 230 / 0 / 80%, 379 검산과 같은 결과', () => {
  const entry = S.forCharacter(FIXTURE, 'arda', '아르다');
  const q = S.findSkill(entry, 'Q');
  assert.deepEqual(S.levelsOf(q).map((l) => l.level), [1, 2, 3, 4, 5]);
  const auto = S.autoValues(q, 5);
  assert.deepEqual(auto, { skillDamage: 230, atkCoefPct: 0, skillAmpCoefPct: 80 });
  const fromSkill = V2.calculate(MEASURED, { ...BASE, ...auto });
  const manual = V2.calculate(MEASURED, { ...BASE, skillDamage: 230, atkCoefPct: 0, skillAmpCoefPct: 80 });
  assert.equal(fromSkill.D, manual.D);
  assert.ok(Math.abs(fromSkill.D - 379.408) < 1e-9);
  assert.equal(S.autoValues(q, 1).skillDamage, 70);
  assert.equal(S.autoValues(q, 6), null); // 없는 레벨
});

test('레벨 비어 있는 스킬은 "수동 입력", 출처 문구, 실험체 찾기(id 우선·이름 대체)', () => {
  const entry = S.forCharacter(FIXTURE, null, '아르다');
  assert.equal(entry.name, '아르다');
  assert.equal(S.forCharacter(FIXTURE, 'none', '아르다'), entry); // id가 틀리면 이름
  assert.equal(S.forCharacter(FIXTURE, 'none', '없음'), null);
  assert.equal(S.optionLabel(S.findSkill(entry, 'Q')), 'Q 샤마쉬의 두루마리');
  const p = S.findSkill(entry, 'P');
  assert.equal(S.optionLabel(p), 'P 패시브(테스트) (수동 입력)');
  assert.equal(S.autoValues(p, 1), null);
  assert.equal(S.sourceText(entry), '나무위키 · 수정 2026-10-16');
  assert.equal(S.sourceText({}), '나무위키');
  assert.deepEqual(S.normalize(null), []);
  assert.deepEqual(S.normalize([null, { name: 'x' }, { name: 'y', skills: [null, { key: 'Q' }] }]), [{ name: 'y', skills: [{ key: 'Q' }] }]);
});

test('비율은 % 소수 오차 정리, 숫자가 아닌 값은 null(입력란 유지)', () => {
  const skill = { key: 'W', levels: [{ level: 1, baseDamage: 'x', attackPowerRatio: 0.07, skillAmpRatio: null }] };
  assert.deepEqual(S.autoValues(skill, 1), { skillDamage: null, atkCoefPct: 7, skillAmpCoefPct: null });
});

test('패치 반영: meta.overrides의 type "skill"만, 실험체(이름/id)와 스킬(키/이름)이 맞을 때', () => {
  const meta = { overrides: [
    { type: 'skill', name: '아르다', skill: 'Q', stat: '피해량', dakgg: '210', patchnote: '230' },
    { type: 'skill', name: '다른', characterId: 'arda', skill: '샤마쉬의 두루마리', stat: '계수', dakgg: '75%', patchnote: '80%' },
    { type: 'skill', name: '아르다', skill: 'W', stat: '피해량', dakgg: '1', patchnote: '2' },
    { type: 'item', name: '아르다', skill: 'Q', stat: 'x', dakgg: '1', patchnote: '2' },
  ] };
  const q = S.findSkill(FIXTURE[0], 'Q');
  assert.deepEqual(S.patchNotes(Meta.normalize(meta), { id: 'arda', name: '아르다' }, q), ['피해량: 210 → 230', '계수: 75% → 80%']);
  assert.deepEqual(S.patchNotes(meta, { id: null, name: '쇼우' }, q), []);
  assert.deepEqual(S.patchNotes(null, { id: 'arda', name: '아르다' }, q), []);
  assert.equal(Meta.overrideLines(meta)[0], '아르다 (스킬 Q) — 피해량: 210 → 230');
});

test('히스토리: 스킬 키·이름·레벨이 저장되고 다시 읽힌다', () => {
  const H2 = H.forVariant('v2');
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  const inputs = { ...BASE, skillDamage: 230, atkCoefPct: 0, skillAmpCoefPct: 80, characterId: 'arda', characterName: '아르다',
    skillKey: 'Q', skillName: '샤마쉬의 두루마리', skillLevel: 5 };
  const equipped = Object.fromEntries(MEASURED.map((it) => [it.slot, it]));
  H2.save(storage, [H2.makeEntry({ equipped, inputs, result: V2.calculate(MEASURED, inputs) })]);
  const [loaded] = H2.load(storage);
  assert.deepEqual([loaded.inputs.skillKey, loaded.inputs.skillName, loaded.inputs.skillLevel], ['Q', '샤마쉬의 두루마리', 5]);
});

test('runUpdate: 반환 skills 배열 우선, 없으면 reloadSkills, 실패는 null', async () => {
  const given = [{ name: 'a', skills: [] }];
  const fromFile = [{ name: 'b', skills: [] }];
  let reads = 0;
  const reloadSkills = async () => { reads++; return fromFile; };
  const a = await U.runUpdate({ updateItems: async () => ({ count: 1, skills: given }) }, async () => true, null, reloadSkills);
  assert.equal(a.skills, given);
  assert.equal(reads, 0);
  const b = await U.runUpdate({ updateItems: async () => ({ count: 1 }) }, async () => true, null, reloadSkills);
  assert.equal(b.skills, fromFile);
  const c = await U.runUpdate({ updateItems: async () => ({ count: 1 }) }, async () => true, null, async () => { throw new Error('x'); });
  assert.equal(c.ok, true);
  assert.equal(c.skills, null);
  const d = await U.runUpdate({ updateItems: async () => ({ count: 1 }) }, async () => true, null, async () => ({ not: 'array' }));
  assert.equal(d.skills, null);
});

const realSkills = path.join(__dirname, '..', 'data', 'skills.json');
test('실제 data/skills.json(있을 때): 아르다 Q 5레벨 230 / 0 / 80%', { skip: !fs.existsSync(realSkills) && 'data/skills.json 없음' }, () => {
  const list = S.normalize(JSON.parse(fs.readFileSync(realSkills, 'utf8')));
  const entry = S.forCharacter(list, null, '아르다');
  assert.ok(entry, '아르다 없음');
  assert.deepEqual(S.autoValues(S.findSkill(entry, 'Q'), 5), { skillDamage: 230, atkCoefPct: 0, skillAmpCoefPct: 80 });
});
