'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/meta');

const META = {
  fetchedAt: '2026-10-17T02:30:00', // 시간대 없는 ISO는 로컬 시각으로 읽힌다(테스트가 시간대에 무관)
  dakggVersion: '12.6.0',
  patch: { id: 1, version: '12.6', title: '12.6 패치노트', url: 'https://example.com/p', date: '2026-10-16' },
  overrides: [
    { type: 'item', name: '여제', stat: '스킬 증폭', dakgg: 70, patchnote: 75 },
    { type: 'item', name: '여제', stat: '공격력', dakgg: 10, patchnote: 12 },
    { type: 'character', name: '아르다', stat: '공격력', dakgg: 37, patchnote: 39 },
    { type: 'item', name: '쿤달라', stat: '스킬 증폭율', dakgg: 0.1, patchnote: null },
  ],
  unparsed: [{ name: '이단심판관', text: '스킬 피해 일부 조정' }, { text: '이름 없는 문구' }],
};

test('headerText: 버전·패치노트·갱신 시각 한 줄, 메타 없으면 null', () => {
  assert.equal(M.headerText(META), '데이터: dak.gg 12.6.0 · 패치노트 12.6 · 갱신 2026-10-17 02:30');
  assert.equal(M.headerText(null), null);
  assert.equal(M.headerText([]), null);
  assert.equal(M.headerText({}), null);
  assert.equal(M.headerText({ dakggVersion: '12.6.0' }), '데이터: dak.gg 12.6.0');
  assert.equal(M.headerText({ fetchedAt: '어제' }), '데이터: 갱신 어제'); // 날짜가 아니면 원문
});

test('overrideLines: "이름 — 스탯: dak.gg 값 → 패치노트 값", 실험체 표시', () => {
  assert.deepEqual(M.overrideLines(META), [
    '여제 — 스킬 증폭: 70 → 75',
    '여제 — 공격력: 10 → 12',
    '아르다 (실험체) — 공격력: 37 → 39',
    '쿤달라 — 스킬 증폭율: 0.1 → -',
  ]);
  assert.deepEqual(M.overrideLines({ overrides: 'x' }), []);
  assert.deepEqual(M.overrideLines(undefined), []);
});

test('unparsedLines: 확인 필요 목록', () => {
  assert.deepEqual(M.unparsedLines(META), ['이단심판관 — 스킬 피해 일부 조정', '이름 없는 문구']);
  assert.deepEqual(M.unparsedLines({}), []);
});

test('patchedItems: type item만 이름별로 묶음(실험체 제외)', () => {
  const map = M.patchedItems(META);
  assert.deepEqual([...map.keys()], ['여제', '쿤달라']);
  assert.deepEqual(map.get('여제'), ['스킬 증폭: 70 → 75', '공격력: 10 → 12']);
  assert.equal(map.has('아르다'), false);
  assert.equal(M.patchedItems(null).size, 0);
});

test('형식이 틀린 필드(객체·toString 없음)도 예외 없이 무시', () => {
  const bad = { toString: null };
  const meta = {
    fetchedAt: bad, dakggVersion: bad, patch: { version: bad, title: bad, url: bad, date: bad },
    overrides: [{ type: 'item', name: bad, stat: bad, dakgg: bad, patchnote: bad }, { type: 'item', name: '여제', stat: '공격력', dakgg: bad, patchnote: 3 }, 5],
    unparsed: [{ name: bad, text: bad }, null],
  };
  assert.equal(M.headerText(meta), null);
  assert.deepEqual(M.overrideLines(meta), ['여제 — 공격력: - → 3']); // 이름 없는 항목은 제외
  assert.deepEqual(M.unparsedLines(meta), []);
  assert.deepEqual([...M.patchedItems(meta).keys()], ['여제']);
  assert.equal(M.formatTime(bad), '');
  assert.equal(M.safeUrl(bad), '');
});

test('safeUrl: http(s)만 허용', () => {
  assert.equal(M.safeUrl('https://example.com/p'), 'https://example.com/p');
  assert.equal(M.safeUrl('javascript:alert(1)'), '');
  assert.equal(M.safeUrl(undefined), '');
});
