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
