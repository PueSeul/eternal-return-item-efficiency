'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { cssVar, titleBarColors } = require('./theme');

test('cssVar reads the exact variable, not one whose name ends the same way', () => {
  const css = ':root {\n  --accent-bg: #111;\n  --bg: #121417;\n  --text:#e3e5e8 }';
  assert.strictEqual(cssVar(css, '--bg'), '#121417');
  assert.strictEqual(cssVar(css, '--text'), '#e3e5e8');
  assert.throws(() => cssVar(css, '--missing'), /--missing/);
});

test('titleBarColors takes the overlay colors from src/style.css (--bg / --text)', () => {
  const { color, symbolColor } = titleBarColors(path.join(__dirname, '..'));
  assert.match(color, /^#[0-9a-f]{3,8}$/i);
  assert.match(symbolColor, /^#[0-9a-f]{3,8}$/i);
  assert.notStrictEqual(color, symbolColor);
});
