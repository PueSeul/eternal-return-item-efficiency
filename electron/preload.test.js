'use strict';
// preload.js 의 프로그램 업데이트 UI(머리글 1행)를 작은 가짜 DOM·ipcRenderer 로 실행해 동작을 확인한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

function fakeElement(tag) {
  const attrs = new Map();
  const listeners = {};
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(), children: [], hidden: false, disabled: false, title: '', textContent: '', style: {},
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    get href() { return attrs.get('href') || ''; },
    set href(v) { attrs.set('href', String(v)); },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    append: (...nodes) => el.children.push(...nodes),
    prepend: (...nodes) => el.children.unshift(...nodes),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    click: () => (listeners.click || []).forEach((fn) => fn()),
  };
  return el;
}

// preload.js 를 --er-app-update 로 불러온다. handlers: invoke 채널 → 함수. 반환: 요소 찾기·main 이벤트 보내기.
function mount(handlers) {
  const box = fakeElement('div');
  const all = [];
  const document = {
    readyState: 'complete',
    head: fakeElement('head'),
    body: fakeElement('body'),
    createElement: (tag) => { const e = fakeElement(tag); all.push(e); return e; },
    querySelector: (sel) => (sel === 'header .update-box' ? box : null),
    getElementById: () => null,
  };
  const listeners = {};
  const calls = [];
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: {
      invoke: async (channel, ...args) => { calls.push([channel, ...args]); return handlers[channel](...args); },
      on: (channel, fn) => { (listeners[channel] ||= []).push(fn); },
      removeListener: () => {},
    },
  };
  const load = Module._load;
  const argv = process.argv;
  Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
  global.document = document;
  process.argv = [...argv, '--er-app-update'];
  const file = path.join(__dirname, 'preload.js');
  delete require.cache[file];
  try {
    require(file);
  } finally {
    Module._load = load;
    process.argv = argv;
    delete global.document;
  }
  const byId = (id) => all.find((e) => e.id === id);
  const emit = (channel, payload) => (listeners[channel] || []).forEach((fn) => fn({}, payload));
  return { box, all, byId, emit, calls };
}

const tick = () => new Promise((r) => setImmediate(r));
const REL = { version: '1.9.0', notes: '변경 내용', url: 'https://github.com/x/releases/tag/v1.9.0' };

test('app update UI: no banner, one header-row button that turns into "지금 업데이트" with 나중에·릴리스 노트 on its left', async () => {
  const ui = mount({ 'app-update:dismiss': () => {} });
  const btn = ui.byId('app-update-check');
  const status = ui.byId('app-update-status');
  const [later, notes] = [ui.byId('app-update-later'), ui.byId('app-update-notes')];
  assert.equal(ui.all.find((e) => e.id === 'app-update-banner' || e.className.includes('banner')), undefined);
  assert.deepEqual(ui.box.children.map((g) => g.id), ['app-update-group']);
  assert.deepEqual(ui.box.children[0].children, [status, btn]); // 상태 칸이 버튼 왼쪽
  assert.deepEqual(status.children.map((e) => e.id), ['app-update-text', 'app-update-sep', 'app-update-later', 'app-update-notes']);
  const sep = ui.byId('app-update-sep');
  assert.equal(btn.textContent, '업데이트 확인');
  assert.ok(later.hidden && notes.hidden && sep.hidden);

  ui.emit('app-update:available', REL); // 시작 시 자동 확인 결과
  assert.equal(btn.textContent, '지금 업데이트');
  assert.ok(btn.classList.contains('primary'));
  assert.equal(ui.byId('app-update-text').textContent, '새 버전 v1.9.0');
  assert.ok(!later.hidden && !notes.hidden && !sep.hidden);
  assert.equal(notes.getAttribute('href'), REL.url);
  assert.equal(status.title, '변경 내용');

  later.click(); // 나중에: 버튼은 "업데이트 확인"으로, 문구는 버전만
  await tick();
  assert.deepEqual(ui.calls, [['app-update:dismiss', '1.9.0']]);
  assert.equal(btn.textContent, '업데이트 확인');
  assert.ok(!btn.classList.contains('primary'));
  assert.equal(ui.byId('app-update-text').textContent, '새 버전 v1.9.0');
  assert.ok(later.hidden && notes.hidden);
});

test('app update UI: check → install disables the button, failure shows the error and "다시 시도", which installs again', async () => {
  let fail = true;
  let release;
  const ui = mount({
    'app-update:check': async () => ({ status: 'available', current: '1.8.0', ...REL }),
    'app-update:install': () => new Promise((resolve, reject) => { release = () => (fail ? reject(new Error('HTTP 500')) : resolve({})); }),
  });
  const btn = ui.byId('app-update-check');
  const text = ui.byId('app-update-text');
  btn.click();
  await tick();
  assert.equal(btn.textContent, '지금 업데이트');
  btn.click();
  await tick();
  assert.ok(btn.disabled);
  assert.equal(text.textContent, '새 버전 v1.9.0 내려받는 중…');
  assert.ok(ui.byId('app-update-later').hidden);
  ui.emit('app-update:progress', { received: 5, total: 10, percent: 50 });
  assert.equal(text.textContent, '새 버전 v1.9.0'); // 퍼센트는 게이지(src/app.js)가 표시
  release();
  await tick();
  assert.equal(text.textContent, '업데이트 실패: HTTP 500');
  assert.equal(ui.byId('app-update-status').title, '업데이트 실패: HTTP 500 (현재 버전을 그대로 씁니다)');
  assert.equal(btn.textContent, '다시 시도');
  assert.ok(btn.classList.contains('primary') && !btn.disabled);
  fail = false;
  btn.click();
  await tick();
  release();
  await tick();
  assert.deepEqual(ui.calls.map((c) => c[0]), ['app-update:check', 'app-update:install', 'app-update:install']);
  assert.match(text.textContent, /^v1\.9\.0 내려받기 완료/);
});

test('app update UI: an available notice arriving during a check that answers latest ends in "업데이트 확인"', async () => {
  let answer;
  const ui = mount({ 'app-update:check': () => new Promise((resolve) => { answer = resolve; }) });
  const btn = ui.byId('app-update-check');
  btn.click();
  await tick();
  ui.emit('app-update:available', REL);
  answer({ status: 'latest', current: '1.9.0' });
  await tick();
  assert.equal(btn.textContent, '업데이트 확인');
  assert.ok(!btn.classList.contains('primary') && !btn.disabled);
  assert.equal(ui.byId('app-update-text').textContent, '최신 버전 v1.9.0');
  assert.ok(ui.byId('app-update-later').hidden);
});

test('app update UI: latest keeps "업데이트 확인" and shows the current version', async () => {
  const ui = mount({ 'app-update:check': async () => ({ status: 'latest', current: '1.9.0' }) });
  const btn = ui.byId('app-update-check');
  btn.click();
  await tick();
  assert.equal(btn.textContent, '업데이트 확인');
  assert.equal(ui.byId('app-update-text').textContent, '최신 버전 v1.9.0');
  assert.ok(!btn.disabled);
});
