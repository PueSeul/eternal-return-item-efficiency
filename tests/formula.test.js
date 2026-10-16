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

test("calculate: '(택1)' 스탯은 choiceStat에 따라 한쪽만 반영", () => {
  const crown = { slot: '머리', price: 1, stats: { '공격력(택1)': 25, '스킬 증폭(택1)': 100 } };
  const amp = F.calculate([crown], { ...IN, choiceStat: 'skillAmp' });
  assert.deepEqual([amp.stats.atk, amp.stats.skillAmp], [0, 100]);
  const atk = F.calculate([crown], { ...IN, choiceStat: 'atk' });
  assert.deepEqual([atk.stats.atk, atk.stats.skillAmp], [25, 0]);
  const none = F.calculate([crown], { ...IN, choiceStat: 'none' });
  assert.deepEqual([none.stats.atk, none.stats.skillAmp], [0, 0]);
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

test("calculate: 방어 관통율·방어 관통은 적용 방어력 R'을 낮춤", () => {
  const pen = { slot: '무기', price: 1, stats: { '방어 관통율': 0.2, '방어 관통': 10 } };
  const r = F.calculate([pen], { ...IN, defense: 100 });
  close(r.R, 70); // 100 × (1 − 0.2) − 10
  close(r.B, 100 * 100 / 170);
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
