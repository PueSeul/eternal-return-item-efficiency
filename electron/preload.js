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
  // 머리글 2행의 .update-box 안에 데이터 그룹과 같은 .update-group 으로 넣는다(구분점·줄바꿈은 src/style.css).
  const group = el('div', { id: 'app-update-group', className: 'update-group' });
  group.append(status, check);
  const box = document.querySelector('header .update-box') || document.querySelector('header') || document.body;
  box.append(group);
  // 상태 문구: 짧은 문구 + 툴팁에 전체 문장. fade(완료 문구)는 5초 뒤 지운다.
  let clearTimer = null;
  const setStatus = (text, full, color, fade) => {
    clearTimeout(clearTimer);
    status.style.color = color || '';
    status.textContent = text;
    status.title = full || text;
    if (fade) clearTimer = setTimeout(() => { status.textContent = ''; status.title = ''; }, 5000);
  };

  const banner = el('div', { id: 'app-update-banner', className: 'banner', hidden: true });
  // display 를 인라인으로 주면 hidden 이 무시되므로 간격은 margin 으로 준다.
  Object.assign(banner.style, { borderColor: 'var(--accent)', color: 'var(--text)' });
  const text = el('span');
  const now = el('button', { id: 'app-update-now', type: 'button', textContent: '지금 업데이트' });
  const later = el('button', { id: 'app-update-later', type: 'button', className: 'text-btn', textContent: '나중에' });
  // 링크는 앱의 링크형 버튼 모양(.meta-line: 보조색, hover·포커스 때 강조색+밑줄). <a> 기본 밑줄만 지운다.
  const notes = el('a', { className: 'meta-line', textContent: '릴리스 노트', target: '_blank', rel: 'noopener' });
  document.head.append(el('style', { textContent:
    '#app-update-banner a { text-decoration: none; }'
    + ' #app-update-banner a:hover, #app-update-banner a:focus-visible { color: var(--accent); text-decoration: underline; }' }));
  for (const node of [now, later, notes]) node.style.marginLeft = '10px';
  banner.append(text, now, later, notes);
  const header = document.querySelector('header');
  if (header) header.after(banner);
  else document.body.prepend(banner);

  let shown = null;
  let installing = false; // 설치 중에는 확인 결과가 배너(설치 대상 버전)를 바꾸지 않는다
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
  // 진행률·크기는 src/app.js 가 배너 앞에 넣는 원형 게이지(src/gauge.js)가 보여 준다("37% 내려받는 중 · 12.3 / 100.0 MB").
  // 문구 칸에는 버전만 남겨 퍼센트를 두 번 보이지 않게 한다.
  appUpdate.onProgress(() => {
    if (shown) text.textContent = `새 버전 v${shown.version}`;
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
    setStatus('업데이트 확인 중…');
    try {
      const res = await appUpdate.check();
      if (res.status === 'available') {
        setStatus(`새 버전 v${res.version}`, `새 버전 v${res.version}이 있습니다`);
        show(res);
      } else {
        setStatus(`최신 버전 v${res.current}`, `최신 버전입니다(v${res.current})`, '', true);
        if (!installing && shown) { // 이전에 알린 버전이 철회된 경우 배너도 내린다
          shown = null;
          banner.hidden = true;
        }
      }
    } catch (err) {
      setStatus(err.message, err.message, 'var(--warn)');
    } finally {
      check.disabled = installing;
    }
  });
}

// --er-titlebar(데스크톱): index.html 의 #titlebar 를 보이게 하고 아이콘·버전을 넣는다. 제목은 document.title 을 따른다.
function mountTitlebar() {
  const bar = document.getElementById('titlebar');
  if (!bar) return;
  const versionArg = process.argv.find((a) => a.startsWith('--er-version='));
  bar.querySelector('.titlebar-icon').src = 'build/icon.ico';
  bar.querySelector('.titlebar-version').textContent = versionArg ? versionArg.slice('--er-version='.length) : '';
  const title = bar.querySelector('.titlebar-title');
  const sync = () => { title.textContent = document.title; };
  sync();
  new MutationObserver(sync).observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });
  bar.hidden = false;
}

const onReady = (fn) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
};
if (process.argv.includes('--er-titlebar')) onReady(mountTitlebar);

if (process.argv.includes('--er-app-update')) onReady(mountAppUpdateUi);
