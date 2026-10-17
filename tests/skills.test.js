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
test('스킬 목록: P·Q·W·E·R만 보이고 RQ·Q2·변신·무기 스킬은 숨김, 숨긴 스킬도 기록 복원으로는 찾음', () => {
  for (const k of ['P', 'Q', 'W', 'E', 'R', 'q']) assert.equal(S.isListed({ key: k }), true, k);
  for (const k of ['RQ', 'Q2', '변신', 'D', 'WQ', '']) assert.equal(S.isListed({ key: k }), false, k);
  const char = { skills: [{ key: 'Q', name: 'a', levels: [{ level: 1, baseDamage: 1 }] }, { key: 'RQ', name: 'b', levels: [{ level: 1, baseDamage: 2 }] }] };
  const shown = S.choices(char).filter((c) => S.isListed(c.skill)).map((c) => c.skill.key);
  assert.deepEqual(shown, ['Q']);
  const hit = S.matchChoice(char, { key: 'RQ', index: 0 });
  assert.equal(hit && hit.skill.key, 'RQ');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(app, /if \(!Skills\.isListed\(hit\.skill\)\) opts\.push\(choiceOption\(hit\)\)/);
});

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
  assert.equal(S.optionLabel(S.findSkill(entry, 'Q')), 'Q 샤마쉬의 두루마리 — 피해량');
  const p = S.findSkill(entry, 'P');
  assert.equal(S.optionLabel(p), 'P 패시브(테스트) — 체력 회복량 (수동 입력)'); // entries 빈 배열 → 이전 스키마 한 항목
  assert.equal(S.autoValues(p, 1), null);
  assert.equal(S.sourceText(entry), '나무위키 · 수정 2026-10-16');
  assert.equal(S.sourceText({}), '나무위키');
  assert.deepEqual(S.normalize(null), []);
  assert.deepEqual(S.normalize([null, { name: 'x' }, { name: 'y', skills: [null, { key: 'Q' }] }]), [{ name: 'y', skills: [{ key: 'Q' }] }]);
});

