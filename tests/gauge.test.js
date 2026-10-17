'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../src/gauge.js');
const U = require('../src/updater.js');

test('원형 게이지: 퍼센트 범위·링 오프셋, 문구는 괄호 없이 구분점으로', () => {
  assert.equal(G.clampPct(42.4), 42);
  assert.equal(G.clampPct(150), 100);
  assert.equal(G.clampPct(-3), 0);
  assert.equal(G.clampPct(null), null);
  assert.equal(G.dashOffset(0), G.CIRC);
  assert.equal(G.dashOffset(100), 0);
  assert.ok(Math.abs(G.dashOffset(50) - G.CIRC / 2) < 1e-9);
  const text = G.detailText([U.progressText({ stage: 'skills', done: 12, total: 28 }), '약 20초 남음']);
  assert.equal(text, '스킬 수집 중 12/28 · 약 20초 남음');
  assert.doesNotMatch(text, /[()]/);
  assert.equal(G.detailText(['', '약 2분 예상']), '약 2분 예상');
  assert.equal(G.HIDE_AFTER_MS, 1000);
});

test('업데이트 진행률(fraction): 경과 ÷ (경과 + 남은 시간), 병렬 단계·skills 등장에도 뒤로 가지 않고 완료 전 100% 아님', () => {
  const eta = U.createEta(0, 100000);
  assert.equal(eta.fraction(0), 0);
  assert.ok(Math.abs(eta.fraction(10000) - 0.1) < 1e-9); // 이벤트 전: 초기 예상치(100초) 기준
  // 병렬 실행으로 고정 단계 3개가 먼저 끝나도 skills 전에는 초기 예상치보다 앞서가지 않는다.
  eta.update({ stage: 'items', done: 1, total: 1 });
  eta.update({ stage: 'characters', done: 1, total: 1 });
  eta.update({ stage: 'patchnotes', done: 1, total: 1 });
  const before = eta.fraction(20000);
  assert.ok(Math.abs(before - 0.2) < 1e-9);
  // skills 0/28: 작업량 3/31 → 남은 시간이 늘어도 게이지는 유지
  eta.update({ stage: 'skills', done: 0, total: 28 });
  assert.equal(eta.fraction(21000), before);
  // skills 14/28: 비율 17/31 → 경과/(경과+남은) = 17/31
  eta.update({ stage: 'skills', done: 14, total: 28 });
  assert.ok(Math.abs(eta.fraction(40000) - 17 / 31) < 1e-9);
  eta.update({ stage: 'skills', done: 28, total: 28 });
  assert.equal(eta.fraction(60000), 0.99); // 100%는 완료 처리(gauge.done)에서
});

test('게이지 마크업·스타일: 스크립트 포함, 강조색 링 120ms 전환, 실패 시 경고색, 퍼센트 tabular-nums', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  assert.match(html, /<script src="src\/gauge\.js"><\/script>[\s\S]*<script src="src\/app\.js">/);
  assert.match(css, /\.gauge-bar \{[^}]*stroke: var\(--accent\)[^}]*transition: stroke-dashoffset 120ms/);
  assert.match(css, /\.gauge\.error \.gauge-bar \{ stroke: var\(--warn\)/);
  assert.match(css, /\.gauge-pct \{[^}]*tabular-nums/);
});
