'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { updateAll, loadFetchAll, downloadLatest, updateLatest, startUpdate, cancelJob, MANIFEST_NAME } = require('./update');

test('updateAll forwards progress events and rejects with the last stage after the overall limit', async () => {
  const root = tmpDir();
  const seen = [];
  let signal;
  const slow = async (opts) => {
    signal = opts.signal;
    opts.onProgress({ stage: 'patchnote', done: 0, total: 1, message: '패치노트 확인 중' });
    opts.onProgress({ stage: 'items', done: 0, total: 1, message: '아이템 수집(dak.gg) 중' });
    opts.onProgress({ stage: 'items', done: 1, total: 1, message: '아이템 수집(dak.gg) 완료' });
    await new Promise((r) => setTimeout(r, 500));
    throw new Error('late failure');
  };
  // 마지막 이벤트(아이템 완료)가 아니라 끝나지 않은 단계(패치노트)를 알린다.
  await assert.rejects(updateAll(slow, root, { onProgress: (p) => seen.push(p), timeoutMs: 100 }),
    /0\.1초 안에 끝나지 않아 중단했습니다 \(끝나지 않은 단계: 패치노트 확인 중\)/);
  assert.strictEqual(seen.length, 3);
  assert.ok(signal.aborted);
  assert.deepStrictEqual(fs.readdirSync(root), []); // 임시 폴더도 남지 않는다
  // fetchAll 의 단계 오류는 그대로 전달된다.
  await assert.rejects(updateAll(async () => { throw new Error('패치노트 확인 단계 실패: 응답 없음(20초 초과)'); }, root),
    /패치노트 확인 단계 실패: 응답 없음/);
  await new Promise((r) => setTimeout(r, 500)); // slow 의 늦은 실패가 처리되지 않은 거부로 남지 않는지
  fs.rmSync(root, { recursive: true, force: true });
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'er-update-test-'));
}

// fetchAll 흉내: outDir 에 네 파일(skip 에 든 이름은 빼고)을 쓰고 결과를 반환.
function fakeFetchAll(result, skip = []) {
  return async ({ outDir }) => {
    const files = { 'items.json': result.items, 'characters.json': result.characters, 'skills.json': result.skills, 'items.meta.json': result.meta };
    for (const [name, value] of Object.entries(files)) {
      if (!skip.includes(name) && value !== undefined) fs.writeFileSync(path.join(outDir, name), JSON.stringify(value));
    }
    return result;
  };
}

test('updateAll moves the four files into dataDir and returns count/savedPath/skills/meta', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  const meta = { patch: { version: '1.2' } };
  const skills = [{ characterId: 'c', name: '아르다', skills: [] }];
  const result = { items: [{ id: '1', name: '카른웬난' }, { id: '2' }], characters: [{ id: 'c' }], skills, meta };
  const res = await updateAll(fakeFetchAll(result), dataDir);
  assert.deepStrictEqual(res, { count: 2, savedPath: path.join(dataDir, 'items.json'), skills, meta });
  assert.deepStrictEqual(fs.readdirSync(dataDir).sort(), ['characters.json', 'items.json', 'items.meta.json', 'skills.json']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(res.savedPath, 'utf8')), result.items);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8')), skills);
  fs.rmSync(root, { recursive: true, force: true });
});

test('updateAll replaces existing files and skips missing ones without error', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'items.json'), '[{"id":"old"}]'); // 나머지 세 파일은 없음
  const result = { items: [{ id: '1' }], characters: [{ id: 'c' }], skills: [{ name: 's' }], meta: { m: 1 } };
  await updateAll(fakeFetchAll(result), dataDir);
  assert.deepStrictEqual(fs.readdirSync(dataDir).sort(), ['characters.json', 'items.json', 'items.meta.json', 'skills.json']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf8')), result.items);
  fs.rmSync(root, { recursive: true, force: true });
});

