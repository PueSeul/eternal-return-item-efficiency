'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateAll, loadFetchAll } = require('./update');

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
