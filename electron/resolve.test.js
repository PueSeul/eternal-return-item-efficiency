'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveFile, contentType } = require('./resolve');

function tmpDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'er-resolve-'));
  const appRoot = path.join(base, 'app');
  const extRoot = path.join(base, 'ext');
  fs.mkdirSync(path.join(appRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'index.html'), 'x');
  fs.writeFileSync(path.join(appRoot, 'data', 'items.json'), '[1]');
  fs.mkdirSync(extRoot);
  return { base, appRoot, extRoot };
}

test('root and plain paths map into app root', () => {
  const { appRoot } = tmpDirs();
  assert.strictEqual(resolveFile('/', appRoot, null), path.join(appRoot, 'index.html'));
  assert.strictEqual(resolveFile('/src/app.js', appRoot, null), path.join(appRoot, 'src', 'app.js'));
});

test('data falls back to bundled file when no external copy exists', () => {
  const { appRoot, extRoot } = tmpDirs();
  assert.strictEqual(resolveFile('/data/items.json', appRoot, extRoot), path.join(appRoot, 'data', 'items.json'));
});

test('external data/ next to exe takes priority', () => {
  const { appRoot, extRoot } = tmpDirs();
  fs.mkdirSync(path.join(extRoot, 'data'));
  fs.writeFileSync(path.join(extRoot, 'data', 'items.json'), '[2]');
  assert.strictEqual(resolveFile('/data/items.json', appRoot, extRoot), path.join(extRoot, 'data', 'items.json'));
  // data/ 밖의 파일은 외부 폴더에서 읽지 않는다.
  fs.writeFileSync(path.join(extRoot, 'index.html'), 'evil');
  assert.strictEqual(resolveFile('/index.html', appRoot, extRoot), path.join(appRoot, 'index.html'));
});

test('traversal and malformed paths are rejected', () => {
  const { appRoot, extRoot } = tmpDirs();
  assert.strictEqual(resolveFile('/%2e%2e/secret', appRoot, extRoot), null);
  assert.strictEqual(resolveFile('/data/%2e%2e/%2e%2e/secret', appRoot, null), null);
  assert.strictEqual(resolveFile('/a%00b', appRoot, null), null);
  assert.strictEqual(resolveFile('/%E0%A4%A', appRoot, null), null);
  // 외부 data/ 탈출 시도는 외부에서 거절되고 앱 폴더 기준으로도 밖이면 null.
  assert.strictEqual(resolveFile('/data/..%5C..%5Csecret', appRoot, extRoot), null);
});

test('content types', () => {
  assert.strictEqual(contentType('a/items.json'), 'application/json; charset=utf-8');
  assert.strictEqual(contentType('a/INDEX.HTML'), 'text/html; charset=utf-8');
  assert.strictEqual(contentType('a/x.bin'), 'application/octet-stream');
});