test('updateAll passes skillsMode and the existing data/skills.json as merge base', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'skills.json'), '[{"name":"old"}]');
  const result = { items: [{ id: '1' }], characters: [{ id: 'c' }], skills: [{ name: 'new' }], meta: {} };
  const seen = [];
  const inner = fakeFetchAll(result);
  const spy = async (opts) => {
    seen.push({ mode: opts.skillsMode, base: fs.readFileSync(path.join(opts.outDir, 'skills.json'), 'utf8') });
    return inner(opts);
  };
  await updateAll(spy, dataDir);
  await updateAll(spy, dataDir, { skillsMode: 'all' });
  assert.deepStrictEqual(seen.map((s) => s.mode), ['patched', 'all']);
  assert.strictEqual(seen[0].base, '[{"name":"old"}]');
  await assert.rejects(updateAll(spy, dataDir, { skillsMode: 'x' }), /알 수 없는 skillsMode/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('updateAll keeps existing files on fetch failure or empty/bad result', async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'items.json'), '[{"id":"old"}]\n');
  await assert.rejects(updateAll(async () => { throw new Error('network down'); }, root), /network down/);
  await assert.rejects(updateAll(async () => ({}), root), /배열이 아닙니다/);
  await assert.rejects(updateAll(fakeFetchAll({ items: [], characters: [{}], skills: [{}], meta: {} }), root), /아이템이 0개/);
  await assert.rejects(updateAll(fakeFetchAll({ items: [{}], characters: [], skills: [{}], meta: {} }), root), /캐릭터가 0개/);
  await assert.rejects(updateAll(fakeFetchAll({ items: [{}], characters: [{}], meta: {} }), root), /스킬 데이터가 0개/);
  await assert.rejects(updateAll(fakeFetchAll({ items: [{}], characters: [{}], skills: [], meta: {} }), root), /스킬 데이터가 0개/);
  // 옮기는 도중 실패하면 이미 옮긴 파일도 기존 것으로 되돌린다.
  fs.writeFileSync(path.join(root, 'characters.json'), '[{"id":"oldc"}]\n');
  const realRename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (path.basename(to) === 'skills.json' && !from.includes(`${path.sep}old${path.sep}`)) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return realRename(from, to);
  };
  try {
    await assert.rejects(updateAll(fakeFetchAll({ items: [{ id: 'new' }], characters: [{}], skills: [{}], meta: {} }), root), /locked/);
  } finally {
    fs.promises.rename = realRename;
  }
  assert.strictEqual(fs.readFileSync(path.join(root, 'characters.json'), 'utf8'), '[{"id":"oldc"}]\n');
  assert.ok(!fs.existsSync(path.join(root, 'skills.json')));
  // 파일 하나라도 빠지면 아무것도 옮기지 않는다.
  await assert.rejects(updateAll(fakeFetchAll({ items: [{}], characters: [{}], skills: [{}], meta: {} }, ['skills.json']), root), /ENOENT/);
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['characters.json', 'items.json']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'items.json'), 'utf8'), '[{"id":"old"}]\n');
  fs.rmSync(root, { recursive: true, force: true });
});

// data-latest 자산 흉내: name → 내용(문자열). manifest 는 contents 의 sha256 으로 만든다(override 로 덮어쓰기).
function fakeRelease(contents, { override = {}, status = {} } = {}) {
  const sha = Object.fromEntries(Object.entries(contents).map(([n, t]) => [n, crypto.createHash('sha256').update(t).digest('hex')]));
  const assets = { ...contents, [MANIFEST_NAME]: JSON.stringify({ generatedAt: 'T', sha256: { ...sha, ...override } }) };
  const calls = [];
  const fetchImpl = async (url) => {
    const name = url.slice(url.lastIndexOf('/') + 1);
    calls.push(name);
    if (status[name] || !(name in assets)) return { ok: false, status: status[name] || 404 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(assets[name]).buffer };
  };
  return { fetchImpl, calls };
}

