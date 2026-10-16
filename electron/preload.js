'use strict';
// 렌더러(index.html)에 window.erDesktop 노출. sandbox 렌더러라 electron 모듈만 쓴다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('erDesktop', {
  // 아이템 수치 업데이트: 성공 시 { count, savedPath }, 실패 시 오류 메시지로 reject.
  updateItems: async () => {
    try {
      return await ipcRenderer.invoke('er:update-items');
    } catch (err) {
      // "Error invoking remote method '...': Error: " 접두어를 떼고 원래 메시지만 전달.
      const msg = String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
      throw new Error(msg);
    }
  },
});
