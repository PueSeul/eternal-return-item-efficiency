'use strict';
// 데스크톱(exe) 진입점: 기존 index.html UI를 app://calc/ 주소로 띄운다.
// file://에서는 data/items.json fetch가 막히므로 커스텀 프로토콜로 파일을 서빙한다(UI 파일은 그대로).
// 히스토리(localStorage)는 app://calc 주소 기준으로 %APPDATA%\er-damage-efficiency 에 저장된다.
const { app, BrowserWindow, ipcMain, net, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveFile, contentType, externalRootOf } = require('./resolve');
const { loadFetchAll, updateAll } = require('./update');
const appUpdate = require('./app-update');
const { titleBarColors } = require('./theme');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://calc`;
const APP_ROOT = path.join(__dirname, '..');

// window.erDesktop.updateItems() (preload.js) → fetchAll() → data/items.json·characters.json·skills.json·items.meta.json 저장. 동시 요청은 하나로 합친다.
let updating = null;
let lastUpdate = null; // 검증(smokeClickUpdate)용: 마지막으로 시작한 업데이트 작업
function assertAppOrigin(event) {
  if (!event.senderFrame || !event.senderFrame.url.startsWith(ORIGIN + '/')) throw new Error('허용되지 않은 요청입니다.');
}

async function handleUpdateItems(event, options) {
  assertAppOrigin(event);
  const skillsMode = (options && options.skillsMode) || 'patched';
  if (!updating) {
    // 진행 이벤트는 요청한 창에 'update:progress' 로 보낸다(preload.js onUpdateProgress).
    const sender = event.sender;
    const onProgress = (p) => {
      if (!sender.isDestroyed()) sender.send('update:progress', p);
    };
    updating = loadFetchAll(APP_ROOT)
      .then((fetchAll) => updateAll(fetchAll, UPDATE_DATA_DIR, { onProgress, skillsMode }))
      .finally(() => { updating = null; });
    lastUpdate = updating;
  }
  return updating;
}

// 계산식 버전: 기본은 v2. v1 exe는 빌드 때 패키지 package.json 에 erFormula:"v1" 이 들어간다(electron/build.js --v1).
// 개발 실행은 환경변수 ER_FORMULA=v1 로 고를 수 있다. 'v1' 외의 값은 기본(v2).
const FORMULA = (app.isPackaged ? require('../package.json').erFormula : process.env.ER_FORMULA) === 'v1' ? 'v1' : 'v2';
const APP_TITLE = '이터널 리턴 아이템별 가격대비 효율 계산기';
// 창 제목 = 페이지 제목 + 버전(예: "… 계산기 1.2.0").
const windowTitle = (pageTitle) => `${pageTitle} ${app.getVersion()}`;
const TITLEBAR_HEIGHT = 36;

// 프로그램 자동 업데이트(app-update.js): 릴리스 자산이 기본(v2) exe 라 v2 에서만 켠다. 설치는 포터블 exe 실행에서만
// 가능하다(PORTABLE_EXECUTABLE_FILE = 실제 exe 경로). ER_UPDATE_API 는 검증용 릴리스 API 주소.
const APP_UPDATE = FORMULA === 'v2';
const PORTABLE_EXE = process.env.PORTABLE_EXECUTABLE_FILE || null;
const UPDATE_API = process.env.ER_UPDATE_API || appUpdate.RELEASES_API;
let pendingSwap = null; // 교체 마무리 대상({ from }): 창이 처음 정상 로드된 뒤에 이전 exe 를 지운다(로드 전 실패면 이전 exe 보존)
let latestRelease = null; // 마지막으로 찾은 새 버전(설치 대상)
const dismissedVersions = new Set(); // "나중에": 이번 실행에서 다시 알리지 않을 버전
let installing = null;
let smokeUpdateQuit = null; // 검증용: 새 exe 를 띄운 뒤 app.quit 대신 부른다

