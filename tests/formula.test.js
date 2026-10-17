'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const F = require('../src/formula');
const items = require(path.join(__dirname, 'fixtures', 'items.sample.json'));

const base = { S: 100, R: 100, skillAmp: 0, ampRate: 0, enemySkillReductionRate: 0, enemySkillReduction: 0, finalRate: 0, enemyFinalReductionRate: 0 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
// S·R·계수는 기본값이 없으므로 테스트용 입력을 채운다.
const IN = { ...F.DEFAULT_INPUTS, skillDamage: 100, atkCoefPct: 50, defense: 100 };

test('B = S × 100 / (R + 100)', () => {
  close(F.damage({ ...base, S: 200, R: 100 }).B, 100);
  close(F.damage({ ...base, S: 150, R: 0 }).B, 150);
});

test('D = (B × A + I) × F 기본 예시', () => {
  // B=100, A=1+0.25-0.05=1.2, I=-10, F=1+0.1-0.05=1.05 → (120-10)*1.05 = 115.5
  const r = F.damage({ ...base, S: 200, R: 100, ampRate: 0.25, enemySkillReductionRate: 0.05, enemySkillReduction: 10, finalRate: 0.1, enemyFinalReductionRate: 0.05 });
  close(r.A, 1.2);
  close(r.I, -10);
  close(r.F, 1.05);
  close(r.D, 115.5);
  // I = 스킬 증폭 − 적의 스킬 피해 감소: (120 + 30 − 10) × 1.05 = 147
  const r2 = F.damage({ ...base, S: 200, R: 100, skillAmp: 30, ampRate: 0.25, enemySkillReductionRate: 0.05, enemySkillReduction: 10, finalRate: 0.1, enemyFinalReductionRate: 0.05 });
  close(r2.I, 20);
  close(r2.D, 147);
});

test('피해 증폭 A 최솟값은 0.1', () => {
  const r = F.damage({ ...base, enemySkillReductionRate: 2 }); // 1 - 2 = -1 → 0.1
  close(r.A, 0.1);
  close(r.D, 50 * 0.1);
  close(F.damage({ ...base, enemySkillReductionRate: 0.9 }).A, 0.1); // 경계값 정확히 0.1
  close(F.damage({ ...base, enemySkillReductionRate: 0.5 }).A, 0.5); // 하한 위는 그대로
});

test('최종 피해량 D 최솟값은 1', () => {
  close(F.damage({ ...base, S: 0 }).D, 1);
  close(F.damage({ ...base, enemySkillReduction: 1000 }).D, 1); // 음수 → 1
  close(F.damage({ ...base, enemyFinalReductionRate: 5 }).D, 1); // F 음수 → 1
  close(F.damage({ ...base, S: 2, R: 0 }).D, 2); // 1 위는 그대로
});

test('aggregateStats는 같은 키를 합산하고 숫자가 아닌 값은 무시', () => {
  const t = F.aggregateStats([...items, { stats: { 공격력: 'x' } }]);
  assert.equal(t['공격력'], 75);
  assert.equal(t['스킬 증폭'], 50);
  close(t['스킬 증폭율'], 0.25);
  close(t['최종 피해 증가율'], 0.05);
});

test('calculate: 픽스처 5부위 장착 시 스탯이 각 항에 대입됨', () => {
  const r = F.calculate(items, IN);
  // 공격력 75 → S = 100 + 0.5×75 = 137.5, R' = 100, B = 68.75
  // A = 1.25, I = 스킬 증폭 50 − 0 = 50, F = 1.05 → D = (68.75×1.25 + 50) × 1.05 = 142.734375
  close(r.S, 137.5);
  close(r.R, 100);
  close(r.B, 68.75);
  close(r.A, 1.25);
  close(r.I, 50);
  close(r.F, 1.05);
  close(r.D, 142.734375);
  assert.equal(r.price, 1000);
  close(r.ratio, r.D / 1000);
});

test('calculate: 퍼센트 입력값은 /100으로 변환', () => {
  const r = F.calculate(items, { ...IN, enemySkillReductionPct: 25, extraFinalIncreasePct: 10, enemyFinalReductionPct: 5 });
  close(r.A, 1.0);
  close(r.F, 1.1);
});

test("calculate: '레벨 당' 스탯은 레벨을 곱하고 '(고유) 스킬 증폭'은 A에 합산", () => {
  const extra = { slot: '옷', price: 1, stats: { '레벨 당 스킬 증폭': 5, '레벨 당 공격력': 2, '(고유) 스킬 증폭': 0.25 } };
  const r = F.calculate([extra], { ...IN, level: 10 });
  assert.equal(r.stats.skillAmp, 50);
  assert.equal(r.stats.atk, 20);
  close(r.A, 1.25);
  close(r.S, 100 + 0.5 * 20);
  close(r.I, 50);
});

const gear = (slot, stats) => ({ slot, price: 1, stats });
const ATK = { 공격력: 10 };
const AMP = { '스킬 증폭': 20 };

test("choiceStat: a > s면 'atk'", () => {
  const set = [gear('무기', AMP), gear('머리', ATK), gear('옷', { '레벨 당 공격력': 1 }), gear('팔', AMP), gear('다리', { 방어력: 5 })];
  assert.equal(F.choiceStat(set), 'atk'); // a=2, s=1 (무기 제외)
});

test("choiceStat: s > a면 'skillAmp'", () => {
  const set = [gear('무기', ATK), gear('머리', AMP), gear('옷', { '레벨 당 스킬 증폭': 1 }), gear('팔', { '(고유) 스킬 증폭': 0.2 }), gear('다리', ATK)];
  assert.equal(F.choiceStat(set), 'skillAmp'); // a=1, s=3
});

test("choiceStat: 2:2 동률이면 'skillAmp', 무기는 세지 않음", () => {
  const set = [gear('무기', ATK), gear('머리', ATK), gear('옷', ATK), gear('팔', AMP), gear('다리', AMP)];
  assert.equal(F.choiceStat(set), 'skillAmp');
});

test('choiceStat: 둘 다 가진 아이템은 양쪽 모두 셈, 택1 키는 세지 않음', () => {
  const both = { ...ATK, ...AMP };
  // a=3(머리·옷·팔), s=1(머리) → atk. '스킬 증폭(택1)'은 s에 세지 않는다.
  const set = [gear('무기', AMP), gear('머리', both), gear('옷', ATK), gear('팔', ATK), gear('다리', { '스킬 증폭(택1)': 50 })];
  assert.equal(F.choiceStat(set), 'atk');
  // a=2(머리·옷), s=2(머리·팔) → 동률이라 skillAmp. '공격력(택1)'은 a에 세지 않는다.
  const set2 = [gear('무기', ATK), gear('머리', both), gear('옷', ATK), gear('팔', AMP), gear('다리', { '공격력(택1)': 50 })];
  assert.equal(F.choiceStat(set2), 'skillAmp');
  // 둘 다 가진 아이템이 한쪽에만 세어지면 결과가 뒤집히는 경우
  const none = gear('다리', { 방어력: 5 });
  assert.equal(F.choiceStat([gear('머리', both), gear('옷', ATK), gear('팔', {}), none]), 'atk'); // a=2, s=1
  assert.equal(F.choiceStat([gear('머리', both), gear('옷', AMP), gear('팔', ATK), none]), 'skillAmp'); // a=2, s=2
  // 값이 0인 스탯은 가진 것으로 보지 않는다
  assert.equal(F.choiceStat([gear('머리', ATK), gear('옷', { '스킬 증폭': 0 })]), 'atk'); // a=1, s=0
});

test("calculate: '(택1)' 스탯은 자동 결정된 한쪽만 반영", () => {
  const crown = gear('머리', { '공격력(택1)': 25, '스킬 증폭(택1)': 100 });
  const amp = F.calculate([crown, gear('옷', AMP)], IN); // a=0, s=1
  assert.equal(amp.choice, 'skillAmp');
  assert.deepEqual([amp.stats.atk, amp.stats.skillAmp], [0, 120]);
  const atk = F.calculate([crown, gear('옷', ATK)], IN); // a=1, s=0
  assert.equal(atk.choice, 'atk');
  assert.deepEqual([atk.stats.atk, atk.stats.skillAmp], [35, 0]);
  // 저장된 옛 입력의 choiceStat은 무시된다(복원 후 재계산도 같은 규칙).
  assert.equal(F.calculate([crown, gear('옷', ATK)], { ...IN, choiceStat: 'skillAmp' }).choice, 'atk');
});

test('가격 합이 0이면 ratio/효율은 null', () => {
  const r = F.calculate([items[4]], IN);
  assert.equal(r.price, 0);
  assert.equal(r.ratio, null);
  assert.equal(F.efficiencyPercent(r.ratio, 1), null);
});

test('efficiencyPercent: 최고치 대비 퍼센트', () => {
  close(F.efficiencyPercent(0.5, 1), 50);
  close(F.efficiencyPercent(1, 1), 100);
  assert.equal(F.efficiencyPercent(1, null), null);
});

test('픽스처는 모든 슬롯을 하나씩 포함', () => {
  assert.deepEqual(items.map((i) => i.slot).sort(), [...F.SLOTS].sort());
});

test("calculate: 방어 관통 입력란(자동 = 아이템 합)이 적용 방어력 R'을 낮춤", () => {
  const pen = { slot: '무기', price: 1, stats: { '방어 관통율': 0.2, '방어 관통': 10 } };
  const auto = F.itemPen([pen, null]);
  assert.equal(auto.pen, 10);
  close(auto.penPct, 20);
  const r = F.calculate([pen], { ...IN, defense: 100, extraPen: auto.pen, extraPenPct: auto.penPct });
  close(r.R, 70); // 100 × (1 − 0.2) − 10
  close(r.B, 100 * 100 / 170);
  // 관통이 방어력보다 크면 R'은 0(하한), B = S
  const neg = F.calculate([pen], { ...IN, defense: 1, extraPen: 10, extraPenPct: 20 });
  assert.equal(neg.R, 0); // max(0, 1 × 0.8 − 10)
  close(neg.B, neg.S);
});

test("calculate: 방어 관통 입력란이 최종값(아이템 합을 또 더하지 않음, 수동값 그대로), R=150·관통 200이면 R'=0·B=S", () => {
  const pen = { slot: '무기', price: 1, stats: { '방어 관통율': 0.2, '방어 관통': 10 } };
  const r = F.calculate([pen], { ...IN, defense: 100, extraPen: 15, extraPenPct: 30 });
  close(r.stats.penRate, 0.3);
  close(r.stats.pen, 15);
  close(r.stats.itemPen, 10); // 표시용 아이템 합
  close(r.R, 55); // 100 × (1 − 0.3) − 15 (10+15, 20%+30%로 이중 합산하지 않음)
  const manual0 = F.calculate([pen], { ...IN, defense: 100, extraPen: 0, extraPenPct: 0 });
  close(manual0.R, 100); // 수동 0이면 아이템 방관이 있어도 0
  const zero = F.calculate([{ slot: '무기', price: 1, stats: {} }], { ...IN, defense: 150, extraPen: 200 });
  assert.equal(zero.R, 0);
  assert.equal(zero.B, zero.S);
  assert.equal(F.DEFAULT_INPUTS.extraPen, 0);
  assert.equal(F.DEFAULT_INPUTS.extraPenPct, 0);
});

test('슬롯 순서: 무기 · 옷 · 머리 · 팔 · 다리', () => {
  assert.deepEqual(F.SLOTS, ['무기', '옷', '머리', '팔', '다리']);
});

test('calculate: 공격력은 계수(%)로 S에, 고정 스킬 증폭은 I에 들어감', () => {
  const r0 = F.calculate(items, { ...IN, atkCoefPct: 0 });
  close(r0.S, 100);
  close(r0.I, 50);
  const r1 = F.calculate(items, { ...IN, atkCoefPct: 100, enemySkillReduction: 7 });
  close(r1.S, 175);
  close(r1.I, 43);
  const r2 = F.calculate(items, { ...IN, enemySkillReduction: 200 }); // I 음수 허용, D는 하한 1 규칙만
  close(r2.I, -150);
});

test('S·R·공격력 계수는 기본값 없음(사용자 입력 필수), 적의 스킬 피해 감소(고정)는 기본값 0', () => {
  for (const k of ['skillDamage', 'atkCoefPct', 'defense']) assert.equal(F.DEFAULT_INPUTS[k], null);
  assert.equal(F.DEFAULT_INPUTS.enemySkillReduction, 0);
  assert.ok(!('skillAmpCoefPct' in F.DEFAULT_INPUTS));
  assert.throws(() => F.calculate(items, F.DEFAULT_INPUTS), /skillDamage/);
  assert.throws(() => F.calculate(items, { ...IN, defense: null }), /defense/);
});
