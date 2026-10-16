// 데미지 계산식(브라우저와 Node 테스트에서 함께 사용).
// D = (B × A + I) × F
//   B = S × 100 / (R' + 100)
//   A = 1 + 스킬 증폭율 − 적의 스킬 피해 감소율   (최솟값 0.1)
//   I = −적의 스킬 피해 감소(고정)
//   F = 1 + 최종 피해 증가율 − 적의 최종 피해 감소율
//   최종 피해량 최솟값 1, 모드 증폭 제외(루미아섬 기준)
// 아이템 스탯 매핑 근거(공식 라운지 피해 공식, 나무위키 "이터널 리턴/가이드" 피해 공식):
//   스킬에 정의된 피해(S) = 툴팁 기본 피해 + 공격력 계수 × 공격력 + 스킬 증폭 계수 × 스킬 증폭
//   적용 방어력(R') = R × (1 − 방어 관통율) − 방어 관통
//   스킬 증폭(%)은 증폭율로 0.1 미만으로 내려가지 않음 → A
//   고정 스킬 증폭은 계수로 S에 들어가므로 I에는 넣지 않는다(이중 반영 방지).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERFormula = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_AMP = 0.1;
  const MIN_DAMAGE = 1;

  // data/items.json의 slot 값과 동일.
  const SLOTS = ['무기', '머리', '옷', '팔', '다리'];

  // 아이템 stats 키(dak.gg 한국어 스탯 이름) → 식의 항. 비율 스탯은 0~1 소수.
  // '(고유) 스킬 증폭'은 dak.gg에서 "+25%"로 표기되는 비율 스탯이라 스킬 증폭율에 합산한다.
  // '레벨 당 ...'은 레벨을 곱해 고정 스탯에 더한다.
  const STAT_KEYS = {
    atk: ['공격력'],                                // S: 공격력 계수 × 공격력 합
    atkPerLevel: ['레벨 당 공격력'],
    skillAmp: ['스킬 증폭'],                         // S: 스킬 증폭 계수 × 스킬 증폭 합
    skillAmpPerLevel: ['레벨 당 스킬 증폭'],
    skillAmpRate: ['스킬 증폭율', '(고유) 스킬 증폭'], // A
    finalRate: ['최종 피해 증가율'],                  // F
    penRate: ['방어 관통율'],                        // R' = R × (1 − 방어 관통율) − 방어 관통
    pen: ['방어 관통'],
    choiceAtk: ['공격력(택1)'],                      // 택1 스탯: inputs.choiceStat === 'atk'일 때만 공격력에 합산
    choiceSkillAmp: ['스킬 증폭(택1)'],              // inputs.choiceStat === 'skillAmp'일 때만 스킬 증폭에 합산
  };

  // '(택1)' 스탯 처리 방식. 게임에서 둘 중 하나를 고르는 스탯이라 전체 계산에 한 방식을 적용한다.
  const CHOICE_OPTIONS = [
    { value: 'skillAmp', label: '스킬 증폭(택1) 적용' },
    { value: 'atk', label: '공격력(택1) 적용' },
    { value: 'none', label: '택1 스탯 적용 안 함' },
  ];

  // 사용자 입력 필드와 기본값. 비율(%) 항목은 퍼센트 단위(예: 5 = 5%)로 입력한다.
  // null = 기본값 없음(스킬 툴팁·대상에 따라 다르므로 사용자가 반드시 입력).
  const DEFAULT_INPUTS = {
    level: 20,                  // '레벨 당' 스탯에 곱하는 레벨
    choiceStat: 'skillAmp',     // '(택1)' 스탯 처리: CHOICE_OPTIONS의 value
    skillDamage: null,          // S의 툴팁 기본 피해량
    atkCoefPct: null,           // S의 공격력 계수(%) — 툴팁 "(+공격력의 X%)"
    skillAmpCoefPct: null,      // S의 스킬 증폭 계수(%) — 툴팁 "(+스킬 증폭의 X%)"
    defense: null,              // R: 피격 대상 방어력
    enemySkillReductionPct: 0,  // 적의 스킬 피해 감소율(%)
    enemySkillReduction: 0,     // 적의 스킬 피해 감소(고정값)
    extraFinalIncreasePct: 0,   // 아이템 외 추가 최종 피해 증가율(%)
    enemyFinalReductionPct: 0,  // 적의 최종 피해 감소율(%)
  };

  function damage(p) {
    const B = (p.S * 100) / (p.R + 100);
    const A = Math.max(MIN_AMP, 1 + p.ampRate - p.enemySkillReductionRate);
    const I = 0 - p.enemySkillReduction; // 0 − x: 입력 0일 때 −0 표시 방지
    const F = 1 + p.finalRate - p.enemyFinalReductionRate;
    const D = Math.max(MIN_DAMAGE, (B * A + I) * F);
    return { B, A, I, F, D };
  }

  // 장착 아이템 stats 합(숫자 값만).
  function aggregateStats(items) {
    const totals = {};
    for (const item of items) {
      for (const [key, value] of Object.entries(item.stats || {})) {
        const n = Number(value);
        if (Number.isFinite(n)) totals[key] = (totals[key] || 0) + n;
      }
    }
    return totals;
  }

  function totalPrice(items) {
    return items.reduce((sum, it) => sum + (Number(it.price) || 0), 0);
  }

  function calculate(items, inputs) {
    // null·빈 값이 Number 연산에서 0으로 바뀌어 조용히 계산되는 것을 막는다.
    for (const key of Object.keys(DEFAULT_INPUTS)) {
      if (key !== 'choiceStat' && (typeof inputs[key] !== 'number' || !Number.isFinite(inputs[key]))) {
        throw new Error(`입력값 ${key}가 숫자가 아닙니다.`);
      }
    }
    const totals = aggregateStats(items);
    const sum = (keys) => keys.reduce((s, k) => s + (totals[k] || 0), 0);
    const choice = inputs.choiceStat;
    const atk = sum(STAT_KEYS.atk) + sum(STAT_KEYS.atkPerLevel) * inputs.level +
      (choice === 'atk' ? sum(STAT_KEYS.choiceAtk) : 0);
    const skillAmp = sum(STAT_KEYS.skillAmp) + sum(STAT_KEYS.skillAmpPerLevel) * inputs.level +
      (choice === 'skillAmp' ? sum(STAT_KEYS.choiceSkillAmp) : 0);
    const skillAmpRate = sum(STAT_KEYS.skillAmpRate);
    const itemFinalRate = sum(STAT_KEYS.finalRate);
    const penRate = sum(STAT_KEYS.penRate);
    const pen = sum(STAT_KEYS.pen);
    const S = inputs.skillDamage + (inputs.atkCoefPct / 100) * atk + (inputs.skillAmpCoefPct / 100) * skillAmp;
    const R = inputs.defense * (1 - penRate) - pen;
    const terms = damage({
      S,
      R,
      ampRate: skillAmpRate,
      enemySkillReductionRate: inputs.enemySkillReductionPct / 100,
      enemySkillReduction: inputs.enemySkillReduction,
      finalRate: itemFinalRate + inputs.extraFinalIncreasePct / 100,
      enemyFinalReductionRate: inputs.enemyFinalReductionPct / 100,
    });
    const price = totalPrice(items);
    return {
      stats: { atk, skillAmp, skillAmpRate, itemFinalRate, penRate, pen },
      S,
      R,
      ...terms,
      price,
      ratio: price > 0 ? terms.D / price : null,
    };
  }

  // 효율 % = (이번 데미지/가격) ÷ (비교 기준의 데미지/가격) × 100
  function efficiencyPercent(ratio, bestRatio) {
    if (ratio == null || !bestRatio) return null;
    return (ratio / bestRatio) * 100;
  }

  return { MIN_AMP, MIN_DAMAGE, SLOTS, STAT_KEYS, CHOICE_OPTIONS, DEFAULT_INPUTS, damage, aggregateStats, totalPrice, calculate, efficiencyPercent };
});
