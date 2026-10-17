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
  // options(선택)는 updateItems에 그대로 넘긴다(예: {skillsMode: 'patched' | 'all'}).
  // 결과는 { ok, count, meta, skills, message }.
  async function runUpdate(desktop, reload, reloadMeta, reloadSkills, options) {
    let res;
    try {
      res = await (options ? desktop.updateItems(options) : desktop.updateItems());
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
    // note: 데스크톱이 알리는 부가 사실(GitHub 데이터 대신 직접 수집, 이미 최신 등).
    const done = count == null ? '아이템 갱신 완료' : `아이템 ${count}개 갱신 완료`;
    const note = res ? str(res.note) : '';
    // short: 머리글 상태 칸용 짧은 문구(전체 문장 message는 툴팁).
    const short = count == null ? '아이템 갱신됨' : `아이템 ${count}개 갱신됨`;
    return { ok: true, count, meta, skills, message: note ? `${done} — ${note}` : done, short };
  }

  // 진행 이벤트 {stage, done, total, message} → 상태 문구.
  // 단계 이름: 'manifest'·'download'(GitHub 데이터), 'items'·'characters'·'patchnotes'·'skills'(직접 수집),
  // 'fallback'(GitHub 실패 → 직접 수집, message 그대로). 모르는 단계는 message, 없으면 stage 그대로.
  // total이 양수면 " done/total", 아니면 "…".
  const STAGE_TEXT = {
    manifest: 'GitHub 데이터 확인 중', download: 'GitHub 데이터 내려받는 중',
    items: '아이템 수집 중', characters: '실험체 수집 중', patchnotes: '패치노트 확인 중', skills: '스킬 수집 중',
  };
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

  // ---------- 예상 남은 시간 ----------
  // 작업량 가중치: items·characters·patchnotes 각 1, skills는 total건. 처음 보는 단계는 1.
  // 다른 단계 이벤트가 오면 이전 단계는 완료로 본다. 남은 시간 = 경과 ÷ 완료 비율 − 경과.
  // skills 이벤트 전에는 전체 작업량을 모르므로 초기 예상치(지난 실행 소요 시간, 없으면 2분)의 남은 몫과 큰 쪽을 쓴다.
  const DEFAULT_ETA_MS = 120000;
  const FIXED_STAGES = ['items', 'characters', 'patchnotes'];
  function createEta(startMs, initialMs) {
    const initial = Number.isFinite(initialMs) && initialMs > 0 ? initialMs : DEFAULT_ETA_MS;
    const stages = new Map(); // stage → {weight, done(0..weight)}
    let current = null;
    let seen = false;
    function update(ev) {
      if (!ev || typeof ev !== 'object' || !str(ev.stage)) return;
      seen = true;
      const stage = str(ev.stage);
      if (current && current !== stage && stages.has(current)) {
        const prev = stages.get(current);
        prev.done = prev.weight;
      }
      current = stage;
      const total = Number(ev.total);
      const done = Number(ev.done);
      const hasTotal = ev.total != null && Number.isFinite(total) && total > 0;
      const weight = stage === 'skills' && hasTotal ? total : 1;
      const frac = hasTotal && ev.done != null && Number.isFinite(done) ? Math.min(1, Math.max(0, done / total)) : 0;
      stages.set(stage, { weight, done: frac * weight });
    }
    function remainingMs(nowMs) {
      const elapsed = Math.max(0, nowMs - startMs);
      const byInitial = Math.max(0, initial - elapsed);
      // 경과 1초 미만이면 비율 추정이 0에 가까워 "곧 완료"로 잘못 나오므로 초기 예상치를 쓴다.
      if (!seen || elapsed < 1000) return byInitial;
      let all = 0;
      let done = 0;
      for (const s of FIXED_STAGES) if (!stages.has(s)) all += 1;
      for (const s of stages.values()) { all += s.weight; done += s.done; }
      const ratio = all > 0 ? done / all : 0;
      const byRatio = ratio > 0 ? elapsed / ratio - elapsed : byInitial;
      return stages.has('skills') ? Math.max(0, byRatio) : Math.max(byRatio, byInitial);
    }
    // 진행률 0~1(원형 게이지) = 경과 ÷ (경과 + 남은 시간). 남은 시간과 같은 추정을 써서 문구와 어긋나지 않게 하고,
    // skills 전(작업량 미상)에는 초기 예상치 기준으로 움직인다. 단계가 병렬로 끝나거나 skills로 작업량이 늘어
    // 추정이 줄 수 있으므로 지금까지의 최댓값을 돌려준다(게이지가 뒤로 가지 않게). 100%는 완료 처리에서 채운다.
    let maxFraction = 0;
    function fraction(nowMs) {
      const elapsed = Math.max(0, nowMs - startMs);
      const left = remainingMs(nowMs);
      const f = elapsed + left > 0 ? elapsed / (elapsed + left) : 0;
      maxFraction = Math.max(maxFraction, Math.min(0.99, f));
      return maxFraction;
    }
    return { update, remainingMs, fraction, started: () => seen };
  }

  // 밀리초 → "1분 20초" / "45초" / "2분"(초 올림).
  function durationText(ms) {
    const sec = Math.max(0, Math.ceil(Math.round(ms) / 1000)); // 부동소수 오차(205000.00000003)로 1초 올라가지 않게
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m ? (s ? `${m}분 ${s}초` : `${m}분`) : `${s}초`;
  }
  function etaText(eta, nowMs) {
    const ms = eta.remainingMs(nowMs);
    if (!eta.started()) return `약 ${durationText(ms)} 예상`;
    return ms < 1000 ? '곧 완료' : `약 ${durationText(ms)} 남음`;
  }

  return { canUpdate, rematch, runUpdate, progressText, canProgress, createEta, durationText, etaText, DEFAULT_ETA_MS };
});
