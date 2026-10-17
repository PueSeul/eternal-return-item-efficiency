'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V2 = require('../src/formula_v2');
const E = require('../src/explain');
const H = require('../src/history');

const item = (id, slot, name, price, stats) => ({ id, slot, name, price, grade: '전설', imageUrl: '', stats });
// dak.gg 툴팁(er.dakgg.io/api/v1/data/items) 값 그대로의 호스트 측정 구성.
const MEASURED = [
  { ...item('130501', '무기', '여제', 5, { '공격력': 40, '스킬 증폭': 93, '쿨다운 감소': 15 }), weaponType: '아르카나' },
  item('205503', '머리', '쿤달라', 200, { '스킬 증폭': 82, '이동 속도율': 0.03, '쿨다운 감소': 20 }),
  item('202526', '옷', '이단심판관', 350, { '방어력': 30, '스킬 증폭': 30, '레벨 당 스킬 증폭': 5, '쿨다운 감소': 15 }),
  item('705608', '팔', '임세티', 250, { '스킬 증폭': 92, '(고유) 스킬 증폭': 0.15 }),
  item('204410', '다리', '글레이셜 슈즈', 200, { '스킬 증폭': 33, '이동 속도': 0.25, '쿨다운 감소': 15 }),
];
const BASE = { ...V2.DEFAULT_INPUTS, level: 20, skillDamage: 230, atkCoefPct: 0, skillAmpCoefPct: 80, defense: 150 };

test('v2 검산: 스탯창 스킬 증폭 898이 되도록 아이템 외 스킬 증폭을 넣으면 인게임 측정 379', () => {
  // 고정 330 + 레벨 당 5×20 = 430, 아이템 외 351 → (781) × 1.15 = 898.15 (스탯창 898)
  const inputs = { ...BASE, extraSkillAmp: 351 };
  assert.equal(Math.round(V2.skillAmpTotal(MEASURED, inputs)), 898);
  const r = V2.calculate(MEASURED, inputs);
  // S = 230 + 0.8 × 898.15 = 948.52, B = 948.52 × 100 / 250 = 379.408
  assert.ok(Math.abs(r.SA - 898.15) < 1e-9);
  assert.ok(Math.abs(r.S - 948.52) < 1e-9);
  assert.ok(Math.abs(r.D - 379.408) < 1e-9);
  assert.equal(Math.round(r.D), 379);
  assert.equal(r.price, 1005);
});

const fs = require('fs');
const path = require('path');
const C = require('../src/characters');
// 고정 검산은 항상 픽스처(아르다 한 명)를 쓴다. 픽스처의 attackPower·attackPowerPerLevel은 확인 안 된 임의값
// (공격력 계수 0인 검산에는 영향 없음), 아르카나 skillAmpRatio 0.047은 dak.gg characters API 값(handoff/status-dev-data.md 8차).
const ARDA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'characters.sample.json'), 'utf8')).find((c) => c.name === '아르다');
const realChars = path.join(__dirname, '..', 'data', 'characters.json');

test('실제 data/characters.json(있을 때): 아르다 검산 D ≈ 379(±1)', { skip: !fs.existsSync(realChars) && 'data/characters.json 없음' }, () => {
  const arda = JSON.parse(fs.readFileSync(realChars, 'utf8')).find((c) => c.name === '아르다');
  assert.ok(arda, '아르다 없음');
  const auto = C.autoValues(arda, '아르카나', 20, 20);
  const inputs = { ...BASE, masteryLevel: 20, extraAtk: auto.extraAtk, extraSkillAmp: 0, extraSkillAmpPct: auto.extraSkillAmpPct };
  assert.ok(Math.abs(V2.skillAmpTotal(MEASURED, inputs) - 898.7) <= 1);
  assert.ok(Math.abs(V2.calculate(MEASURED, inputs).D - 379) <= 1);
});

