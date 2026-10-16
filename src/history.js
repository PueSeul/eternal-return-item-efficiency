// 계산 히스토리: localStorage에 JSON 배열로 영구 저장(브라우저/Node 테스트 공용).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERHistory = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_ENTRIES = 500;

  // 계산식 변형(variant)마다 저장 키와 계산식 버전이 다른 같은 API를 만든다.
  function build(STORAGE_KEY, FORMULA_VERSION) {

  function isCurrent(e) {
    return e.formulaVersion === FORMULA_VERSION;
  }

  function comparableRatio(e) {
    const r = e && e.result && isCurrent(e) ? e.result.ratio : null;
    return typeof r === 'number' && Number.isFinite(r) ? r : null;
  }

  function load(storage) {
    try {
      const list = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(list)) return [];
      // 구조가 깨진 기록은 버린다(렌더링 중 예외 방지).
      return list.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' &&
        e.result && typeof e.result === 'object' && e.itemIds && typeof e.itemIds === 'object');
    } catch {
      return [];
    }
  }

  function save(storage, list) {
    storage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  // 새 기록을 맨 앞에 추가한 새 배열을 돌려준다.
  function add(list, entry) {
    return [entry, ...list].slice(0, MAX_ENTRIES);
  }

  function remove(list, id) {
    return list.filter((e) => e.id !== id);
  }

  // 비교 기준: 기록 전체 중 최고 "데미지 ÷ 가격 합".
  function bestRatio(list) {
    let best = null;
    for (const e of list) {
      const r = comparableRatio(e);
      if (r != null && (best == null || r > best)) best = r;
    }
    return best;
  }

  // 기록의 효율 %: 계산 때 저장한 값(기준 세트 대비 또는 당시 히스토리 최고 대비).
  // 효율 %를 저장하지 않던 예전 기록은 현재 기록 중 최고 비율(best) 대비로 계산. 이전 계산식 기록은 null.
  function entryPercent(e, best) {
    if (!e || !isCurrent(e)) return null;
    if (Object.prototype.hasOwnProperty.call(e, 'efficiencyPct')) {
      return typeof e.efficiencyPct === 'number' && Number.isFinite(e.efficiencyPct) ? e.efficiencyPct : null;
    }
    const r = comparableRatio(e);
    return r == null || !best ? null : (r / best) * 100;
  }

  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // 기록의 효율 { kind, value }: kind 'percent'(효율 %, 방식 표시 없는 예전 기록 포함) 또는
  // 'perPrice'(기준 가격 0 → 가격당 추가 데미지). 이전 계산식 기록·값 없음은 value null.
  function entryEfficiency(e, best) {
    if (e && e.efficiencyKind === 'perPrice') {
      return { kind: 'perPrice', value: isCurrent(e) ? finite(e.efficiencyPerPrice) : null };
    }
    return { kind: 'percent', value: entryPercent(e, best) };
  }

  // 보기 정렬: 'recent' = 시각 내림차순, 'efficiency' = 같은 방식끼리 값 내림차순
  // (효율 % 기록 → 가격당 추가 데미지 기록 → 값 없음 순, 같으면 최근 먼저).
  const SORT_MODES = ['recent', 'efficiency'];
  const KIND_RANK = { percent: 0, perPrice: 1 };

  function sorted(list, mode) {
    const time = (e) => {
      const t = Date.parse(e.time);
      return Number.isFinite(t) ? t : -Infinity;
    };
    const best = bestRatio(list);
    const eff = new Map(list.map((e) => [e, entryEfficiency(e, best)]));
    const rank = (e) => {
      const x = eff.get(e);
      return x.value == null ? 2 : KIND_RANK[x.kind];
    };
    const value = (e) => {
      const v = eff.get(e).value;
      return v == null ? 0 : v;
    };
    const byTime = (a, b) => time(b) - time(a);
    const cmp = mode === 'efficiency' ? (a, b) => (rank(a) - rank(b)) || (value(b) - value(a)) || byTime(a, b) : byTime;
    return [...list].sort((a, b) => cmp(a, b) || 0);
  }

  // baseline: 계산 때의 기준 세트 { ids, names }(채워진 슬롯만, 없으면 생략),
  // efficiency: { pct, mode: 'baseline' | 'history', kind: 'percent' | 'perPrice', value } — 저장된 효율이 표시·정렬에 쓰인다.
  // kind 'perPrice'(기준 가격 0)는 efficiencyKind와 efficiencyPerPrice(가격당 추가 데미지)로 저장, efficiencyPct는 null.
  function makeEntry({ equipped, inputs, result, baseline, efficiency, now = new Date() }) {
    const itemIds = {};
    const itemNames = {};
    for (const [slot, item] of Object.entries(equipped)) {
      itemIds[slot] = item.id;
      itemNames[slot] = item.name;
    }
    const entry = {
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      time: now.toISOString(),
      formulaVersion: FORMULA_VERSION,
      itemIds,
      itemNames,
      inputs: { ...inputs },
      result: resultFields(result),
    };
    if (baseline) {
      entry.baselineIds = { ...baseline.ids };
      entry.baselineNames = { ...baseline.names };
    }
    if (efficiency) {
      const kind = efficiency.kind === 'perPrice' ? 'perPrice' : 'percent';
      entry.efficiencyPct = kind === 'percent' ? finite(efficiency.pct) : null;
      entry.efficiencyMode = efficiency.mode;
      entry.efficiencyKind = kind;
      if (kind === 'perPrice') entry.efficiencyPerPrice = finite(efficiency.value);
    }
    return entry;
  }

  // 결과의 숫자 항(D·price·각 항)과 null 비율만 저장한다(stats·choice 제외).
  function resultFields(result) {
    const out = {};
    for (const [k, v] of Object.entries(result)) if (typeof v === 'number' || v === null) out[k] = v;
    return out;
  }

  // 기록의 슬롯별 아이템을 현재 데이터(byId: Map<id 문자열, item>)에서 찾는다(표시용).
  // 데이터에 없으면 found=false, imageUrl=null이고 이름은 기록에 저장된 이름(없으면 id)으로 대체한다.
  function slotItems(entry, slots, byId) {
    return slots.map((slot) => {
      const id = entry.itemIds ? entry.itemIds[slot] : undefined;
      const item = id != null ? byId.get(String(id)) : undefined;
      const savedName = entry.itemNames && entry.itemNames[slot];
      return {
        slot,
        id: id == null ? null : String(id),
        found: !!item,
        name: item ? item.name : (savedName || (id != null ? String(id) : '?')),
        imageUrl: item && item.imageUrl ? item.imageUrl : null,
      };
    });
  }

  return { STORAGE_KEY, MAX_ENTRIES, FORMULA_VERSION, SORT_MODES, load, save, add, remove, isCurrent, bestRatio, entryPercent, entryEfficiency, sorted, makeEntry, slotItems };
  }

  // v1 계산식 버전. 3 = S·R·공격력 계수 직접 입력, 고정 스킬 증폭은 I 항. 4 = '(택1)' 스탯 자동 결정.
  // 다른 버전 기록은 효율 비교(최고치·효율순)에서 제외한다.
  const v1 = build('er-damage-calc-history-v1', 4);
  // v2 계산식(formula_v2.js)은 기록을 따로 저장한다.
  const v2 = build('er-damage-calc-history-formula-v2', 'v2-1');
  v1.forVariant = (variant) => (variant === 'v2' ? v2 : v1);
  v2.forVariant = v1.forVariant;
  return v1;
});
