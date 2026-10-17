'use strict';
// 렌더러(index.html)에 window.erDesktop 노출. sandbox 렌더러라 electron 모듈만 쓴다.
const { contextBridge, ipcRenderer } = require('electron');

// v2 exe: main 이 additionalArguments 로 넘긴 --er-formula=v2 를 window.ER_FORMULA 로 주입. 기본(v1)은 주입하지 않음.
if (process.argv.includes('--er-formula=v2')) contextBridge.exposeInMainWorld('ER_FORMULA', 'v2');

contextBridge.exposeInMainWorld('erDesktop', {
  // 업데이트 진행 이벤트 {stage, done, total, message} 구독. 반환한 함수를 부르면 구독 해제.
  onUpdateProgress: (cb) => {
    const listener = (_event, p) => cb(p);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  // 아이템 수치 업데이트: 성공 시 { count, savedPath, skills, meta }, 실패 시 오류 메시지(어느 단계에서 왜)로 reject.
  // options.skillsMode: 'patched'(기본) | 'all'.
  updateItems: async (options) => {
    try {
      return await ipcRenderer.invoke('er:update-items', { skillsMode: options && options.skillsMode });
    } catch (err) {
      // "Error invoking remote method '...': Error: " 접두어를 떼고 원래 메시지만 전달.
      const msg = String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
      throw new Error(msg);
    }
  },
});
