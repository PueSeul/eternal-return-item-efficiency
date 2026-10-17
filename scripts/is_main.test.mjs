import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { isMain } from "./is_main.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(DIR, "is_main.mjs");
const SWAP_ARG = "--er-swap-from=C:\\Users\\x\\ER-Damage-Calculator-1.7.2-portable.exe";

test("isMain: argv[1] that is the module file is true, other or unresolvable argv[1] false", () => {
  const url = pathToFileURL(SELF).href;
  assert.equal(isMain(url, ["node", SELF]), true);
  assert.equal(isMain(url, ["node", path.join(DIR, "fetch_items.mjs")]), false);
  assert.equal(isMain(url, ["exe"]), false);
  assert.equal(isMain(url, ["exe", SWAP_ARG]), false); // 업데이트 뒤 exe 의 첫 인자(이전에는 lstat ENOENT)
  assert.equal(isMain(url, ["exe", "--er-no-rename"]), false);
});

// 패키지 앱에서 process.argv[1] 은 exe 의 첫 인자다. 그 상태로 네 수집 모듈을 불러와도 오류가 없어야 한다.
test("fetch_*.mjs import without error when argv[1] is the exe's update argument", () => {
  const names = ["fetch_items.mjs", "fetch_characters.mjs", "fetch_skills.mjs", "fetch_patchnote.mjs"];
  const code = `process.argv[1] = ${JSON.stringify(SWAP_ARG)};
for (const n of ${JSON.stringify(names)}) await import(${JSON.stringify(pathToFileURL(DIR).href + "/")} + n);
console.log("ok");`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(out.trim(), "ok");
});