async function checkAppUpdate() {
  const res = await appUpdate.checkForUpdate({ fetch: net.fetch, currentVersion: app.getVersion(), apiUrl: UPDATE_API });
  latestRelease = res.status === 'available' ? res : null; // 설치 중이면 handleAppUpdateInstall 이 잡아 둔 대상을 쓴다
  return res;
}

const releaseInfo = (r) => ({ version: r.version, notes: r.notes || '', url: r.url || '' });

async function handleAppUpdateCheck(event) {
  assertAppOrigin(event);
  const res = await checkAppUpdate();
  return { status: res.status, current: res.current, ...releaseInfo(res) };
}

function handleAppUpdateDismiss(event, version) {
  assertAppOrigin(event);
  dismissedVersions.add(String(version));
}

// 받기(<자산 이름>.download) → <자산 이름>으로 바꾸기 → 새 exe 를 교체 인자로 실행 → 종료(app-update.js launchSwap).
// 받기·실행이 실패하면 받은 파일을 지우고(원본 그대로) 오류로 끝낸다.
function handleAppUpdateInstall(event) {
  assertAppOrigin(event);
  if (installing) return installing;
  if (!PORTABLE_EXE) throw new Error('개발 실행에서는 설치할 수 없습니다(포터블 exe에서만 가능).');
  const rel = latestRelease;
  if (!rel) throw new Error('먼저 업데이트를 확인하세요.');
  if (!rel.asset) throw new Error(`v${rel.version} 릴리스에 exe 파일이 없습니다.`);
  // 새 exe 는 릴리스 자산 이름으로 둔다(1.1.0 은 원래 이름으로 둬 파일명만 옛 버전으로 남았다).
  const exe = path.join(path.dirname(PORTABLE_EXE), rel.asset.name);
  if (path.resolve(exe).toLowerCase() === path.resolve(PORTABLE_EXE).toLowerCase()) {
    throw new Error(`지금 실행 중인 파일 이름이 새 버전 파일 이름(${rel.asset.name})과 같아 교체할 수 없습니다. 파일 이름을 바꾼 뒤 다시 시도하세요.`);
  }
  const sender = event.sender;
  let last = null;
  const onProgress = ({ received, total }) => {
    const percent = total ? Math.min(100, Math.floor((received * 100) / total)) : null;
    const step = percent === null ? Math.floor(received / 1048576) : percent; // 1% 또는 1MB 마다
    if (step === last || sender.isDestroyed()) return;
    last = step;
    sender.send('app-update:progress', { received, total, percent });
  };
  const dest = `${exe}.download`;
  installing = appUpdate.downloadAsset({ fetch: net.fetch, asset: rel.asset, dest, onProgress })
    .then(async (res) => {
      try {
        await fs.promises.rename(dest, exe);
      } catch (err) {
        await fs.promises.rm(dest, { force: true });
        throw new Error(`새 파일을 ${rel.asset.name}(으)로 저장하지 못했습니다: ${err.code || err.message}`);
      }
      try {
        await appUpdate.launchSwap({ dest: exe, target: PORTABLE_EXE, pid: process.pid });
      } catch (err) {
        await fs.promises.rm(exe, { force: true });
        throw new Error(`새 버전을 실행하지 못했습니다: ${err.code || err.message}`);
      }
      setTimeout(() => (smokeUpdateQuit ? smokeUpdateQuit(res) : app.quit()), 300);
      return { version: rel.version };
    })
    .catch((err) => {
      installing = null;
      throw err;
    });
  return installing;
}

// 창 첫 로드 뒤 한 번: 교체 마무리 실패 알림, 최신 릴리스 확인 → 새 버전이면 'app-update:available'.
async function notifyAppUpdate(contents) {
  if (pendingSwap) {
    appUpdate.finishSwap(pendingSwap).catch((err) => {
      if (!contents.isDestroyed()) contents.send('app-update:error', err.message);
    });
    pendingSwap = null;
  }
  try {
    const res = await checkAppUpdate();
    if (res.status === 'available' && !dismissedVersions.has(res.version) && !contents.isDestroyed()) {
      contents.send('app-update:available', releaseInfo(res));
    }
  } catch (err) {
    console.error(err.message); // 시작 시 확인 실패는 알리지 않는다("업데이트 확인"을 누르면 오류가 보인다).
  }
}

