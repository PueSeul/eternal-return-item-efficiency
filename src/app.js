(function () {
  'use strict';
  const Formula = window.ERFormula;
  const History = window.ERHistory;
  const DATA_URL = 'data/items.json';
  const GRADES = ['일반', '고급', '희귀', '영웅', '전설', '신화'];
  const INPUT_FIELDS = [
    { key: 'level', label: '레벨', hint: "'레벨 당' 스탯 × 레벨", step: 1, min: 1 },
    { key: 'skillDamage', label: '스킬 기본 피해량 (S)', hint: '스킬 툴팁의 피해량 고정 수치(예: 200)', step: 'any', min: 0 },
    { key: 'atkCoefPct', label: '공격력 계수 (%)', hint: '툴팁 "(+공격력의 X%)"의 X, 없으면 0', step: 'any', min: 0 },
    { key: 'skillAmpCoefPct', label: '스킬 증폭 계수 (%)', hint: '툴팁 "(+스킬 증폭의 X%)"의 X, 없으면 0', step: 'any', min: 0 },
    { key: 'defense', label: '피격 대상 방어력 (R)', hint: '대상의 방어력, 0 이상', step: 'any', min: 0 },
    { key: 'enemySkillReductionPct', label: '적의 스킬 피해 감소율 (%)', hint: 'A 항에서 뺌', step: 'any' },
    { key: 'enemySkillReduction', label: '적의 스킬 피해 감소 (고정)', hint: 'I 항에서 뺌', step: 'any' },
    { key: 'extraFinalIncreasePct', label: '추가 최종 피해 증가율 (%)', hint: '아이템 외 F 항 가산', step: 'any' },
    { key: 'enemyFinalReductionPct', label: '적의 최종 피해 감소율 (%)', hint: 'F 항에서 뺌', step: 'any' },
  ];

  const $ = (sel) => document.querySelector(sel);
  const state = { items: [], byId: new Map(), equipped: {}, history: [], historySort: 'recent', pickerSlot: null };
  const defaultText = (key) => (Formula.DEFAULT_INPUTS[key] == null ? '기본값 없음, 직접 입력' : `기본값 ${Formula.DEFAULT_INPUTS[key]}`);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  const fmt = (n, d = 2) => (n == null || !Number.isFinite(n) ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d }));

  function itemImage(item) {
    const img = el('img', { src: item.imageUrl || '', alt: item.name, loading: 'lazy' });
    img.onerror = () => { img.style.visibility = 'hidden'; };
    return img;
  }

  function statsText(item) {
    return Object.entries(item.stats || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '스탯 없음';
  }

  function showBanner(text) {
    const b = $('#data-banner');
    b.textContent = text;
    b.hidden = false;
  }

  // ---------- 데이터 ----------
  async function loadData() {
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
    state.items = list.filter((it) => it && Formula.SLOTS.includes(it.slot));
    state.byId = new Map(state.items.map((it) => [String(it.id), it]));
    const missing = Formula.SLOTS.filter((s) => !state.items.some((it) => it.slot === s));
    if (!state.items.length) showBanner('data/items.json에 장비 아이템이 없습니다. `scripts/fetch_items.py`를 다시 실행하세요.');
    else if (missing.length) showBanner(`다음 부위의 아이템이 데이터에 없습니다: ${missing.join(', ')}`);
    const sources = [...new Set(state.items.map((it) => it.priceSource).filter(Boolean))];
    $('#price-note').textContent = '가격 출처(데이터 파일의 priceSource): ' + (sources.length ? sources.join(' / ') : '표기 없음');
  }

  // ---------- 슬롯 ----------
  // 구성·입력이 바뀌거나 비교 기준(히스토리)이 바뀌면 이전 결과는 현재 상태와 맞지 않으므로 숨긴다.
  function hideResult() {
    $('#result').hidden = true;
  }

  function saveHistory() {
    try {
      History.save(localStorage, state.history);
    } catch (err) {
      alert('히스토리를 저장하지 못했습니다: ' + err.message);
    }
  }

  function renderSlots() {
    hideResult();
    const box = $('#slots');
    box.replaceChildren();
    for (const slot of Formula.SLOTS) {
      const item = state.equipped[slot];
      const card = el('div', { className: 'slot' + (item ? ' filled' : '') }, el('div', { className: 'label', textContent: slot }));
      if (item) {
        card.append(
          itemImage(item),
          el('div', { className: 'grade-' + item.grade, textContent: item.name }),
          el('div', { className: 'muted', textContent: `${item.grade} · 가격 ${fmt(item.price)}` }),
        );
      } else {
        card.append(el('div', { className: 'muted', textContent: '비어 있음' }));
      }
      const pick = el('button', { type: 'button', textContent: item ? '변경' : '선택', disabled: !state.items.length });
      pick.onclick = () => openPicker(slot);
      const actions = el('div', { className: 'actions' }, pick);
      if (item) {
        const clear = el('button', { type: 'button', textContent: '비우기' });
        clear.onclick = () => { delete state.equipped[slot]; renderSlots(); };
        actions.append(clear);
      }
      card.append(actions);
      box.append(card);
    }
    const filled = Formula.SLOTS.filter((s) => state.equipped[s]).length;
    const all = filled === Formula.SLOTS.length;
    $('#slot-status').textContent = all ? '모든 슬롯이 채워졌습니다.' : `${filled}/${Formula.SLOTS.length} 슬롯 채워짐 — 모든 슬롯을 채워야 계산할 수 있습니다.`;
    $('#calc-btn').disabled = !all;
  }

  // ---------- 아이템 선택 창 ----------
  function openPicker(slot) {
    state.pickerSlot = slot;
    $('#picker-title').textContent = `${slot} 아이템 선택`;
    $('#picker-search').value = '';
    $('#picker-grade').value = '';
    renderPicker();
    $('#picker').showModal();
    $('#picker-search').focus();
  }

  function renderPicker() {
    const q = $('#picker-search').value.trim().toLowerCase();
    const grade = $('#picker-grade').value;
    const list = $('#picker-list');
    list.replaceChildren();
    const rows = state.items.filter((it) => it.slot === state.pickerSlot &&
      (!grade || it.grade === grade) &&
      (!q || String(it.name).toLowerCase().includes(q)));
    for (const it of rows) {
      const li = el('li', null,
        itemImage(it),
        el('div', null,
          el('div', { className: 'grade-' + it.grade, textContent: `${it.name} (${it.grade})` }),
          el('div', { className: 'muted', textContent: `가격 ${fmt(it.price)}${it.priceSource ? ' — ' + it.priceSource : ''}` }),
          el('div', { className: 'stats', textContent: statsText(it) })));
      li.onclick = () => {
        state.equipped[state.pickerSlot] = it;
        $('#picker').close();
        renderSlots();
      };
      list.append(li);
    }
    if (!rows.length) list.append(el('li', { className: 'muted', textContent: '조건에 맞는 아이템이 없습니다.' }));
  }

  // ---------- 입력 ----------
  function renderInputs() {
    const form = $('#inputs');
    for (const f of INPUT_FIELDS) {
      const input = el('input', { type: 'number', id: 'in-' + f.key, step: f.step, value: Formula.DEFAULT_INPUTS[f.key] ?? '' });
      if (f.min != null) input.min = f.min;
      if (Formula.DEFAULT_INPUTS[f.key] == null) input.placeholder = '직접 입력';
      form.append(el('label', null, f.label, input, el('span', { className: 'hint', textContent: `${f.hint} (${defaultText(f.key)})` })));
    }
    const choice = el('select', { id: 'in-choiceStat' });
    for (const o of Formula.CHOICE_OPTIONS) choice.append(el('option', { value: o.value, textContent: o.label }));
    choice.value = Formula.DEFAULT_INPUTS.choiceStat;
    form.append(el('label', null, "'(택1)' 스탯 처리", choice,
      el('span', { className: 'hint', textContent: '둘 중 하나를 고르는 아이템 스탯을 어느 쪽으로 계산할지' })));
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
    out.choiceStat = $('#in-choiceStat').value;
    return out;
  }

  function writeInputs(inputs) {
    for (const f of INPUT_FIELDS) {
      const v = inputs && inputs[f.key] != null ? inputs[f.key] : Formula.DEFAULT_INPUTS[f.key];
      $('#in-' + f.key).value = v ?? '';
    }
    const choice = inputs && Formula.CHOICE_OPTIONS.some((o) => o.value === inputs.choiceStat)
      ? inputs.choiceStat : Formula.DEFAULT_INPUTS.choiceStat;
    $('#in-choiceStat').value = choice;
  }

  // ---------- 계산 ----------
  function calculate() {
    let inputs;
    try {
      inputs = readInputs();
    } catch (err) {
      alert(err.message);
      return;
    }
    const items = Formula.SLOTS.map((s) => state.equipped[s]);
    if (items.some((it) => !it)) return;
    const result = Formula.calculate(items, inputs);
    const entry = History.makeEntry({ equipped: state.equipped, inputs, result });
    state.history = History.add(state.history, entry);
    saveHistory();
    renderResult(result);
    renderHistory();
  }

  function renderResult(r) {
    const best = History.bestRatio(state.history);
    const pct = Formula.efficiencyPercent(r.ratio, best);
    const box = $('#result');
    const row = (k, v) => el('tr', null, el('td', { textContent: k }), el('td', { textContent: v }));
    box.replaceChildren(
      el('div', { className: 'big', textContent: `데미지 총량 D = ${fmt(r.D)}` }),
      el('div', { className: 'big', textContent: `데미지 효율 = ${pct == null ? '계산 불가(가격 합 0)' : fmt(pct, 1) + '%'}` }),
      el('div', { className: 'muted', textContent: `기준: 히스토리 전체 중 최고 (D ÷ 가격 합) = 100%. 이번 D ÷ 가격 합 = ${fmt(r.ratio, 4)} (가격 합 ${fmt(r.price)})` }),
      el('table', null,
        row('공격력 합 → S', fmt(r.stats.atk)),
        row('스킬 증폭 합 → S', fmt(r.stats.skillAmp)),
        row('스킬 증폭율 합 → A', fmt(r.stats.skillAmpRate, 4)),
        row('최종 피해 증가율 합(아이템) → F', fmt(r.stats.itemFinalRate, 4)),
        row('방어 관통율 / 방어 관통 합 → R\'', `${fmt(r.stats.penRate, 4)} / ${fmt(r.stats.pen)}`),
        row('S (스킬 정의 피해량)', fmt(r.S)),
        row("R' (적용 방어력)", fmt(r.R)),
        row('B (기본 피해)', fmt(r.B)),
        row('A (피해 증폭, 최소 0.1)', fmt(r.A, 4)),
        row('I (피해 증가)', fmt(r.I)),
        row('F (최종 피해 증폭)', fmt(r.F, 4))));
    box.hidden = false;
  }

  // ---------- 히스토리 ----------
  function renderHistory() {
    const list = $('#history');
    list.replaceChildren();
    const best = History.bestRatio(state.history);
    for (const btn of document.querySelectorAll('#history-tabs button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.sort === state.historySort));
    }
    for (const e of History.sorted(state.history, state.historySort)) {
      const current = History.isCurrent(e);
      const pct = current ? Formula.efficiencyPercent(e.result.ratio, best) : null;
      const names = Formula.SLOTS.map((s) => `${s}: ${(e.itemNames && e.itemNames[s]) || '?'}`).join(' / ');
      const del = el('button', { type: 'button', className: 'del', textContent: '×', title: '이 기록 삭제' });
      del.onclick = (ev) => {
        ev.stopPropagation();
        state.history = History.remove(state.history, e.id);
        saveHistory();
        hideResult();
        renderHistory();
      };
      const li = el('li', { title: '클릭하면 이 구성을 불러옵니다' },
        el('div', { className: 'muted', textContent: new Date(e.time).toLocaleString('ko-KR') }),
        el('div', { textContent: names }),
        el('div', { textContent: `D ${fmt(e.result.D)} · 가격 ${fmt(e.result.price)} · 효율 ${current ? (pct == null ? '-' : fmt(pct, 1) + '%') : '— (이전 계산식 기록, 효율 비교 제외)'}` }),
        del);
      li.onclick = () => restore(e);
      list.append(li);
    }
    if (!state.history.length) list.append(el('li', { className: 'muted', textContent: '아직 기록이 없습니다.' }));
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
    writeInputs(entry.inputs);
    renderSlots();
    if (missing.length) alert('현재 데이터에서 찾을 수 없는 아이템이 있어 비워 두었습니다: ' + missing.join(', '));
  }

  // ---------- 시작 ----------
  async function init() {
    const gradeSel = $('#picker-grade');
    gradeSel.append(el('option', { value: '', textContent: '모든 등급' }));
    for (const g of GRADES) gradeSel.append(el('option', { value: g, textContent: g }));
    $('#picker-search').oninput = renderPicker;
    gradeSel.onchange = renderPicker;
    $('#picker-close').onclick = () => $('#picker').close();
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
    renderInputs();
    $('#inputs').addEventListener('input', hideResult);
    renderSlots();
    await loadData();
    // 데이터 로딩 뒤에 히스토리를 보여 줘야 클릭 복원 시 아이템을 찾을 수 있다.
    state.history = History.load(localStorage);
    renderHistory();
    renderSlots();
  }

  init();
})();
