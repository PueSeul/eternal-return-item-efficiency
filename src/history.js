// 계산 히스토리: localStorage에 JSON 배열로 영구 저장(브라우저/Node 테스트 공용).
(function (root, factory) {
  // 기준 세트 모듈은 이 파일 뒤에 로드되므로 쓸 때 찾는다.
  const api = factory(() => root.ERBaseline || require('./baseline'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERHistory = api;
})(typeof self !== 'undefined' ? self : this, function (getBaseline) {
  'use strict';

  const MAX_ENTRIES = 500;

  // 계산식 변형(variant)마다 저장 키와 계산식 버전이 다른 같은 API를 만든다.
  function build(STORAGE_KEY, FORMULA_VERSION) {

  function isCurrent(e) {
    return e.formulaVersion === FORMULA_VERSION;
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

  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const NONE = Object.freeze({ pct: null, gainPct: null, per1000: null });

  // 기록의 효율 지표 { pct, gainPct, per1000 }(기준 세트 대비, 없으면 null). 이전 계산식 기록은 모두 null.
  //  - 현재 형식(efficiencyGainPct 저장): 저장값 그대로.
  //  - 예전 기준 세트 대비 효율 % 기록: 효율 %만(기준 가격이 저장되지 않아 기준 대비 증가율은 되살릴 수 없음).
  //  - 예전 'perPrice' 기록(기준 가격 0, v = (D − 기준 D) ÷ 가격): 기준 D = D − v × 가격으로 재계산.
  //  - 히스토리 최고 대비였던 기록·효율 미저장 기록: 기준 세트가 없었으므로 모두 null.
  function entryEfficiency(e) {
    if (!e || !isCurrent(e)) return NONE;
    if (Object.prototype.hasOwnProperty.call(e, 'efficiencyGainPct')) {
      return { pct: finite(e.efficiencyPct), gainPct: finite(e.efficiencyGainPct), per1000: finite(e.efficiencyPer1000) };
    }
    if (e.efficiencyKind === 'perPrice') {
      const v = finite(e.efficiencyPerPrice);
      const D = e.result ? finite(e.result.D) : null;
      const price = e.result ? finite(e.result.price) : null;
      if (v == null || D == null || !(price > 0)) return NONE;
      return { pct: null, ...getBaseline().gainMetrics(D, D - v * price, price) };
    }
    if (e.efficiencyMode === 'baseline') return { pct: finite(e.efficiencyPct), gainPct: null, per1000: null };
    return NONE;
  }

  // 보기 정렬: 'recent' = 시각 내림차순, 'efficiency' = 묶음별 값 내림차순
  // (효율 % 기록 → 효율 % 없이 1,000당 %만 있는 기록(기준 가격 0) → 값 없음 순, 같으면 최근 먼저).
  const SORT_MODES = ['recent', 'efficiency'];

  function sorted(list, mode) {
    const time = (e) => {
      const t = Date.parse(e.time);
      return Number.isFinite(t) ? t : -Infinity;
    };
    const eff = new Map(list.map((e) => [e, entryEfficiency(e)]));
    const rank = (e) => {
      const x = eff.get(e);
      return x.pct != null ? 0 : x.per1000 != null ? 1 : 2;
    };
    const value = (e) => {
      const x = eff.get(e);
      return x.pct ?? x.per1000 ?? 0;
    };
    const byTime = (a, b) => time(b) - time(a);
    const cmp = mode === 'efficiency' ? (a, b) => (rank(a) - rank(b)) || (value(b) - value(a)) || byTime(a, b) : byTime;
    return [...list].sort((a, b) => cmp(a, b) || 0);
  }

  // baseline: 계산 때의 기준 세트 { ids, names }(채워진 슬롯만, 없으면 생략),
  // efficiency: Baseline.efficiency 결과 { mode: 'baseline' | 'none', pct, gainPct, per1000 } —
  // efficiencyMode·efficiencyPct·efficiencyGainPct·efficiencyPer1000으로 저장해 표시·정렬에 쓴다.
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
      entry.efficiencyMode = efficiency.mode;
      entry.efficiencyPct = finite(efficiency.pct);
      entry.efficiencyGainPct = finite(efficiency.gainPct);
      entry.efficiencyPer1000 = finite(efficiency.per1000);
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

  return { STORAGE_KEY, MAX_ENTRIES, FORMULA_VERSION, SORT_MODES, load, save, add, remove, isCurrent, entryEfficiency, sorted, makeEntry, slotItems };
  }

  // v1 계산식 버전. 3 = S·R·공격력 계수 직접 입력, 고정 스킬 증폭은 I 항. 4 = '(택1)' 스탯 자동 결정.
  // 5 = 적용 방어력 R' 하한 0 + 추가 방어 관통 입력. 다른 버전 기록은 효율 비교(최고치·효율순)에서 제외한다.
  const v1 = build('er-damage-calc-history-v1', 5);
  // v2 계산식(formula_v2.js)은 기록을 따로 저장한다. v2-2 = R' 하한 0 + 추가 방어 관통 입력.
  const v2 = build('er-damage-calc-history-formula-v2', 'v2-2');
  v1.forVariant = (variant) => (variant === 'v2' ? v2 : v1);
  v2.forVariant = v1.forVariant;
  return v1;
});
