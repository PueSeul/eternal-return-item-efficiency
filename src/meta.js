// data/items.meta.json(데이터 출처·패치노트 반영 내역) 표시용 함수(브라우저/Node 테스트 공용).
// 스키마: {fetchedAt, dakggVersion, patch:{id,version,title,url,date},
//          overrides:[{type:'item'|'character', name, stat, dakgg, patchnote}], unparsed:[{name, text}]}
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERMeta = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  // 문자열·숫자·불리언만 글자로 쓴다(객체 등 형식이 틀린 값은 빈 문자열 — 변환 중 예외 방지).
  const str = (v) => (['string', 'number', 'boolean'].includes(typeof v) ? String(v).trim() : '');
  const pad = (n) => String(n).padStart(2, '0');

  // 메타 객체로 쓸 수 있으면 필드를 문자열·배열로 정리해 돌려주고, 아니면 null.
  function normalize(meta) {
    if (!isObj(meta)) return null;
    const p = isObj(meta.patch) ? meta.patch : {};
    return {
      fetchedAt: str(meta.fetchedAt),
      dakggVersion: str(meta.dakggVersion),
      patch: { id: str(p.id), version: str(p.version), title: str(p.title), url: str(p.url), date: str(p.date) },
      // 이름 없는 덮어쓰기, 내용 없는 확인 필요 항목은 표시할 것이 없어 뺀다.
      overrides: Array.isArray(meta.overrides) ? meta.overrides.filter((o) => isObj(o) && str(o.name)) : [],
      unparsed: Array.isArray(meta.unparsed) ? meta.unparsed.filter((u) => isObj(u) && (str(u.name) || str(u.text))) : [],
    };
  }

  // 갱신 시각을 로컬 시간 "YYYY-MM-DD HH:mm"으로. 날짜로 읽을 수 없으면 원문 그대로.
  function formatTime(value) {
    value = str(value);
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 헤더 한 줄: "데이터: dak.gg 12.6.0 · 패치노트 12.6 · 갱신 2026-10-17 02:30". 표시할 값이 없으면 null.
  function headerText(meta) {
    const m = normalize(meta);
    if (!m) return null;
    const parts = [];
    if (m.dakggVersion) parts.push(`dak.gg ${m.dakggVersion}`);
    if (m.patch.version) parts.push(`패치노트 ${m.patch.version}`);
    const t = formatTime(m.fetchedAt);
    if (t) parts.push(`갱신 ${t}`);
    return parts.length ? '데이터: ' + parts.join(' · ') : null;
  }

  const val = (v) => str(v) || '-';

  // 패치노트 반영 내역: "아이템명 — 스탯: dak.gg 값 → 패치노트 값" (실험체는 이름 뒤에 "(실험체)").
  function overrideLines(meta) {
    const m = normalize(meta);
    if (!m) return [];
    return m.overrides.map((o) =>
      `${str(o.name)}${o.type === 'character' ? ' (실험체)' : ''} — ${str(o.stat)}: ${val(o.dakgg)} → ${val(o.patchnote)}`);
  }

  // 확인 필요(파싱하지 못한 패치노트 문구): "이름 — 원문".
  function unparsedLines(meta) {
    const m = normalize(meta);
    if (!m) return [];
    return m.unparsed.map((u) => (str(u.name) ? `${str(u.name)} — ${str(u.text)}` : str(u.text)));
  }

  // 아이템 이름 → 패치노트로 덮어쓴 스탯 목록(type이 'item'인 항목만).
  function patchedItems(meta) {
    const map = new Map();
    const m = normalize(meta);
    if (!m) return map;
    for (const o of m.overrides) {
      if (o.type !== 'item' || !str(o.name)) continue;
      const name = str(o.name);
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(`${str(o.stat)}: ${val(o.dakgg)} → ${val(o.patchnote)}`);
    }
    return map;
  }

  // 패치노트 링크는 http(s) 주소만 허용.
  function safeUrl(url) {
    const s = str(url);
    return /^https?:\/\//i.test(s) ? s : '';
  }

  return { normalize, formatTime, headerText, overrideLines, unparsedLines, patchedItems, safeUrl };
});