// 개발 실행(npm run app)과 exe가 같은 히스토리를 쓰도록 저장 위치 고정. v1·v2 는 별도 폴더(히스토리 분리).
// 폴더 이름은 기존 배포본과 같게 유지한다(v2 = er-damage-efficiency-v2).
app.setPath('userData', path.join(app.getPath('appData'), FORMULA === 'v2' ? 'er-damage-efficiency-v2' : 'er-damage-efficiency'));

// exe 옆 data/ 폴더를 우선 사용(portable exe는 임시 폴더에서 풀려 실행되므로 원래 exe 위치를 쓴다, resolve.js externalRootOf).
const EXTERNAL_ROOT = externalRootOf({ isPackaged: app.isPackaged, portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  exePath: app.getPath('exe'), userData: app.getPath('userData') });
// 프로그램 안 업데이트가 저장하는 곳: exe 옆 data/ (개발 실행에서는 프로젝트 data/). resolveFile 이 이 파일을 우선 읽는다.
const UPDATE_DATA_DIR = path.join(EXTERNAL_ROOT || APP_ROOT, 'data');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

async function handleRequest(request) {
  const file = resolveFile(new URL(request.url).pathname, APP_ROOT, EXTERNAL_ROOT);
  if (!file) return new Response('Bad request', { status: 400 });
  try {
    const body = await fs.promises.readFile(file);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minHeight: 800,
    autoHideMenuBar: true,
    title: windowTitle(APP_TITLE),
    // Windows 기본 제목 표시줄 대신 index.html 의 #titlebar(preload.js 가 보이게 함). 최소화·최대화·닫기는
    // 네이티브 버튼 오버레이를 앱 색(style.css --bg/--text)으로 쓴다(스냅·더블클릭 최대화·닫기 빨강 hover 유지).
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(APP_ROOT), height: TITLEBAR_HEIGHT },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // preload.js 가 이 인자를 보고 window.ER_FORMULA 를 주입한다.
      // --er-app-update: preload.js 가 "업데이트 확인" 버튼과 새 버전 배너를 넣는다.
      // --er-titlebar / --er-version: preload.js 가 자체 타이틀바를 보이게 하고 버전을 적는다.
      additionalArguments: [`--er-formula=${FORMULA}`, '--er-titlebar', `--er-version=${app.getVersion()}`,
        ...(APP_UPDATE ? ['--er-app-update'] : [])],
    },
  });
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(windowTitle(title));
  });
  if (APP_UPDATE) win.webContents.once('did-finish-load', () => notifyAppUpdate(win.webContents));
  // 외부 링크는 기본 브라우저로, 앱 창은 app:// 밖으로 이동하지 않는다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN + '/')) event.preventDefault();
  });
  if (process.env.ER_SMOKE_OUT) smokeTest(win, process.env.ER_SMOKE_OUT);
  win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

