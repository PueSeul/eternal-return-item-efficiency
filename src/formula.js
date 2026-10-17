// 데미지 계산식(브라우저와 Node 테스트에서 함께 사용).
// D = (B × A + I) × F
//   B = S × 100 / (R' + 100)
//   A = 1 + 스킬 증폭율 − 적의 스킬 피해 감소율   (최솟값 0.1)
//   I = 고정 스킬 증폭 합 − 적의 스킬 피해 감소(고정)   (호스트 결정: 이미지 식 그대로)
//   F = 1 + 최종 피해 증가율 − 적의 최종 피해 감소율
//   최종 피해량 최솟값 1, 모드 증폭 제외(루미아섬 기준)
// 아이템 스탯 매핑:
//   스킬에 정의된 피해(S) = 툴팁 기본 피해 + 공격력 계수 × 공격력
//   적용 방어력(R') = max(0, R × (1 − 방어 관통율) − 방어 관통)  (입력란 값 = 최종값, 기본은 아이템 합 자동 기입)
//   스킬 증폭율 → A, 고정 스킬 증폭 → I, 최종 피해 증가율 → F
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERFormula = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_AMP = 0.1;
  const MIN_DAMAGE = 1;

  // data/items.json의 slot 값과 동일(화면 표시 순서). 저장값은 슬롯 이름 키라 순서와 무관.
  const SLOTS = ['무기', '옷', '머리', '팔', '다리'];

  // 적용 방어력: 방어 관통으로 0 아래로 내려가지 않는다. penRate는 0~1 소수.
  function effectiveDefense(defense, penRate, pen) {
    return Math.max(0, defense * (1 - penRate) - pen);
  }

  // 아이템 stats 키(dak.gg 한국어 스탯 이름) → 식의 항. 비율 스탯은 0~1 소수.
  // '(고유) 스킬 증폭'은 dak.gg에서 "+25%"로 표기되는 비율 스탯이라 스킬 증폭율에 합산한다.
  // '레벨 당 ...'은 레벨을 곱해 고정 스탯에 더한다.
  const STAT_KEYS = {
    atk: ['공격력'],                                // S: 공격력 계수 × 공격력 합
    atkPerLevel: ['레벨 당 공격력'],
    skillAmp: ['스킬 증폭'],                         // I: 고정 스킬 증폭 합
    skillAmpPerLevel: ['레벨 당 스킬 증폭'],
    skillAmpRate: ['스킬 증폭율', '(고유) 스킬 증폭'], // A
    finalRate: ['최종 피해 증가율'],                  // F
    penRate: ['방어 관통율'],                        // R' = R × (1 − 방어 관통율) − 방어 관통
    pen: ['방어 관통'],
    choiceAtk: ['공격력(택1)'],                      // 택1 스탯: choiceStat(items) === 'atk'일 때만 공격력에 합산
    choiceSkillAmp: ['스킬 증폭(택1)'],              // choiceStat(items) === 'skillAmp'일 때만 스킬 증폭에 합산
  };

  // '(택1)' 스탯 자동 결정. 무기를 제외한 부위 중 공격력 계열 스탯을 가진 부위 수(a)와
  // 스킬 증폭 계열 스탯을 가진 부위 수(s)를 세어(한 아이템이 둘 다 가지면 둘 다 셈)
  // a > s 이면 'atk', 그 외(동률 포함)는 'skillAmp'.
  function choiceStat(items) {
    const has = (it, keys) => keys.some((k) => {
      const n = Number(it.stats && it.stats[k]);
      return Number.isFinite(n) && n !== 0;
    });
    let a = 0;
    let s = 0;
    for (const it of items) {
      if (!it || it.slot === '무기') continue;
      if (has(it, [...STAT_KEYS.atk, ...STAT_KEYS.atkPerLevel])) a++;
      if (has(it, ['스킬 증폭', '레벨 당 스킬 증폭', '(고유) 스킬 증폭'])) s++;
    }
    return a > s ? 'atk' : 'skillAmp';
  }

  // 사용자 입력 필드와 기본값. 비율(%) 항목은 퍼센트 단위(예: 5 = 5%)로 입력한다.
  // null = 기본값 없음(스킬 툴팁·대상에 따라 다르므로 사용자가 반드시 입력).
  const DEFAULT_INPUTS = {
    level: 20,                  // '레벨 당' 스탯에 곱하는 레벨
    skillDamage: null,          // S의 툴팁 기본 피해량
    atkCoefPct: null,           // S의 공격력 계수(%) — 툴팁 "(+공격력의 X%)"
    defense: null,              // R: 피격 대상 방어력
    extraPen: 0,                // 방어 관통(고정) 최종값(키 이름은 기존 기록 호환용)
    extraPenPct: 0,             // 방어 관통율(%) 최종값
    enemySkillReductionPct: 0,  // 적의 스킬 피해 감소율(%)
    enemySkillReduction: 0,     // 적의 스킬 피해 감소(고정값)
    extraFinalIncreasePct: 0,   // 아이템 외 추가 최종 피해 증가율(%)
    enemyFinalReductionPct: 0,  // 적의 최종 피해 감소율(%)
  };

  function damage(p) {
    const B = (p.S * 100) / (p.R + 100);
    const A = Math.max(MIN_AMP, 1 + p.ampRate - p.enemySkillReductionRate);
    const I = p.skillAmp - p.enemySkillReduction;
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
      if (typeof inputs[key] !== 'number' || !Number.isFinite(inputs[key])) {
        throw new Error(`입력값 ${key}가 숫자가 아닙니다.`);
      }
    }
    const totals = aggregateStats(items);
    const sum = (keys) => keys.reduce((s, k) => s + (totals[k] || 0), 0);
    const choice = choiceStat(items);
    const atk = sum(STAT_KEYS.atk) + sum(STAT_KEYS.atkPerLevel) * inputs.level +
      (choice === 'atk' ? sum(STAT_KEYS.choiceAtk) : 0);
    const skillAmp = sum(STAT_KEYS.skillAmp) + sum(STAT_KEYS.skillAmpPerLevel) * inputs.level +
      (choice === 'skillAmp' ? sum(STAT_KEYS.choiceSkillAmp) : 0);
    const skillAmpRate = sum(STAT_KEYS.skillAmpRate);
    const itemFinalRate = sum(STAT_KEYS.finalRate);
    const itemPenRate = sum(STAT_KEYS.penRate);
    const itemPen = sum(STAT_KEYS.pen);
    // 방어 관통 입력란이 최종값(장비 슬롯이 바뀌면 아이템 합으로 자동 기입, 수동 수정 가능). 아이템 합은 표시용.
    const penRate = inputs.extraPenPct / 100;
    const pen = inputs.extraPen;
    const S = inputs.skillDamage + (inputs.atkCoefPct / 100) * atk;
    const R = effectiveDefense(inputs.defense, penRate, pen);
    const terms = damage({
      S,
      R,
      skillAmp,
      ampRate: skillAmpRate,
      enemySkillReductionRate: inputs.enemySkillReductionPct / 100,
      enemySkillReduction: inputs.enemySkillReduction,
      finalRate: itemFinalRate + inputs.extraFinalIncreasePct / 100,
      enemyFinalReductionRate: inputs.enemyFinalReductionPct / 100,
    });
    const price = totalPrice(items);
    return {
      stats: { atk, skillAmp, skillAmpRate, itemFinalRate, itemPenRate, itemPen, penRate, pen },
      choice,
      S,
      R,
      ...terms,
      price,
      ratio: price > 0 ? terms.D / price : null,
    };
  }

  // 방어 관통 입력란 자동값: 아이템(빈 슬롯 무시)의 방어 관통 합 · 방어 관통율 합(% 단위).
  function itemPen(items) {
    const totals = aggregateStats(items.filter(Boolean));
    const sum = (keys) => keys.reduce((s, k) => s + (totals[k] || 0), 0);
    return { pen: sum(STAT_KEYS.pen), penPct: sum(STAT_KEYS.penRate) * 100 };
  }

  // 효율 % = (이번 데미지/가격) ÷ (비교 기준의 데미지/가격) × 100
  function efficiencyPercent(ratio, bestRatio) {
    if (ratio == null || !bestRatio) return null;
    return (ratio / bestRatio) * 100;
  }

  return { MIN_AMP, MIN_DAMAGE, SLOTS, STAT_KEYS, DEFAULT_INPUTS, effectiveDefense, choiceStat, damage, aggregateStats, totalPrice, itemPen, calculate, efficiencyPercent };
});
