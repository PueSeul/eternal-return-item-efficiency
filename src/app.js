(function () {
  'use strict';
  // 계산식 변형: 기본은 v2. 데스크톱 v1 빌드는 preload가 window.ER_FORMULA = 'v1'을 주입, 웹은 ?formula=v1.
  const VARIANT = (window.ER_FORMULA || new URLSearchParams(location.search).get('formula') || 'v2') === 'v1' ? 'v1' : 'v2';
  const V2 = VARIANT === 'v2';
  const Formula = V2 ? window.ERFormulaV2 : window.ERFormula;
  const History = window.ERHistory.forVariant(VARIANT);
  const explainLines = V2 ? window.ERExplain.linesV2 : window.ERExplain.lines;
  const Updater = window.ERUpdater;
  const Meta = window.ERMeta;
  const Baseline = window.ERBaseline;
  const Skills = window.ERSkills;
  const Gauge = window.ERGauge;
  const SKILL_FIELDS = ['skillDamage', 'atkCoefPct', 'skillAmpCoefPct'];
  const DATA_URL = 'data/items.json';
  const META_URL = 'data/items.meta.json';
  const GRADES = ['일반', '고급', '희귀', '영웅', '전설', '신화'];
  const INPUT_FIELDS_V2 = [
    { key: 'level', label: '캐릭터 레벨', step: 1, min: 1 },
    { key: 'masteryLevel', label: '숙련도 레벨', step: 1, min: 0 },
    { key: 'skillDamage', label: '스킬 기본 피해량', step: 'any', min: 0 },
    { key: 'atkCoefPct', label: '공격력 계수 (%)', step: 'any', min: 0 },
    { key: 'skillAmpCoefPct', label: '스킬 증폭 계수 (%)', step: 'any', min: 0 },
    { key: 'defense', label: '피격 대상 방어력 (R)', step: 'any', min: 0 },
    { key: 'extraPen', label: '방어 관통(고정)', step: 'any' },
    { key: 'extraPenPct', label: '방어 관통율(%)', step: 'any' },
    { key: 'extraAtk', label: '아이템 외 공격력', step: 'any' },
    { key: 'extraSkillAmp', label: '아이템 외 스킬 증폭', step: 'any' },
    { key: 'extraSkillAmpPct', label: '아이템 외 % 스킬 증폭 (%)', short: '아이템 외 %스증', step: 'any' },
    { key: 'extraDamageIncreasePct', label: '추가 피해 증가 (%)', step: 'any' },
    { key: 'enemyDamageReductionPct', label: '대상 피해 감소 (%)', step: 'any' },
    { key: 'enemySkillReductionPct', label: '대상 스킬 피해 감소 (%)', short: '대상 스킬피해 감소 %', step: 'any' },
  ];
  const INPUT_FIELDS = V2 ? INPUT_FIELDS_V2 : [
    { key: 'level', label: '성장형 스탯', step: 1, min: 1 },
    { key: 'skillDamage', label: '스킬 기본 피해량 (S)', step: 'any', min: 0 },
    { key: 'atkCoefPct', label: '공격력 계수 (%)', step: 'any', min: 0 },
    { key: 'defense', label: '피격 대상 방어력 (R)', step: 'any', min: 0 },
    { key: 'extraPen', label: '방어 관통(고정)', step: 'any' },
    { key: 'extraPenPct', label: '방어 관통율(%)', step: 'any' },
    { key: 'enemySkillReductionPct', label: '적의 스킬 피해 감소율 (%)', step: 'any' },
    { key: 'enemySkillReduction', label: '적의 스킬 피해 감소 (고정)', step: 'any' },
    { key: 'extraFinalIncreasePct', label: '추가 최종 피해 증가율 (%)', step: 'any' },
    { key: 'enemyFinalReductionPct', label: '적의 최종 피해 감소율 (%)', step: 'any' },
  ];

  // 방어 관통 입력란 키 → 자동값(Formula.itemPen 결과) 키.
  const PEN_NOTES = { extraPen: { note: 'auto-pen', auto: 'pen', label: '방어 관통 합' }, extraPenPct: { note: 'auto-penPct', auto: 'penPct', label: '방어 관통율 합(%)' } };

  const $ = (sel) => document.querySelector(sel);
  const state = { items: [], byId: new Map(), equipped: {}, history: [], historySort: 'recent', pickerSlot: null, pickerTarget: 'equipped', baseline: {}, characters: [], charactersError: '', meta: null, patched: new Map(), skills: [], skillsError: '', skillCharName: '' };

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  const fmt = (n, d = 2) => (n == null || !Number.isFinite(n) ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d }));

  function itemImage(item) {
    // 장식용: 이름은 항상 옆에 글자로 있으므로 대체 텍스트를 비워 중복 낭독을 막는다.
    const img = el('img', { src: item.imageUrl || '', alt: '', loading: 'lazy' });
    img.onerror = () => { img.style.visibility = 'hidden'; };
    return img;
  }

  // 등급 색 점(이름 옆). 등급은 보조기기용 이름으로도 붙인다.
  function gradeDot(grade) {
    const dot = el('span', { className: 'dot', title: grade || '' });
    dot.dataset.grade = grade || '';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', (grade || '등급 없음') + ' 등급');
    return dot;
  }

  // 단색 × 아이콘 버튼(비우기·삭제).
  function closeButton(label) {
    const b = el('button', { type: 'button', className: 'icon-btn', title: label });
    b.setAttribute('aria-label', label);
    b.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    return b;
  }

  // 자동 입력값의 부동소수 꼬리(124.39999999999999)를 입력란에 그대로 보이지 않게 정리.
  const tidy = (x) => Number(Number(x).toFixed(9));

  function statsText(item) {
    return Object.entries(item.stats || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '스탯 없음';
  }

  function showBanner(text) {
    const b = $('#data-banner');
    b.textContent = text;
    b.hidden = false;
  }

  // ---------- 데이터 ----------
  // data/items.json을 읽어 state.items를 채운다. 읽기에 성공하면 true.
  async function loadData() {
    $('#data-banner').hidden = true;
    let res;
    try {
      res = await fetch(DATA_URL, { cache: 'no-store' });
    } catch {
      showBanner('데이터 파일을 읽지 못했습니다. index.html을 직접 열지 말고 `npm start`로 실행하세요.\n' +
        '데이터 파일이 없다면 `scripts/fetch_items.py` 실행이 필요합니다.');
      return;
    }
    if (!res.ok) {
      showBanner('데이터 파일 없음, `scripts/fetch_items.py` 실행 필요 (data/items.json)');
      return;
    }
    let list;
    try {
      list = await res.json();
    } catch {
      showBanner('data/items.json 형식이 올바르지 않습니다. `scripts/fetch_items.py`를 다시 실행하세요.');
      return;
    }
    if (!Array.isArray(list)) {
      showBanner('data/items.json 형식이 올바르지 않습니다(배열이 아님). `scripts/fetch_items.py`를 다시 실행하세요.');
      return;
    }
    const items = list.filter((it) => it && Formula.SLOTS.includes(it.slot));
    const byId = new Map(items.map((it) => [String(it.id), it]));
    state.items = items; // 둘 다 만든 뒤 함께 교체(중간 예외 시 이전 데이터 유지)
    state.byId = byId;
    const missing = Formula.SLOTS.filter((s) => !state.items.some((it) => it.slot === s));
    if (!state.items.length) showBanner('data/items.json에 장비 아이템이 없습니다. `scripts/fetch_items.py`를 다시 실행하세요.');
    else if (missing.length) showBanner(`다음 부위의 아이템이 데이터에 없습니다: ${missing.join(', ')}`);
    return true;
  }

  // ---------- 데이터 메타(출처·패치노트 반영 내역) ----------
  // data/items.meta.json을 읽는다. 없거나 형식이 틀리면 null(헤더 줄 숨김).
  async function fetchMeta() {
    try {
      const res = await fetch(META_URL, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function setMeta(meta) {
    state.meta = Meta.normalize(meta);
    state.patched = Meta.patchedItems(state.meta);
    const line = $('#data-meta');
    const text = Meta.headerText(state.meta);
    line.textContent = text || '';
    line.hidden = !text;
    if ($('#meta-panel').open) renderMetaPanel();
    renderSkillNote(); // 스킬 "패치 반영" 표식
  }

  // ---------- v2 스킬 선택(data/skills.json) ----------
  function fetchSkills() {
    return fetch('data/skills.json', { cache: 'no-store' }).then((res) => {
      if (!res.ok) throw new Error('없음');
      return res.json();
    });
  }

  // list: skills.json 내용(배열이 아니면 없음으로 표시). 선택 중이던 스킬·레벨은 유지한다.
  function setSkills(list) {
    state.skills = Skills.normalize(list);
    state.skillsError = Array.isArray(list) ? '' : 'data/skills.json 없음 — 스킬 계수는 직접 입력';
    renderSkillOptions(currentSkillKeep());
  }

  async function loadSkills() {
    let list = null;
    try {
      list = await fetchSkills();
    } catch { /* 없음 표시 */ }
    setSkills(list);
  }

  // 선택된(또는 기록에서 복원된) 실험체 { id, name }. 실험체 데이터가 없어도 복원된 id를 쓴다.
  function characterRef() {
    const c = selectedCharacter();
    if (c) return { id: String(c.id), name: c.name };
    const name = $('#in-character').value.trim();
    if (!name) return null;
    const r = state.restoredCharacter;
    return { id: r && r.name === name ? r.id : null, name };
  }

  function currentSkillEntry() {
    const ref = characterRef();
    return ref ? Skills.forCharacter(state.skills, ref.id, ref.name) : null;
  }

  // 선택한 {skill, entry(피해 항목), index}. 없으면 null.
  function currentSkill() {
    return Skills.findChoice(currentSkillEntry(), $('#in-skill').value);
  }

  // 지금 선택을 { key, index, label, level, name }으로(실험체가 없으면 null).
  function currentSkillKeep() {
    const sel = $('#in-skill');
    if (!sel || !sel.value || !characterRef()) return null;
    const lv = $('#in-skillLevel').value;
    const d = sel.selectedOptions[0] ? sel.selectedOptions[0].dataset : {};
    return { key: d.key || '', index: d.index === '' || d.index == null ? null : Number(d.index), label: d.label || '',
      level: lv === '' ? null : Number(lv), name: d.name || '' };
  }

  // 스킬 선택 목록(스킬 × 피해 항목)을 다시 만든다. keep(기록 복원값 등)이 현재 데이터에 없어도 "(현재 데이터에 없음)"으로 남긴다.
  function renderSkillOptions(keep) {
    if (!V2) return;
    const entry = currentSkillEntry();
    const list = Skills.choices(entry);
    const option = (value, text, data) => {
      const o = el('option', { value, textContent: text });
      Object.assign(o.dataset, { key: data.key || '', index: data.index == null ? '' : String(data.index), label: data.label || '', name: data.name || '' });
      return o;
    };
    const opts = [option('', list.length ? '스킬 선택 안 함' : '스킬 데이터 없음', {})];
    const choiceOption = (c) => option(c.value, Skills.optionLabel(c.skill, c.entry), { key: String(c.skill.key), index: c.manual ? -1 : c.index, label: c.entry.label, name: c.skill.name });
    // P·Q·W·E·R의 피해 항목만 목록에 보인다(피해 항목이 없는 스킬은 "수동 입력").
    // 숨긴 스킬·항목이 기록에서 복원되면 그 항목만 임시로 넣어 선택을 유지.
    const shown = Skills.damageChoices(entry).filter((c) => Skills.isListed(c.skill));
    for (const c of shown) opts.push(choiceOption(c));
    let value = '';
    if (keep && keep.key) {
      const hit = Skills.matchChoice(entry, keep);
      if (hit) {
        value = hit.value;
        if (!shown.some((c) => c.value === hit.value)) opts.push(choiceOption(hit));
      }
      else {
        value = 'missing';
        const text = `${keep.key}${keep.name ? ' ' + keep.name : ''}${keep.label ? ' — ' + keep.label : ''} (현재 데이터에 없음)`;
        opts.push(option(value, text, keep));
      }
    }
    const sel = $('#in-skill');
    sel.replaceChildren(...opts);
    sel.value = value;
    sel.disabled = opts.length === 1;
    renderSkillLevels(keep ? keep.level : null);
  }

  // 선택한 피해 항목의 레벨 목록. 기본은 최고 레벨, keepLevel이 있으면 그 레벨(데이터에 없으면 표시만 남김).
  function renderSkillLevels(keepLevel) {
    const lv = $('#in-skillLevel');
    const choice = currentSkill();
    const levels = choice ? Skills.levelsOf(choice.entry).map((l) => l.level) : [];
    const opts = levels.map((n) => el('option', { value: String(n), textContent: `${n}레벨` }));
    if ($('#in-skill').value && keepLevel != null && Number.isFinite(keepLevel) && !levels.includes(keepLevel)) {
      opts.push(el('option', { value: String(keepLevel), textContent: `${keepLevel}레벨 (현재 데이터에 없음)` }));
    }
    lv.replaceChildren(...opts);
    lv.disabled = !opts.length;
    if (keepLevel != null && opts.some((o) => o.value === String(keepLevel))) lv.value = String(keepLevel);
    else if (levels.length) lv.value = String(levels[levels.length - 1]);
    renderSkillNote();
  }

  // 스킬·레벨을 고르면 스킬 기본 피해량·공격력 계수·스킬 증폭 계수를 채운다(이후 수동 수정 가능).
  function applySkill() {
    const lv = $('#in-skillLevel').value;
    const choice = currentSkill();
    const auto = lv === '' || !choice ? null : Skills.autoValues(choice.entry, Number(lv));
    if (auto) for (const k of SKILL_FIELDS) if (auto[k] != null) $('#in-' + k).value = auto[k];
    hideResult();
    renderSkillNote();
  }

  // 스킬 출처("나무위키 · 수정 날짜"), 수동 수정 여부, 패치노트 반영·역사란 불일치 표식, 미반영 계수.
  function renderSkillNote() {
    const note = $('#skill-note');
    if (!V2 || !note) return;
    const entry = currentSkillEntry();
    const choice = currentSkill();
    if (!choice) {
      note.replaceChildren($('#in-skill').value ? '현재 데이터에 없는 스킬 — 기록된 값 유지' : state.skillsError);
      note.title = note.textContent;
      return;
    }
    const { skill, entry: dmg } = choice;
    const source = Skills.sourceText(entry);
    const lv = $('#in-skillLevel').value;
    const auto = lv === '' ? null : Skills.autoValues(dmg, Number(lv));
    let text;
    if (!Skills.levelsOf(dmg).length) text = `수동 입력(수치 없음) · ${source}`;
    else {
      const edited = auto && SKILL_FIELDS.some((k) => {
        const raw = $('#in-' + k).value.trim();
        return auto[k] != null && (raw === '' || Number(raw) !== auto[k]);
      });
      text = source + (edited ? ' · 수동 수정됨' : '');
    }
    const patches = Skills.patchNotes(state.meta, characterRef(), skill);
    const mismatch = Skills.mismatchText(dmg);
    const extras = lv === '' ? [] : Skills.extraRatioTexts(dmg, Number(lv));
    note.replaceChildren(text, patches.length
      ? el('span', { className: 'patch-badge', textContent: '패치 반영', title: '패치노트 반영: ' + patches.join(', ') }) : '',
    mismatch ? el('span', { className: 'patch-badge', textContent: '역사란과 불일치',
      title: mismatch }) : '',
    extras.length ? el('span', { className: 'skill-extra', textContent: '미반영 계수: ' + extras.join(', ') }) : '');
    // 메모는 한 줄로 잘리므로 전체 문구는 툴팁으로.
    note.title = [text, mismatch ? '역사란과 불일치: ' + mismatch : '', extras.length ? '미반영 계수: ' + extras.join(', ') : ''].filter(Boolean).join('\n');
  }

  function renderMetaPanel() {
    const m = state.meta || Meta.normalize({});
    const patch = $('#meta-patch');
    const title = [m.patch.title || (m.patch.version ? `패치노트 ${m.patch.version}` : ''), m.patch.date ? `(${m.patch.date})` : '']
      .filter(Boolean).join(' ');
    const url = Meta.safeUrl(m.patch.url);
    patch.replaceChildren(url && title ? el('a', { href: url, target: '_blank', rel: 'noopener', textContent: title }) : (title || '패치노트 정보 없음'));
    const fill = (sel, lines) => $(sel).replaceChildren(...(lines.length
      ? lines.map((t) => el('li', { textContent: t }))
      : [el('li', { className: 'muted', textContent: '없음' })]));
    fill('#meta-overrides', Meta.overrideLines(m));
    fill('#meta-unparsed', Meta.unparsedLines(m));
    // 스킬 재수집 내역(메타 skillsFetched가 있을 때만): 패치노트 줄 바로 아래.
    let skills = $('#meta-skills');
    if (!skills) {
      skills = el('p', { id: 'meta-skills', className: 'muted' });
      patch.after(skills);
    }
    const fetched = Meta.skillsFetchedText(m);
    skills.textContent = fetched;
    skills.hidden = !fetched;
  }

  // 패치노트로 덮어쓴 스탯이 있는 아이템 표식.
  function patchBadge(item) {
    const stats = state.patched.get(String(item.name).trim());
    return stats ? el('span', { className: 'patch-badge', textContent: '패치 반영', title: '패치노트 반영: ' + stats.join(', ') }) : null;
  }

  // ---------- 아이템 수치 업데이트(데스크톱 전용) ----------
  function setupUpdater() {
    const btn = $('#update-btn');
    const status = $('#update-status');
    if (!Updater.canUpdate(window)) return; // 웹 실행: 버튼 숨김 유지
    $('#data-update-group').hidden = false;
    $('#update-split').hidden = false;
    // 상태 문구: 짧은 문구 + 툴팁에 전체 문장. 완료 문구(fade)는 5초 뒤 지운다(오류는 남김).
    let clearTimer = null;
    const setStatus = (text, full, error, fade) => {
      clearTimeout(clearTimer);
      status.className = error ? 'muted error' : 'muted';
      status.textContent = text;
      status.title = full || text;
      if (fade) clearTimer = setTimeout(() => { status.textContent = ''; status.title = ''; }, 5000);
    };
    // 스플릿 버튼: 본체는 패치된 실험체만 스킬 재수집(skillsMode "patched"), ▾ 메뉴는 전체(skillsMode "all").
    const more = $('#update-more');
    const menu = ERDropdown.menu(more, $('#update-split'), '업데이트 방식', ['전체 재확인 · 약 2분'], () => run('all'));
    // 데스크톱 진행 이벤트: 업데이트 중에만 상태 문구에 단계·진행률 표시.
    // 예상 남은 시간: 1초마다 갱신, 성공한 실행의 소요 시간을 모드별로 저장해 다음 실행의 초기 예상치로 쓴다.
    // 진행 표시는 원형 게이지(퍼센트 + "단계 · 남은 시간"), 결과·오류 문구는 상태 문구.
    let updating = false;
    const progress = Updater.canProgress(window);
    const etaKey = (mode) => 'er-update-last-ms:' + mode;
    let eta = null;
    let stageText = '';
    let timer = null;
    const gauge = progress ? Gauge.create(document, 'update-gauge', '데이터 업데이트 진행') : null;
    if (gauge) status.before(gauge.el); // .update-state 안: 게이지·문구가 버튼 바로 왼쪽에 오른쪽 정렬
    const showProgress = () => {
      if (!updating) return;
      const now = Date.now();
      gauge.set(eta.fraction(now) * 100, Gauge.detailText([stageText, Updater.etaText(eta, now)]));
    };
    if (progress) {
      window.erDesktop.onUpdateProgress((ev) => {
        if (!updating) return;
        const text = Updater.progressText(ev);
        if (text) stageText = text;
        eta.update(ev);
        showProgress();
      });
    }
    const run = async (mode) => {
      menu.close();
      btn.disabled = true;
      more.disabled = true;
      btn.textContent = '업데이트 중…';
      setStatus('', '', false, false);
      updating = true;
      const startedAt = Date.now();
      if (progress) {
        let last = NaN;
        try { last = Number(localStorage.getItem(etaKey(mode))); } catch { /* 저장소 없음 */ }
        eta = Updater.createEta(startedAt, last);
        stageText = '';
        showProgress();
        timer = setInterval(showProgress, 1000);
      }
      try {
        const r = await Updater.runUpdate(window.erDesktop, loadData, fetchMeta, V2 ? fetchSkills : null, { skillsMode: mode });
        updating = false; // 이후 늦게 온 진행 이벤트가 결과 문구를 덮지 않도록
        clearInterval(timer);
        if (r.ok && progress) {
          try { localStorage.setItem(etaKey(mode), String(Date.now() - startedAt)); } catch { /* 저장소 없음 */ }
        }
        if (gauge) {
          if (r.ok) gauge.done('');
          else gauge.fail('');
        }
        if (r.ok) {
          // 반환에 meta가 있으면 그것, 없으면 다시 읽은 메타 파일(runUpdate가 결정).
          setMeta(r.meta);
          // 방어 관통이 자동값이던 칸은 갱신된 아이템 수치의 합으로 다시 채운다(수동값은 유지).
          const oldPen = penAuto(state.equipped);
          const penWasAuto = Object.keys(PEN_NOTES).filter((key) => penIsAuto(key, oldPen));
          const { equipped, removed } = Updater.rematch(state.equipped, state.byId);
          state.equipped = equipped;
          const newPen = penAuto(state.equipped);
          for (const key of penWasAuto) $('#in-' + key).value = tidy(newPen[PEN_NOTES[key].auto]);
          // 기준 세트는 저장값에서 다시 찾는다(최초 로딩 실패로 비어 있던 기준도 갱신 데이터로 복원).
          loadBaseline();
          // v2: 실험체 데이터도 다시 읽고 선택 중인 실험체를 id로 다시 찾는다.
          const lostCharacter = V2 ? await loadCharacters(true) : null;
          // v2: 스킬 데이터도 갱신(받은 skills가 없으면 기존 데이터 유지). 선택 중인 스킬·레벨은 키로 유지.
          if (V2 && r.skills) setSkills(r.skills);
          renderSlots();
          renderHistory();
          if ($('#picker').open) renderPicker();
          const full = r.message + (removed.length ? ` — 데이터에서 사라져 비운 슬롯: ${removed.join(', ')}` : '') +
            (lostCharacter ? ` — 데이터에서 사라져 비운 실험체: ${lostCharacter}` : '');
          setStatus(`${r.short} · ${Updater.durationText(Date.now() - startedAt)}`, full, false, true);
        } else {
          setStatus(r.message, r.message, true, false);
        }
      } catch (err) {
        if (gauge) gauge.fail('');
        setStatus('업데이트 처리 중 오류: ' + err.message, '', true, false);
      } finally {
        updating = false;
        clearInterval(timer);
        btn.disabled = false;
        more.disabled = false;
        btn.textContent = '아이템 업데이트';
      }
    };
    btn.onclick = () => run('patched');
  }

  // ---------- 프로그램 업데이트 배너(데스크톱 preload가 넣는 #app-update-banner) ----------
  // 다운로드 진행({received, total, percent})을 같은 원형 게이지로 배너 맨 앞에 표시한다.
  // 문구: "내려받는 중 · 5.0 / 20.0 MB · 약 12초 남음"(괄호 없음). 남은 시간은 첫 진행 이후 받은 속도로 추정.
  // 시작·완료·실패는 preload가 배너 문구 칸(#app-update-banner의 첫 span)에 쓰는 문구로 안다:
  // "내려받는 중…" → 0%부터, "내려받기 완료" → 100% 후 1초 뒤 숨김(percent가 null인 경로 포함), "업데이트 실패" → 경고색.
  function setupAppUpdateGauge() {
    const au = window.erDesktop && window.erDesktop.appUpdate;
    if (!au || typeof au.onProgress !== 'function') return;
    const gauge = Gauge.create(document, 'app-update-gauge', '프로그램 업데이트 다운로드');
    const mb = (n) => (Number(n) / 1048576).toFixed(1);
    let started = null; // {at, received}: 이번 다운로드의 첫 진행 시각·양(남은 시간 추정)
    let lastText = '';
    let attached = false;
    const onBannerText = (text) => {
      if (text === lastText) return;
      lastText = text;
      if (/업데이트 실패/.test(text)) gauge.fail();
      else if (/내려받기 완료/.test(text)) gauge.done('');
      else if (/내려받는 중…$/.test(text)) { started = null; gauge.set(0, '내려받는 중'); }
    };
    const attach = () => {
      if (attached) return true;
      const banner = document.getElementById('app-update-banner');
      const textEl = banner && [...banner.children].find((c) => c.tagName === 'SPAN');
      if (!textEl) return false;
      attached = true;
      banner.prepend(gauge.el);
      // 문구 칸만 감시한다(게이지 자신의 변경은 감시 대상이 아님).
      new MutationObserver(() => onBannerText(textEl.textContent))
        .observe(textEl, { childList: true, subtree: true, characterData: true });
      lastText = textEl.textContent;
      return true;
    };
    // preload는 DOMContentLoaded에 배너를 만든다. app.js는 그보다 먼저 실행되므로 그때 연결한다.
    if (!attach()) document.addEventListener('DOMContentLoaded', attach, { once: true });
    au.onProgress((p) => {
      if (!p || !attach()) return;
      const received = Number(p.received);
      const total = Number(p.total);
      const hasTotal = Number.isFinite(total) && total > 0;
      const now = Date.now();
      if (!started || received < started.received) started = { at: now, received };
      let left = '';
      const rate = (received - started.received) / (now - started.at); // 바이트/ms
      if (hasTotal && rate > 0 && now - started.at >= 1000) {
        left = `약 ${Updater.durationText((total - received) / rate)} 남음`;
      }
      const size = hasTotal ? `${mb(received)} / ${mb(total)} MB` : (Number.isFinite(received) ? `${mb(received)} MB` : '');
      const pct = Gauge.clampPct(p.percent);
      if (pct === 100) gauge.done(Gauge.detailText(['내려받기 완료', size]));
      else gauge.set(pct, Gauge.detailText(['내려받는 중', size, left]));
    });
    if (typeof au.onError === 'function') au.onError(() => { if (attach()) gauge.fail(); });
  }

  // ---------- 슬롯 ----------
  // 구성·입력이 바뀌거나 비교 기준(히스토리)이 바뀌면 이전 결과는 현재 상태와 맞지 않으므로 숨긴다.
  function hideResult() {
    $('#result').hidden = true;
    setCalcMsg('');
  }

  // 계산 버튼 옆 작은 인라인 문구(입력 오류·복원 누락). 구성·입력이 바뀌면 hideResult가 지운다.
  function setCalcMsg(text) {
    $('#calc-msg').textContent = text;
  }

  function saveHistory() {
    try {
      History.save(localStorage, state.history);
    } catch (err) {
      alert('히스토리를 저장하지 못했습니다: ' + err.message);
    }
  }

  // 슬롯 카드 한 장(장비 슬롯·기준 세트 공용). onClear는 아이템이 있을 때만 "비우기" 버튼으로.
  // 한 줄: 슬롯명 · 아이콘 · 등급 점 + 이름 · 가격 · 비우기. 행 전체가 선택/변경 버튼(클릭·Enter·Space). 스탯은 이름의 툴팁으로.
  function slotCard(slot, item, onPick, onClear) {
    const card = el('div', { className: 'slot' + (item ? ' filled' : '') }, el('span', { className: 'label', textContent: slot }));
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${slot} ${item ? '변경' : '선택'}`);
    const enabled = state.items.length > 0;
    card.tabIndex = enabled ? 0 : -1;
    if (!enabled) card.setAttribute('aria-disabled', 'true');
    if (item) {
      card.append(
        itemImage(item),
        el('span', { className: 'slot-name', title: `${item.name} (${item.grade})\n${statsText(item)}` },
          gradeDot(item.grade), el('span', { className: 'name-text', textContent: item.name }), patchBadge(item)),
        el('span', { className: 'price', textContent: fmt(item.price), title: `가격 ${fmt(item.price)}` }),
      );
      const clear = closeButton(`${slot} 비우기`);
      clear.onclick = (ev) => { ev.stopPropagation(); onClear(); };
      clear.onkeydown = (ev) => ev.stopPropagation();
      card.append(clear);
    } else {
      card.append(el('span', { className: 'slot-icon-empty' }), el('span', { className: 'slot-empty', textContent: '비어 있음' }));
    }
    card.onclick = () => { if (enabled) onPick(); };
    card.onkeydown = (ev) => {
      if (ev.target !== card || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      if (enabled) onPick();
    };
    return card;
  }

  function renderSlots() {
    hideResult();
    const box = $('#slots');
    box.replaceChildren(...Formula.SLOTS.map((slot) => slotCard(slot, state.equipped[slot], () => openPicker(slot, 'equipped'), () => {
      delete state.equipped[slot];
      renderSlots();
      applyPenAuto();
      if (slot === '무기') applyAuto('amp');
      focusSlotButton('#slots', `${slot} 선택`);
    })));
    renderBaseline();
    const filled = Formula.SLOTS.filter((s) => state.equipped[s]).length;
    const all = filled === Formula.SLOTS.length;
    $('#slots-clear').disabled = !filled;
    $('#slot-status').textContent = all ? '' : `${filled}/${Formula.SLOTS.length}`;
    $('#slot-status').title = all ? '' : `${filled}/${Formula.SLOTS.length} — 모두 채워야 계산`;
    $('#calc-btn').disabled = !all;
    $('#calc-btn').title = all ? '' : '장비 슬롯 5칸을 모두 채워야 계산할 수 있습니다.';
    updateSkillAmpTotal();
    renderAutoNotes();
    renderPenNotes();
  }

  // ---------- 데미지 효율 계산 기준(기준 세트) ----------
  // 기준 세트가 바뀌면 이전 결과와 맞지 않으므로 숨기고 localStorage에 저장한다.
  function saveBaseline() {
    state.baselineMissing = []; // 사용자가 기준을 바꾸면 화면의 기준이 저장값이 된다.
    try {
      Baseline.save(localStorage, VARIANT, state.baseline, Formula.SLOTS);
    } catch (err) {
      alert('기준 세트를 저장하지 못했습니다: ' + err.message);
    }
  }

  // 저장된 기준 세트를 현재 데이터로 찾는다. 데이터에 없는 아이템은 비워 두고 표시하되,
  // 저장값은 사용자가 기준을 바꿀 때까지 유지한다(데이터가 다시 그 아이템을 갖게 되면 복원).
  function loadBaseline() {
    let saved = {};
    try {
      saved = Baseline.load(localStorage, VARIANT, Formula.SLOTS);
    } catch { /* 저장소 접근 불가: 빈 기준 */ }
    const { set, missing } = Baseline.resolve(saved, state.byId, Formula.SLOTS);
    state.baseline = set;
    state.baselineMissing = missing;
  }

  function renderBaseline() {
    hideResult();
    $('#baseline-slots').replaceChildren(...Formula.SLOTS.map((slot) => slotCard(slot, state.baseline[slot], () => openPicker(slot, 'baseline'), () => {
      delete state.baseline[slot];
      saveBaseline();
      renderBaseline();
      focusSlotButton('#baseline-slots', `${slot} 선택`);
    })));
    const filled = Formula.SLOTS.filter((s) => state.baseline[s]).length;
    const missing = state.baselineMissing || [];
    // 데이터에 없어 비워 둔 저장 기준도 지울 수 있어야 한다.
    $('#baseline-clear').disabled = !filled && !missing.length;
    // 효율 식 설명은 제목의 툴팁. 여기는 상태만 짧게.
    const status = $('#baseline-status');
    // 헤더는 한 줄 고정: 짧은 상태만 보이고 전체 문구는 툴팁.
    const incomplete = filled !== Formula.SLOTS.length;
    status.textContent = [incomplete ? `${filled}/${Formula.SLOTS.length}` : '', missing.length ? `없는 기준 ${missing.length}개` : ''].filter(Boolean).join(' · ');
    status.title = [incomplete ? `${filled}/${Formula.SLOTS.length} — 미완성 시 히스토리 최고 대비` : '', missing.length ? `데이터에 없는 저장 기준: ${missing.join(', ')}` : ''].filter(Boolean).join(' · ');
    status.className = missing.length ? 'muted error' : 'muted';
  }

  // ---------- 아이템 선택 창 ----------
  // target: 'equipped'(장비 슬롯) 또는 'baseline'(기준 세트).
  function openPicker(slot, target) {
    state.pickerSlot = slot;
    state.pickerTarget = target;
    $('#picker-title').textContent = `${target === 'baseline' ? '기준 세트 · ' : ''}${slot} 아이템 선택`;
    $('#picker-search').value = '';
    $('#picker-grade').value = '';
    renderPicker();
    $('#picker').showModal();
    $('#picker-search').focus();
  }

  function pickItem(it) {
    $('#picker').close();
    const slot = state.pickerSlot;
    if (state.pickerTarget === 'baseline') {
      state.baseline[slot] = it;
      saveBaseline();
      renderBaseline();
    } else {
      state.equipped[slot] = it;
      renderSlots();
      applyPenAuto();
      if (slot === '무기') applyAuto('amp');
    }
    focusSlotButton(state.pickerTarget === 'baseline' ? '#baseline-slots' : '#slots', `${slot} 변경`);
  }

  // 다시 그린 슬롯 행(role=button, aria-label로 찾음)으로 포커스를 돌려 키보드 흐름이 끊기지 않게.
  function focusSlotButton(boxSel, label) {
    const b = [...$(boxSel).querySelectorAll('.slot[role="button"]')].find((x) => x.getAttribute('aria-label') === label);
    if (b) b.focus();
  }

  // 검색창 키보드 이동(↑↓)으로 고르는 행. 검색창이 포커스를 유지하고 aria-activedescendant로 알린다.
  function setPickerActive(i) {
    const rows = [...document.querySelectorAll('#picker-list li[role="option"]')];
    const search = $('#picker-search');
    state.pickerActive = rows.length ? Math.max(0, Math.min(rows.length - 1, i)) : -1;
    rows.forEach((li, n) => {
      const on = n === state.pickerActive;
      li.classList.toggle('active', on);
      li.setAttribute('aria-selected', String(on));
    });
    const cur = rows[state.pickerActive];
    if (cur) {
      search.setAttribute('aria-activedescendant', cur.id);
      cur.scrollIntoView({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }

  function pickerKey(ev) {
    if (ev.isComposing || ev.keyCode === 229) return; // 한글 조합 확정 Enter는 선택이 아니다
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      setPickerActive(state.pickerActive + (ev.key === 'ArrowDown' ? 1 : -1));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const it = state.pickerRows && state.pickerRows[state.pickerActive];
      if (it) pickItem(it);
    }
  }

  function renderPicker() {
    const q = $('#picker-search').value.trim().toLowerCase();
    const grade = $('#picker-grade').value;
    const list = $('#picker-list');
    list.replaceChildren();
    const rows = state.items.filter((it) => it.slot === state.pickerSlot &&
      (!grade || it.grade === grade) &&
      (!q || String(it.name).toLowerCase().includes(q)));
    state.pickerRows = rows;
    rows.forEach((it, i) => {
      const li = el('li', { id: 'pick-' + i },
        itemImage(it),
        el('div', null,
          el('div', { className: 'pick-name' }, gradeDot(it.grade), el('span', { textContent: it.name }), patchBadge(it)),
          el('div', { className: 'stats', textContent: statsText(it) })),
        el('span', { className: 'price', textContent: fmt(it.price), title: it.priceSource ? `가격 출처: ${it.priceSource}` : '' }));
      li.setAttribute('role', 'option');
      li.onclick = () => pickItem(it);
      li.onmouseenter = () => setPickerActive(i);
      list.append(li);
    });
    if (!rows.length) list.append(el('li', { className: 'empty', textContent: '조건에 맞는 아이템이 없습니다.' }));
    setPickerActive(0);
  }

  // ---------- 입력 ----------
  function renderInputs() {
    const form = $('#inputs');
    if (V2) {
      // 실험체 선택(이름 검색 + 앱 스타일 후보 목록). 무기 종류는 무기 슬롯 아이템의 weaponType으로 자동 결정.
      const input = el('input', { type: 'search', id: 'in-character', placeholder: '실험체 검색' });
      input.setAttribute('aria-label', '실험체');
      form.append(el('label', null, labelText('실험체'), input,
        el('span', { id: 'character-note', className: 'muted small' })));
      window.ERDropdown.clearable(input);
      window.ERDropdown.combo(input, () => state.characters.map((c) => c.name));
      // 스킬 선택(data/skills.json) → 스킬 기본 피해량·계수 자동 입력.
      const skillSel = el('select', { id: 'in-skill', disabled: true });
      skillSel.setAttribute('aria-label', '스킬');
      const levelSel = el('select', { id: 'in-skillLevel', disabled: true });
      levelSel.setAttribute('aria-label', '스킬 레벨');
      form.append(el('label', null, labelText('스킬'), skillSel, el('span', { id: 'skill-note', className: 'muted small' })),
        el('label', null, labelText('스킬 레벨'), levelSel));
      // 네이티브 select 팝업 대신 앱 스타일 드롭다운(select는 숨겨 값·id 유지).
      window.ERDropdown.enhance(skillSel);
      window.ERDropdown.enhance(levelSel);
    }
    for (const f of INPUT_FIELDS) {
      const input = el('input', { type: 'number', id: 'in-' + f.key, step: f.step, value: Formula.DEFAULT_INPUTS[f.key] ?? '' });
      if (f.min != null) input.min = f.min;
      if (Formula.DEFAULT_INPUTS[f.key] == null) input.placeholder = '직접 입력';
      // v2: 스탯창 스킬 증폭과 맞춰 볼 수 있도록 현재 합계를 아이템 외 스킬 증폭 옆에 표시,
      // 자동 입력되는 칸에는 자동값 출처를 작게 표시.
      // 방어 관통 두 칸은 v1·v2 모두 자동(아이템 합)/수동 표시.
      const noteId = { extraSkillAmp: 'sa-total', extraAtk: 'auto-atk', extraSkillAmpPct: 'auto-amp', extraPen: 'auto-pen', extraPenPct: 'auto-penPct' }[f.key];
      const extra = noteId && (V2 || PEN_NOTES[f.key]) ? el('span', { id: noteId, className: 'muted small' }) : null;
      if (extra) input.setAttribute('aria-label', f.label);
      form.append(el('label', null, labelText(f.short || f.label, f.label), input, extra));
    }
  }

  // 조밀한 입력 그리드: 라벨은 한 줄로 자르고 전체 문구는 툴팁으로.
  // short: 칸이 좁은 라벨의 짧은 문구(전체 이름 full은 툴팁).
  function labelText(text, full) {
    return el('span', { className: 'lbl', textContent: text, title: full || text });
  }

  // ---------- v2 실험체 자동 입력 ----------
  function selectedCharacter() {
    const name = $('#in-character').value.trim();
    return state.characters.find((c) => c.name === name) || null;
  }

  function currentAuto() {
    const weapon = state.equipped['무기'];
    const n = (key) => Number($('#in-' + key).value);
    return window.ERCharacters.autoValues(selectedCharacter(), weapon ? weapon.weaponType || null : null, n('level'), n('masteryLevel'));
  }

  // 자동값 출처와 경고 표시. 입력란 값이 자동값과 다르면 "수동 수정"으로 표시한다.
  function renderAutoNotes() {
    if (!V2) return;
    const auto = currentAuto();
    // 짧게 "자동" / "수동 수정 (자동 124.4)", 산출 근거는 툴팁.
    const note = (id, key, value, source) => {
      const cur = Number($('#in-' + key).value);
      const box = $('#' + id);
      const same = value != null && cur === tidy(value);
      box.textContent = value == null ? '' : same ? '자동' : `수동 수정 (자동 ${fmt(value)})`;
      box.title = value == null ? '' : `자동: ${source} = ${fmt(value)}`;
    };
    note('auto-atk', 'extraAtk', auto.extraAtk, auto.atkSource);
    note('auto-amp', 'extraSkillAmpPct', auto.extraSkillAmpPct, auto.ampSource);
    const charNote = $('#character-note');
    charNote.className = auto.warning ? 'muted small error' : 'muted small';
    charNote.textContent = state.charactersError || auto.warning;
    charNote.title = charNote.textContent;
    renderSkillNote();
  }

  // ---------- 방어 관통 자동 입력(v1·v2) ----------
  // 장비 슬롯이 바뀔 때마다 아이템 방관 합을 입력란에 채운다(아이템 외 공격력과 같은 규칙: 이후 수동 수정 가능,
  // 다음 슬롯 변경 때 다시 자동값). 입력란 값 = 계산에 쓰는 최종값.
  function penAuto(set) {
    return Formula.itemPen(Formula.SLOTS.map((s) => set[s]));
  }

  function applyPenAuto() {
    const auto = penAuto(state.equipped);
    for (const [key, p] of Object.entries(PEN_NOTES)) $('#in-' + key).value = tidy(auto[p.auto]);
    hideResult();
    renderPenNotes();
  }

  // 입력란 값이 현재 장비의 아이템 합과 같으면 "자동", 다르면 "수동 (자동 35)".
  function penIsAuto(key, auto) {
    const raw = $('#in-' + key).value.trim();
    return raw !== '' && Number(raw) === tidy(auto[PEN_NOTES[key].auto]);
  }

  function renderPenNotes() {
    const auto = penAuto(state.equipped);
    for (const [key, p] of Object.entries(PEN_NOTES)) {
      const box = $('#' + p.note);
      const value = tidy(auto[p.auto]);
      box.textContent = penIsAuto(key, auto) ? '자동' : `수동 (자동 ${fmt(value)})`;
      box.title = `자동: 장비 아이템 ${p.label} = ${fmt(value)}`;
    }
  }

  // 사용자가 실험체를 바꾸면 스킬 선택을 비우고 그 실험체의 스킬 목록으로 바꾼다.
  function syncSkillCharacter() {
    const ref = characterRef();
    const name = ref ? ref.name : '';
    if (name === state.skillCharName) return;
    state.skillCharName = name;
    renderSkillOptions(null);
  }

  // 실험체·레벨·숙련도·무기가 바뀌면 그 변경에 영향받는 자동값만 입력란에 채운다(이후 수동 수정 가능).
  // which: 'atk'(캐릭터 레벨), 'amp'(숙련도 레벨·무기), 'both'(실험체).
  function applyAuto(which) {
    if (!V2) return;
    const auto = currentAuto();
    if (which !== 'amp' && auto.extraAtk != null && Number.isFinite(auto.extraAtk)) $('#in-extraAtk').value = tidy(auto.extraAtk);
    if (which !== 'atk' && auto.extraSkillAmpPct != null && Number.isFinite(auto.extraSkillAmpPct)) $('#in-extraSkillAmpPct').value = tidy(auto.extraSkillAmpPct);
    hideResult();
    updateSkillAmpTotal();
    renderAutoNotes();
  }

  // reselect: 데이터 갱신 뒤 다시 읽을 때 true — 선택 중이던 실험체를 id로 다시 찾고, 없어졌으면 비운 뒤 그 이름을 돌려준다.
  async function loadCharacters(reselect) {
    const prevName = $('#in-character').value.trim();
    const prev = selectedCharacter();
    const prevId = prev ? String(prev.id) : (state.restoredCharacter && state.restoredCharacter.name === prevName ? state.restoredCharacter.id : null);
    try {
      const res = await fetch('data/characters.json', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const list = await res.json();
      if (!Array.isArray(list)) throw new Error();
      state.characters = list.filter((c) => c && typeof c.name === 'string');
      state.charactersError = '';
    } catch {
      state.characters = [];
      state.charactersError = 'data/characters.json 없음 — 실험체 자동 입력 불가(아이템 외 입력란에 직접 입력)';
    }
    let lostName = null;
    if (reselect) {
      const { character, lost } = window.ERCharacters.rematch(state.characters, prevId, prevName);
      $('#in-character').value = character ? character.name : '';
      state.restoredCharacter = null;
      if (lost) lostName = prevName;
    }
    // 로딩 중에 이미 실험체 이름을 입력했으면 이제 자동값을 채운다(히스토리는 로딩 뒤에 표시되므로 복원값과 겹치지 않음).
    if (selectedCharacter()) applyAuto('both');
    else renderAutoNotes();
    state.skillCharName = characterRef() ? characterRef().name : '';
    renderSkillOptions(currentSkillKeep());
    return lostName;
  }

  function updateSkillAmpTotal() {
    const box = $('#sa-total');
    if (!box) return;
    const value = (key) => {
      const raw = $('#in-' + key).value.trim();
      return raw === '' ? NaN : Number(raw);
    };
    const sa = Formula.skillAmpTotal(Formula.SLOTS.map((s) => state.equipped[s]),
      { level: value('level'), extraSkillAmp: value('extraSkillAmp'), extraSkillAmpPct: value('extraSkillAmpPct') });
    box.textContent = `합계 ${sa == null ? '—' : fmt(sa)}`;
    box.title = '현재 스킬 증폭 합계(아이템 + 아이템 외) — 게임 스탯창 값과 비교';
  }

  function readInputs() {
    const out = {};
    for (const f of INPUT_FIELDS) {
      const raw = $('#in-' + f.key).value.trim();
      const n = Number(raw);
      if (raw === '') throw new Error(`"${f.label}" 값을 입력하세요.`);
      if (!Number.isFinite(n)) throw new Error(`"${f.label}" 값이 숫자가 아닙니다.`);
      if (f.min != null && n < f.min) throw new Error(`"${f.label}" 값은 ${f.min} 이상이어야 합니다.`);
      out[f.key] = n;
    }
    // 방어 관통 입력란이 최종값인 기록 표시(이전 기록의 extraPen·extraPenPct는 아이템 합에 더하던 추가값).
    out.penMode = 'total';
    if (V2) {
      // 실험체도 기록에 저장(복원용). 선택하지 않았으면 null.
      // 데이터에 없는(로딩 실패 등) 복원 실험체도 이름·id를 잃지 않도록 복원값을 이어받는다.
      const c = selectedCharacter();
      const name = $('#in-character').value.trim();
      const restored = state.restoredCharacter;
      out.characterId = c ? String(c.id) : (restored && restored.name === name ? restored.id : null);
      out.characterName = c ? c.name : (name || null);
      // 스킬·레벨(복원용). 선택 안 함이면 null.
      const keep = currentSkillKeep();
      out.skillKey = keep ? keep.key : null;
      out.skillName = keep ? keep.name || null : null;
      out.skillLevel = keep ? keep.level : null;
      out.skillEntry = keep ? keep.index : null;
      out.skillEntryLabel = keep ? keep.label || null : null;
    }
    return out;
  }

  function writeInputs(inputs) {
    for (const f of INPUT_FIELDS) {
      const v = inputs && inputs[f.key] != null ? inputs[f.key] : Formula.DEFAULT_INPUTS[f.key];
      $('#in-' + f.key).value = v ?? '';
    }
    if (V2) {
      const c = inputs && inputs.characterId != null ? state.characters.find((x) => String(x.id) === String(inputs.characterId)) : null;
      $('#in-character').value = c ? c.name : (inputs && inputs.characterName) || '';
      state.restoredCharacter = inputs && inputs.characterName
        ? { id: inputs.characterId == null ? null : String(inputs.characterId), name: $('#in-character').value } : null;
      // 스킬·레벨 선택 복원(입력란 값은 기록값 그대로, 자동 입력하지 않음).
      state.skillCharName = $('#in-character').value.trim();
      const key = inputs && inputs.skillKey != null && inputs.skillKey !== '' ? String(inputs.skillKey) : null;
      const level = inputs && typeof inputs.skillLevel === 'number' ? inputs.skillLevel : null;
      renderSkillOptions(key && characterRef() ? { key, level, name: (inputs && inputs.skillName) || '',
        index: Number.isInteger(inputs.skillEntry) ? inputs.skillEntry : null, label: inputs.skillEntryLabel || '' } : null);
      renderAutoNotes();
    }
  }

  // ---------- 계산 ----------
  function calculate() {
    let inputs;
    try {
      inputs = readInputs();
    } catch (err) {
      setCalcMsg(err.message);
      return;
    }
    const items = Formula.SLOTS.map((s) => state.equipped[s]);
    if (items.some((it) => !it)) return;
    const result = Formula.calculate(items, inputs);
    // 기준 세트가 5칸 다 차 있으면 같은 입력값으로 기준 세트도 계산해 그 대비로 효율 %·기준 대비를 낸다(미완성이면 "—").
    const baseItems = Baseline.isComplete(state.baseline, Formula.SLOTS) ? Formula.SLOTS.map((s) => state.baseline[s]) : null;
    // 방어 관통이 자동값(현재 장비 합)이면 기준 세트는 기준 아이템의 합으로, 수동이면 그 값 그대로 계산한다.
    let baseInputs = inputs;
    if (baseItems) {
      const cur = penAuto(state.equipped);
      const base = penAuto(state.baseline);
      baseInputs = { ...inputs };
      for (const [key, p] of Object.entries(PEN_NOTES)) if (penIsAuto(key, cur)) baseInputs[key] = tidy(base[p.auto]);
    }
    const baseResult = baseItems ? Formula.calculate(baseItems, baseInputs) : null;
    const eff = Baseline.efficiency(result, baseResult);
    const entry = History.makeEntry({ equipped: state.equipped, inputs, result, efficiency: eff,
      baseline: Baseline.snapshot(state.baseline, Formula.SLOTS) });
    state.history = History.add(state.history, entry);
    saveHistory();
    renderResult(result, items, inputs, eff, baseItems, baseResult, baseInputs);
    renderHistory();
  }

  function renderResult(r, items, inputs, eff, baseItems, baseResult, baseInputs) {
    const box = $('#result');
    // 큰 숫자 3개(데미지 총량 · 데미지 효율 · 기준 대비) + 작은 줄(가격 · 1,000당) + 비교 표. 산출 기준은 툴팁.
    const stat = (label, value, extra) => el('div', { className: 'stat', title: extra.title || '' },
      el('span', { className: 'stat-label', textContent: label }),
      el('span', { className: 'stat-value' + (extra.accent ? ' accent' : ''), textContent: value }));
    const noBase = '기준 없음 — 기준 세트 5칸을 모두 채우면 계산합니다';
    const nodes = [el('div', { className: 'result-stats' },
      stat('데미지 총량', fmt(r.D), {}),
      stat(Baseline.LABELS.pct, Baseline.pctText(eff.pct), { accent: true, title: !baseResult ? noBase
        : eff.pct == null ? '가격 합이 0이라 계산하지 않습니다' : '현재 세트 가격당 데미지 ÷ 기준 세트 가격당 데미지 × 100' }),
      stat(Baseline.LABELS.gain, Baseline.signedPct(eff.gainPct), { accent: true, title: baseResult ? '(현재 D ÷ 기준 D − 1) × 100' : noBase })),
    el('p', { className: 'stat-sub', title: baseResult ? '1,000당 = 기준 대비 증가율 ÷ 현재 가격 합 × 1000' : noBase,
      textContent: `가격 ${fmt(r.price)} · ${baseResult ? Baseline.per1000Text(eff.per1000) : '기준 없음'}` })];
    if (baseResult) {
      // 비교 표: 행 = 기준 / 현재 / 차이, 열 = 가격 합 · 데미지 총량 · 가격당 데미지.
      const signed = (v, d) => (v == null ? '—' : (v > 0 ? '+' : '') + fmt(v, d));
      const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
      const rows = Baseline.compareRows(r, baseResult).map((row) => {
        const diff = row.label === '차이';
        const f = diff ? signed : (v, d) => (v == null ? '—' : fmt(v, d));
        const td = (v, d) => el('td', { textContent: f(v, d), className: diff ? sign(v) : '' });
        return el('tr', { className: diff ? 'diff' : '' }, el('th', { scope: 'row', textContent: row.label }),
          td(row.price), td(row.D), td(row.ratio, 4));
      });
      nodes.push(el('table', { className: 'compare' },
        el('thead', null, el('tr', null, ...['', '가격 합', '데미지 총량', '가격당 데미지'].map((t) => el('th', { scope: 'col', textContent: t })))),
        el('tbody', null, ...rows)));
    }
    // 실제 숫자를 대입한 계산 과정(식 한 줄씩)은 접기/펼치기(기본 접힘, 상태는 localStorage에 기억).
    const steps = el('details', { className: 'all-steps', open: window.ERExplain.loadStepsOpen(localStorage) },
      el('summary', { textContent: '계산 과정 보기' }),
      el('pre', { className: 'steps', textContent: explainLines(items, inputs, r, eff.refRatio, '기준 세트', eff).join('\n') }));
    steps.addEventListener('toggle', () => window.ERExplain.saveStepsOpen(localStorage, steps.open));
    if (baseResult) {
      steps.append(el('details', { className: 'base-steps' },
        el('summary', { textContent: `기준 세트 계산 과정 (D = ${fmt(baseResult.D)})` }),
        el('pre', { className: 'steps', textContent: explainLines(baseItems, baseInputs || inputs, baseResult, null).join('\n') })));
    }
    nodes.push(steps);
    box.replaceChildren(...nodes);
    box.hidden = false;
  }

  // ---------- 히스토리 ----------
  // 슬롯 순서대로 아이콘 5개. 아이콘은 기록의 id로 현재 데이터에서 찾고,
  // 데이터에 없거나 이미지 로드가 실패하면 빈 자리 + 이름을 보인다.
  function historyIcons(entry, extraClass = '') {
    const row = el('div', { className: 'hist-icons' + extraClass });
    for (const s of History.slotItems(entry, Formula.SLOTS, state.byId)) {
      const box = el('div', { className: 'hist-icon' });
      if (s.imageUrl) {
        const img = el('img', { src: s.imageUrl, alt: '', loading: 'lazy' });
        img.onerror = () => { img.style.visibility = 'hidden'; };
        box.append(img);
      }
      // 이름은 툴팁으로만(조밀한 기록 행). 데이터에 없는 아이템은 점선 칸.
      const cell = el('div', { className: 'hist-item' + (s.found ? '' : ' missing'), title: `${s.slot}: ${s.name}${s.found ? '' : ' (현재 데이터에 없음)'}` }, box);
      row.append(cell);
    }
    return row;
  }

  function renderHistory() {
    const list = $('#history');
    list.replaceChildren();
    for (const btn of document.querySelectorAll('#history-tabs button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.sort === state.historySort));
    }
    for (const e of History.sorted(state.history, state.historySort)) {
      const current = History.isCurrent(e);
      const eff = History.entryEfficiency(e);
      const hasBase = e.baselineIds && Object.keys(e.baselineIds).length;
      // 기준 세트 아이콘(작게): 이 기록이 어떤 기준 세트 대비였는지.
      const baseRow = hasBase
        ? el('div', { className: 'hist-base' }, el('span', { className: 'muted small', textContent: '기준' }),
          historyIcons({ itemIds: e.baselineIds, itemNames: e.baselineNames }, ' small'))
        : null;
      const del = closeButton('이 기록 삭제');
      del.classList.add('del');
      del.onclick = (ev) => {
        ev.stopPropagation();
        // 삭제 뒤 포커스는 같은 자리(다음 기록, 없으면 앞 기록)로.
        const idx = [...list.children].indexOf(li);
        state.history = History.remove(state.history, e.id);
        saveHistory();
        hideResult();
        renderHistory();
        const rows = list.querySelectorAll('li[tabindex]');
        const next = rows[Math.min(idx, rows.length - 1)];
        if (next) next.focus();
        else $('#clear-history').focus();
      };
      // 왼쪽: 현재 세트 아이콘 줄, 기준 줄, 메타 줄(시각 · 데미지 · 가격).
      // 오른쪽 열(세로 중앙): 위 "효율 58.6%"(크게), 아래 "기준 대비 +47.4%", 더 작게 "1,000당 +41.0%".
      // 산출 기준·기준 없음·이전 계산식 사유는 툴팁.
      const effTitle = !current ? '이전 계산식 기록 — 효율 비교 제외'
        : e.efficiencyMode === 'baseline' ? '기준 세트 대비' : '기준 없음';
      const effNode = el('div', { className: 'hist-eff' + (current ? '' : ' old'), title: effTitle },
        el('span', { className: 'hist-eff-top' },
          el('span', { className: 'hist-eff-label', textContent: '효율' }),
          el('span', { className: 'hist-eff-value', textContent: Baseline.pctText(eff.pct) })),
        el('span', { className: 'hist-eff-gain', textContent: `${Baseline.LABELS.gain} ${Baseline.signedPct(eff.gainPct)}` }),
        el('span', { className: 'hist-eff-sub', textContent: current && e.efficiencyMode !== 'baseline' ? '기준 없음' : Baseline.per1000Text(eff.per1000) }));
      const date = new Date(e.time);
      const time = date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const li = el('li', { title: '클릭하면 이 구성을 불러옵니다', tabIndex: 0 },
        el('div', { className: 'hist-main' },
          el('div', { className: 'hist-row' }, historyIcons(e), baseRow),
          el('div', { className: 'hist-meta' },
            el('span', { className: 'hist-time', textContent: time, title: date.toLocaleString('ko-KR') }),
            el('span', { className: 'hist-sub', textContent: `데미지 ${fmt(e.result.D)} · 가격 ${fmt(e.result.price)}` }))),
        effNode,
        del);
      li.onclick = () => restore(e);
      li.onkeydown = (ev) => {
        if (ev.target === li && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          restore(e);
        }
      };
      list.append(li);
    }
    if (!state.history.length) list.append(el('li', { className: 'empty', textContent: '아직 기록이 없습니다.' }));
  }

  function restore(entry) {
    const missing = [];
    state.equipped = {};
    for (const slot of Formula.SLOTS) {
      const id = entry.itemIds && entry.itemIds[slot];
      const item = id != null ? state.byId.get(String(id)) : null;
      if (item) state.equipped[slot] = item;
      else missing.push(`${slot}(${(entry.itemNames && entry.itemNames[slot]) || id})`);
    }
    // 기준 세트를 저장한 기록이면 그 기준 세트도 복원(저장 전 기록은 현재 기준 유지).
    if (entry.baselineIds && typeof entry.baselineIds === 'object') {
      const saved = {};
      for (const [slot, id] of Object.entries(entry.baselineIds)) saved[slot] = { id, name: (entry.baselineNames || {})[slot] };
      const { set, missing: baseMissing } = Baseline.resolve(saved, state.byId, Formula.SLOTS);
      state.baseline = set;
      saveBaseline();
      missing.push(...baseMissing.map((s) => '기준 ' + s));
    }
    writeInputs(History.penTotals(entry.inputs, penAuto(state.equipped)));
    renderSlots();
    if (missing.length) setCalcMsg('현재 데이터에 없어 비워 둔 아이템: ' + missing.join(', '));
  }

  // ---------- 시작 ----------
  async function init() {
    // 기본(새 계산식) 제목은 index.html에 있다. 이전 계산식(v1) 빌드만 제목을 바꾼다.
    if (!V2) $('h1').textContent = document.title = '이터널 리턴 아이템 가격 대비 데미지 효율 계산기';
    const gradeSel = $('#picker-grade');
    gradeSel.append(el('option', { value: '', textContent: '모든 등급' }));
    for (const g of GRADES) gradeSel.append(el('option', { value: g, textContent: g }));
    window.ERDropdown.enhance(gradeSel);
    window.ERDropdown.clearable($('#picker-search'));
    $('#picker-search').oninput = renderPicker;
    $('#picker-search').onkeydown = pickerKey;
    gradeSel.onchange = renderPicker;
    $('#picker-close').onclick = () => $('#picker').close();
    $('#data-meta').onclick = () => { renderMetaPanel(); $('#meta-panel').showModal(); };
    $('#meta-close').onclick = () => $('#meta-panel').close();
    $('#calc-btn').onclick = calculate;
    for (const btn of document.querySelectorAll('#history-tabs button')) {
      btn.onclick = () => { state.historySort = btn.dataset.sort; renderHistory(); };
    }
    $('#clear-history').onclick = () => {
      if (!state.history.length || !confirm('히스토리를 모두 삭제할까요?')) return;
      state.history = [];
      saveHistory();
      hideResult();
      renderHistory();
    };
    $('#baseline-clear').onclick = () => {
      state.baseline = {};
      saveBaseline();
      renderBaseline();
    };
    // 장비 슬롯 5칸만 비운다(히스토리·기준 세트는 그대로).
    $('#slots-clear').onclick = () => {
      const hadWeapon = !!state.equipped['무기'];
      state.equipped = {};
      renderSlots();
      applyPenAuto();
      if (hadWeapon) applyAuto('amp');
      focusSlotButton('#slots', `${Formula.SLOTS[0]} 선택`);
    };
    // 머리글 상태 문구는 한 줄로 잘리므로 전체 문장을 툴팁으로(데스크톱이 넣는 #app-update-status 포함).
    const syncStatusTitles = () => {
      for (const s of document.querySelectorAll('#update-status, #app-update-status')) {
        const t = s.textContent.trim();
        if (s.title !== t) s.title = t;
      }
    };
    new MutationObserver(syncStatusTitles).observe($('header .update-box'), { childList: true, subtree: true, characterData: true });
    syncStatusTitles();
    renderInputs();
    // 숫자 입력란은 마우스 휠로 값이 바뀌지 않게(포커스 중 휠 기본 동작 차단).
    $('#inputs').addEventListener('wheel', (ev) => {
      if (ev.target.type === 'number' && document.activeElement === ev.target) ev.preventDefault();
    }, { passive: false });
    $('#inputs').addEventListener('input', (ev) => {
      if (V2 && ev.target.id === 'in-skill') {
        renderSkillLevels(null);
        applySkill();
        return;
      }
      if (V2 && ev.target.id === 'in-skillLevel') {
        applySkill();
        return;
      }
      const which = V2 && { 'in-character': 'both', 'in-level': 'atk', 'in-masteryLevel': 'amp' }[ev.target.id];
      if (which) {
        applyAuto(which);
        if (which === 'both') syncSkillCharacter();
        return;
      }
      hideResult();
      updateSkillAmpTotal();
      renderAutoNotes();
      renderPenNotes();
    });
    renderSlots();
    const [, , meta] = await Promise.all([loadData(), V2 ? loadCharacters() : null, fetchMeta(), V2 ? loadSkills() : null]);
    setMeta(meta);
    // 최초 로딩이 끝난 뒤에 버튼을 연다(늦게 끝난 최초 로딩이 갱신 데이터를 덮어쓰지 않도록).
    setupUpdater();
    setupAppUpdateGauge();
    loadBaseline();
    // 데이터 로딩 뒤에 히스토리를 보여 줘야 클릭 복원 시 아이템을 찾을 수 있다.
    state.history = History.load(localStorage);
    renderHistory();
    renderSlots();
  }

  init();
})();
