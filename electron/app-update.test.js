'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const {
  RELEASES_API, compareVersions, checkForUpdate, downloadAsset, launchSwap, SWAP_SCRIPT,
} = require('./app-update');

function tmpDir(prefix = 'er-app-update-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const json = (status, body) => async () => new Response(JSON.stringify(body), { status });
const release = (tag, assets = []) => ({ tag_name: tag, body: '변경 내역', html_url: `https://github.com/x/y/releases/tag/${tag}`, assets });
const exeAsset = (name, size = 10) => ({ name, browser_download_url: `https://example.test/${name}`, size });

test('compareVersions orders semver including v prefix and prereleases', () => {
  assert.ok(compareVersions('1.1.0', '1.0.9') > 0);
  assert.ok(compareVersions('v1.10.0', '1.9.0') > 0);
  assert.strictEqual(compareVersions('v1.1.0', '1.1.0'), 0);
  assert.ok(compareVersions('1.1.0-beta.2', '1.1.0') < 0);
  assert.ok(compareVersions('1.1.0-beta.10', '1.1.0-beta.2') > 0);
  assert.ok(compareVersions('1.1.0-alpha', '1.1.0-alpha.1') < 0);
  assert.ok(compareVersions('2.0.0', '10.0.0') < 0);
  assert.throws(() => compareVersions('1.1', '1.0.0'), /버전 형식이 아닙니다: 1\.1/);
});

test('checkForUpdate: no release (404) or same/older tag is latest, newer tag is available with the exe asset', async () => {
  let called;
  const no = await checkForUpdate({ fetch: async (url, init) => { called = { url, init }; return new Response('{}', { status: 404 }); }, currentVersion: '1.1.0' });
  assert.deepStrictEqual(no, { status: 'latest', current: '1.1.0', version: null });
  assert.strictEqual(called.url, RELEASES_API);
  assert.match(called.init.headers['User-Agent'], /1\.1\.0/);
  assert.strictEqual((await checkForUpdate({ fetch: json(200, release('v1.1.0')), currentVersion: '1.1.0' })).status, 'latest');
  assert.strictEqual((await checkForUpdate({ fetch: json(200, release('v1.0.0')), currentVersion: '1.1.0' })).status, 'latest');
  const NEW = 'ER-Damage-Calculator-1.2.0-portable.exe';
  const OLD = 'ER-Damage-Calculator-v2-1.2.0-portable.exe';
  const V1 = 'ER-Damage-Calculator-v1-1.2.0-portable.exe';
  const assets = [exeAsset(V1, 1), exeAsset(OLD, 2), exeAsset(NEW, 99)];
  assert.deepStrictEqual(await checkForUpdate({ fetch: json(200, release('v1.2.0', assets)), currentVersion: '1.1.0' }), {
    status: 'available', current: '1.1.0', version: '1.2.0', notes: '변경 내역', url: 'https://github.com/x/y/releases/tag/v1.2.0',
    asset: { name: NEW, url: `https://example.test/${NEW}`, size: 99 },
  });
  const pick = async (list) => (await checkForUpdate({ fetch: json(200, release('v1.2.0', list)), currentVersion: '1.1.0' })).asset;
  assert.strictEqual((await pick([exeAsset(V1), exeAsset(OLD)])).name, OLD); // 옛 이름만 있으면 그것을 받는다
  assert.strictEqual(await pick([exeAsset(V1), exeAsset('ER-Damage-Calculator-1.2.0.zip')]), null);
  // 다른 버전 이름의 자산은 고르지 않는다.
  assert.strictEqual((await pick([exeAsset('ER-Damage-Calculator-1.1.0-portable.exe'), exeAsset(OLD)])).name, OLD);
  assert.strictEqual(await pick([exeAsset('ER-Damage-Calculator-1.2.0junk-portable.exe')]), null);
  assert.strictEqual(await pick([]), null);
});

test('checkForUpdate failures name the reason', async () => {
  await assert.rejects(checkForUpdate({ fetch: json(403, {}), currentVersion: '1.1.0' }), /업데이트 확인 실패: HTTP 403/);
  await assert.rejects(checkForUpdate({ fetch: json(200, release('latest')), currentVersion: '1.1.0' }), /릴리스 태그를 읽지 못했습니다\(latest\)/);
  const offline = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
  await assert.rejects(checkForUpdate({ fetch: offline, currentVersion: '1.1.0' }), /업데이트 확인 실패: fetch failed \(ENOTFOUND\)/);
});

test('downloadAsset writes the file and reports progress; bad size/content removes it', async () => {
  const root = tmpDir();
  const dest = path.join(root, 'app.exe.download');
  const body = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(70000, 1)]);
  const seen = [];
  const fetch = async (url) => {
    assert.strictEqual(url, 'https://example.test/1.2.0.exe');
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  };
  const res = await downloadAsset({ fetch, asset: { url: 'https://example.test/1.2.0.exe', size: body.length }, dest, onProgress: (p) => seen.push(p) });
  assert.deepStrictEqual(res, { received: body.length, total: body.length });
  assert.ok(fs.readFileSync(dest).equals(body));
  assert.ok(seen.length >= 1);
  assert.deepStrictEqual(seen[seen.length - 1], { received: body.length, total: body.length });

  await assert.rejects(downloadAsset({ fetch, asset: { url: 'https://example.test/1.2.0.exe', size: 5 }, dest }), /다운로드 실패: 크기가 다릅니다/);
  assert.ok(!fs.existsSync(dest));
  const html = async () => new Response('<html>');
  await assert.rejects(downloadAsset({ fetch: html, asset: { url: 'x', size: 0 }, dest }), /다운로드 실패: 받은 파일이 exe가 아닙니다/);
  assert.ok(!fs.existsSync(dest));
  await assert.rejects(downloadAsset({ fetch: json(404, {}), asset: { url: 'x', size: 0 }, dest }), /다운로드 실패: HTTP 404/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('downloadAsset fails when no data arrives for idleMs', async () => {
  const root = tmpDir();
  const dest = path.join(root, 'app.exe.download');
  const stalled = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('MZ')); } }); // 더 오지 않음
  const fetch = async (_url, { signal }) => {
    assert.ok(signal);
    return new Response(stalled);
  };
  await assert.rejects(downloadAsset({ fetch, asset: { url: 'x', size: 100 }, dest, idleMs: 100 }), /다운로드 실패: 응답 없음\(0\.1초 동안 데이터 없음\)/);
  assert.ok(!fs.existsSync(dest));
  fs.rmSync(root, { recursive: true, force: true });
});

