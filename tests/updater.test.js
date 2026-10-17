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
  assert.deepEqual(r, { ok: true, count: 312, meta: null, skills: null, message: '아이템 312개 갱신 완료' });
});

test('runUpdate: 반환에 meta 객체가 있으면 결과에 그대로, 아니면 null', async () => {
  const meta = { dakggVersion: '12.6.0', overrides: [] };
  const r = await U.runUpdate({ updateItems: async () => ({ count: 1, savedPath: 'x', meta }) }, async () => true);
  assert.equal(r.meta, meta);
  for (const bad of [undefined, null, 'x', [1]]) {
    const t = await U.runUpdate({ updateItems: async () => ({ count: 1, meta: bad }) }, async () => true);
    assert.equal(t.meta, null);
  }
  const u = await U.runUpdate({ updateItems: async () => undefined }, async () => true);
  assert.equal(u.meta, null);
});

test('runUpdate: meta 반환이 있으면 파일을 다시 읽지 않고, 없으면 reloadMeta 결과를 쓴다', async () => {
  const given = { dakggVersion: 'A' };
  const fromFile = { dakggVersion: 'B' };
  let reads = 0;
  const reloadMeta = async () => { reads++; return fromFile; };
  const a = await U.runUpdate({ updateItems: async () => ({ count: 1, meta: given }) }, async () => true, reloadMeta);
  assert.equal(a.meta, given);
  assert.equal(reads, 0);
  const b = await U.runUpdate({ updateItems: async () => ({ count: 1 }) }, async () => true, reloadMeta);
  assert.equal(b.meta, fromFile);
  assert.equal(reads, 1);
  // 메타 다시 읽기가 실패해도 업데이트 성공은 유지, meta는 null
  const c = await U.runUpdate({ updateItems: async () => ({ count: 1 }) }, async () => true, async () => { throw new Error('x'); });
  assert.equal(c.ok, true);
  assert.equal(c.meta, null);
  // 업데이트 실패면 메타도 읽지 않는다
  await U.runUpdate({ updateItems: async () => { throw new Error('y'); } }, async () => true, reloadMeta);
  assert.equal(reads, 1);
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
