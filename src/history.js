// 계산 히스토리: localStorage에 JSON 배열로 영구 저장(브라우저/Node 테스트 공용).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERHistory = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'er-damage-calc-history-v1';
  const MAX_ENTRIES = 500;
  // 계산식 버전. 3 = S·R·공격력 계수 직접 입력, 고정 스킬 증폭은 I 항. 다른 버전 기록은 효율 비교(최고치·효율순)에서 제외한다.
  const FORMULA_VERSION = 3;

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

  // 보기 정렬: 'recent' = 시각 내림차순, 'efficiency' = D÷가격 내림차순(비율 없음은 뒤, 같으면 최근 먼저).
  const SORT_MODES = ['recent', 'efficiency'];

  function sorted(list, mode) {
    const time = (e) => {
      const t = Date.parse(e.time);
      return Number.isFinite(t) ? t : -Infinity;
    };
    const ratio = (e) => {
      const r = comparableRatio(e);
      return r == null ? -Infinity : r;
    };
    const byTime = (a, b) => time(b) - time(a);
    const cmp = mode === 'efficiency' ? (a, b) => (ratio(b) - ratio(a)) || byTime(a, b) : byTime;
    return [...list].sort((a, b) => cmp(a, b) || 0);
  }

  function makeEntry({ equipped, inputs, result, now = new Date() }) {
    const itemIds = {};
    const itemNames = {};
    for (const [slot, item] of Object.entries(equipped)) {
      itemIds[slot] = item.id;
      itemNames[slot] = item.name;
    }
    return {
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      time: now.toISOString(),
      formulaVersion: FORMULA_VERSION,
      itemIds,
      itemNames,
      inputs: { ...inputs },
      result: { D: result.D, price: result.price, ratio: result.ratio, S: result.S, R: result.R, B: result.B, A: result.A, I: result.I, F: result.F },
    };
  }

  return { STORAGE_KEY, MAX_ENTRIES, FORMULA_VERSION, SORT_MODES, load, save, add, remove, isCurrent, bestRatio, sorted, makeEntry };
});