test('v2 실험체 자동 입력 검산: 아르다 + 아르카나 숙련 20 + 레벨 20 → 스킬 증폭 합계 898.7, D ≈ 379', () => {
  const auto = C.autoValues(ARDA, MEASURED[0].weaponType || '아르카나', 20, 20);
  assert.equal(auto.extraSkillAmpPct, 94); // 0.047 × 20 = 94%
  assert.equal(auto.warning, '');
  const inputs = { ...BASE, masteryLevel: 20, extraAtk: auto.extraAtk, extraSkillAmp: 0, extraSkillAmpPct: auto.extraSkillAmpPct };
  // SA = 430 × (1 + 0.15 + 0.94) = 898.7
  assert.ok(Math.abs(V2.skillAmpTotal(MEASURED, inputs) - 898.7) < 1e-9);
  const r = V2.calculate(MEASURED, inputs);
  // D = (230 + 0.8 × 898.7) × 100 / 250 = 379.584
  assert.ok(Math.abs(r.D - 379.584) < 1e-9);
  assert.ok(Math.abs(r.D - 379) <= 1);
});

test('실험체 자동값: 공격력 성장식, 숙련도 없음 경고, 무기 없음, 실험체 없음', () => {
  const c = { id: 'x', name: '테스트', attackPower: 30, attackPowerPerLevel: 4.5, masteries: { '활': { skillAmpRatio: 0.05 } } };
  const a = C.autoValues(c, '활', 20, 10);
  assert.equal(a.extraAtk, 30 + 4.5 * 19);
  assert.equal(a.extraSkillAmpPct, 50);
  const noMastery = C.autoValues(c, '아르카나', 1, 20);
  assert.equal(noMastery.extraAtk, 30);
  assert.equal(noMastery.extraSkillAmpPct, 0);
  assert.match(noMastery.warning, /아르카나 숙련도가 없습니다/);
  const noWeapon = C.autoValues(c, null, 20, 20);
  assert.equal(noWeapon.extraSkillAmpPct, null);
  assert.match(noWeapon.warning, /무기를 장착/);
  assert.deepEqual(C.autoValues(null, '활', 20, 20), { extraAtk: null, extraSkillAmpPct: null, atkSource: '', ampSource: '', warning: '' });
});

test('실험체 재매칭: 데이터 갱신 뒤 id로 다시 찾고(이름 바뀌어도), 없어지면 lost', () => {
  const list = [{ id: 1, name: '아르다(새 이름)' }, { id: 2, name: '쇼우' }];
  assert.deepEqual(C.rematch(list, '1', '아르다'), { character: list[0], lost: false });
  assert.deepEqual(C.rematch(list, '9', '아르다'), { character: null, lost: true });
  assert.deepEqual(C.rematch(list, null, '쇼우'), { character: list[1], lost: false }); // id 모름 → 이름
  assert.deepEqual(C.rematch(list, null, '없음'), { character: null, lost: true });
  assert.deepEqual(C.rematch(list, null, ''), { character: null, lost: false }); // 선택 없음
});

test('v2: 공격력·방어 관통·피해 배수·스킬 피해 감소', () => {
  const items = [
    item('w', '무기', '검', 100, { '공격력': 50, '레벨 당 공격력': 2, '방어 관통율': 0.1 }),
    item('h', '머리', '모자', 100, { '방어 관통': 10, '최종 피해 증가율': 0.05 }),
    item('c', '옷', '옷', 100, { '스킬 증폭율': 0.1 }),
    item('a', '팔', '팔', 100, { '스킬 증폭': 40 }),
    item('l', '다리', '다리', 100, {}),
  ];
  const inputs = { ...V2.DEFAULT_INPUTS, level: 10, skillDamage: 100, atkCoefPct: 50, skillAmpCoefPct: 20, defense: 100,
    extraAtk: 30, extraSkillAmp: 60, extraSkillAmpPct: 10, extraDamageIncreasePct: 10, enemyDamageReductionPct: 5, enemySkillReductionPct: 20 };
  const r = V2.calculate(items, inputs);
  // 공격력 50+2×10+30=100, SA=(40+60)×(1+0.1+0.1)=120, S=100+50+24=174,
  // R'=100×0.9−10=80, B=17400/180=96.667, M=1+0.05+0.1−0.05=1.1, K=0.8, D=85.0667
  assert.equal(r.stats.atk, 100);
  assert.ok(Math.abs(r.SA - 120) < 1e-9);
  assert.ok(Math.abs(r.S - 174) < 1e-9);
  assert.ok(Math.abs(r.R - 80) < 1e-9);
  assert.ok(Math.abs(r.M - 1.1) < 1e-9);
  assert.ok(Math.abs(r.K - 0.8) < 1e-9);
  assert.ok(Math.abs(r.D - (17400 / 180) * 1.1 * 0.8) < 1e-9);
  assert.ok(Math.abs(r.ratio - r.D / 500) < 1e-12);
});

