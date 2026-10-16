// v2 실험체·숙련도 자동 입력값(브라우저/Node 테스트 공용). 데이터: data/characters.json
//   [{id, name, imageUrl, attackPower, attackPowerPerLevel, masteries: {"아르카나": {skillAmpRatio, attackPowerRatio, attackSpeedRatio}}}]
//   masteries 키는 items.json 무기의 weaponType과 같은 한글 표기, 값은 숙련 1레벨당 비율.
// 아이템 외 공격력 = attackPower + attackPowerPerLevel × (캐릭터 레벨 − 1)
// 아이템 외 % 스킬 증폭 = skillAmpRatio × 숙련도 레벨 (아이템 %와 합산, 입력란은 % 단위)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERCharacters = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  // character: 실험체(없으면 null), weaponType: 무기 슬롯 아이템의 weaponType(없으면 null).
  // 돌려주는 값: extraAtk(없으면 null), extraSkillAmpPct(없으면 null), 설명 문구, 경고.
  function autoValues(character, weaponType, level, masteryLevel) {
    const out = { extraAtk: null, extraSkillAmpPct: null, atkSource: '', ampSource: '', warning: '' };
    if (!character) return out;
    const base = num(character.attackPower);
    const growth = num(character.attackPowerPerLevel);
    out.extraAtk = base + growth * (level - 1);
    out.atkSource = `${character.name} 기본 공격력 ${base} + 성장 ${growth}×(${level}−1)`;
    if (!weaponType) {
      out.warning = '무기를 장착하면 숙련도 % 스킬 증폭이 자동 반영됩니다.';
      return out;
    }
    const m = character.masteries && character.masteries[weaponType];
    if (!m) {
      out.extraSkillAmpPct = 0;
      out.ampSource = `${weaponType} 숙련도 없음`;
      out.warning = `${character.name}은(는) ${weaponType} 숙련도가 없습니다.`;
      return out;
    }
    const ratio = num(m.skillAmpRatio);
    // 부동소수 오차 정리(0.047×20×100 = 94.00000000000001 → 94)
    out.extraSkillAmpPct = Number((ratio * masteryLevel * 100).toFixed(10));
    out.ampSource = `${weaponType} 숙련 ${ratio * 100}%×${masteryLevel}`;
    return out;
  }

  return { autoValues };
});
