// v2 데미지 계산식(브라우저와 Node 테스트에서 함께 사용). 근거: handoff/status-formula.md, README "계산식 v2".
//   SA = (스킬 증폭 고정 합 + 레벨 당 스킬 증폭 × 성장형 스탯 + 아이템 외 스킬 증폭)
//        × (1 + % 스킬 증폭 합 + 아이템 외 % 스킬 증폭)          (배수 최솟값 0.1)
//   S  = 스킬 기본 피해량 + 공격력 계수 × 공격력 합 + 스킬 증폭 계수 × SA
//   R' = max(0, R × (1 − 방어 관통율 합) − 방어 관통 합)  (합 = 아이템 + 입력란의 추가값) ;  B = S × 100 / (100 + R')
//   D  = B × M × K   (최솟값 1)
//        M = 1 + 최종 피해 증가율 + 추가 피해 증가 − 대상 피해 감소   (최솟값 0.1)
//        K = 1 − 대상 스킬 피해 감소
// 택1 자동 결정·가격·효율은 v1(formula.js)과 같은 함수를 쓴다.
(function (root, factory) {
  const api = factory(root.ERFormula || (typeof require === 'function' ? require('./formula') : undefined));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERFormulaV2 = api;
})(typeof self !== 'undefined' ? self : this, function (V1) {
  'use strict';

  const { MIN_AMP, MIN_DAMAGE, SLOTS, STAT_KEYS, effectiveDefense, choiceStat, aggregateStats, totalPrice, efficiencyPercent } = V1;

  // 사용자 입력 필드와 기본값. 비율(%) 항목은 퍼센트 단위(예: 5 = 5%)로 입력한다.
  // null = 기본값 없음(스킬 툴팁·대상에 따라 다르므로 사용자가 반드시 입력).
  const DEFAULT_INPUTS = {
    level: 20,                     // 캐릭터 레벨: '레벨 당' 아이템 스탯과 실험체 성장치에 함께 사용
    masteryLevel: 20,              // 무기 숙련도 레벨(실험체 자동 입력용, 식에는 아이템 외 % 스킬 증폭으로 들어감)
    skillDamage: null,             // 스킬 기본 피해량
    atkCoefPct: null,              // 공격력 계수(%) — 툴팁 "(+공격력의 X%)"
    skillAmpCoefPct: null,         // 스킬 증폭 계수(%) — 툴팁 "(+스킬 증폭의 X%)"
    defense: null,                 // R: 피격 대상 방어력
    extraPen: 0,                   // 아이템 외 추가 방어 관통(고정)
    extraPenPct: 0,                // 아이템 외 추가 방어 관통율(%)
    extraAtk: 0,                  // 아이템 외 공격력(캐릭터 기본·성장 등)
    extraSkillAmp: 0,              // 아이템 외 스킬 증폭(고정)
    extraSkillAmpPct: 0,           // 아이템 외 % 스킬 증폭(무기 숙련도 등)
    extraDamageIncreasePct: 0,     // 추가 피해 증가(%)
    enemyDamageReductionPct: 0,    // 대상 피해 감소(%)
    enemySkillReductionPct: 0,     // 대상 스킬 피해 감소(%)
  };

  // 스탯 합계(빈 슬롯은 무시). SA 미리보기(일부 슬롯만 채운 상태)와 calculate가 함께 쓴다.
  function statTotals(items, inputs) {
    const list = items.filter(Boolean);
    const totals = aggregateStats(list);
    const sum = (keys) => keys.reduce((s, k) => s + (totals[k] || 0), 0);
    const choice = choiceStat(list);
    const atk = sum(STAT_KEYS.atk) + sum(STAT_KEYS.atkPerLevel) * inputs.level +
      (choice === 'atk' ? sum(STAT_KEYS.choiceAtk) : 0) + inputs.extraAtk;
    const skillAmpFlat = sum(STAT_KEYS.skillAmp) + sum(STAT_KEYS.skillAmpPerLevel) * inputs.level +
      (choice === 'skillAmp' ? sum(STAT_KEYS.choiceSkillAmp) : 0) + inputs.extraSkillAmp;
    const itemSkillAmpRate = sum(STAT_KEYS.skillAmpRate);
    const skillAmpRate = itemSkillAmpRate + inputs.extraSkillAmpPct / 100;
    const skillAmpMult = Math.max(MIN_AMP, 1 + skillAmpRate);
    return {
      choice,
      atk,
      skillAmpFlat,
      itemSkillAmpRate,
      skillAmpRate,
      skillAmpMult,
      SA: skillAmpFlat * skillAmpMult,
      itemFinalRate: sum(STAT_KEYS.finalRate),
      penRate: sum(STAT_KEYS.penRate),
      pen: sum(STAT_KEYS.pen),
    };
  }

  // 현재 스킬 증폭 합계(스탯창 값과 맞춰 보기용). 필요한 입력이 숫자가 아니면 null.
  function skillAmpTotal(items, inputs) {
    for (const k of ['level', 'extraSkillAmp', 'extraSkillAmpPct']) {
      if (typeof inputs[k] !== 'number' || !Number.isFinite(inputs[k])) return null;
    }
    return statTotals(items, inputs).SA;
  }

  function calculate(items, inputs) {
    // null·빈 값이 Number 연산에서 0으로 바뀌어 조용히 계산되는 것을 막는다.
    for (const key of Object.keys(DEFAULT_INPUTS)) {
      if (typeof inputs[key] !== 'number' || !Number.isFinite(inputs[key])) {
        throw new Error(`입력값 ${key}가 숫자가 아닙니다.`);
      }
    }
    const t = statTotals(items, inputs);
    const S = inputs.skillDamage + (inputs.atkCoefPct / 100) * t.atk + (inputs.skillAmpCoefPct / 100) * t.SA;
    // 아이템 방어 관통 합(t.penRate·t.pen) + 입력란의 추가값.
    const penRate = t.penRate + inputs.extraPenPct / 100;
    const pen = t.pen + inputs.extraPen;
    const R = effectiveDefense(inputs.defense, penRate, pen);
    const B = (S * 100) / (100 + R);
    const M = Math.max(MIN_AMP, 1 + t.itemFinalRate + inputs.extraDamageIncreasePct / 100 - inputs.enemyDamageReductionPct / 100);
    const K = 1 - inputs.enemySkillReductionPct / 100;
    const D = Math.max(MIN_DAMAGE, B * M * K);
    const price = totalPrice(items);
    const { choice, ...rest } = t;
    const stats = { ...rest, itemPenRate: t.penRate, itemPen: t.pen, penRate, pen };
    return { stats, choice, SA: t.SA, S, R, B, M, K, D, price, ratio: price > 0 ? D / price : null };
  }

  return { VERSION: 'v2', MIN_AMP, MIN_DAMAGE, SLOTS, STAT_KEYS, DEFAULT_INPUTS, choiceStat, statTotals, skillAmpTotal, calculate, totalPrice, efficiencyPercent };
});
