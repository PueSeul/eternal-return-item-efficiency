'use strict';
// 데스크톱(exe) 진입점: 기존 index.html UI를 app://calc/ 주소로 띄운다.
// file://에서는 data/items.json fetch가 막히므로 커스텀 프로토콜로 파일을 서빙한다(UI 파일은 그대로).
// 히스토리(localStorage)는 app://calc 주소 기준으로 %APPDATA%\er-damage-efficiency 에 저장된다.
const { app, BrowserWindow, ipcMain, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveFile, contentType } = require('./resolve');
const { loadFetchItems, updateItems } = require('./update');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://calc`;
const APP_ROOT = path.join(__dirname, '..');
// exe 옆 data/ 폴더를 우선 사용(portable exe는 임시 폴더에서 풀려 실행되므로 원래 exe 위치를 쓴다).
const EXTERNAL_ROOT = !app.isPackaged ? null
  : process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
// 프로그램 안 업데이트가 저장하는 곳: exe 옆 data/ (개발 실행에서는 프로젝트 data/). resolveFile 이 이 파일을 우선 읽는다.
const UPDATE_DATA_DIR = path.join(EXTERNAL_ROOT || APP_ROOT, 'data');

// window.erDesktop.updateItems() (preload.js) → fetchItems() → data/items.json 저장. 동시 요청은 하나로 합친다.
let updating = null;
let lastUpdate = null; // 검증(smokeClickUpdate)용: 마지막으로 시작한 업데이트 작업
async function handleUpdateItems(event) {
  if (!event.senderFrame || !event.senderFrame.url.startsWith(ORIGIN + '/')) throw new Error('허용되지 않은 요청입니다.');
  if (!updating) {
    updating = loadFetchItems(APP_ROOT)
      .then((fetchItems) => updateItems(fetchItems, UPDATE_DATA_DIR))
      .finally(() => { updating = null; });
    lastUpdate = updating;
  }
  return updating;
}

// 계산식 버전: v2 exe는 빌드 때 패키지 package.json 에 erFormula:"v2" 가 들어간다(electron/build.js --v2).
// 개발 실행은 환경변수 ER_FORMULA=v2 로 고를 수 있다. 'v2' 외의 값은 기본(v1, 주입 없음).
const FORMULA = (app.isPackaged ? require('../package.json').erFormula : process.env.ER_FORMULA) === 'v2' ? 'v2' : null;

// 개발 실행(npm run app)과 exe가 같은 히스토리를 쓰도록 저장 위치 고정. v2는 별도 폴더(히스토리 분리).
app.setPath('userData', path.join(app.getPath('appData'), FORMULA ? 'er-damage-efficiency-v2' : 'er-damage-efficiency'));

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
    height: 860,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // preload.js 가 이 인자를 보고 window.ER_FORMULA 를 주입한다.
      additionalArguments: FORMULA ? [`--er-formula=${FORMULA}`] : [],
    },
  });
  // v2 창 제목에는 v2 를 붙인다(페이지 <title> 이 창 제목을 덮어쓰므로 여기서 가로챈다).
  if (FORMULA) {
    win.webContents.on('page-title-updated', (event, title) => {
      if (/\bv2\b/i.test(title)) return;
      event.preventDefault();
      win.setTitle(`${title} v2`);
    });
  }
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
function smokeTest(win, outFile) {
  const updateSelector = process.env.ER_SMOKE_UPDATE;
  const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), updateSelector ? 180000 : 30000);
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
          itemCount: document.querySelectorAll('#slots select option, #slots button').length,
          slotButtons: document.querySelectorAll('#slots button').length,
          localStorageKeys: Object.keys(localStorage),
          formula: window.ER_FORMULA === undefined ? null : window.ER_FORMULA,
          hasSkillAmpInput: document.body.innerText.includes('스킬 증폭 계수'),
        })`);
        result.windowTitle = win.getTitle();
        result.externalRoot = EXTERNAL_ROOT;
        result.userData = app.getPath('userData');
        // 빌드 버전 확인: v2는 주입·창 제목·v2 입력란(스킬 증폭 계수), v1은 주입 없음.
        const formulaOk = FORMULA
          ? result.formula === 'v2' && /\bv2\b/.test(result.windowTitle) && result.hasSkillAmpInput
          : result.formula === null;
        result.ok = result.bannerHidden && result.slotButtons > 0 && formulaOk;
        if (updateSelector) {
          result.update = await smokeClickUpdate(win, updateSelector);
          result.ok = result.ok && result.update.ok;
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
  const file = path.join(UPDATE_DATA_DIR, 'items.json');
  const mtime = () => (fs.existsSync(file) ? fs.statSync(file).mtime.toISOString() : null);
  const before = mtime();
  const prev = lastUpdate;
  const clicked = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b || b.hidden) return false; b.click(); return true; })()`);
  if (!clicked) return { ok: false, error: `button not found or hidden: ${selector}` };
  const deadline = Date.now() + 5000;
  while (lastUpdate === prev && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (lastUpdate === prev) return { ok: false, error: 'click did not start update' };
  try {
    const res = await lastUpdate;
    await new Promise((r) => setTimeout(r, 2000)); // UI가 새 파일을 다시 읽을 시간
    const after = mtime();
    // 프로토콜로 다시 읽은 data/items.json 개수와 UI 상태 문구.
    const ui = await win.webContents.executeJavaScript(`(async () => ({
      servedCount: (await (await fetch('data/items.json', { cache: 'no-store' })).json()).length,
      status: (document.getElementById('update-status') || {}).textContent || '',
      bannerHidden: document.getElementById('data-banner').hidden,
    }))()`);
    const ok = after !== null && after !== before && ui.servedCount === res.count && ui.bannerHidden;
    return { ok, before, after, ...res, ...ui };
  } catch (err) {
    return { ok: false, before, error: String(err && err.message || err) };
  }
}

if (!app.requestSingleInstanceLock()) {
  // 이미 실행 중이면 기존 창을 앞으로(second-instance). 검증 실행이면 실패로 끝낸다.
  if (process.env.ER_SMOKE_OUT) console.error('smoke: another instance is already running');
  app.exit(process.env.ER_SMOKE_OUT ? 1 : 0);
} else {
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
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