// spawn 흉내: 다음 틱에 'spawn' 또는 'error' 를 낸다.
function fakeSpawn(outcome) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    calls.push({ cmd, args, opts, child });
    process.nextTick(() => (outcome instanceof Error ? child.emit('error', outcome) : child.emit('spawn')));
    return child;
  };
  return { fn, calls };
}

test('launchSwap writes an ASCII CRLF script and starts it detached with paths in the environment', async () => {
  const root = tmpDir();
  const target = path.join(root, 'app.exe');
  const { fn, calls } = fakeSpawn();
  const env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATH: 'p', ER_SMOKE_OUT: 'x', PORTABLE_EXECUTABLE_FILE: 'y', ER_UPDATE_API: 'z' };
  const script = await launchSwap({ target, downloaded: `${target}.download`, pid: 42, failMarker: path.join(root, 'fail.txt'), env, spawnFn: fn });
  assert.strictEqual(script, `${target}.update.cmd`);
  const text = fs.readFileSync(script, 'latin1');
  assert.strictEqual(text, SWAP_SCRIPT);
  assert.ok(/^[\x00-\x7f]*$/.test(text));
  assert.ok(!/[^\r]\n/.test(text));
  const [call] = calls;
  assert.strictEqual(call.cmd, env.ComSpec);
  assert.deepStrictEqual(call.args, ['/d', '/v:off', '/s', '/c', '""%ER_SCRIPT%""']);
  assert.deepStrictEqual(call.opts.env, {
    ComSpec: env.ComSpec, PATH: 'p', ER_UPDATE_API: 'z', ER_SCRIPT: script,
    ER_TARGET: target, ER_NEW: `${target}.download`, ER_PID: '42', ER_FAIL: path.join(root, 'fail.txt'),
  });
  assert.ok(call.opts.detached && call.opts.windowsHide && call.opts.windowsVerbatimArguments && call.child.unrefed);
  fs.rmSync(root, { recursive: true, force: true });
});

