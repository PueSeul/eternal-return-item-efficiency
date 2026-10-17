'use strict';
// app:// 프로토콜 요청 경로 → 실제 파일 경로. Electron 없이 테스트할 수 있도록 분리.
// data/ 아래 파일은 exe 옆 data/ 폴더(외부 데이터)에 있으면 그것을 우선 사용한다.
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// root 밖으로 나가는 경로(.., 절대경로, NUL)는 null.
function safeJoin(root, rel) {
  if (rel.includes('\0')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, '.' + path.sep + rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

// urlPath: URL의 pathname(예: '/data/items.json'). appRoot: 앱 파일 폴더.
// externalRoot: exe가 있는 폴더(없으면 null). 반환: 읽을 파일 경로 또는 null.
function resolveFile(urlPath, appRoot, externalRoot) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const parts = rel.split(/[\\/]+/);
  if (externalRoot && parts[0] === 'data' && parts.length > 1) {
    const ext = safeJoin(path.join(externalRoot, 'data'), parts.slice(1).join(path.sep));
    if (ext && isFile(ext)) return ext;
  }
  return safeJoin(appRoot, rel);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

module.exports = { resolveFile, contentType };
