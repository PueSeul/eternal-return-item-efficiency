'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');

test('레이아웃: 두 열 1:1, 히스토리 sticky + 목록만 내부 스크롤, 1100px 미만 한 열', () => {
  assert.match(html, /<main class="layout">/);
  assert.match(html, /<section class="panel calc-panel">/);
  assert.match(html, /<section class="panel history-panel">[\s\S]*<ol id="history" class="history">/);
  assert.match(css, /main\.layout \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(css, /\.history-panel \{[^}]*position: sticky; top: 16px; max-height: calc\(100vh - 32px\)/);
  assert.match(css, /\.history-panel > \.history \{[^}]*overflow-y: auto/);
  assert.match(css, /@media \(max-width: 1099px\) \{[\s\S]*\.history-panel \{ position: static/);
});
