'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/formula');
const E = require('../src/explain');

const item = (id, slot, name, price, stats) => ({ id, slot, name, price, grade: '전설', imageUrl: '', stats });
const ITEMS = [
  item('w', '무기', '프라가라흐', 400, { '공격력': 90, '레벨 당 공격력': 1.5, '공격력(택1)': 10 }),
  item('h', '머리', '미스릴 투구', 200, { '공격력': 30, '방어 관통': 12 }),
  item('c', '옷', '옷A', 300, { '스킬 증폭율': 0.12, '스킬 증폭(택1)': 5 }),
  item('a', '팔', '팔A', 0, { '스킬 증폭': 62 }),
  item('l', '다리', '다리A', 0, { '최종 피해 증가율': 0.05 }),
];
const INPUTS = { ...F.DEFAULT_INPUTS, level: 20, skillDamage: 200, atkCoefPct: 50, defense: 100 };

test('계산 과정: 실제 값을 대입한 식 한 줄씩 + 아이템별 기여', () => {
  const r = F.calculate(ITEMS, INPUTS);
  // 손계산: 공격력 90+30+1.5×20=150, S=200+75=275, R'=100−12=88, B=27500/188=146.2766,
  // 무기 제외 공격력 보유 1(머리) vs 스킬 증폭 보유 1(팔) → 동률이라 스킬 증폭(택1): 62+5=67,
  // D=(146.2766×1.12+67)×1.05=242.3713, 가격 900 → 0.2693, 최고 0.3 대비 89.8%
  assert.deepEqual(E.lines(ITEMS, INPUTS, r, 0.3), [
    '택1 적용: 스킬 증폭(택1) (무기 제외 부위의 공격력/스킬 증폭 보유 수 비교)',
    '공격력 합 = 아이템 공격력 120 (프라가라흐 90, 미스릴 투구 30) + 레벨 당 1.5 (프라가라흐 1.5)×20 = 150',
    'S = 200 + 150 × 50% = 275',
    "R' = max(0, 100 × (1 − (아이템 0% + 추가 0%)) − (아이템 12 (미스릴 투구 12) + 추가 0)) = 88",
    "B = 275 × 100 / (88 + 100) = 146.28",
    'A = 1 + 0.12 (옷A 0.12) − 0 = 1.12 (최솟값 0.1)',
    '스킬 증폭 합 = 아이템 스킬 증폭 62 (팔A 62) + 스킬 증폭(택1) 5 (옷A 5) = 67',
    'I = 스킬 증폭 합 67 − 0 = 67',
    'F = 1 + 0.05 (다리A 0.05) + 0 − 0 = 1.05',
    'D = (146.28 × 1.12 + 67) × 1.05 = 242.37',
    '효율 = D 242.37 ÷ 가격 합 900 (프라가라흐 400, 미스릴 투구 200, 옷A 300) = 0.2693 → 최고 0.3 대비 89.8%',
  ]);
});

test('계산 과정: A·D 최솟값 적용 표시, 가격 합 0, 택1 없으면 택1 줄 없음', () => {
  const items = ITEMS.map((it) => ({ ...it, price: 0, stats: { ...it.stats } }));
  delete items[0].stats['공격력(택1)'];
  delete items[2].stats['스킬 증폭(택1)'];
  const inputs = { ...INPUTS, skillDamage: 0, atkCoefPct: 0, enemySkillReductionPct: 500, enemySkillReduction: 1000 };
  const r = F.calculate(items, inputs);
  const out = E.lines(items, inputs, r, null);
  assert.ok(!out.some((l) => l.startsWith('택1')));
  assert.equal(out.find((l) => l.startsWith('A =')), 'A = 1 + 0.12 (옷A 0.12) − 5 = -3.88 → 최솟값 0.1 적용 = 0.1');
  // D = (0×0.1 + 62−1000)×1.05 = −984.9 → 1
  assert.equal(out.find((l) => l.startsWith('D =')), 'D = (0 × 0.1 + -938) × 1.05 = -984.9 → 최솟값 1 적용 = 1');
  assert.equal(out[out.length - 1], '가격 합 0 — 효율 계산 제외');
});

test('계산 과정: 효율 %는 화면(toLocaleString)과 같은 반올림, 작은 비율도 표시', () => {
  // 0.8985 × 100 = 89.85: toFixed(1)은 이진 오차로 89.8, toLocaleString은 89.9
  assert.equal(E.num(0.8985 * 100, 1), (0.8985 * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 }));
  assert.equal(E.num(-0.001), '0');
  const inputs = { ...INPUTS, extraFinalIncreasePct: 0.4 };
  const out = E.lines(ITEMS, inputs, F.calculate(ITEMS, inputs), 0.3);
  assert.equal(out.find((l) => l.startsWith('F =')), 'F = 1 + 0.05 (다리A 0.05) + 0.004 − 0 = 1.054');
  const items = ITEMS.map((it) => ({ ...it, stats: { ...it.stats } }));
  items[2].stats['스킬 증폭율'] = 0.125;
  items[4].stats['(고유) 스킬 증폭'] = 0.125;
  const a = E.lines(items, INPUTS, F.calculate(items, INPUTS), 0.3).find((l) => l.startsWith('A ='));
  assert.equal(a, 'A = 1 + 0.25 (옷A 0.125, 다리A 0.125) − 0 = 1.25 (최솟값 0.1)');
});
