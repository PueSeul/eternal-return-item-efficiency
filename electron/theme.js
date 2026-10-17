'use strict';
// src/style.css 의 CSS 변수 값 읽기. 창 조절 버튼 오버레이(titleBarOverlay) 색을 화면 색(--bg·--text)과 맞춘다.
const fs = require('fs');
const path = require('path');

function cssVar(css, name) {
  const m = new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*([^;}]+)`).exec(css);
  if (!m) throw new Error(`style.css 에 ${name} 변수가 없습니다`);
  return m[1].trim();
}

// 반환 { color: 배경(--bg), symbolColor: 글자(--text) }.
function titleBarColors(appRoot) {
  const css = fs.readFileSync(path.join(appRoot, 'src', 'style.css'), 'utf8');
  return { color: cssVar(css, '--bg'), symbolColor: cssVar(css, '--text') };
}

module.exports = { cssVar, titleBarColors };
