'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const {
  RELEASES_API, compareVersions, checkForUpdate, downloadAsset, exeName, misnamedTarget, parseSwapArgs, launchSwap, launchRename, waitForExit, finishSwap, NO_RENAME, RENAME_SCRIPT,
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

test('launchSwap starts the new exe itself (no cmd/console) with the swap arguments, detached, without smoke/portable env', async () => {
  const { fn, calls } = fakeSpawn();
  const env = { PATH: 'p', ER_SMOKE_OUT: 'x', PORTABLE_EXECUTABLE_FILE: 'y', ER_UPDATE_API: 'z' };
  await launchSwap({ dest: 'C:\\d\\ER-Damage-Calculator-1.3.0-portable.exe', target: 'C:\\d\\old (1).exe', pid: 42, env, spawnFn: fn });
  const [call] = calls;
  assert.strictEqual(call.cmd, 'C:\\d\\ER-Damage-Calculator-1.3.0-portable.exe');
  assert.deepStrictEqual(call.args, ['--er-swap-from=C:\\d\\old (1).exe', '--er-swap-pid=42']);
  assert.deepStrictEqual(call.opts.env, { PATH: 'p', ER_UPDATE_API: 'z' });
  assert.ok(call.opts.detached && call.opts.stdio === 'ignore' && call.child.unrefed);
  const self = 'C:\\d\\ER-Damage-Calculator-1.3.0-portable.exe';
  const args = (from, pid) => ['exe', `--er-swap-from=${from}`, `--er-swap-pid=${pid}`];
  assert.deepStrictEqual(parseSwapArgs(args('C:\\d\\ER-Damage-Calculator-v2-1.1.0-portable.exe', 42), self),
    { from: 'C:\\d\\ER-Damage-Calculator-v2-1.1.0-portable.exe', pid: 42 });
  assert.strictEqual(parseSwapArgs(['exe', '--er-swap-pid=1'], self), null);
  // 다른 파일·다른 폴더·자기 자신·잘못된 PID·포터블 아님은 무시(아무것도 지우지 않음)
  assert.strictEqual(parseSwapArgs(args('C:\\d\\old (1).exe', 42), self), null);
  assert.strictEqual(parseSwapArgs(args('C:\\other\\ER-Damage-Calculator-1.1.0-portable.exe', 42), self), null);
  assert.strictEqual(parseSwapArgs(args(self, 42), self), null);
  assert.strictEqual(parseSwapArgs(args('C:\\d\\ER-Damage-Calculator-1.1.0-portable.exe', 'abc'), self), null);
  assert.strictEqual(parseSwapArgs(args('C:\\d\\ER-Damage-Calculator-1.1.0-portable.exe', 0), self), null);
  assert.strictEqual(parseSwapArgs(args('C:\\d\\ER-Damage-Calculator-1.1.0-portable.exe', 42), null), null);
  const fail = fakeSpawn(Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' }));
  await assert.rejects(launchSwap({ dest: 'd', target: 't', pid: 1, env: {}, spawnFn: fail.fn }), /UNKNOWN/);
});

test('misnamedTarget: a release-pattern name for another version maps to the running version name, other names are left alone', () => {
  const root = tmpDir();
  const at = (n) => path.join(root, n);
  assert.strictEqual(exeName('1.2.0'), 'ER-Damage-Calculator-1.2.0-portable.exe');
  assert.strictEqual(misnamedTarget(at('ER-Damage-Calculator-v2-1.1.0-portable.exe'), '1.2.0'), at('ER-Damage-Calculator-1.2.0-portable.exe'));
  assert.strictEqual(misnamedTarget(at('ER-Damage-Calculator-v2-1.2.0-portable.exe'), '1.2.0'), at('ER-Damage-Calculator-1.2.0-portable.exe'));
  assert.strictEqual(misnamedTarget(at('ER-Damage-Calculator-1.2.0-portable.exe'), '1.2.0'), null);
  assert.strictEqual(misnamedTarget(at('계산기.exe'), '1.2.0'), null);
  assert.strictEqual(misnamedTarget(at('ER-Damage-Calculator-v1-1.1.0-portable.exe'), '1.2.0'), null);
  fs.writeFileSync(at('ER-Damage-Calculator-1.2.0-portable.exe'), 'x'); // 이미 있으면 건드리지 않는다
  assert.strictEqual(misnamedTarget(at('ER-Damage-Calculator-v2-1.1.0-portable.exe'), '1.2.0'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('waitForExit polls until the process is gone, false on timeout', async () => {
  let checks = 0;
  assert.strictEqual(await waitForExit({ pid: 7, alive: () => ++checks < 3, sleep: async () => {} }), true);
  assert.strictEqual(checks, 3);
  assert.strictEqual(await waitForExit({ pid: 7, alive: () => true, timeoutMs: 0, sleep: async () => {} }), false);
});

test('finishSwap removes the old exe (and a leftover .old); already gone is fine', async () => {
  const root = tmpDir();
  const from = path.join(root, 'old.exe');
  fs.writeFileSync(from, 'old');
  fs.writeFileSync(`${from}.old`, 'older');
  await finishSwap({ from });
  assert.deepStrictEqual(fs.readdirSync(root), []);
  await finishSwap({ from });
  fs.rmSync(root, { recursive: true, force: true });
});

test('launchRename writes an ASCII CRLF VBScript and runs it with wscript //B (no console), paths as arguments', async () => {
  const fake = fakeSpawn();
  const calls = fake.calls;
  // 스크립트가 시작되면 ready 를 쓴다(흉내)
  const fn = (cmd, args, opts) => {
    fs.writeFileSync(path.join(path.dirname(args[2]), 'ready'), '');
    return fake.fn(cmd, args, opts);
  };
  const env = { SystemRoot: 'C:\\Windows', PATH: 'p', ER_SMOKE_OUT: 'x', PORTABLE_EXECUTABLE_FILE: 'y' };
  await launchRename({ from: 'C:\\d\\ER-Damage-Calculator-v2-1.1.0-portable.exe', to: 'C:\\d\\ER-Damage-Calculator-1.2.0-portable.exe', env, spawnFn: fn });
  const [call] = calls;
  assert.strictEqual(call.cmd, 'C:\\Windows\\System32\\wscript.exe');
  const [b, n, script, from, to] = call.args;
  assert.deepStrictEqual([b, n, from, to], ['//B', '//Nologo', 'C:\\d\\ER-Damage-Calculator-v2-1.1.0-portable.exe', 'C:\\d\\ER-Damage-Calculator-1.2.0-portable.exe']);
  const text = fs.readFileSync(script, 'latin1');
  assert.strictEqual(text, RENAME_SCRIPT);
  assert.ok(/^[\x00-\x7f]*$/.test(text) && !/[^\r]\n/.test(text));
  assert.ok(text.includes(NO_RENAME));
  assert.deepStrictEqual(call.opts.env, { SystemRoot: 'C:\\Windows', PATH: 'p' });
  assert.ok(call.opts.detached && call.child.unrefed);
  fs.rmSync(path.dirname(script), { recursive: true, force: true });
  const fail = fakeSpawn(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(launchRename({ from: 'a', to: 'b', env, spawnFn: fail.fn }), /ENOENT/);
  // 시작은 됐지만 스크립트가 돌지 않고 끝남(Windows Script Host 차단) → 실패, 임시 폴더 정리
  let dir;
  const dead = fakeSpawn();
  const deadFn = (cmd, args, opts) => {
    dir = path.dirname(args[2]);
    const child = dead.fn(cmd, args, opts);
    child.kill = () => {};
    setTimeout(() => child.emit('exit', 1), 20);
    return child;
  };
  await assert.rejects(launchRename({ from: 'a', to: 'b', env, spawnFn: deadFn, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }), /시작되지 않았습니다/);
  assert.ok(!fs.existsSync(dir));
});

const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const windows = process.platform === 'win32';

test('rename script (real wscript) waits until the exe is released, renames it, starts it and removes itself', { skip: !windows && 'Windows only' }, async () => {
  const root = tmpDir('er rename (test) %TEMP% ');
  const from = path.join(root, 'App (x86) 1.1.0.exe');
  const to = path.join(root, 'App (x86) 1.2.0.exe');
  // 실행될 파일은 인자 없이 조용히 끝나는 GUI 프로그램(rundll32 복사본). 잠금은 공유 없이 연 핸들로 약 3초.
  fs.copyFileSync(path.join(SYS, 'rundll32.exe'), from);
  fs.writeFileSync(`${from}.old`, 'left by the 1.1.0 batch');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f = [IO.File]::Open($env:ER_LOCK, 'Open', 'Read', 'None'); 'locked'; Start-Sleep 3; $f.Close()"],
  { env: { ...process.env, ER_LOCK: from }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => holder.stdout.on('data', (d) => String(d).includes('locked') && r()));
  const { fn, calls } = (() => { const c = []; return { calls: c, fn: (...a) => { const ch = spawn(...a); c.push(ch); return ch; } }; })();
  await launchRename({ from, to, spawnFn: fn });
  const scriptDir = path.dirname(calls[0].spawnargs[3]);
  assert.ok(fs.existsSync(from), 'renamed while locked');
  await new Promise((r) => holder.once('exit', r));
  for (const end = Date.now() + 30000; Date.now() < end && fs.existsSync(scriptDir);) await new Promise((r) => setTimeout(r, 200));
  assert.ok(!fs.existsSync(scriptDir), 'script folder not removed');
  assert.ok(fs.existsSync(to) && !fs.existsSync(from) && !fs.existsSync(`${from}.old`));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

// 실제 잠금: 임시 exe(ping.exe 복사본)가 실행 중인 동안은 지우지 못하고(.old 로 이름만 바뀔 수 있음), 끝나면 지운다.
test('finishSwap retries while the old exe is still locked and removes it once released', { skip: !windows && 'Windows only' }, async () => {
  const root = tmpDir('er swap (test) %TEMP% ');
  const from = path.join(root, 'App (x86) 1.1.0.exe');
  fs.copyFileSync(path.join(SYS, 'PING.EXE'), from);
  const holder = spawn(from, ['-n', '4', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => holder.once('spawn', r));
  const exited = new Promise((r) => holder.once('exit', r));
  let lockedTries = 0;
  const started = Date.now();
  const sleep = (ms) => {
    if (holder.exitCode === null) {
      lockedTries++;
      assert.ok(fs.existsSync(from) || fs.existsSync(`${from}.old`), 'removed while the exe was running');
    }
    return new Promise((r) => setTimeout(r, ms));
  };
  await finishSwap({ from, sleep, timeoutMs: 30000 });
  await exited;
  assert.ok(lockedTries > 0 && Date.now() - started >= 2000);
  assert.deepStrictEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});
