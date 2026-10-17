// 계산 과정 텍스트: Formula.calculate 결과에 실제 숫자를 대입한 식을 한 줄씩 만든다(브라우저/Node 테스트 공용).
(function (root, factory) {
  const api = factory(root.ERFormula || (typeof require === 'function' ? require('./formula') : undefined));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERExplain = api;
})(typeof self !== 'undefined' ? self : this, function (Formula) {
  'use strict';

  const K = Formula.STAT_KEYS;

  // 소수 digits자리 반올림, 불필요한 0 제거. 화면(app.js fmt의 toLocaleString)과 같은 반올림을 쓰도록 Intl을 사용.
  const formatters = {};
  function num(n, digits = 2) {
    const f = formatters[digits] || (formatters[digits] = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, useGrouping: false }));
    const s = f.format(n);
    return s === '-0' ? '0' : s;
  }
  // 비율 스탯(A·F 항, 0~1 소수)은 0.4% 같은 값이 사라지지 않도록 소수 4자리.
  const rate = (n) => num(n, 4);
  const pct = (r) => num(r * 100) + '%';

  // keys에 해당하는 스탯의 아이템별 기여(0이 아닌 것만).
  function contrib(items, keys) {
    const parts = [];
    for (const it of items) {
      const v = keys.reduce((s, k) => {
        const n = Number(it.stats && it.stats[k]);
        return s + (Number.isFinite(n) ? n : 0);
      }, 0);
      if (v !== 0) parts.push({ name: it.name, value: v });
    }
    return parts;
  }
  // "120 (프라가라흐 90, 미스릴 투구 30)" — 기여 아이템이 없으면 값만.
  function withParts(value, parts, f = num) {
    return parts.length ? `${f(value)} (${parts.map((p) => `${p.name} ${f(p.value)}`).join(', ')})` : f(value);
  }
  const sumOf = (parts) => parts.reduce((s, p) => s + p.value, 0);

  // 고정 + 레벨 당 × 성장형 스탯 + 택1(적용된 쪽일 때만) [+ 아이템 외(v2)] 합계 줄.
  function sumLine(label, items, level, fixedKeys, perLevelKeys, choiceKeys, applied, total, extra) {
    const fixed = contrib(items, fixedKeys);
    const per = contrib(items, perLevelKeys);
    const terms = [`아이템 ${label} ${withParts(sumOf(fixed), fixed)}`];
    if (per.length) terms.push(`레벨 당 ${withParts(sumOf(per), per)}×${num(level)}`);
    const ch = contrib(items, choiceKeys);
    if (applied && ch.length) terms.push(`${label}(택1) ${withParts(sumOf(ch), ch)}`);
    if (extra != null) terms.push(`아이템 외 ${num(extra)}`);
    return `${label} 합 = ${terms.join(' + ')} = ${num(total)}`;
  }

  function choiceLine(items, r) {
    const anyChoice = contrib(items, [...K.choiceAtk, ...K.choiceSkillAmp]).length > 0;
    return anyChoice
      ? [`택1 적용: ${r.choice === 'atk' ? '공격력(택1)' : '스킬 증폭(택1)'} (무기 제외 부위의 공격력/스킬 증폭 보유 수 비교)`]
      : [];
  }

  // R' = max(0, R × (1 − 방관율 합) − 방관 고정 합). 합 = 아이템 + 추가(입력란). 0 아래면 원래 값 → 0 표시.
  function penLines(items, inputs, r) {
    const raw = inputs.defense * (1 - r.stats.penRate) - r.stats.pen;
    return [
      `R' = max(0, ${num(inputs.defense)} × (1 − (아이템 ${withParts(r.stats.itemPenRate, contrib(items, K.penRate), pct)} + ` +
        `추가 ${pct(inputs.extraPenPct / 100)})) − (아이템 ${withParts(r.stats.itemPen, contrib(items, K.pen))} + 추가 ${num(inputs.extraPen)})) = ` +
        (raw < 0 ? `${num(raw)} → 0` : num(r.R)),
    ];
  }

  // refLabel: 비교 기준 이름(히스토리 최고 = '최고', 기준 세트 = '기준 세트').
  function efficiencyLine(items, r, bestRatio, refLabel = '최고') {
    if (!(r.price > 0)) return '가격 합 0 — 효율 계산 제외';
    const priceText = withParts(r.price, contrib(items.map((it) => ({ name: it.name, stats: { p: it.price } })), ['p']));
    const p = Formula.efficiencyPercent(r.ratio, bestRatio);
    return `효율 = D ${num(r.D)} ÷ 가격 합 ${priceText} = ${num(r.ratio, 4)}` +
      (p == null ? '' : ` → ${refLabel} ${num(bestRatio, 4)} 대비 ${num(p, 1)}%`);
  }

  const minNote = (raw, value, min, f) =>
    (raw < min ? `${f(raw)} → 최솟값 ${min} 적용 = ${f(value)}` : `${f(value)} (최솟값 ${min})`);

  // v2(formula_v2.js) 계산 과정. r: FormulaV2.calculate 결과.
  function linesV2(items, inputs, r, bestRatio, refLabel) {
    const out = [];
    if (inputs.characterName) {
      out.push(`실험체: ${inputs.characterName} · 캐릭터 레벨 ${num(inputs.level)} · 숙련도 레벨 ${num(inputs.masteryLevel)}`);
    }
    out.push(...choiceLine(items, r));
    out.push(sumLine('공격력', items, inputs.level, K.atk, K.atkPerLevel, K.choiceAtk, r.choice === 'atk', r.stats.atk, inputs.extraAtk));
    out.push(sumLine('스킬 증폭', items, inputs.level, K.skillAmp, K.skillAmpPerLevel, K.choiceSkillAmp, r.choice === 'skillAmp',
      r.stats.skillAmpFlat, inputs.extraSkillAmp));
    const extraPct = inputs.extraSkillAmpPct / 100;
    out.push(`SA = ${num(r.stats.skillAmpFlat)} × (1 + ${withParts(r.stats.itemSkillAmpRate, contrib(items, K.skillAmpRate), rate)} + ` +
      `아이템 외 ${rate(extraPct)}) = ${num(r.stats.skillAmpFlat)} × ` +
      `${minNote(1 + r.stats.skillAmpRate, r.stats.skillAmpMult, Formula.MIN_AMP, rate)} = ${num(r.SA)}`);
    out.push(`S = ${num(inputs.skillDamage)} + ${num(r.stats.atk)} × ${num(inputs.atkCoefPct)}% + ` +
      `SA ${num(r.SA)} × ${num(inputs.skillAmpCoefPct)}% = ${num(r.S)}`);
    out.push(...penLines(items, inputs, r));
    out.push(`B = ${num(r.S)} × 100 / (100 + ${num(r.R)}) = ${num(r.B)}`);
    const rawM = 1 + r.stats.itemFinalRate + inputs.extraDamageIncreasePct / 100 - inputs.enemyDamageReductionPct / 100;
    out.push(`피해 배수 = 1 + ${withParts(r.stats.itemFinalRate, contrib(items, K.finalRate), rate)} + ` +
      `${rate(inputs.extraDamageIncreasePct / 100)} − ${rate(inputs.enemyDamageReductionPct / 100)} = ` +
      minNote(rawM, r.M, Formula.MIN_AMP, rate));
    out.push(`스킬 피해 감소 배수 = 1 − ${rate(inputs.enemySkillReductionPct / 100)} = ${rate(r.K)}`);
    const rawD = r.B * r.M * r.K;
    out.push(`D = ${num(r.B)} × ${rate(r.M)} × ${rate(r.K)} = ` +
      (rawD < Formula.MIN_DAMAGE ? `${num(rawD)} → 최솟값 ${Formula.MIN_DAMAGE} 적용 = ${num(r.D)}` : num(r.D)));
    out.push(efficiencyLine(items, r, bestRatio, refLabel));
    return out;
  }

  // items: 장착 아이템 5개, inputs: 입력값, r: Formula.calculate 결과, bestRatio: 효율 100% 기준(D/가격).
  function lines(items, inputs, r, bestRatio, refLabel) {
    const out = choiceLine(items, r);
    out.push(sumLine('공격력', items, inputs.level, K.atk, K.atkPerLevel, K.choiceAtk, r.choice === 'atk', r.stats.atk));
    out.push(`S = ${num(inputs.skillDamage)} + ${num(r.stats.atk)} × ${num(inputs.atkCoefPct)}% = ${num(r.S)}`);
    out.push(...penLines(items, inputs, r));
    out.push(`B = ${num(r.S)} × 100 / (${num(r.R)} + 100) = ${num(r.B)}`);
    const enemyRate = inputs.enemySkillReductionPct / 100;
    const rawA = 1 + r.stats.skillAmpRate - enemyRate;
    out.push(`A = 1 + ${withParts(r.stats.skillAmpRate, contrib(items, K.skillAmpRate), rate)} − ${rate(enemyRate)} = ` +
      minNote(rawA, r.A, Formula.MIN_AMP, rate));
    out.push(sumLine('스킬 증폭', items, inputs.level, K.skillAmp, K.skillAmpPerLevel, K.choiceSkillAmp, r.choice === 'skillAmp', r.stats.skillAmp));
    out.push(`I = 스킬 증폭 합 ${num(r.stats.skillAmp)} − ${num(inputs.enemySkillReduction)} = ${num(r.I)}`);
    out.push(`F = 1 + ${withParts(r.stats.itemFinalRate, contrib(items, K.finalRate), rate)} + ${rate(inputs.extraFinalIncreasePct / 100)} − ` +
      `${rate(inputs.enemyFinalReductionPct / 100)} = ${rate(r.F)}`);
    const rawD = (r.B * r.A + r.I) * r.F;
    out.push(`D = (${num(r.B)} × ${rate(r.A)} + ${num(r.I)}) × ${rate(r.F)} = ` +
      (rawD < Formula.MIN_DAMAGE ? `${num(rawD)} → 최솟값 ${Formula.MIN_DAMAGE} 적용 = ${num(r.D)}` : num(r.D)));
    out.push(efficiencyLine(items, r, bestRatio, refLabel));
    return out;
  }

  return { lines, linesV2, num };
});
