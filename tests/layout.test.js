'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');

test('레이아웃: 왼쪽 필요 폭·히스토리 남는 폭, 페이지 스크롤 없이 결과·히스토리 목록만 내부 스크롤, 1100px 미만 한 열', () => {
  assert.match(html, /<main class="layout">/);
  assert.match(html, /<section class="panel calc-panel">[\s\S]*class="block slot-pair"[\s\S]*id="slots"[\s\S]*id="baseline-slots"/);
  assert.match(html, /<section class="panel history-panel">[\s\S]*<ol id="history" class="history">/);
  assert.match(css, /body \{[^}]*overflow: hidden/);
  assert.match(css, /main\.layout \{[^}]*grid-template-columns: minmax\(720px, 760px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.calc-panel > \.result \{[^}]*overflow-y: auto/);
  assert.match(css, /\.history-panel > \.history \{[^}]*overflow-y: auto/);
  assert.match(css, /\.inputs \{[^}]*repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(css, /::-webkit-scrollbar \{ width: 8px/);
  assert.match(css, /@media \(max-width: 1099px\) \{[\s\S]*body \{ display: block; overflow: auto/);
});

test('결과·히스토리 효율 표시: 큰 숫자 3개(데미지·효율·기준 대비) + 가격·1,000당 작은 줄, 히스토리 3단', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(app, /stat\('데미지 총량'[\s\S]{0,80}stat\(Baseline\.LABELS\.pct[\s\S]{0,400}stat\(Baseline\.LABELS\.gain/);
  assert.match(app, /className: 'stat-sub'[\s\S]{0,200}`가격 \$\{fmt\(r\.price\)\} · \$\{baseResult \? Baseline\.per1000Text\(eff\.per1000\) : '기준 없음'\}`/);
  assert.match(app, /'hist-eff-value'[\s\S]{0,200}'hist-eff-gain'[\s\S]{0,200}'hist-eff-sub'/);
  assert.match(css, /\.result-stats \{ display: flex; gap: 32px; \}/);
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  assert.match(main, /height: 900,\s*minHeight: 800,/);
});

test('입력 컨트롤: 네이티브 select·datalist 팝업 대신 앱 드롭다운, 숫자 스핀 숨김·휠 차단', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(html, /<script src="src\/dropdown\.js"><\/script>\s*<script src="src\/app\.js">/);
  for (const v of ['skillSel', 'levelSel', 'gradeSel']) assert.match(app, new RegExp(`ERDropdown\\.enhance\\(${v}\\)`));
  assert.match(app, /ERDropdown\.combo\(input,/);
  assert.doesNotMatch(app, /datalist|setAttribute\('list'/);
  assert.match(app, /addEventListener\('wheel'[\s\S]{0,160}preventDefault\(\)[\s\S]{0,20}\{ passive: false \}/);
  assert.match(css, /input\[type="number"\]::-webkit-inner-spin-button[^{]*\{ -webkit-appearance: none/);
  assert.match(css, /\.dd-list\[popover\] \{ position: fixed;[^}]*overflow-y: auto/);
  // 검색 입력란: 기본 × 숨김, 앱 × 버튼은 값 있을 때만, 짧은 placeholder
  assert.match(app, /placeholder: '실험체 검색'/);
  assert.match(app, /ERDropdown\.clearable\(input\)[\s\S]*ERDropdown\.clearable\(\$\('#picker-search'\)\)/);
  assert.match(css, /input\[type="search"\]::-webkit-search-cancel-button \{ -webkit-appearance: none; display: none; \}/);
  assert.match(css, /\.search-box input:placeholder-shown \+ \.search-clear \{ display: none; \}/);
});

test('머리글: 좌(제목/메타)·우(앱 행/데이터 행) 두 블록, 28px 두 행, 같은 폭 버튼 세로 정렬, 상태 문구 말줄임 없음', () => {
  const app0 = () => fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(css, /\.title-row \{ display: grid; grid-template-rows: 28px 28px; row-gap: 4px/);
  assert.match(css, /\.update-box \{ display: grid; grid-template-columns: auto auto; grid-template-rows: 28px 28px; row-gap: 4px; justify-content: end/);
  assert.match(css, /#app-update-status, #app-update-check \{ grid-row: 1; \}/);
  assert.match(css, /\.update-state, #update-split \{ grid-row: 2; \}/);
  assert.match(css, /#app-update-check, #update-split \{ grid-column: 2; justify-self: stretch; \}/);
  assert.match(css, /#app-update-check, #update-btn \{ height: 28px; padding: 0 10px; \}/);
  assert.match(css, /\.split-btn #update-more \{ flex: none; width: 28px;/);
  assert.doesNotMatch(css + app0(), /update-all-btn/);
  assert.match(html, /<span id="update-split" class="split-btn" hidden><button id="update-btn" type="button"><span class="label-idle">아이템 업데이트<\/span><span class="label-busy">업데이트 중…<\/span><\/button><button id="update-more"/);
  assert.match(css, /#update-btn > span \{ grid-area: 1 \/ 1; \}/);
  assert.match(css, /#update-btn \.label-busy, #update-btn\.busy \.label-idle \{ visibility: hidden; \}/);
  assert.match(app0(), /btn\.classList\.add\('busy'\)[\s\S]*btn\.classList\.remove\('busy'\)/);
  assert.doesNotMatch(app0(), /btn\.textContent = /);
  // 취소(×): cancelUpdate가 있을 때만, 진행 중에만 보이고, 취소되면 결과 무시.
  assert.match(css, /#update-cancel \{ width: 20px; height: 20px; flex: none; \}/);
  assert.match(css, /#update-cancel:hover:not\(:disabled\), #update-cancel:focus-visible \{ background: #c42b1c; color: #fff; \}/);
  assert.match(app0(), /typeof \(window\.erDesktop && window\.erDesktop\.cancelUpdate\) === 'function'/);
  assert.match(app0(), /title: '업데이트 취소', hidden: true/);
  assert.match(app0(), /setStatus\('취소 중…'/);
  assert.match(app0(), /setStatus\('업데이트 취소됨', '', false, true\)/);
  assert.match(app0(), /if \(cancelled\) return; \/\/ 취소됨/);
  assert.match(app0(), /ERDropdown\.menu\(more, \$\('#update-split'\), '업데이트 방식', \['전체 재확인 · 약 2분'\], \(\) => run\('all'\)\)/);
  assert.match(app0(), /btn\.onclick = \(\) => run\('patched'\)/);
  assert.match(app0(), /btn\.disabled = true;\s*more\.disabled = true;/);
  assert.match(css, /\.update-state \{ display: flex;[^}]*gap: 8px; margin-left: auto; min-width: 220px/);
  assert.match(html, /<span class="update-state"><span id="update-status"/);
  assert.match(html, />아이템 업데이트<\/span>/);
  assert.doesNotMatch(css, /#(app-)?update-status[^{]*\{[^}]*(ellipsis|overflow: hidden)/);
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(app, /short: '아이템 외 %스증'/);
  assert.match(app, /short: '대상 스킬피해 감소 %'/);
  assert.match(app, /labelText\(f\.short \|\| f\.label, f\.label\)/);
  assert.match(html, /<div class="update-box">\s*<div id="data-update-group" class="update-group" hidden>\s*<span class="update-state">/);
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
  assert.match(preload, /id: 'app-update-group', className: 'update-group'/);
  assert.match(preload, /`최신 버전 v\$\{res\.current\}`/);
});

test('슬롯 두 열 헤더: 32px 한 줄 고정, 제목·버튼 nowrap, 상태 말줄임', () => {
  assert.match(css, /\.slot-col > \.block-head \{ height: 32px;[^}]*flex-wrap: nowrap/);
  assert.match(css, /\.slot-col > \.block-head h2 \{ white-space: nowrap; flex-shrink: 0/);
  assert.match(css, /\.slot-col > \.block-head \.muted \{ overflow: hidden; text-overflow: ellipsis/);
  assert.match(css, /\.slot-col > \.block-head \.text-btn \{ white-space: nowrap; flex-shrink: 0/);
});

test('히스토리 효율 열: 오른쪽 세로 중앙, 숫자 20~22px 굵게', () => {
  assert.match(css, /\.history li:not\(\.empty\) \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*align-items: center/);
  const m = css.match(/\.hist-eff-value \{[^}]*font-size: (\d+)px;[^}]*font-weight: 700/);
  assert.ok(m && +m[1] >= 20 && +m[1] <= 22);
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(app, /className: 'hist-eff-value'/);
});

test('hover/포커스: 비활성 탭 밝게, 링크형 버튼 강조색, 120ms 전환', () => {
  assert.match(css, /--fast: 120ms/);
  assert.match(css, /\.tabs button\[aria-pressed="false"\]:hover[^{]*\{ background: var\(--hover\); color: var\(--text\)/);
  assert.match(css, /\.text-btn:hover:not\(:disabled\)[^{]*\{[^}]*color: var\(--accent\)/);
  assert.match(css, /\.link-btn:hover:not\(:disabled\)[^{]*\{ color: var\(--accent\)/);
  assert.match(css, /\.meta-line:hover[^{]*\{ color: var\(--accent\)/);
  assert.match(css, /button:hover:not\(:disabled\) \{[^}]*background: var\(--hover\)/);
});

test('전체 비우기: 장비 슬롯·기준 세트 헤더 모두 "전체 비우기" text-btn, 장비 쪽은 equipped만 비움', () => {
  const js = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(html, /<h2>장비 슬롯<\/h2>[\s\S]*<button id="slots-clear" class="text-btn" type="button" aria-label="장비 슬롯 전체 비우기" disabled>전체 비우기<\/button>[\s\S]*id="slots"/);
  assert.match(html, /<button id="baseline-clear" class="text-btn" type="button" aria-label="기준 세트 전체 비우기" disabled>전체 비우기<\/button>[\s\S]*id="baseline-slots"/);
  assert.doesNotMatch(html, /기준 비우기|슬롯 비우기/);
  const handler = js.slice(js.indexOf("$('#slots-clear').onclick"), js.indexOf('renderInputs();', js.indexOf("$('#slots-clear').onclick")));
  assert.match(handler, /state\.equipped = \{\}/);
  assert.doesNotMatch(handler, /baseline|history/);
});

test('슬롯 행: 행 전체가 role=button(클릭·Enter·Space), 선택/변경 버튼 없음, 비우기는 전파 차단, 행 50px·아이콘 40px', () => {
  const js = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  const body = js.slice(js.indexOf('function slotCard('), js.indexOf('function renderSlots('));
  assert.match(body, /setAttribute\('role', 'button'\)/);
  assert.match(body, /aria-label', `\$\{slot\} \$\{item \? '변경' : '선택'\}`/);
  assert.match(body, /card\.onclick/);
  assert.match(body, /ev\.key !== 'Enter' && ev\.key !== ' '/);
  assert.match(body, /ev\.stopPropagation\(\); onClear\(\)/);
  assert.doesNotMatch(body, /textContent: item \? '변경' : '선택'/);
  assert.match(css, /\.slot \{[^}]*height: 50px[^}]*transition: background-color 120ms, border-color 120ms/);
  assert.match(css, /\.slot:hover, \.slot:focus-visible \{[^}]*border-color: var\(--accent\)/);
  assert.match(css, /\.slot img \{ width: 40px; height: 40px/);
});
