// v2 스킬 선택 → 스킬 기본 피해량·계수 자동 입력(브라우저/Node 테스트 공용). 데이터: data/skills.json
//   [{characterId, name, skills:[{key:'Q'|'W'|'E'|'R'|'P'|'RQ'…, name,
//      levels:[{level, baseDamage, attackPowerRatio, skillAmpRatio}], raw, sourceLabel}],
//     wikiRevisedAt, needsReview:[{skill, text, reason}]}]   (비율은 0~1 소수)
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

  // 레벨 숫자가 있는 레벨 항목만, 레벨 오름차순.
  function levelsOf(skill) {
    if (!skill || !Array.isArray(skill.levels)) return [];
    return skill.levels.filter((l) => isObj(l) && finite(l.level) != null).sort((a, b) => a.level - b.level);
  }

  // 선택 목록 표시: "Q 샤마쉬의 두루마리", 레벨 수치가 없으면 " (수동 입력)".
  function optionLabel(skill) {
    const label = [str(skill.key), str(skill.name)].filter(Boolean).join(' ');
    return levelsOf(skill).length ? label : `${label} (수동 입력)`;
  }

  // 입력란 값: {skillDamage, atkCoefPct, skillAmpCoefPct}(계수는 % 단위). 숫자가 아닌 항목은 null(입력란 그대로).
  // 그 레벨이 없으면 null.
  function autoValues(skill, level) {
    const l = levelsOf(skill).find((x) => x.level === Number(level));
    if (!l) return null;
    return { skillDamage: finite(l.baseDamage), atkCoefPct: toPct(l.attackPowerRatio), skillAmpCoefPct: toPct(l.skillAmpRatio) };
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

  return { normalize, forCharacter, findSkill, levelsOf, optionLabel, autoValues, sourceText, patchNotes };
});
