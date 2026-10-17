// 앱 스타일 드롭다운. 자체 타이틀바 창에서 네이티브 <select>/<datalist> 팝업 위치가 어긋나므로
// 버튼 + 목록(popover, 아래로 열림)으로 대신한다. 원래 <select>는 hidden으로 남겨 값·id·이벤트를 그대로 쓴다.
// - enhance(select): 버튼 클릭/재클릭·Esc·바깥 클릭으로 열고 닫음, ↑↓Home End Enter Space, 타이핑 검색.
// - combo(input, getItems): 검색 입력란 아래 후보 목록(↑↓Enter, Esc). 고르면 input 값을 바꾸고 input 이벤트.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ERDropdown = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_HEIGHT = 320;
  const TYPEAHEAD_MS = 600;

  // disabled가 아닌 다음 항목(step ±1, 끝에서 멈춤). 없으면 cur.
  function nextIndex(disabled, cur, step) {
    for (let i = cur + step; i >= 0 && i < disabled.length; i += step) if (!disabled[i]) return i;
    return cur;
  }
  // 타이핑 검색: cur 다음부터 한 바퀴 돌며 prefix로 시작하는 첫 항목. 없으면 -1.
  function typeaheadIndex(texts, disabled, cur, prefix) {
    const p = String(prefix).toLowerCase();
    if (!p) return -1;
    const n = texts.length;
    // 같은 글자 반복이 아니면 현재 항목부터(입력이 이어지는 중), 첫 글자면 다음 항목부터.
    const start = p.length > 1 ? 0 : 1;
    for (let k = start; k < n + start; k++) {
      const i = ((cur < 0 ? 0 : cur) + k) % n;
      if (!disabled[i] && String(texts[i]).toLowerCase().startsWith(p)) return i;
    }
    return -1;
  }
  // 같은 글자를 빠르게 반복(qq)하면 그 한 글자로 다음 항목 순환, 아니면 누적 접두어.
  function searchPrefix(typed) {
    const s = String(typed);
    return s.length > 1 && [...s].every((c) => c === s[0]) ? s[0] : s;
  }
  // 검색 후보: 앞부분 일치 먼저, 그다음 포함 일치(원래 순서 유지).
  function filterItems(items, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return items.slice();
    const head = [], mid = [];
    for (const s of items) {
      const t = String(s).toLowerCase();
      if (t.startsWith(q)) head.push(s); else if (t.includes(q)) mid.push(s);
    }
    return head.concat(mid);
  }
  // 목록 위치: 기준 요소 바로 아래, 최대 320px(아래 공간만큼 줄임). 아래 공간이 96px도 안 되고
  // 위가 더 넓을 때만(창 맨 아래 컨트롤) 위로 연다 — 목록이 화면 밖으로 나가지 않게.
  const MIN_BELOW = 96;
  function placement(rect, viewportHeight) {
    const left = Math.round(rect.left), width = Math.round(rect.width);
    const top = Math.round(rect.bottom + 2);
    const below = viewportHeight - top - 8;
    const above = Math.round(rect.top - 2) - 8;
    if (below < MIN_BELOW && above > below) {
      const maxHeight = Math.min(MAX_HEIGHT, above);
      return { left, width, maxHeight, bottom: Math.round(viewportHeight - rect.top + 2) };
    }
    return { left, top, width, maxHeight: Math.max(0, Math.min(MAX_HEIGHT, below)) };
  }

  // 모달 dialog 안에서 Esc로 목록만 닫을 때 dialog의 cancel(닫힘)을 이번 한 번 막는다.
  function swallowDialogCancel(anchor) {
    const dlg = anchor.closest('dialog');
    if (!dlg) return;
    const h = (e) => e.preventDefault();
    dlg.addEventListener('cancel', h, { once: true });
    setTimeout(() => dlg.removeEventListener('cancel', h), 0);
  }

  let seq = 0;
  let openPopup = null; // { close } — 한 번에 하나만 연다.

  // 공통 목록(popover). 모달 dialog 안이면 그 안에 붙여야 비활성(inert)이 되지 않는다.
  function makeList(anchor, label) {
    const list = document.createElement('ul');
    list.className = 'dd-list';
    list.id = 'dd-list-' + (++seq);
    list.setAttribute('role', 'listbox');
    if (label) list.setAttribute('aria-label', label);
    list.setAttribute('popover', 'manual');
    (anchor.closest('dialog') || document.body).append(list);
    return list;
  }

  function popupController(anchor, list, ctl, onClose) {
    let active = -1;
    const items = () => [...list.children];
    function setActive(i, scroll) {
      const lis = items();
      lis.forEach((li, k) => li.classList.toggle('active', k === i));
      active = i;
      if (lis[i]) {
        ctl.setAttribute('aria-activedescendant', lis[i].id);
        if (scroll) lis[i].scrollIntoView({ block: 'nearest' });
      } else ctl.removeAttribute('aria-activedescendant');
    }
    function position() {
      const p = placement(anchor.getBoundingClientRect(), window.innerHeight);
      Object.assign(list.style, { left: p.left + 'px', top: p.top == null ? 'auto' : p.top + 'px',
        bottom: p.bottom == null ? 'auto' : p.bottom + 'px', minWidth: p.width + 'px', maxHeight: p.maxHeight + 'px' });
    }
    const isOpen = () => list.matches(':popover-open');
    function onDocDown(ev) {
      if (!list.contains(ev.target) && !anchor.contains(ev.target)) close();
    }
    function onScroll(ev) { if (ev.target !== list && !list.contains(ev.target)) close(); }
    function open() {
      if (isOpen()) return;
      if (openPopup) openPopup.close();
      list.showPopover();
      position();
      ctl.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onDocDown, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', close);
      openPopup = { close };
    }
    function close() {
      if (!isOpen()) return;
      list.hidePopover();
      ctl.setAttribute('aria-expanded', 'false');
      ctl.removeAttribute('aria-activedescendant');
      document.removeEventListener('pointerdown', onDocDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      if (openPopup && openPopup.close === close) openPopup = null;
      if (onClose) onClose();
    }
    // 목록을 눌러도 포커스는 버튼·입력란에 남긴다.
    list.addEventListener('mousedown', (ev) => ev.preventDefault());
    list.addEventListener('mousemove', (ev) => {
      const li = ev.target.closest('li[role="option"]');
      const i = items().indexOf(li);
      if (i >= 0 && i !== active && li.getAttribute('aria-disabled') !== 'true') setActive(i, false);
    });
    return { open, close, isOpen, setActive, position, active: () => active, items };
  }

  function option(listId, i, text, selected, disabled) {
    const li = document.createElement('li');
    li.id = `${listId}-o${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (disabled) li.setAttribute('aria-disabled', 'true');
    li.textContent = text;
    li.title = text;
    return li;
  }

  const CHEVRON = '<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

  function enhance(sel) {
    if (sel.dataset.dd) return;
    sel.dataset.dd = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    // 선택형 combobox(WAI-ARIA APG select-only): 포커스는 버튼, 활성 항목은 aria-activedescendant.
    btn.setAttribute('role', 'combobox');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const label = sel.getAttribute('aria-label') || '';
    if (label) btn.setAttribute('aria-label', label);
    btn.innerHTML = '<span class="dd-text"></span>' + CHEVRON;
    const text = btn.firstChild;
    // 라벨 클릭이 버튼으로 가도록 숨긴 select보다 앞에 둔다.
    sel.before(btn);
    sel.hidden = true;
    const list = makeList(btn, label);
    btn.setAttribute('aria-controls', list.id);
    const pc = popupController(btn, list, btn);

    function refresh() {
      const o = sel.selectedOptions[0];
      text.textContent = o ? o.textContent : '';
      btn.title = text.textContent;
      btn.disabled = sel.disabled;
      if (sel.disabled) pc.close();
    }
    function build() {
      const opts = [...sel.options];
      list.replaceChildren(...opts.map((o, i) => option(list.id, i, o.textContent, i === sel.selectedIndex, o.disabled)));
      return opts;
    }
    function choose(i) {
      const o = sel.options[i];
      pc.close();
      if (!o || o.disabled) return;
      if (sel.selectedIndex !== i) {
        sel.selectedIndex = i;
        refresh();
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function open(at) {
      if (sel.disabled) return;
      build();
      pc.open();
      pc.setActive(at == null ? sel.selectedIndex : at, true);
    }
    // 열린 목록을 select 상태(옵션·선택값)에 다시 맞춘다.
    function resync() {
      refresh();
      if (pc.isOpen()) { build(); pc.setActive(sel.selectedIndex, false); }
    }
    const disabledList = () => [...sel.options].map((o) => o.disabled);
    let typed = '', typedAt = 0;

    btn.addEventListener('click', () => (pc.isOpen() ? pc.close() : open()));
    list.addEventListener('click', (ev) => {
      const i = pc.items().indexOf(ev.target.closest('li[role="option"]'));
      if (i >= 0) { choose(i); btn.focus(); }
    });
    btn.addEventListener('keydown', (ev) => {
      const k = ev.key;
      const isOpen = pc.isOpen();
      if (k === 'Escape' || k === 'Tab') {
        if (isOpen) { pc.close(); if (k === 'Escape') { ev.preventDefault(); ev.stopPropagation(); swallowDialogCancel(btn); } }
        return;
      }
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
        ev.preventDefault();
        const dis = disabledList();
        if (!isOpen) {
          // Home·End는 열면서 바로 처음·끝으로, ↑↓는 현재 선택에서 시작.
          open(k === 'Home' ? nextIndex(dis, -1, 1) : k === 'End' ? nextIndex(dis, dis.length, -1) : null);
          return;
        }
        const cur = pc.active();
        const i = k === 'ArrowDown' ? nextIndex(dis, cur, 1) : k === 'ArrowUp' ? nextIndex(dis, cur, -1)
          : k === 'Home' ? nextIndex(dis, -1, 1) : nextIndex(dis, dis.length, -1);
        pc.setActive(i, true);
        return;
      }
      if (k === 'Enter' || k === ' ') {
        ev.preventDefault();
        if (k === ' ' && typed && Date.now() - typedAt < TYPEAHEAD_MS) { typeahead(' '); return; }
        if (isOpen) choose(pc.active()); else open();
        return;
      }
      if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); typeahead(k); }
    });
    // 타이핑 검색: 열려 있으면 해당 항목으로 이동, 닫혀 있으면 바로 선택.
    function typeahead(ch) {
      const now = Date.now();
      typed = now - typedAt < TYPEAHEAD_MS ? typed + ch : ch;
      typedAt = now;
      const opts = [...sel.options];
      const cur = pc.isOpen() ? pc.active() : sel.selectedIndex;
      const i = typeaheadIndex(opts.map((o) => o.textContent), opts.map((o) => o.disabled), cur, searchPrefix(typed));
      if (i < 0) return;
      if (pc.isOpen()) pc.setActive(i, true); else choose(i);
    }

    // 코드에서 바꾸는 select 값·옵션·disabled를 버튼에 반영한다.
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(sel, 'value', { configurable: true,
      get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); resync(); } });
    new MutationObserver(resync)
      .observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    refresh();
    return { button: btn, list, refresh };
  }

  // 스플릿 버튼의 ▾ 메뉴: trigger 클릭·Enter·↓로 열고(재클릭·Esc·바깥 클릭으로 닫힘), ↑↓Enter로 고른다.
  // 목록은 anchor(스플릿 버튼 전체) 아래에 같은 폭 이상으로 붙는다. onPick(i)는 고른 항목 번호.
  function menu(trigger, anchor, label, labels, onPick) {
    const list = makeList(anchor, label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', list.id);
    const pc = popupController(anchor, list, trigger);
    const dis = labels.map(() => false);
    function open(at) {
      if (trigger.disabled) return;
      list.replaceChildren(...labels.map((t, i) => option(list.id, i, t, false, false)));
      pc.open();
      pc.setActive(at, true);
    }
    function choose(i) {
      pc.close();
      if (i >= 0 && i < labels.length) onPick(i);
    }
    trigger.addEventListener('click', () => (pc.isOpen() ? pc.close() : open(0)));
    list.addEventListener('click', (ev) => {
      const i = pc.items().indexOf(ev.target.closest('li[role="option"]'));
      if (i >= 0) choose(i);
    });
    trigger.addEventListener('keydown', (ev) => {
      const k = ev.key;
      const isOpen = pc.isOpen();
      if (k === 'Escape' || k === 'Tab') {
        if (isOpen) { pc.close(); if (k === 'Escape') { ev.preventDefault(); ev.stopPropagation(); } }
      } else if (k === 'ArrowDown' || k === 'ArrowUp') {
        ev.preventDefault();
        if (!isOpen) open(k === 'ArrowDown' ? 0 : labels.length - 1);
        else pc.setActive(nextIndex(dis, pc.active(), k === 'ArrowDown' ? 1 : -1), true);
      } else if (k === 'Enter' || k === ' ') {
        ev.preventDefault();
        if (isOpen) choose(pc.active()); else open(0);
      }
    });
    return { list, close: pc.close, isOpen: pc.isOpen };
  }

  // 검색 입력란 + 후보 목록(네이티브 datalist 대신).
  function combo(input, getItems) {
    const label = input.getAttribute('aria-label') || '';
    const list = makeList(input, label ? label + ' 후보' : '');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.autocomplete = 'off';
    const pc = popupController(input, list, input);
    let shown = [];

    function render() {
      shown = filterItems(getItems(), input.value);
      if (!shown.length || (shown.length === 1 && shown[0] === input.value.trim())) { pc.close(); return; }
      list.replaceChildren(...shown.map((s, i) => option(list.id, i, s, s === input.value.trim(), false)));
      pc.open();
      pc.position();
      pc.setActive(-1, false);
    }
    function choose(i) {
      const v = shown[i];
      pc.close();
      if (v == null) return;
      if (input.value !== v) {
        input.value = v;
        choosing = true;
        try {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } finally { choosing = false; }
      }
    }
    let choosing = false;
    input.addEventListener('input', () => { if (!choosing && document.activeElement === input) render(); });
    input.addEventListener('click', () => (pc.isOpen() ? pc.close() : render()));
    input.addEventListener('blur', () => pc.close());
    list.addEventListener('click', (ev) => {
      const i = pc.items().indexOf(ev.target.closest('li[role="option"]'));
      if (i >= 0) choose(i);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.isComposing) return;
      const k = ev.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        ev.preventDefault();
        if (!pc.isOpen()) { render(); return; }
        const dis = shown.map(() => false);
        const cur = pc.active();
        // 아직 활성 항목이 없을 때 ↑는 마지막 후보부터.
        pc.setActive(k === 'ArrowDown' ? nextIndex(dis, cur, 1) : nextIndex(dis, cur < 0 ? dis.length : cur, -1), true);
      } else if (k === 'Enter') {
        if (pc.isOpen() && pc.active() >= 0) { ev.preventDefault(); choose(pc.active()); }
      } else if (k === 'Escape') {
        if (pc.isOpen()) { ev.preventDefault(); ev.stopPropagation(); swallowDialogCancel(input); pc.close(); }
      }
    });
    return { list, close: pc.close };
  }

  // type=search 입력란: 브라우저 기본 지우기(파란 ×) 대신 앱 톤 단색 × 버튼. 값이 있을 때만 보인다(CSS :placeholder-shown).
  const CROSS = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  function clearable(input) {
    const box = document.createElement('span');
    box.className = 'search-box';
    input.before(box);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-clear';
    btn.tabIndex = -1; // 키보드는 Esc로 지운다(기본 동작)
    btn.setAttribute('aria-label', '검색어 지우기');
    btn.title = '지우기';
    btn.innerHTML = CROSS;
    box.append(input, btn);
    btn.addEventListener('mousedown', (ev) => ev.preventDefault());
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      input.focus();
      if (input.value === '') return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return btn;
  }

  return { nextIndex, typeaheadIndex, searchPrefix, filterItems, placement, enhance, combo, menu, clearable, MAX_HEIGHT };
});
