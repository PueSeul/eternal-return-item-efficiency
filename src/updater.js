// "아이템 수치 업데이트" 버튼 로직(브라우저/Node 테스트 공용).
// 데스크톱(Electron)에서는 preload가 window.erDesktop.updateItems()를 노출한다(성공 시 {count, savedPath}, 실패 시 reject).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERUpdater = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 버튼 표시 조건: window.erDesktop?.updateItems가 함수일 때만(웹 실행에서는 숨김).
  function canUpdate(win) {
    return !!(win && win.erDesktop && typeof win.erDesktop.updateItems === 'function');
  }

  // 갱신된 데이터(byId)로 장착 슬롯을 id로 다시 매칭한다. 없어진 id의 슬롯은 비운다.
  function rematch(equipped, byId) {
    const next = {};
    const removed = [];
    for (const [slot, item] of Object.entries(equipped || {})) {
      if (!item) continue;
      const fresh = byId.get(String(item.id));
      if (fresh && fresh.slot === slot) next[slot] = fresh;
      else removed.push(`${slot}(${item.name})`);
    }
    return { equipped: next, removed };
  }

  // updateItems() 실행 → 성공하면 reload()로 data/items.json을 다시 읽는다.
  // reload는 성공 여부(boolean)를 돌려준다. 결과는 { ok, message }.
  async function runUpdate(desktop, reload) {
    let res;
    try {
      res = await desktop.updateItems();
    } catch (err) {
      return { ok: false, message: '업데이트 실패: ' + ((err && err.message) || String(err)) };
    }
    let reloaded = false;
    try {
      reloaded = await reload();
    } catch { /* 아래에서 실패로 안내 */ }
    if (!reloaded) {
      return { ok: false, message: '업데이트 후 data/items.json을 다시 읽지 못했습니다.' };
    }
    const count = res && Number.isFinite(Number(res.count)) ? Number(res.count) : null;
    return { ok: true, count, message: count == null ? '아이템 갱신 완료' : `아이템 ${count}개 갱신 완료` };
  }

  return { canUpdate, rematch, runUpdate };
});
