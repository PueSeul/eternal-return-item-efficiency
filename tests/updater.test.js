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
  assert.deepEqual(r, { ok: true, count: 312, meta: null, skills: null, message: '아이템 312개 갱신 완료', short: '아이템 312개 갱신됨' });
});

test('runUpdate: count가 없으면 짧은 문구 "아이템 갱신됨"', async () => {
  const r = await U.runUpdate({ updateItems: async () => ({ note: 'x' }) }, async () => true);
  assert.equal(r.short, '아이템 갱신됨');
  assert.equal(r.message, '아이템 갱신 완료 — x');
});

test('runUpdate: 반환의 note(직접 수집 폴백 등)를 완료 문구 뒤에 붙인다', async () => {
  const r = await U.runUpdate({ updateItems: async () => ({ count: 3, note: 'GitHub 데이터를 받지 못해 직접 수집했습니다(x)' }) }, async () => true);
  assert.equal(r.message, '아이템 3개 갱신 완료 — GitHub 데이터를 받지 못해 직접 수집했습니다(x)');
});

test('progressText: GitHub 데이터 단계(manifest·download)와 폴백(message)', () => {
  assert.equal(U.progressText({ stage: 'manifest', done: 0, total: 1 }), 'GitHub 데이터 확인 중 0/1');
  assert.equal(U.progressText({ stage: 'download', done: 2, total: 4 }), 'GitHub 데이터 내려받는 중 2/4');
  assert.equal(U.progressText({ stage: 'fallback', message: 'GitHub 데이터를 받지 못해 직접 수집합니다(x)' }),
    'GitHub 데이터를 받지 못해 직접 수집합니다(x)…');
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

test('runUpdate 실패: {ok:false, error}로 돌려줘도 그 메시지, reload 안 함', async () => {
  let reloaded = false;
  const r = await U.runUpdate({ updateItems: async () => ({ ok: false, error: '나무위키 응답 없음' }) }, async () => { reloaded = true; return true; });
  assert.equal(reloaded, false);
  assert.deepEqual([r.ok, r.message], [false, '업데이트 실패: 나무위키 응답 없음']);
});

test('runUpdate: options(skillsMode)를 updateItems에 그대로 넘긴다', async () => {
  const seen = [];
  const desktop = { updateItems: async (o) => { seen.push(o); return { count: 1 }; } };
  await U.runUpdate(desktop, async () => true, null, null, { skillsMode: 'all' });
  await U.runUpdate(desktop, async () => true, null, null, { skillsMode: 'patched' });
  assert.deepEqual(seen, [{ skillsMode: 'all' }, { skillsMode: 'patched' }]);
});

test('예상 남은 시간: 초기 예상(기본 2분/지난 소요), 단계 가중치(고정 단계 1 + skills total건) 기반 추정', () => {
  assert.equal(U.etaText(U.createEta(0), 0), '약 2분 예상');
  assert.equal(U.etaText(U.createEta(0, 80000), 0), '약 1분 20초 예상');
  const eta = U.createEta(0);
  eta.update({ stage: 'items', done: 1, total: 1 });
  eta.update({ stage: 'characters' });
  // skills 전: 비율(10s ÷ 1/3 − 10s = 20s)보다 초기 예상의 남은 몫(120 − 10 = 110s)이 크다
  assert.equal(U.etaText(eta, 10000), '약 1분 50초 남음');
  eta.update({ stage: 'patchnotes' });
  eta.update({ stage: 'skills', done: 9, total: 91 });
  // 완료 3 + 9 / 전체 3 + 91 → 30s ÷ (12/94) − 30s = 205s
  assert.equal(U.etaText(eta, 30000), '약 3분 25초 남음');
  eta.update({ stage: 'skills', done: 91, total: 91 });
  assert.equal(U.etaText(eta, 60000), '곧 완료');
  assert.equal(U.durationText(45200), '46초');
  // 첫 이벤트 직후(경과 1초 미만)는 초기 예상치
  const early = U.createEta(0);
  early.update({ stage: 'skills', done: 10, total: 91 });
  assert.equal(U.etaText(early, 100), '약 2분 남음');
});

test('진행 문구: 단계·진행률, 모르는 단계는 message, 구독 함수 없으면 false', () => {
  assert.equal(U.progressText({ stage: 'items' }), '아이템 수집 중…');
  assert.equal(U.progressText({ stage: 'patchnotes', done: 0, total: 0 }), '패치노트 확인 중…');
  assert.equal(U.progressText({ stage: 'skills', done: 37, total: 91 }), '스킬 수집 중 37/91');
  assert.equal(U.progressText({ stage: 'x', message: '저장 중' }), '저장 중…');
  assert.equal(U.progressText(null), '');
  assert.equal(U.canProgress({ erDesktop: { onUpdateProgress: () => {} } }), true);
  assert.equal(U.canProgress({ erDesktop: { updateItems: async () => ({}) } }), false);
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