test('launchSwap rejects and removes the script when cmd cannot be started', async () => {
  const root = tmpDir();
  const target = path.join(root, 'app.exe');
  const { fn } = fakeSpawn(Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(launchSwap({ target, downloaded: 'd', pid: 1, failMarker: 'f', env: {}, spawnFn: fn }), /ENOENT/);
  assert.ok(!fs.existsSync(`${target}.update.cmd`));
  fs.rmSync(root, { recursive: true, force: true });
});

// 실제 cmd 로 교체 배치 실행(공백·괄호·% 가 든 경로). 임시 exe: 원본 = ping.exe 복사본(실행 중 잠김), 새 파일 = hostname.exe 복사본.
const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const windows = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitGone(file, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!fs.existsSync(file)) return true;
    await sleep(200);
  }
  return false;
}

// 배치가 start 로 띄운 임시 exe 가 끝나 폴더를 지울 수 있을 때까지 재시도.
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

// 기다릴 PID 로 넘길 짧은 프로세스(곧 끝남).
const briefPid = () => spawn(path.join(SYS, 'PING.EXE'), ['-n', '1', '127.0.0.1'], { stdio: 'ignore', windowsHide: true }).pid;

test('swap script waits for the running exe, keeps the original as .old and puts the new file in place', { skip: !windows && 'Windows only' }, async () => {
  const root = tmpDir('er swap (test) %TEMP% ');
  const target = path.join(root, 'App (x86).exe');
  const downloaded = `${target}.download`;
  const failMarker = path.join(root, 'fail.txt');
  fs.copyFileSync(path.join(SYS, 'PING.EXE'), target);
  fs.copyFileSync(path.join(SYS, 'HOSTNAME.EXE'), downloaded);
  const original = fs.readFileSync(target);
  const fresh = fs.readFileSync(downloaded);
  // exe 를 잠근 채 약 5초 실행. 넘기는 PID 는 다른 짧은 프로세스라 잠금 대기만으로 기다려야 한다.
  const holder = spawn(target, ['-n', '6', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  const holderDone = new Promise((r) => holder.on('exit', r));
  const started = Date.now();
  const script = await launchSwap({ target, downloaded, pid: briefPid(), failMarker });
  // holder 가 확실히 실행 중인 처음 3초 동안은 원본이 그대로여야 한다.
  while (Date.now() - started < 3000) {
    assert.strictEqual(holder.exitCode, null);
    assert.ok(fs.readFileSync(target).equals(original), 'replaced while the exe was running');
    await sleep(100);
  }
  await holderDone;
  assert.ok(await waitGone(script, 30000), 'swap script did not finish');
  assert.ok(fs.readFileSync(target).equals(fresh));
  assert.ok(fs.readFileSync(`${target}.old`).equals(original));
  assert.ok(!fs.existsSync(downloaded));
  assert.ok(!fs.existsSync(failMarker));
  cleanup(root);
});

test('swap script restores the original and leaves the fail marker when the new file is missing or cannot start', { skip: !windows && 'Windows only' }, async () => {
  for (const bad of [null, Buffer.from('MZ not an exe')]) {
    const root = tmpDir('er swap (test) ');
    const target = path.join(root, 'App.exe');
    const downloaded = `${target}.download`;
    const failMarker = path.join(root, 'fail.txt');
    fs.copyFileSync(path.join(SYS, 'HOSTNAME.EXE'), target);
    if (bad) fs.writeFileSync(downloaded, bad);
    const original = fs.readFileSync(target);
    const script = await launchSwap({ target, downloaded, pid: briefPid(), failMarker });
    assert.ok(await waitGone(script, 30000), 'swap script did not finish');
    assert.ok(fs.readFileSync(target).equals(original));
    assert.ok(!fs.existsSync(`${target}.old`));
    assert.ok(!fs.existsSync(downloaded));
    assert.ok(fs.existsSync(failMarker));
    cleanup(root);
  }
});