test('entries: 스킬 × 피해 항목 선택지, 라벨/번호로 복원, 미반영 계수·역사란 불일치', () => {
  const entry = S.forCharacter(FIXTURE, 'arda', '아르다');
  const list = S.choices(entry);
  assert.deepEqual(list.map((c) => [c.value, S.optionLabel(c.skill, c.entry)]), [
    ['Q#0', 'Q 샤마쉬의 두루마리 — 피해량'],
    ['Q#1', 'Q 샤마쉬의 두루마리 — 추가 피해량(테스트)'],
    ['P#0', 'P 패시브(테스트) — 체력 회복량 (수동 입력)'],
  ]);
  const extra = S.findChoice(entry, 'Q#1');
  assert.deepEqual(S.autoValues(extra.entry, 2), { skillDamage: 40, atkCoefPct: 10, skillAmpCoefPct: 30 });
  assert.deepEqual(S.extraRatioTexts(extra.entry, 1), ['최대 체력의 3%']);
  assert.deepEqual(S.extraRatioTexts(S.findChoice(entry, 'Q#0').entry, 5), []);
  assert.equal(S.mismatchText(extra.entry), '역사란: 추가 피해량 [25 / 45]');
  assert.equal(S.mismatchText({ historyMismatch: { text: 'baseDamage 설명란 [70], 역사 마지막 [60]' } }), 'baseDamage 설명란 [70], 역사 마지막 [60]');
  assert.equal(S.mismatchText({ historyMismatch: {} }), '나무위키 역사란 수치와 다릅니다');
  assert.equal(S.mismatchText(S.findChoice(entry, 'Q#0').entry), '');
  assert.deepEqual(S.extraRatioTexts({ levels: [{ level: 1, extraRatios: [{ stat: '야성 중첩', ratio: null }, { stat: '대상 현재 체력', ratio: 0.05 }] }] }, 1),
    ['야성 중첩', '대상 현재 체력의 5%']);
  assert.deepEqual(S.extraRatioTexts({ levels: [{ level: 1, extraRatios: { '방어력': 0.5 } }] }, 1), ['방어력의 50%']);
  assert.deepEqual(S.extraRatioTexts({ levels: [{ level: 1, extraRatios: ['대상 잃은 체력의 2%'] }] }, 1), ['대상 잃은 체력의 2%']);
  // 복원: 라벨 우선, 라벨 없으면 번호(이전 기록은 번호도 없음 → 0), 없는 라벨은 null
  assert.equal(S.matchChoice(entry, { key: 'Q', label: '추가 피해량(테스트)', index: 0 }).value, 'Q#1');
  assert.equal(S.matchChoice(entry, { key: 'Q', index: 1 }).value, 'Q#1');
  assert.equal(S.matchChoice(entry, { key: 'Q' }).value, 'Q#0');
  assert.equal(S.matchChoice(entry, { key: 'Q', label: '없는 줄' }), null);
  assert.equal(S.findChoice(entry, 'W#0'), null);
  // 첫 항목 = 이전 스키마 levels: 379 검산 그대로
  assert.deepEqual(S.autoValues(S.findChoice(entry, 'Q#0').entry, 5), { skillDamage: 230, atkCoefPct: 0, skillAmpCoefPct: 80 });
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
test('실제 data/skills.json(있을 때): 아비게일 W·츠바메 P·블레어 Q 기본 피해량과 중첩 계수 표시', { skip: !fs.existsSync(realSkills) && 'data/skills.json 없음' }, () => {
  const list = S.normalize(JSON.parse(fs.readFileSync(realSkills, 'utf8')));
  const pickFirst = (name, key) => {
    const entry = S.forCharacter(list, null, name);
    assert.ok(entry, name + ' 없음');
    const c = S.choices(entry).find((x) => x.skill.key === key);
    assert.ok(c, `${name} ${key} 없음`);
    const e = S.findChoice(entry, c.value).entry;
    const lv = S.levelsOf(e)[0].level;
    return { auto: S.autoValues(e, lv), extras: S.extraRatioTexts(e, lv) };
  };
  const ab = pickFirst('아비게일', 'W');
  assert.equal(ab.auto.skillDamage, 80);
  assert.ok(ab.extras.includes('대상 현재 체력의 8% (+스킬 증폭의 2%)'), ab.extras.join(' / '));
  const tz = pickFirst('츠바메', 'P');
  assert.equal(tz.auto.skillDamage, 30);
  assert.ok(tz.extras.includes('대상 최대 체력의 4% (+추가 공격력의 4%)'), tz.extras.join(' / '));
  const bl = pickFirst('블레어', 'Q');
  assert.equal(bl.auto.skillDamage, 20);
  assert.ok(bl.extras.includes('추가 공격력의 90%'));
  // 레벨별 ratio 배열은 선택한 레벨의 값으로 표시
  const arr = { label: 'x', levels: [1, 2, 3].map((level) => ({ level, baseDamage: 1, extraRatios: [{ stat: '대상 최대 체력', ratio: [0.01, 0.02, 0.03], nested: [{ stat: '추가 공격력', ratio: [0.1, 0.2, 0.3] }] }] })) };
  assert.deepEqual(S.extraRatioTexts(arr, 2), ['대상 최대 체력의 2% (+추가 공격력의 20%)']);
});
test('실제 data/skills.json(있을 때): 아르다 Q 5레벨 230 / 0 / 80%', { skip: !fs.existsSync(realSkills) && 'data/skills.json 없음' }, () => {
  const list = S.normalize(JSON.parse(fs.readFileSync(realSkills, 'utf8')));
  const entry = S.forCharacter(list, null, '아르다');
  assert.ok(entry, '아르다 없음');
  assert.deepEqual(S.autoValues(S.findSkill(entry, 'Q'), 5), { skillDamage: 230, atkCoefPct: 0, skillAmpCoefPct: 80 });
  // 화면과 같은 경로: 선택지(키#번호) → 피해 항목 → 5레벨
  const q = S.choices(entry).find((c) => c.skill.key === 'Q');
  assert.equal(S.optionLabel(q.skill, q.entry), 'Q 샤마쉬의 두루마리 — 피해량');
  assert.deepEqual(S.autoValues(S.findChoice(entry, q.value).entry, 5), { skillDamage: 230, atkCoefPct: 0, skillAmpCoefPct: 80 });
  // 실제 파일의 historyMismatch({text})·서술형 extraRatios(ratio null)도 원문/라벨로 나온다
  const all = list.flatMap((c) => c.skills.flatMap((s) => S.entriesOf(s)));
  const hm = all.find((e) => e.historyMismatch);
  assert.ok(hm && S.mismatchText(hm) && S.mismatchText(hm) !== '나무위키 역사란 수치와 다릅니다');
  const narrative = all.flatMap((e) => S.levelsOf(e)).find((l) => (l.extraRatios || []).some((x) => x && x.ratio == null));
  if (narrative) {
    const texts = S.extraRatioTexts({ levels: [narrative] }, narrative.level);
    assert.equal(texts.length, narrative.extraRatios.length);
  }
});