test("v2 방어 관통: 추가 고정·% 입력 합산, R=150·관통 200이면 R'=0·B=S, 계산 과정에 둘 다 표시", () => {
  const items = MEASURED.map((it) => ({ ...it, stats: { ...it.stats } }));
  items[1].stats['방어 관통'] = 10; // 쿤달라
  items[2].stats['방어 관통율'] = 0.1; // 이단심판관
  const inputs = { ...BASE, extraSkillAmp: 351, extraPen: 5, extraPenPct: 20 };
  const r = V2.calculate(items, inputs);
  assert.ok(Math.abs(r.stats.penRate - 0.3) < 1e-12);
  assert.equal(r.stats.pen, 15);
  assert.ok(Math.abs(r.R - (150 * 0.7 - 15)) < 1e-9); // 90
  const line = E.linesV2(items, inputs, r, null).find((l) => l.startsWith("R'"));
  assert.equal(line, "R' = max(0, 150 × (1 − (아이템 10% (이단심판관 10%) + 추가 20%)) − (아이템 10 (쿤달라 10) + 추가 5)) = 90");
  const zeroIn = { ...BASE, extraSkillAmp: 351, extraPen: 200 };
  const z = V2.calculate(MEASURED, zeroIn);
  assert.equal(z.R, 0);
  assert.equal(z.B, z.S);
  assert.equal(E.linesV2(MEASURED, zeroIn, z, null).find((l) => l.startsWith("R'")),
    "R' = max(0, 150 × (1 − (아이템 0% + 추가 0%)) − (아이템 0 + 추가 200)) = -50 → 0");
});

test('v2 최솟값: 증폭 배수 0.1, D 1', () => {
  const inputs = { ...BASE, extraSkillAmp: 0, extraSkillAmpPct: -500, enemyDamageReductionPct: 500 };
  const r = V2.calculate(MEASURED, inputs);
  assert.equal(r.stats.skillAmpMult, 0.1); // 1 + 0.15 − 5 < 0.1
  assert.ok(Math.abs(r.SA - 43) < 1e-9); // 430 × 0.1
  assert.equal(r.M, 0.1);
  const zero = V2.calculate(MEASURED, { ...BASE, skillDamage: 0, skillAmpCoefPct: 0 });
  assert.equal(zero.D, 1);
  const neg = V2.calculate(MEASURED, { ...BASE, enemySkillReductionPct: 150 });
  assert.equal(neg.D, 1);
});

test('v2: 택1 자동 규칙은 v1과 같고, 빈 입력은 거부', () => {
  const items = MEASURED.map((it) => ({ ...it, stats: { ...it.stats } }));
  items[0].stats['스킬 증폭(택1)'] = 10;
  items[0].stats['공격력(택1)'] = 5;
  const r = V2.calculate(items, { ...BASE, extraSkillAmp: 0 });
  assert.equal(r.choice, 'skillAmp'); // 무기 제외 4부위 모두 스킬 증폭
  assert.equal(r.stats.skillAmpFlat, 440);
  assert.equal(r.stats.atk, 40);
  assert.throws(() => V2.calculate(MEASURED, { ...BASE, skillAmpCoefPct: null }), /skillAmpCoefPct/);
  assert.equal(V2.skillAmpTotal([MEASURED[3], undefined], { level: NaN, extraSkillAmp: 0, extraSkillAmpPct: 0 }), null);
  // 일부 슬롯만 있어도 미리보기 합계: 임세티 92 × 1.15
  assert.ok(Math.abs(V2.skillAmpTotal([undefined, MEASURED[3]], { level: 20, extraSkillAmp: 0, extraSkillAmpPct: 0 }) - 105.8) < 1e-9);
});

