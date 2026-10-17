// 원형 진행 게이지(SVG 링 22px + 퍼센트 + 작은 문구). 데이터 업데이트와 프로그램 업데이트 배너가 같이 쓴다.
// 문구는 괄호 없이 구분점(" · ")으로만 나열한다: "42%  스킬 수집 중 12/28 · 약 20초 남음".
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERGauge = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 22;
  const R = 9;
  const CIRC = 2 * Math.PI * R;
  const HIDE_AFTER_MS = 1000;

  // 퍼센트(0~100, 정수). 알 수 없으면 null.
  function clampPct(p) {
    if (p == null || p === '') return null;
    const n = Number(p);
    return Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : null;
  }
  // 링 stroke-dashoffset: 0% = 원 둘레 전체(빈 링), 100% = 0(가득 찬 링).
  function dashOffset(p) {
    const pct = clampPct(p);
    return CIRC * (1 - (pct == null ? 0 : pct) / 100);
  }
  // 퍼센트 옆 작은 문구: 빈 조각은 빼고 구분점으로 잇는다(괄호 없음).
  function detailText(parts) {
    return (parts || []).map((s) => (s == null ? '' : String(s).trim())).filter(Boolean).join(' · ');
  }

  function create(doc, id, label) {
    const NS = 'http://www.w3.org/2000/svg';
    const wrap = doc.createElement('span');
    wrap.className = 'gauge';
    if (id) wrap.id = id;
    wrap.hidden = true;
    wrap.setAttribute('role', 'progressbar');
    if (label) wrap.setAttribute('aria-label', label);
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'gauge-ring');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('width', String(SIZE));
    svg.setAttribute('height', String(SIZE));
    svg.setAttribute('aria-hidden', 'true');
    const circle = (cls) => {
      const c = doc.createElementNS(NS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', String(SIZE / 2));
      c.setAttribute('cy', String(SIZE / 2));
      c.setAttribute('r', String(R));
      return c;
    };
    const bar = circle('gauge-bar');
    bar.setAttribute('transform', `rotate(-90 ${SIZE / 2} ${SIZE / 2})`);
    bar.setAttribute('stroke-dasharray', CIRC.toFixed(3));
    bar.setAttribute('stroke-dashoffset', CIRC.toFixed(3));
    svg.append(circle('gauge-track'), bar);
    const pctEl = doc.createElement('span');
    pctEl.className = 'gauge-pct';
    const textEl = doc.createElement('span');
    textEl.className = 'gauge-text';
    wrap.append(svg, pctEl, textEl);

    let hideTimer = null;
    function set(pct, text) {
      clearTimeout(hideTimer);
      const p = clampPct(pct);
      wrap.hidden = false;
      wrap.classList.remove('error');
      bar.setAttribute('stroke-dashoffset', dashOffset(p).toFixed(3));
      pctEl.textContent = p == null ? '' : `${p}%`;
      if (p == null) wrap.removeAttribute('aria-valuenow');
      else wrap.setAttribute('aria-valuenow', String(p));
      textEl.textContent = text || '';
      // 보조기술용 값 문구: "42% · 스킬 수집 중 12/28 · 약 20초 남음"
      wrap.setAttribute('aria-valuetext', detailText([pctEl.textContent, text]));
    }
    // 완료: 100%로 채우고 1초 뒤 숨김.
    function done(text) {
      set(100, text);
      hideTimer = setTimeout(() => { wrap.hidden = true; }, HIDE_AFTER_MS);
    }
    // 실패: 링을 경고색으로(숨기지 않음, 다음 set에서 해제).
    function fail(text) {
      clearTimeout(hideTimer);
      wrap.hidden = false;
      wrap.classList.add('error');
      if (text != null) textEl.textContent = text;
    }
    function hide() {
      clearTimeout(hideTimer);
      wrap.hidden = true;
    }
    return { el: wrap, set, done, fail, hide };
  }

  return { create, clampPct, dashOffset, detailText, CIRC, HIDE_AFTER_MS };
});