// 검증용: ER_SMOKE_OUT=<파일경로> 로 실행하면 로드 결과(JSON)와 스크린샷(.png)을 남기고 종료한다.
// 데이터가 로드되지 않았거나(배너 표시) 검사 중 오류·제한 시간 초과면 종료 코드 1.
// ER_SMOKE_UPDATE=<CSS 선택자> 를 함께 주면 그 버튼을 눌러 아이템 업데이트까지 확인한다(결과의 update).
// ER_SMOKE_APPUPDATE=check|install 이면 프로그램 업데이트 확인·설치까지 확인한다(결과의 appUpdate, smokeAppUpdate).
function smokeTest(win, outFile) {
  const updateSelector = process.env.ER_SMOKE_UPDATE;
  const appUpdateMode = process.env.ER_SMOKE_APPUPDATE;
  const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), updateSelector || appUpdateMode ? 600000 : 30000);
  function finish(result) {
    clearTimeout(timer);
    try {
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('smoke output write failed:', err.message);
      result.ok = false;
    }
    app.exit(result.ok ? 0 : 1);
  }
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const result = await win.webContents.executeJavaScript(`({
          url: location.href,
          bannerHidden: document.getElementById('data-banner').hidden,
          banner: document.getElementById('data-banner').textContent,
          itemCount: document.querySelectorAll('#slots select option, #slots button, #slots [role="button"]').length,
          slotButtons: document.querySelectorAll('#slots button, #slots [role="button"]').length,
          localStorageKeys: Object.keys(localStorage),
          formula: window.ER_FORMULA === undefined ? null : window.ER_FORMULA,
          hasSkillAmpInput: document.body.innerText.includes('스킬 증폭 계수'),
          titlebarShown: !!document.getElementById('titlebar') && !document.getElementById('titlebar').hidden,
          titlebarText: (document.getElementById('titlebar') || {}).textContent || null,
          titlebarHeight: (document.getElementById('titlebar') || { offsetHeight: 0 }).offsetHeight,
        })`);
        result.windowTitle = win.getTitle();
        result.appVersion = app.getVersion();
        result.exePath = PORTABLE_EXE;
        result.externalRoot = EXTERNAL_ROOT;
        result.userData = app.getPath('userData');
        // 빌드 버전 확인: v2는 주입·창 제목·v2 입력란(스킬 증폭 계수), v1은 주입.
        const formulaOk = FORMULA === 'v2'
          ? result.formula === 'v2' && result.windowTitle === windowTitle(APP_TITLE) && result.hasSkillAmpInput
          : result.formula === 'v1';
        const titlebarOk = result.titlebarShown && result.titlebarHeight === TITLEBAR_HEIGHT
          && result.titlebarText.includes(app.getVersion());
        result.ok = result.bannerHidden && result.slotButtons > 0 && formulaOk && titlebarOk;
        if (updateSelector) {
          result.update = await smokeClickUpdate(win, updateSelector);
          result.ok = result.ok && result.update.ok;
        }
        if (appUpdateMode) {
          result.appUpdate = await smokeAppUpdate(win, appUpdateMode);
          result.ok = result.ok && result.appUpdate.ok;
        }
        const image = await win.webContents.capturePage();
        fs.writeFileSync(outFile.replace(/\.json$/i, '') + '.png', image.toPNG());
        finish(result);
      } catch (err) {
        finish({ ok: false, error: String(err && err.message || err) });
      }
    }, 1500);
  });
}

