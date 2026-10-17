'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/dropdown.js');

test('드롭다운 키 이동: 비활성 항목 건너뛰고 끝에서 멈춤', () => {
  const dis = [false, true, false, false];
  assert.equal(D.nextIndex(dis, 0, 1), 2);
  assert.equal(D.nextIndex(dis, 2, -1), 0);
  assert.equal(D.nextIndex(dis, 3, 1), 3);
  assert.equal(D.nextIndex(dis, -1, 1), 0); // Home
  assert.equal(D.nextIndex(dis, 4, -1), 3); // End
});

test('타이핑 검색: 같은 첫 글자는 다음 항목으로 순환, 이어 치면 접두어 일치', () => {
  const texts = ['스킬 선택 안 함', 'Q 화살', 'W 방패', 'Q2 연사', 'E 도약'];
  const dis = texts.map(() => false);
  assert.equal(D.typeaheadIndex(texts, dis, 0, 'q'), 1);
  assert.equal(D.typeaheadIndex(texts, dis, 1, 'q'), 3);
  assert.equal(D.typeaheadIndex(texts, dis, 3, 'q'), 1);
  assert.equal(D.typeaheadIndex(texts, dis, 1, 'q2'), 3);
  assert.equal(D.typeaheadIndex(texts, dis, 0, 'x'), -1);
});

test('실험체 후보: 앞부분 일치 먼저, 포함 일치 다음, 빈 검색은 전체', () => {
  const names = ['아비게일', '아르다', '블레어', '레오나르도'];
  assert.deepEqual(D.filterItems(names, '아'), ['아비게일', '아르다']);
  assert.deepEqual(D.filterItems(names, '레'), ['레오나르도', '블레어']);
  assert.deepEqual(D.filterItems(names, ' '), names);
});

test('목록은 아래로 열리고 최대 320px, 아래 공간이 모자라면 줄임', () => {
  assert.deepEqual(D.placement({ left: 10.4, bottom: 100, width: 200 }, 900), { left: 10, top: 102, width: 200, maxHeight: 320 });
  assert.equal(D.placement({ left: 0, bottom: 700, width: 100 }, 900).maxHeight, 190);
  // 아래 공간이 96px 미만이고 위가 더 넓을 때만 위로(화면 밖으로 나가지 않게)
  const up = D.placement({ left: 0, top: 862, bottom: 890, width: 100 }, 900);
  assert.equal(up.top, undefined);
  assert.equal(up.bottom, 40);
  assert.equal(up.maxHeight, 320);
  // 아래 공간이 96px 이상이면 그대로 아래(높이만 줄임)
  assert.deepEqual(D.placement({ left: 0, top: 752, bottom: 780, width: 100 }, 900), { left: 0, top: 782, width: 100, maxHeight: 110 });
});

test('타이핑 검색어: 같은 글자 반복은 한 글자(순환), 다른 글자는 누적', () => {
  assert.equal(D.searchPrefix('qq'), 'q');
  assert.equal(D.searchPrefix('qqq'), 'q');
  assert.equal(D.searchPrefix('q2'), 'q2');
  assert.equal(D.searchPrefix('아르'), '아르');
});
