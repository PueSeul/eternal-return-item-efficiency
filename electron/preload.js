'use strict';
// 렌더러(index.html)에 window.erDesktop 노출. sandbox 렌더러라 electron 모듈만 쓴다.
const { contextBridge, ipcRenderer } = require('electron');

// main 이 additionalArguments 로 넘긴 --er-formula=v1|v2 를 window.ER_FORMULA 로 주입(src/app.js 기본은 v2).
const formulaArg = process.argv.find((a) => a === '--er-formula=v1' || a === '--er-formula=v2');
if (formulaArg) contextBridge.exposeInMainWorld('ER_FORMULA', formulaArg.slice('--er-formula='.length));

// main 이벤트 구독. 반환한 함수를 부르면 구독 해제.
function subscribe(channel, cb) {
  const listener = (_event, p) => cb(p);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// ipcRenderer.invoke 오류에서 "Error invoking remote method '...': Error: " 접두어를 떼고 원래 메시지만 전달.
async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    const msg = String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
    throw new Error(msg);
  }
}

// 프로그램 업데이트(main.js · app-update.js).
const appUpdate = {
  check: () => invoke('app-update:check'), // { status: 'latest'|'available', current, version, notes, url }
  install: () => invoke('app-update:install'), // 받은 뒤 교체 배치를 띄우고 프로그램이 종료된다
  dismiss: (version) => invoke('app-update:dismiss', version),
  onAvailable: (cb) => subscribe('app-update:available', cb), // { version, notes, url }
  onProgress: (cb) => subscribe('app-update:progress', cb), // { received, total, percent }
  onError: (cb) => subscribe('app-update:error', cb), // 지난 교체 실패 메시지
};

contextBridge.exposeInMainWorld('erDesktop', {
  // 업데이트 진행 이벤트 {stage, done, total, message} 구독.
  onUpdateProgress: (cb) => subscribe('update:progress', cb),
  // 아이템 수치 업데이트: 성공 시 { count, savedPath, skills, meta }, 실패 시 오류 메시지(어느 단계에서 왜)로 reject.
  // options.skillsMode: 'patched'(기본) | 'all'.
  updateItems: (options) => invoke('er:update-items', { skillsMode: options && options.skillsMode }),
  appUpdate,
});

// --er-app-update(기본 exe): 머리글에 "업데이트 확인" 버튼, 그 아래에 새 버전 배너를 넣는다(index.html 은 그대로).
// 원격 문자열(릴리스 노트 등)은 textContent·title 로만 넣는다.
function mountAppUpdateUi() {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const status = el('span', { id: 'app-update-status', className: 'muted' });
  status.setAttribute('role', 'status');
  const check = el('button', { id: 'app-update-check', type: 'button', textContent: '업데이트 확인' });
  const box = document.querySelector('header .update-box') || document.querySelector('header') || document.body;
  box.append(status, check);

  const banner = el('div', { id: 'app-update-banner', className: 'banner', hidden: true });
  // display 를 인라인으로 주면 hidden 이 무시되므로 간격은 margin 으로 준다.
  Object.assign(banner.style, { borderColor: 'var(--accent)', color: 'var(--text)' });
  const text = el('span');
  const now = el('button', { id: 'app-update-now', type: 'button', textContent: '지금 업데이트' });
  const later = el('button', { id: 'app-update-later', type: 'button', textContent: '나중에' });
  const notes = el('a', { textContent: '릴리스 노트', target: '_blank', rel: 'noopener' });
  for (const node of [now, later, notes]) node.style.marginLeft = '10px';
  banner.append(text, now, later, notes);
  const header = document.querySelector('header');
  if (header) header.after(banner);
  else document.body.prepend(banner);

  let shown = null;
  let installing = false; // 설치 중에는 확인 결과가 배너(설치 대상 버전)를 바꾸지 않는다
  const mb = (n) => (n / 1048576).toFixed(1);
  const show = (info) => {
    if (installing) return;
    shown = info;
    text.textContent = `새 버전 v${info.version}`;
    banner.title = info.notes ? info.notes.slice(0, 1000) : '';
    notes.href = info.url || '';
    notes.hidden = !/^https:\/\//.test(info.url || '');
    now.hidden = false;
    now.disabled = false;
    later.disabled = false;
    banner.hidden = false;
  };
  appUpdate.onAvailable(show);
  appUpdate.onError((msg) => {
    shown = null;
    text.textContent = `업데이트 실패: ${msg}`;
    now.hidden = true;
    notes.hidden = true;
    banner.hidden = false;
  });
  appUpdate.onProgress(({ received, total, percent }) => {
    if (!shown) return;
    text.textContent = percent === null
      ? `새 버전 v${shown.version} 내려받는 중 (${mb(received)} MB)`
      : `새 버전 v${shown.version} 내려받는 중 ${percent}% (${mb(received)} / ${mb(total)} MB)`;
  });
  now.addEventListener('click', async () => {
    if (!shown || installing) return;
    installing = true;
    now.disabled = true;
    later.disabled = true;
    check.disabled = true;
    text.textContent = `새 버전 v${shown.version} 내려받는 중…`;
    try {
      await appUpdate.install();
      text.textContent = `v${shown.version} 내려받기 완료 — 프로그램을 교체하고 다시 시작합니다…`;
    } catch (err) {
      installing = false;
      text.textContent = `업데이트 실패: ${err.message} (현재 버전을 그대로 씁니다)`;
      now.disabled = false;
      later.disabled = false;
      check.disabled = false;
    }
  });
  later.addEventListener('click', () => {
    banner.hidden = true;
    if (shown) appUpdate.dismiss(shown.version).catch(() => {});
  });
  check.addEventListener('click', async () => {
    if (installing) return;
    check.disabled = true;
    status.style.color = '';
    status.textContent = '업데이트 확인 중…';
    try {
      const res = await appUpdate.check();
      if (res.status === 'available') {
        status.textContent = `새 버전 v${res.version}이 있습니다`;
        show(res);
      } else {
        status.textContent = `최신 버전입니다(v${res.current})`;
        if (!installing && shown) { // 이전에 알린 버전이 철회된 경우 배너도 내린다
          shown = null;
          banner.hidden = true;
        }
      }
    } catch (err) {
      status.textContent = err.message;
      status.style.color = 'var(--warn)';
    } finally {
      check.disabled = installing;
    }
  });
}

if (process.argv.includes('--er-app-update')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAppUpdateUi);
  else mountAppUpdateUi();
}