// 검증용: 업데이트 버튼 클릭 → main 의 업데이트 작업 완료 대기 → 저장 파일 시각 기록.
async function smokeClickUpdate(win, selector) {
  const names = ['items.json', 'characters.json', 'skills.json', 'items.meta.json'];
  const mtime = () => Object.fromEntries(names.map((n) => {
    const file = path.join(UPDATE_DATA_DIR, n);
    return [n, fs.existsSync(file) ? fs.statSync(file).mtime.toISOString() : null];
  }));
  const before = mtime();
  const prev = lastUpdate;
  // 렌더러가 preload 의 onUpdateProgress 로 받은 진행 이벤트를 시각과 함께 모은다(IPC 전달 확인용).
  await win.webContents.executeJavaScript(`(() => {
    window.__smokeProgress = [];
    window.erDesktop.onUpdateProgress((p) => window.__smokeProgress.push({ t: Date.now(), ...p }));
  })()`);
  const progressLog = async (startedAt) => {
    const events = await win.webContents.executeJavaScript('window.__smokeProgress');
    return {
      progressCount: events.length,
      progressStages: [...new Set(events.map((e) => e.stage))],
      // 단계별 첫·마지막 이벤트 시각(시작 기준 ms)과 마지막 이벤트.
      progressTimeline: Object.fromEntries([...new Set(events.map((e) => e.stage))].map((s) => {
        const of = events.filter((e) => e.stage === s);
        return [s, { firstMs: of[0].t - startedAt, lastMs: of[of.length - 1].t - startedAt, events: of.length,
          last: `${of[of.length - 1].done}/${of[of.length - 1].total} ${of[of.length - 1].message}` }];
      })),
      // 이벤트 사이 가장 긴 공백(멈춤처럼 보이는 구간).
      maxGapMs: events.reduce((m, e, i) => (i ? Math.max(m, e.t - events[i - 1].t) : m), 0),
    };
  };
  const startedAt = Date.now();
  // 버튼은 UI 최초 로딩(v2는 캐릭터 데이터 포함)이 끝난 뒤에 보이므로 최대 15초 기다린다.
  let clicked = false;
  for (const end = Date.now() + 15000; !clicked && Date.now() < end;) {
    clicked = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b || b.hidden) return false; b.click(); return true; })()`);
    if (!clicked) await new Promise((r) => setTimeout(r, 200));
  }
  if (!clicked) return { ok: false, error: `button not found or hidden: ${selector}` };
  const deadline = Date.now() + 5000;
  while (lastUpdate === prev && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (lastUpdate === prev) return { ok: false, error: 'click did not start update' };
  try {
    const res = await lastUpdate;
    const elapsedMs = Date.now() - startedAt;
    const progress = await progressLog(startedAt);
    await new Promise((r) => setTimeout(r, 2000)); // UI가 새 파일을 다시 읽을 시간
    const after = mtime();
    // 프로토콜로 다시 읽은 네 파일(외부 data/ 우선)과 UI 상태 문구.
    const ui = await win.webContents.executeJavaScript(`(async () => {
      const get = async (n) => (await fetch('data/' + n, { cache: 'no-store' })).json();
      return {
        servedCount: (await get('items.json')).length,
        servedCharacters: (await get('characters.json')).length,
        servedSkills: JSON.stringify(await get('skills.json')),
        servedMeta: JSON.stringify(await get('items.meta.json')),
        status: (document.getElementById('update-status') || {}).textContent || '',
        bannerHidden: document.getElementById('data-banner').hidden,
      };
    })()`);
    const ok = names.every((n) => after[n] !== null && after[n] !== before[n])
      && ui.servedCount === res.count && ui.servedMeta === JSON.stringify(res.meta)
      && ui.servedSkills === JSON.stringify(res.skills) && ui.bannerHidden && progress.progressCount > 0;
    // 결과 파일이 커지지 않도록 skills 는 개수만 남긴다.
    const { skills, ...rest } = res;
    const { servedSkills, ...uiRest } = ui;
    return { ok, elapsedMs, ...progress, before, after, ...rest, skillCount: skills.length,
      servedSkillCount: JSON.parse(servedSkills).length, ...uiRest };
  } catch (err) {
    return { ok: false, elapsedMs: Date.now() - startedAt, ...(await progressLog(startedAt)), before,
      error: String(err && err.message || err) };
  }
}

// 검증용: check → "업데이트 확인" 클릭 후 상태 문구. install → 시작 알림 배너의 "지금 업데이트" 클릭,
// 교체 배치를 띄우고 종료하기 직전(smokeUpdateQuit)까지 기다린다. 실패 문구가 배너에 뜨면 실패.
async function smokeAppUpdate(win, mode) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const state = () => js(`(() => {
    const b = document.getElementById('app-update-banner');
    const s = document.getElementById('app-update-status');
    return { bannerShown: !!b && !b.hidden, banner: b ? b.textContent : null, status: s ? s.textContent : null };
  })()`);
  let stopped = false;
  const until = async (cond, ms) => {
    for (const end = Date.now() + ms; !stopped && Date.now() < end;) {
      const s = await state();
      if (cond(s)) return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    return stopped ? null : state();
  };
  if (mode === 'check') {
    await js(`document.getElementById('app-update-check').click()`);
    const s = await until((x) => x.status && !x.status.includes('확인 중'), 30000);
    return { ok: !!s.status && !s.status.includes('확인 중') && !s.status.includes('실패'), ...s };
  }
  const shown = await until((x) => x.bannerShown, 30000);
  if (!shown.bannerShown) return { ok: false, error: 'update banner not shown', ...shown };
  await js(`window.__appUpdateProgress = []; window.erDesktop.appUpdate.onProgress((p) => window.__appUpdateProgress.push(p)); 0`);
  const startedAt = Date.now();
  const quitting = new Promise((resolve) => { smokeUpdateQuit = resolve; });
  await js(`document.getElementById('app-update-now').click()`);
  // 다운로드 중간(30% 이상) 배너 문구(게이지 + 문구 칸): 퍼센트가 한 번만 보이는지 확인용.
  const mid = (async () => {
    while (!stopped) {
      if (await js('window.__appUpdateProgress.some((p) => p.percent >= 30)')) return (await state()).banner;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  })();
  const outcome = await Promise.race([
    quitting.then((res) => ({ downloaded: res })),
    until((x) => /실패/.test(x.banner || ''), 300000).then((s) => ({ failed: s })),
  ]);
  stopped = true;
  const progress = await js('window.__appUpdateProgress');
  return { ok: !!outcome.downloaded, elapsedMs: Date.now() - startedAt, bannerText: shown.banner, bannerMid: await mid, ...outcome,
    progressCount: progress.length, lastProgress: progress[progress.length - 1] || null };
}

// 프로그램 업데이트 뒤 시작 단계(포터블 exe 만). 반환 { exit } 면 이 실행은 끝내고, { swap } 이면 lock 을 잡은 뒤 이전 exe 를 지운다.
// 1) 교체 인자로 실행됐으면 이전 프로세스 종료를 기다린다(이전 프로세스가 lock 을 놓아야 이 실행이 lock 을 잡는다).
// 2) 파일 이름의 버전이 실행 중 버전과 다르면(1.1.0·1.2.0 의 교체 결과) wscript 로 이름을 바꿔 다시 시작한다.
async function prepareStart() {
  if (!PORTABLE_EXE) return {};
  const swap = appUpdate.parseSwapArgs(process.argv, PORTABLE_EXE);
  if (swap) {
    // 이전 프로세스가 끝나지 않았으면 이전 exe 를 건드리지 않고 그냥 실행한다(lock 확보 실패면 기존 창으로).
    return (await appUpdate.waitForExit({ pid: swap.pid })) ? { swap } : {};
  }
  if (process.argv.includes(appUpdate.NO_RENAME)) return {};
  const want = appUpdate.misnamedTarget(PORTABLE_EXE, app.getVersion());
  // VBScript 가 없는 Windows 에서는 바로잡지 않는다(wscript 가 아무것도 실행하지 못하면 프로그램이 사라진다).
  if (!want || !fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'vbscript.dll'))) return {};
  try {
    await appUpdate.launchRename({ from: PORTABLE_EXE, to: want });
    return { exit: true };
  } catch (err) {
    console.error(`exe 이름 바로잡기 실패: ${err.message}`);
    return {};
  }
}

function startApp({ swap }) {
  if (!app.requestSingleInstanceLock()) {
    // 이미 실행 중이면 기존 창을 앞으로(second-instance). 검증 실행이면 실패로 끝낸다.
    if (process.env.ER_SMOKE_OUT) console.error('smoke: another instance is already running');
    app.exit(process.env.ER_SMOKE_OUT ? 1 : 0);
    return;
  }
  // 이전 exe 삭제는 창이 정상 로드된 뒤(notifyAppUpdate). 실패 메시지는 'app-update:error'.
  if (swap) pendingSwap = { from: swap.from };
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    protocol.handle(SCHEME, handleRequest);
    ipcMain.handle('er:update-items', handleUpdateItems);
    ipcMain.handle('app-update:check', handleAppUpdateCheck);
    ipcMain.handle('app-update:install', handleAppUpdateInstall);
    ipcMain.handle('app-update:dismiss', handleAppUpdateDismiss);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

prepareStart().then((start) => (start.exit ? app.exit(0) : startApp(start)));