test('v2 계산 과정: 실제 값을 대입한 식 한 줄씩', () => {
  const inputs = { ...BASE, extraSkillAmp: 351 };
  const r = V2.calculate(MEASURED, inputs);
  const withChar = E.linesV2(MEASURED, { ...inputs, characterName: '아르다' }, r, null);
  assert.equal(withChar[0], '실험체: 아르다 · 캐릭터 레벨 20 · 숙련도 레벨 20');
  assert.deepEqual(E.linesV2(MEASURED, inputs, r, null), [
    '공격력 합 = 아이템 공격력 40 (여제 40) + 아이템 외 0 = 40',
    '스킬 증폭 합 = 아이템 스킬 증폭 330 (여제 93, 쿤달라 82, 이단심판관 30, 임세티 92, 글레이셜 슈즈 33) + 레벨 당 5 (이단심판관 5)×20 + 아이템 외 351 = 781',
    'SA = 781 × (1 + 0.15 (임세티 0.15) + 아이템 외 0) = 781 × 1.15 (최솟값 0.1) = 898.15',
    'S = 230 + 40 × 0% + SA 898.15 × 80% = 948.52',
    "R' = max(0, 150 × (1 − (아이템 0% + 추가 0%)) − (아이템 0 + 추가 0)) = 150",
    'B = 948.52 × 100 / (100 + 150) = 379.41',
    '피해 배수 = 1 + 0 + 0 − 0 = 1 (최솟값 0.1)',
    '스킬 피해 감소 배수 = 1 − 0 = 1',
    'D = 379.41 × 1 × 1 = 379.41',
    '효율 = D 379.41 ÷ 가격 합 1005 (여제 5, 쿤달라 200, 이단심판관 350, 임세티 250, 글레이셜 슈즈 200) = 0.3775',
  ]);
});

test('v2 히스토리: 저장 키·계산식 버전이 v1과 분리', () => {
  const H2 = H.forVariant('v2');
  assert.notEqual(H2.STORAGE_KEY, H.STORAGE_KEY);
  assert.match(H2.STORAGE_KEY, /-v2$/);
  assert.equal(H.forVariant('v1'), H);
  assert.equal(H2.forVariant('v1'), H);
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  const inputs = { ...BASE, extraSkillAmp: 351 };
  const r = V2.calculate(MEASURED, inputs);
  const equipped = Object.fromEntries(MEASURED.map((it) => [it.slot, it]));
  const e = H2.makeEntry({ equipped, inputs, result: r });
  H2.save(storage, [e]);
  assert.deepEqual(H.load(storage), []); // v1 키에는 없음
  const [loaded] = H2.load(storage);
  assert.equal(loaded.result.D, r.D);
  assert.equal(loaded.result.SA, r.SA);
  // 실험체·숙련도·레벨도 기록에 남는다(app.js readInputs가 inputs에 넣음).
  const withChar = H2.makeEntry({ equipped, inputs: { ...inputs, characterId: 'arda', characterName: '아르다' }, result: r });
  assert.deepEqual([withChar.inputs.characterId, withChar.inputs.characterName, withChar.inputs.masteryLevel, withChar.inputs.level],
    ['arda', '아르다', 20, 20]);
  assert.ok(H2.isCurrent(loaded) && !H.isCurrent(loaded));
  assert.equal(loaded.result.ratio, r.ratio);
});