const RELEASE = {
  'items.json': '[{"id":"1"},{"id":"2"}]\n', 'characters.json': '[{"id":"c"}]\n',
  'skills.json': '[{"name":"s"}]\n', 'items.meta.json': '{"fetchedAt":"T"}\n',
};

test('downloadLatest replaces the four files after sha256 check and reports manifest/download progress', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'items.json'), '[{"id":"old"}]\n');
  const { fetchImpl, calls } = fakeRelease(RELEASE);
  const seen = [];
  const res = await downloadLatest(fetchImpl, dataDir, { onProgress: (p) => seen.push(p), baseUrl: 'https://x/' });
  assert.deepStrictEqual(res, { count: 2, savedPath: path.join(dataDir, 'items.json'), skills: [{ name: 's' }], meta: { fetchedAt: 'T' } });
  assert.strictEqual(calls[0], MANIFEST_NAME);
  for (const [n, t] of Object.entries(RELEASE)) assert.strictEqual(fs.readFileSync(path.join(dataDir, n), 'utf8'), t);
  assert.deepStrictEqual(fs.readdirSync(dataDir).sort(), ['characters.json', 'items.json', 'items.meta.json', 'skills.json']);
  assert.deepStrictEqual([...new Set(seen.map((p) => p.stage))], ['manifest', 'download']);
  assert.deepStrictEqual(seen.at(-1).done, 4);
  // 다시 부르면 sha256 이 같아 manifest 만 받고 파일을 건드리지 않는다.
  const again = fakeRelease(RELEASE);
  const mtime = fs.statSync(path.join(dataDir, 'skills.json')).mtimeMs;
  const res2 = await downloadLatest(again.fetchImpl, dataDir, { baseUrl: 'https://x/' });
  assert.deepStrictEqual(again.calls, [MANIFEST_NAME]);
  assert.strictEqual(res2.count, 2);
  assert.match(res2.note, /이미 최신/);
  assert.strictEqual(res2.upToDate, true);
  assert.strictEqual(fs.statSync(path.join(dataDir, 'skills.json')).mtimeMs, mtime);
  fs.rmSync(root, { recursive: true, force: true });
});

