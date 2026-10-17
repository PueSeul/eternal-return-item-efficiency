// v2 스킬 선택 → 스킬 기본 피해량·계수 자동 입력(브라우저/Node 테스트 공용). 데이터: data/skills.json
//   [{characterId, name, skills:[{key:'Q'|'W'|'E'|'R'|'P'|'RQ'…, name,
//      entries:[{label, levels:[{level, baseDamage, attackPowerRatio, skillAmpRatio, extraRatios?}], raw, historyMismatch?}],
//      levels(= entries[0].levels, 이전 스키마), raw, sourceLabel}],
//     wikiRevisedAt, needsReview:[{skill, text, reason}]}]   (비율은 0~1 소수)
// entries가 없는 이전 스키마는 {label: sourceLabel, levels, raw} 한 항목으로 본다.
// extraRatios(계산에 넣지 않는 계수, 표시만): [{stat|label|name, ratio}] · {이름: ratio} · ["문구"] 모두 받는다. ratio가 없으면 라벨만.
// historyMismatch: 문자열 또는 {text}(실제 data/skills.json).
// 패치노트로 덮어쓴 스킬 값: items.meta.json overrides 중
//   {type:'skill', name: 실험체 이름, characterId(선택), skill: 스킬 키 또는 스킬 이름, stat, dakgg, patchnote}.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERSkills = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v) => (['string', 'number'].includes(typeof v) ? String(v).trim() : '');
  // 부동소수 오차 정리(0.07 × 100 = 7.000000000000001 → 7).
  const toPct = (ratio) => (finite(ratio) == null ? null : Number((ratio * 100).toFixed(10)));

  // 배열이 아니면 빈 목록. 스킬 목록이 없는 실험체 항목은 뺀다.
  function normalize(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((c) => isObj(c) && Array.isArray(c.skills))
      .map((c) => ({ ...c, skills: c.skills.filter((s) => isObj(s) && str(s.key)) }));
  }

  // 실험체 항목: id가 있으면 id로, 없으면 이름으로 찾는다.
  function forCharacter(list, id, name) {
    if (id != null && id !== '') {
      const byId = list.find((c) => String(c.characterId) === String(id));
      if (byId) return byId;
    }
    return name ? list.find((c) => c.name === name) || null : null;
  }

  function findSkill(entry, key) {
    return entry && key ? entry.skills.find((s) => str(s.key) === String(key)) || null : null;
  }

  // 레벨 숫자가 있는 레벨 항목만, 레벨 오름차순. 피해 항목(entry)이나 이전 스키마의 스킬 모두 받는다.
  function levelsOf(skill) {
    if (!skill || !Array.isArray(skill.levels)) return [];
    return skill.levels.filter((l) => isObj(l) && finite(l.level) != null).sort((a, b) => a.level - b.level);
  }

  // 스킬의 피해 항목 목록. entries가 비었거나 없으면 이전 스키마 한 항목.
  function entriesOf(skill) {
    if (!skill) return [];
    const list = Array.isArray(skill.entries) ? skill.entries.filter(isObj) : [];
    return list.length ? list : [{ label: skill.sourceLabel, levels: skill.levels, raw: skill.raw }];
  }

  // 선택 목록 값 "키#항목번호"(키에는 '#'가 없다).
  const choiceValue = (skill, index) => `${str(skill.key)}#${index}`;

  // 실험체의 선택지: 스킬 × 피해 항목. [{value, skill, entry, index}]
  function choices(character) {
    if (!character) return [];
    return character.skills.flatMap((skill) => entriesOf(skill).map((entry, index) => ({ value: choiceValue(skill, index), skill, entry, index })));
  }

  function findChoice(character, value) {
    return value ? choices(character).find((c) => c.value === String(value)) || null : null;
  }

  // 기록의 {key, index, label}로 선택지를 찾는다: 라벨이 있으면 같은 키·라벨, 없으면 같은 키·번호(번호 없으면 0).
  function matchChoice(character, keep) {
    if (!keep || !keep.key) return null;
    const list = choices(character).filter((c) => str(c.skill.key) === String(keep.key));
    const label = str(keep.label);
    if (label) return list.find((c) => str(c.entry.label) === label) || null;
    const index = Number.isInteger(keep.index) ? keep.index : 0;
    return list.find((c) => c.index === index) || null;
  }

  // 선택 목록 표시: "Q 샤마쉬의 두루마리 — 피해량", 레벨 수치가 없으면 " (수동 입력)".
  // entry를 안 주면 첫 항목(이전 스키마 호환).
  function optionLabel(skill, entry) {
    const e = entry || entriesOf(skill)[0];
    const label = [str(skill.key), str(skill.name)].filter(Boolean).join(' ') + (e && str(e.label) ? ` — ${str(e.label)}` : '');
    return levelsOf(e).length ? label : `${label} (수동 입력)`;
  }

  // 입력란 값: {skillDamage, atkCoefPct, skillAmpCoefPct}(계수는 % 단위). 숫자가 아닌 항목은 null(입력란 그대로).
  // 그 레벨이 없으면 null.
  function autoValues(skill, level) {
    const l = levelsOf(skill).find((x) => x.level === Number(level));
    if (!l) return null;
    return { skillDamage: finite(l.baseDamage), atkCoefPct: toPct(l.attackPowerRatio), skillAmpCoefPct: toPct(l.skillAmpRatio) };
  }

  // 그 레벨의 미반영 계수 문구 목록(예: "최대 체력의 3%"). 계산에는 넣지 않는다.
  function extraRatioTexts(entry, level) {
    const l = levelsOf(entry).find((x) => x.level === Number(level));
    const ex = l ? l.extraRatios : null;
    // 비율 숫자가 없는 서술형 계수(예: {stat:"야성 중첩", ratio:null})는 라벨 그대로.
    const one = (name, ratio) => {
      const pct = toPct(ratio);
      if (!str(name)) return '';
      return pct != null ? `${str(name)}의 ${pct}%` : str(name);
    };
    let list = [];
    if (Array.isArray(ex)) list = ex.map((x) => (isObj(x) ? one(x.stat || x.label || x.name, x.ratio) : str(x)));
    else if (isObj(ex)) list = Object.entries(ex).map(([k, v]) => one(k, v));
    return list.filter(Boolean);
  }

  // historyMismatch 원문: 문자열 또는 {text} 객체. 없으면 ''(값은 있는데 원문이 없으면 기본 문구).
  function mismatchText(entry) {
    const m = entry ? entry.historyMismatch : null;
    if (!m) return '';
    const text = isObj(m) ? str(m.text) : str(m);
    return text || '나무위키 역사란 수치와 다릅니다';
  }

  // 출처 표시: "나무위키 · 수정 2026-10-16". 날짜는 원문 앞의 YYYY-MM-DD(문서에 적힌 날짜, 시간대 변환 없음),
  // 그 형식이 아니면 원문, 없으면 "나무위키".
  function sourceText(entry) {
    const raw = entry ? str(entry.wikiRevisedAt) : '';
    if (!raw) return '나무위키';
    const m = /^\d{4}-\d{2}-\d{2}/.exec(raw);
    return `나무위키 · 수정 ${m ? m[0] : raw}`;
  }

  // 이 스킬을 패치노트로 덮어쓴 내역("스탯: 이전 → 패치노트"). meta는 items.meta.json 내용(정규화 전후 모두 가능).
  function patchNotes(meta, character, skill) {
    if (!isObj(meta) || !Array.isArray(meta.overrides) || !character || !skill) return [];
    const val = (v) => str(v) || '-';
    return meta.overrides.filter((o) => isObj(o) && o.type === 'skill' &&
      ((o.characterId != null && character.id != null && String(o.characterId) === String(character.id)) ||
        (str(o.name) && str(o.name) === character.name)) &&
      (str(o.skill) === str(skill.key) || (str(skill.name) && str(o.skill) === str(skill.name))))
      .map((o) => `${str(o.stat)}: ${val(o.dakgg)} → ${val(o.patchnote)}`);
  }

  return { normalize, forCharacter, findSkill, levelsOf, entriesOf, choices, findChoice, matchChoice, optionLabel, autoValues,
    extraRatioTexts, mismatchText, sourceText, patchNotes };
});
