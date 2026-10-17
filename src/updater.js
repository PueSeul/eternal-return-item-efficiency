// "아이템 수치 업데이트" 버튼 로직(브라우저/Node 테스트 공용).
// 데스크톱(Electron)에서는 preload가 window.erDesktop.updateItems()를 노출한다(성공 시 {count, savedPath[, meta][, skills]}, 실패 시 reject).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERUpdater = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const str = (v) => (['string', 'number'].includes(typeof v) ? String(v).trim() : '');

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
  // reload는 성공 여부(boolean)를 돌려준다. reloadMeta(선택)는 메타 파일을 다시 읽어 돌려준다.
  // reloadSkills(선택)는 data/skills.json을 다시 읽어 돌려준다.
  // 결과는 { ok, count, meta, skills, message }.
  async function runUpdate(desktop, reload, reloadMeta, reloadSkills) {
    let res;
    try {
      res = await desktop.updateItems();
    } catch (err) {
      return { ok: false, message: '업데이트 실패: ' + ((err && err.message) || String(err)) };
    }
    // reject 대신 {ok:false, error|message}로 실패를 돌려주는 경우도 그 메시지를 그대로 보인다.
    if (res && res.ok === false) {
      const msg = str(res.error) || str(res.message) || '알 수 없는 오류';
      return { ok: false, message: '업데이트 실패: ' + msg };
    }
    let reloaded = false;
    try {
      reloaded = await reload();
    } catch { /* 아래에서 실패로 안내 */ }
    if (!reloaded) {
      return { ok: false, message: '업데이트 후 data/items.json을 다시 읽지 못했습니다.' };
    }
    const count = res && Number.isFinite(Number(res.count)) ? Number(res.count) : null;
    // 반환에 meta(items.meta.json 내용) 객체가 있으면 그것을, 없으면 reloadMeta()로 파일을 다시 읽는다(실패 시 null).
    let meta = res && res.meta != null && typeof res.meta === 'object' && !Array.isArray(res.meta) ? res.meta : null;
    if (!meta && reloadMeta) {
      try {
        meta = (await reloadMeta()) || null;
      } catch {
        meta = null;
      }
    }
    // skills: 반환에 skills 배열(skills.json 내용)이 있으면 그것을, 없으면 reloadSkills()로 다시 읽는다(실패·없음은 null).
    let skills = res && Array.isArray(res.skills) ? res.skills : null;
    if (!skills && reloadSkills) {
      try {
        const list = await reloadSkills();
        skills = Array.isArray(list) ? list : null;
      } catch {
        skills = null;
      }
    }
    return { ok: true, count, meta, skills, message: count == null ? '아이템 갱신 완료' : `아이템 ${count}개 갱신 완료` };
  }

  // 진행 이벤트 {stage, done, total, message} → 상태 문구.
  // 단계 이름: 'items'·'patchnotes'·'skills'(데스크톱 쪽 이름 미확정 — 모르는 단계는 message, 없으면 stage 그대로).
  // total이 양수면 " done/total", 아니면 "…".
  const STAGE_TEXT = { items: '아이템 수집 중', patchnotes: '패치노트 확인 중', skills: '스킬 수집 중' };
  function progressText(ev) {
    if (!ev || typeof ev !== 'object') return '';
    const stage = str(ev.stage);
    const label = STAGE_TEXT[stage] || str(ev.message) || stage;
    if (!label) return '';
    const done = Number(ev.done);
    const total = Number(ev.total);
    return ev.total != null && Number.isFinite(total) && total > 0 && ev.done != null && Number.isFinite(done)
      ? `${label} ${done}/${total}` : `${label}…`;
  }

  // 진행 이벤트 구독 가능 여부(웹 미리보기에서는 false → 기존 문구 유지).
  function canProgress(win) {
    return !!(win && win.erDesktop && typeof win.erDesktop.onUpdateProgress === 'function');
  }

  return { canUpdate, rematch, runUpdate, progressText, canProgress };
});
