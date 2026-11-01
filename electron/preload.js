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
  // 업데이트 진행 이벤트 {stage, done, total, message, cancellable: true} 구독.
  onUpdateProgress: (cb) => subscribe('update:progress', cb),
  // 아이템 수치 업데이트: 성공 시 { count, savedPath, skills, meta }(교체 중 취소가 왔으면 completedBeforeCancel: true 추가),
  // 취소 시 { cancelled: true }(네 파일 그대로), 실패 시 오류 메시지(어느 단계에서 왜)로 reject.
  // options.skillsMode: 'patched'(기본) | 'all'.
  updateItems: (options) => invoke('er:update-items', { skillsMode: options && options.skillsMode }),
  // 진행 중인 업데이트 취소 → 업데이트가 끝난 뒤 { cancelled: true }(교체 전에 멈춤) |
  // { cancelled: false, completedBeforeCancel: true }(이미 교체됨) | { cancelled: false }(진행 중인 업데이트 없음·실패).
  cancelUpdate: () => invoke('update:cancel'),
  appUpdate,
});

// --er-app-update(기본 exe): 머리글 1행(.update-box 의 #app-update-group)에 상태 칸과 버튼 하나를 넣는다(index.html 은 그대로).
// 버튼 하나가 상태에 따라 바뀐다: "업데이트 확인"(확인) → 새 버전이 있으면 "지금 업데이트"(primary, 설치)
// → 설치 실패 시 "다시 시도"(primary, 설치). 상태 칸(버튼 왼쪽)은 "새 버전 v1.9.0 · [나중에] [릴리스 노트]".
// 내려받기 진행률은 src/app.js 가 상태 칸 맨 앞에 넣는 원형 게이지가 보여 준다(문구 칸 #app-update-text 를 보고 시작·완료·실패를 안다).
// 원격 문자열(릴리스 노트 등)은 textContent·title 로만 넣는다.
function mountAppUpdateUi() {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const status = el('span', { id: 'app-update-status', className: 'muted' });
  status.setAttribute('role', 'status');
  const text = el('span', { id: 'app-update-text' });
  const later = el('button', { id: 'app-update-later', type: 'button', className: 'text-btn', textContent: '나중에', hidden: true });
  // 링크는 앱의 링크형 버튼 모양(.meta-line: 보조색, hover·포커스 때 밑줄). 브라우저로 열린다(main.js setWindowOpenHandler).
  const notes = el('a', { id: 'app-update-notes', className: 'meta-line', textContent: '릴리스 노트', target: '_blank', rel: 'noopener', hidden: true });
  const sep = el('span', { id: 'app-update-sep', textContent: '·', hidden: true });
  sep.setAttribute('aria-hidden', 'true');
  status.append(text, sep, later, notes);
  const btn = el('button', { id: 'app-update-check', type: 'button', textContent: '업데이트 확인' });
  // 머리글 .update-box 안에 데이터 그룹과 같은 .update-group 으로 넣는다(격자 칸·폭은 src/style.css).
  const group = el('div', { id: 'app-update-group', className: 'update-group' });
  group.append(status, btn);
  const box = document.querySelector('header .update-box') || document.querySelector('header') || document.body;
  box.append(group);

  let mode = 'check'; // 버튼 동작: 'check' | 'install' | 'retry'
  const setMode = (m) => {
    mode = m;
    btn.textContent = m === 'check' ? '업데이트 확인' : m === 'install' ? '지금 업데이트' : '다시 시도';
    btn.classList.toggle('primary', m !== 'check');
  };
  // 상태 문구: 짧은 문구 + 툴팁에 전체 문장. fade(완료 문구)는 5초 뒤 지운다. links: "나중에"·"릴리스 노트" 표시.
  let clearTimer = null;
  const setStatus = (msg, { full, warn, fade, links } = {}) => {
    clearTimeout(clearTimer);
    status.style.color = warn ? 'var(--warn)' : '';
    text.textContent = msg;
    status.title = full || msg;
    later.hidden = !links;
    sep.hidden = !links;
    notes.hidden = !links || !notes.getAttribute('href');
    if (fade) clearTimer = setTimeout(() => { text.textContent = ''; status.title = ''; }, 5000);
  };

  let shown = null; // 알린 새 버전 { version, notes, url }
  let installing = false; // 설치 중에는 확인 결과·알림이 표시(설치 대상 버전)를 바꾸지 않는다
  const show = (info) => {
    if (installing) return;
    shown = info;
    if (/^https:\/\//.test(info.url || '')) notes.href = info.url;
    else notes.removeAttribute('href');
    setStatus(`새 버전 v${info.version}`, { full: info.notes ? info.notes.slice(0, 1000) : `새 버전 v${info.version}이 있습니다`, links: true });
    setMode('install');
    btn.disabled = false;
  };
  appUpdate.onAvailable(show);
  appUpdate.onError((msg) => { // 지난 교체 실패: 문구만(설치할 대상이 없으므로 버튼은 "업데이트 확인")
    if (installing) return;
    shown = null;
    setStatus(`업데이트 실패: ${msg}`, { warn: true });
    setMode('check');
  });
  // 퍼센트는 게이지가 보여 주므로 문구 칸에는 버전만 남겨 두 번 보이지 않게 한다.
  appUpdate.onProgress(() => {
    if (shown && installing) text.textContent = `새 버전 v${shown.version}`;
  });
  const install = async () => {
    if (!shown || installing) return;
    installing = true;
    btn.disabled = true;
    setStatus(`새 버전 v${shown.version} 내려받는 중…`);
    try {
      await appUpdate.install();
      setStatus(`v${shown.version} 내려받기 완료 — 프로그램을 교체하고 다시 시작합니다…`);
    } catch (err) {
      installing = false;
      // 문구는 오류만(머리글 한 줄), 툴팁에 현재 버전 유지 안내까지.
      setStatus(`업데이트 실패: ${err.message}`, { full: `업데이트 실패: ${err.message} (현재 버전을 그대로 씁니다)`, warn: true });
      setMode('retry');
      btn.disabled = false;
    }
  };
  const check = async () => {
    btn.disabled = true;
    setStatus('업데이트 확인 중…');
    try {
      const res = await appUpdate.check();
      if (res.status === 'available') show(res);
      else if (!installing) {
        shown = null; // 이전에 알린 버전이 철회된 경우(확인 중 도착한 알림 포함)도 내린다
        setMode('check');
        setStatus(`최신 버전 v${res.current}`, { full: `최신 버전입니다(v${res.current})`, fade: true });
      }
    } catch (err) {
      if (!installing) setStatus(err.message, { warn: true });
    } finally {
      btn.disabled = installing;
    }
  };
  btn.addEventListener('click', () => {
    if (installing) return;
    if (mode === 'check') check();
    else install();
  });
  // 나중에: 이번 실행에서는 다시 알리지 않는다. 버튼은 "업데이트 확인"으로, 문구는 버전만 남긴다.
  later.addEventListener('click', () => {
    if (!shown || installing) return;
    appUpdate.dismiss(shown.version).catch(() => {});
    setStatus(`새 버전 v${shown.version}`, { full: status.title });
    setMode('check');
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