test('downloadLatest compares with the bundled data when dataDir has no files', async () => {
  const root = tmpDir();
  const bundled = path.join(root, 'bundled');
  fs.mkdirSync(bundled);
  for (const [n, t] of Object.entries(RELEASE)) fs.writeFileSync(path.join(bundled, n), t);
  const { fetchImpl, calls } = fakeRelease(RELEASE);
  const res = await downloadLatest(fetchImpl, path.join(root, 'data'), { bundledDir: bundled, baseUrl: 'https://x/' });
  assert.deepStrictEqual(calls, [MANIFEST_NAME]);
  assert.strictEqual(res.savedPath, path.join(bundled, 'items.json'));
  assert.ok(!fs.existsSync(path.join(root, 'data')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('downloadLatest keeps existing files on HTTP error, bad manifest, sha256 mismatch or bad data', async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'items.json'), '[{"id":"old"}]\n');
  const opts = { baseUrl: 'https://x/' };
  await assert.rejects(downloadLatest(fakeRelease({}, { status: { [MANIFEST_NAME]: 404 } }).fetchImpl, root, opts),
    /data-manifest\.json 받기 실패: HTTP 404/);
  await assert.rejects(downloadLatest(fakeRelease({ 'items.json': '[]' }).fetchImpl, root, opts), /네 파일의 sha256이 없습니다/);
  await assert.rejects(downloadLatest(fakeRelease(RELEASE, { override: { 'skills.json': 'a'.repeat(64) } }).fetchImpl, root, opts),
    /skills\.json의 sha256이 data-manifest\.json과 다릅니다/);
  await assert.rejects(downloadLatest(fakeRelease(RELEASE, { status: { 'characters.json': 500 } }).fetchImpl, root, opts),
    /characters\.json 받기 실패: HTTP 500/);
  await assert.rejects(downloadLatest(fakeRelease({ ...RELEASE, 'items.json': '[]' }).fetchImpl, root, opts), /아이템이 0개/);
  const hang = async (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(downloadLatest(hang, root, { ...opts, timeoutMs: 50 }), /받기 실패: 0\.05초 안에 끝나지 않음/);
  assert.deepStrictEqual(fs.readdirSync(root), ['items.json']); // 임시 폴더도 남지 않는다
  assert.strictEqual(fs.readFileSync(path.join(root, 'items.json'), 'utf8'), '[{"id":"old"}]\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('updateLatest falls back to collect with a note, and names both causes when both fail', async () => {
  const ok = { count: 1, savedPath: 'p', skills: [], meta: {} };
  assert.deepStrictEqual(await updateLatest({ download: async () => ok, collect: async () => assert.fail('no fallback') }), ok);
  const seen = [];
  const res = await updateLatest({ download: async () => { throw new Error('data-manifest.json 받기 실패: HTTP 404'); },
    collect: async () => ok, onProgress: (p) => seen.push(p) });
  assert.match(res.note, /GitHub 데이터를 받지 못해 dak\.gg·패치노트에서 직접 수집했습니다\(data-manifest\.json 받기 실패: HTTP 404\)/);
  assert.strictEqual(res.count, 1);
  assert.deepStrictEqual(seen.map((p) => p.stage), ['fallback']);
  await assert.rejects(updateLatest({ download: async () => { throw new Error('gh down'); }, collect: async () => { throw new Error('dak down'); } }),
    /^Error: dak down \(GitHub 데이터도 받지 못함: gh down\)$/);
});

// 취소: dataDir 의 기존 파일 내용·목록이 그대로인지(임시 폴더도 남지 않는다).
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
}

test('updateAll cancel: returns {cancelled:true} at once without waiting for fetchAll and leaves the files untouched', async () => {
  const root = tmpDir();
  for (const [n, t] of Object.entries(RELEASE)) fs.writeFileSync(path.join(root, n), t);
  const before = snapshot(root);
  let seen;
  const hang = (opts) => { seen = opts.signal; return new Promise(() => {}); }; // 신호를 무시하고 끝나지 않는 fetchAll
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('cancel')), 30);
  const t0 = performance.now();
  const res = await updateAll(hang, root, { signal: controller.signal, onProgress: () => {} });
  assert.deepStrictEqual(res, { cancelled: true });
  assert.ok(performance.now() - t0 < 500, `took ${performance.now() - t0}ms`);
  assert.ok(seen.aborted, 'fetchAll gets the abort');
  assert.deepStrictEqual(snapshot(root), before);
  // 수집은 끝났지만 교체 전에 취소된 경우도 파일을 바꾸지 않는다.
  const late = new AbortController();
  const done = async (opts) => {
    const res2 = await fakeFetchAll({ items: [{ id: 'new' }], characters: [{}], skills: [{}], meta: {} })(opts);
    late.abort();
    return res2;
  };
  assert.deepStrictEqual(await updateAll(done, root, { signal: late.signal }), { cancelled: true });
  assert.deepStrictEqual(snapshot(root), before);
  // 이미 취소된 신호면 시작하지 않는다.
  assert.deepStrictEqual(await updateAll(() => assert.fail('not started'), root, { signal: late.signal }), { cancelled: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('downloadLatest cancel: aborts the request, or stops before replacing after the downloads', async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'items.json'), '[{"id":"old"}]\n');
  const before = snapshot(root);
  const hang = async (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const t0 = performance.now();
  assert.deepStrictEqual(await downloadLatest(hang, root, { baseUrl: 'https://x/', signal: controller.signal }), { cancelled: true });
  assert.ok(performance.now() - t0 < 500, `took ${performance.now() - t0}ms`);
  assert.deepStrictEqual(snapshot(root), before);
  // 네 파일을 다 받은 직후(마지막 download 이벤트)에 취소 → 교체하지 않는다.
  const late = new AbortController();
  const onProgress = (p) => { if (p.stage === 'download' && p.done === 4) late.abort(); };
  const res = await downloadLatest(fakeRelease(RELEASE).fetchImpl, root, { baseUrl: 'https://x/', onProgress, signal: late.signal });
  assert.deepStrictEqual(res, { cancelled: true });
  assert.deepStrictEqual(snapshot(root), before);
  // 이미 최신이어도 manifest 를 받은 뒤 취소했으면 성공이 아니라 취소로 끝난다.
  const same = tmpDir();
  for (const [n, t] of Object.entries(RELEASE)) fs.writeFileSync(path.join(same, n), t);
  const c3 = new AbortController();
  const onManifest = (p) => { if (p.stage === 'manifest' && p.done === 1) c3.abort(); };
  assert.deepStrictEqual(await downloadLatest(fakeRelease(RELEASE).fetchImpl, same, { baseUrl: 'https://x/', onProgress: onManifest, signal: c3.signal }),
    { cancelled: true });
  fs.rmSync(same, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('updateLatest cancel: no fallback after a cancelled download, collect result passed through', async () => {
  const controller = new AbortController();
  const seen = [];
  const res = await updateLatest({
    download: async () => { controller.abort(); throw new Error('manifest 받기 실패: timeout'); },
    collect: async () => assert.fail('no fallback after cancel'),
    onProgress: (p) => seen.push(p),
    signal: controller.signal,
  });
  assert.deepStrictEqual(res, { cancelled: true });
  assert.deepStrictEqual(seen, []);
  const c2 = new AbortController();
  const res2 = await updateLatest({
    download: async () => { throw new Error('gh down'); },
    collect: async () => { c2.abort(); return { cancelled: true }; },
    signal: c2.signal,
  });
  assert.deepStrictEqual(res2, { cancelled: true }); // note 를 붙이지 않는다
  const c3 = new AbortController();
  const res3 = await updateLatest({
    download: async () => { throw new Error('gh down'); },
    collect: async () => { c3.abort(); throw new Error('aborted'); },
    signal: c3.signal,
  });
  assert.deepStrictEqual(res3, { cancelled: true });
});

test('cancelJob on the GitHub download path (updateLatest → downloadLatest): {cancelled:true}, files untouched, no fallback', async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'items.json'), '[{"id":"old"}]\n');
  const before = snapshot(root);
  const { fetchImpl } = fakeRelease(RELEASE);
  // manifest 는 바로, 자산은 신호가 올 때까지 끝나지 않는 GitHub(1.8.4 실측: 취소해도 "아이템 갱신됨").
  // fetch 처럼 이미 중단된 신호면 바로 reject.
  const slow = async (url, init) => (url.endsWith(MANIFEST_NAME) ? fetchImpl(url, init)
    : new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
  for (const at of ['manifest', 'download']) {
    const controller = new AbortController();
    const { signal } = controller;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const onProgress = (p) => { if (p.stage === at && p.done === 0) started(); };
    const job = updateLatest({
      download: () => downloadLatest(slow, root, { baseUrl: 'https://x/', onProgress, signal }),
      collect: async () => assert.fail('no fallback after cancel'),
      onProgress,
      signal,
    });
    await ready;
    const t0 = performance.now();
    assert.deepStrictEqual(await cancelJob(controller, job, new Error('사용자 취소')), { cancelled: true });
    assert.ok(performance.now() - t0 < 500, `took ${performance.now() - t0}ms`);
    assert.deepStrictEqual(await job, { cancelled: true });
    assert.deepStrictEqual(snapshot(root), before, `files untouched (cancel at ${at})`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('전체 재확인(skillsMode all) 취소: 수집이 AbortError 로 끝나도 GitHub 내려받기로 폴백하지 않고 {cancelled:true}', async () => {
  const root = tmpDir();
  for (const [n, t] of Object.entries(RELEASE)) fs.writeFileSync(path.join(root, n), t);
  const before = snapshot(root);
  const controller = new AbortController();
  const { signal } = controller;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  // 나무위키 수집처럼 신호가 오면 AbortError 로 끝나는 fetchAll.
  const fetchAll = (opts) => {
    started();
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  };
  const seen = [];
  const job = startUpdate({
    skillsMode: 'all',
    download: async () => assert.fail('no GitHub download in 전체 재확인'),
    collect: (mode) => updateAll(fetchAll, root, { skillsMode: mode, signal, onProgress: (p) => seen.push(p) }),
    onProgress: (p) => seen.push(p),
    signal,
  });
  await ready;
  assert.deepStrictEqual(await cancelJob(controller, job, new Error('사용자 취소')), { cancelled: true });
  assert.deepStrictEqual(await job, { cancelled: true });
  assert.ok(!seen.some((p) => p.stage === 'fallback'), 'no fallback event');
  assert.deepStrictEqual(snapshot(root), before);
  // 기본 버튼(patched)에서 직접 수집 폴백 중 취소돼도 다른 경로로 넘어가지 않는다.
  const c2 = new AbortController();
  const job2 = startUpdate({
    skillsMode: 'patched',
    download: async () => { throw new Error('gh down'); },
    collect: (mode) => updateAll((opts) => { setTimeout(() => c2.abort(), 10); return fetchAll(opts); }, root, { skillsMode: mode, signal: c2.signal }),
    signal: c2.signal,
  });
  assert.deepStrictEqual(await job2, { cancelled: true });
  assert.deepStrictEqual(snapshot(root), before);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cancel after the swap started: swap completes, result marks completedBeforeCancel, cancelJob says not cancelled', async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'items.json'), '[{"id":"old"}]\n');
  const controller = new AbortController();
  const { mkdir } = fs.promises;
  let job;
  let cancelling;
  // installFiles 의 첫 동작(staging/old 만들기) 시점에 취소가 온다.
  fs.promises.mkdir = async (dir, ...rest) => {
    if (path.basename(dir) === 'old' && !cancelling) cancelling = cancelJob(controller, job, new Error('사용자 취소'));
    return mkdir.call(fs.promises, dir, ...rest);
  };
  try {
    job = downloadLatest(fakeRelease(RELEASE).fetchImpl, root, { baseUrl: 'https://x/', signal: controller.signal });
    const res = await job;
    assert.strictEqual(res.cancelled, false);
    assert.strictEqual(res.completedBeforeCancel, true);
    assert.strictEqual(res.count, 2);
    assert.deepStrictEqual(await cancelling, { cancelled: false, completedBeforeCancel: true });
  } finally {
    fs.promises.mkdir = mkdir;
  }
  for (const [n, t] of Object.entries(RELEASE)) assert.strictEqual(fs.readFileSync(path.join(root, n), 'utf8'), t);
  // 업데이트가 취소와 무관하게 실패했으면 취소도 아니고 완료도 아니다.
  assert.deepStrictEqual(await cancelJob(new AbortController(), Promise.reject(new Error('x')), new Error('c')),
    { cancelled: false, completedBeforeCancel: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadFetchAll imports scripts/fetch_items.mjs from appRoot', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'fetch_items.mjs'), 'export async function fetchAll() { return { items: [{ id: "x" }] }; }\n');
  const fetchAll = await loadFetchAll(root);
  assert.deepStrictEqual(await fetchAll(), { items: [{ id: 'x' }] });
  const root2 = tmpDir();
  fs.mkdirSync(path.join(root2, 'scripts'));
  fs.writeFileSync(path.join(root2, 'scripts', 'fetch_items.mjs'), 'export const other = 1;\n');
  await assert.rejects(loadFetchAll(root2), /fetchAll 함수가 없습니다/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
});
