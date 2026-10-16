'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/updater');

test('canUpdate: window.erDesktop.updateItems가 함수일 때만 true', () => {
  assert.equal(U.canUpdate({ erDesktop: { updateItems: async () => ({}) } }), true);
  assert.equal(U.canUpdate({}), false); // 웹(npm start)
  assert.equal(U.canUpdate({ erDesktop: {} }), false);
  assert.equal(U.canUpdate({ erDesktop: { updateItems: 'x' } }), false);
  assert.equal(U.canUpdate(undefined), false);
});

test('runUpdate 성공: reload 후 "아이템 N개 갱신 완료"', async () => {
  const calls = [];
  const desktop = { updateItems: async () => { calls.push('update'); return { count: 312, savedPath: 'C:/x/items.json' }; } };
  const r = await U.runUpdate(desktop, async () => { calls.push('reload'); return true; });
  assert.deepEqual(calls, ['update', 'reload']);
  assert.deepEqual(r, { ok: true, count: 312, message: '아이템 312개 갱신 완료' });
});

test('runUpdate 실패: reject면 reload하지 않고 오류 메시지', async () => {
  let reloaded = false;
  const desktop = { updateItems: async () => { throw new Error('네트워크 오류'); } };
  const r = await U.runUpdate(desktop, async () => { reloaded = true; return true; });
  assert.equal(reloaded, false);
  assert.equal(r.ok, false);
  assert.equal(r.message, '업데이트 실패: 네트워크 오류');
});

test('runUpdate: 갱신 뒤 데이터 다시 읽기에 실패하면 오류', async () => {
  const r = await U.runUpdate({ updateItems: async () => ({ count: 1 }) }, async () => false);
  assert.equal(r.ok, false);
  // 다시 읽기가 예외를 던져도 reject하지 않고 실패 결과를 돌려준다(버튼 복구 보장).
  const t = await U.runUpdate({ updateItems: async () => ({ count: 1 }) }, async () => { throw new Error('x'); });
  assert.equal(t.ok, false);
});

test('rematch: 장착 슬롯을 id로 새 데이터에 다시 매칭, 없어진 id는 비움', () => {
  const old = { 무기: { id: 'w1', slot: '무기', name: '옛 검' }, 머리: { id: 'h9', slot: '머리', name: '사라진 투구' } };
  const freshW = { id: 'w1', slot: '무기', name: '새 검', stats: { 공격력: 99 } };
  const byId = new Map([['w1', freshW]]);
  const { equipped, removed } = U.rematch(old, byId);
  assert.equal(equipped['무기'], freshW);
  assert.equal('머리' in equipped, false);
  assert.deepEqual(removed, ['머리(사라진 투구)']);
});
