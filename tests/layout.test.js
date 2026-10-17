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
