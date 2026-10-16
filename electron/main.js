'use strict';
// 데스크톱(exe) 진입점: 기존 index.html UI를 app://calc/ 주소로 띄운다.
// file://에서는 data/items.json fetch가 막히므로 커스텀 프로토콜로 파일을 서빙한다(UI 파일은 그대로).
// 히스토리(localStorage)는 app://calc 주소 기준으로 %APPDATA%\er-damage-efficiency 에 저장된다.
const { app, BrowserWindow, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveFile, contentType } = require('./resolve');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://calc`;
const APP_ROOT = path.join(__dirname, '..');
// exe 옆 data/ 폴더를 우선 사용(portable exe는 임시 폴더에서 풀려 실행되므로 원래 exe 위치를 쓴다).
const EXTERNAL_ROOT = !app.isPackaged ? null
  : process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);

// 개발 실행(npm run app)과 exe가 같은 히스토리를 쓰도록 저장 위치 고정.
app.setPath('userData', path.join(app.getPath('appData'), 'er-damage-efficiency'));

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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
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
// 데이터가 로드되지 않았거나(배너 표시) 검사 중 오류·30초 초과면 종료 코드 1.
function smokeTest(win, outFile) {
  const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 30000);
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
          priceNote: document.getElementById('price-note').textContent,
          slotButtons: document.querySelectorAll('#slots button').length,
          localStorageKeys: Object.keys(localStorage),
        })`);
        result.externalRoot = EXTERNAL_ROOT;
        result.userData = app.getPath('userData');
        result.ok = result.bannerHidden && result.slotButtons > 0 && result.priceNote !== '';
        const image = await win.webContents.capturePage();
        fs.writeFileSync(outFile.replace(/\.json$/i, '') + '.png', image.toPNG());
        finish(result);
      } catch (err) {
        finish({ ok: false, error: String(err && err.message || err) });
      }
    }, 1500);
  });
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
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
