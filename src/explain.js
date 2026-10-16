// 계산 과정 텍스트: Formula.calculate 결과에 실제 숫자를 대입한 식을 한 줄씩 만든다(브라우저/Node 테스트 공용).
(function (root, factory) {
  const api = factory(root.ERFormula || (typeof require === 'function' ? require('./formula') : undefined));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERExplain = api;
})(typeof self !== 'undefined' ? self : this, function (Formula) {
  'use strict';

  const K = Formula.STAT_KEYS;

  // 소수 2자리 반올림, 불필요한 0 제거. -0은 0으로.
  function num(n, digits = 2) {
    const r = Number(n.toFixed(digits));
    return String(r === 0 ? 0 : r);
  }
  const pct = (rate) => num(rate * 100) + '%';

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

  // 고정 + 레벨 당 × 성장형 스탯 + 택1(적용된 쪽일 때만) 합계 줄.
  function sumLine(label, items, level, fixedKeys, perLevelKeys, choiceKeys, applied, total) {
    const fixed = contrib(items, fixedKeys);
    const per = contrib(items, perLevelKeys);
    const terms = [`아이템 ${label} ${withParts(sumOf(fixed), fixed)}`];
    if (per.length) terms.push(`레벨 당 ${withParts(sumOf(per), per)}×${num(level)}`);
    const ch = contrib(items, choiceKeys);
    if (applied && ch.length) terms.push(`${label}(택1) ${withParts(sumOf(ch), ch)}`);
    return `${label} 합 = ${terms.join(' + ')} = ${num(total)}`;
  }

  // items: 장착 아이템 5개, inputs: 입력값, r: Formula.calculate 결과, bestRatio: 효율 100% 기준(D/가격).
  function lines(items, inputs, r, bestRatio) {
    const out = [];
    const anyChoice = contrib(items, [...K.choiceAtk, ...K.choiceSkillAmp]).length > 0;
    if (anyChoice) {
      out.push(`택1 적용: ${r.choice === 'atk' ? '공격력(택1)' : '스킬 증폭(택1)'} (무기 제외 부위의 공격력/스킬 증폭 보유 수 비교)`);
    }
    out.push(sumLine('공격력', items, inputs.level, K.atk, K.atkPerLevel, K.choiceAtk, r.choice === 'atk', r.stats.atk));
    out.push(`S = ${num(inputs.skillDamage)} + ${num(r.stats.atk)} × ${num(inputs.atkCoefPct)}% = ${num(r.S)}`);
    out.push(`R' = ${num(inputs.defense)} × (1 − ${withParts(r.stats.penRate, contrib(items, K.penRate), pct)}) − ` +
      `${withParts(r.stats.pen, contrib(items, K.pen))} = ${num(r.R)}`);
    out.push(`B = ${num(r.S)} × 100 / (${num(r.R)} + 100) = ${num(r.B)}`);
    const enemyRate = inputs.enemySkillReductionPct / 100;
    const rawA = 1 + r.stats.skillAmpRate - enemyRate;
    out.push(`A = 1 + ${withParts(r.stats.skillAmpRate, contrib(items, K.skillAmpRate))} − ${num(enemyRate)} = ` +
      (rawA < Formula.MIN_AMP ? `${num(rawA)} → 최솟값 ${Formula.MIN_AMP} 적용 = ${num(r.A)}` : `${num(r.A)} (최솟값 ${Formula.MIN_AMP})`));
    out.push(sumLine('스킬 증폭', items, inputs.level, K.skillAmp, K.skillAmpPerLevel, K.choiceSkillAmp, r.choice === 'skillAmp', r.stats.skillAmp));
    out.push(`I = 스킬 증폭 합 ${num(r.stats.skillAmp)} − ${num(inputs.enemySkillReduction)} = ${num(r.I)}`);
    out.push(`F = 1 + ${withParts(r.stats.itemFinalRate, contrib(items, K.finalRate))} + ${num(inputs.extraFinalIncreasePct / 100)} − ` +
      `${num(inputs.enemyFinalReductionPct / 100)} = ${num(r.F)}`);
    const rawD = (r.B * r.A + r.I) * r.F;
    out.push(`D = (${num(r.B)} × ${num(r.A)} + ${num(r.I)}) × ${num(r.F)} = ` +
      (rawD < Formula.MIN_DAMAGE ? `${num(rawD)} → 최솟값 ${Formula.MIN_DAMAGE} 적용 = ${num(r.D)}` : num(r.D)));
    if (!(r.price > 0)) {
      out.push('가격 합 0 — 효율 계산 제외');
    } else {
      const priceText = withParts(r.price, contrib(items.map((it) => ({ name: it.name, stats: { p: it.price } })), ['p']));
      const p = Formula.efficiencyPercent(r.ratio, bestRatio);
      out.push(`효율 = D ${num(r.D)} ÷ 가격 합 ${priceText} = ${num(r.ratio, 4)}` +
        (p == null ? '' : ` → 최고 ${num(bestRatio, 4)} 대비 ${num(p, 1)}%`));
    }
    return out;
  }

  return { lines, num };
});
