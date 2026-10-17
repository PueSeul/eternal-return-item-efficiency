import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FILES, MANIFEST_NAME, publish, sameData } from "./refresh_data.mjs";

const meta = (fetchedAt, version = "1.2") => JSON.stringify({ fetchedAt, dakggVersion: "9.9", patch: { version } });
function dir(files) {
  const d = mkdtempSync(path.join(tmpdir(), "er-refresh-test-"));
  for (const [n, t] of Object.entries(files)) writeFileSync(path.join(d, n), t);
  return d;
}
const BASE = { "items.json": "[1]\n", "characters.json": "[2]\n", "skills.json": "[3]\n" };

test("sameData ignores only items.meta.json fetchedAt", () => {
  const old = dir({ ...BASE, "items.meta.json": meta("A") });
  assert.equal(sameData(old, dir({ ...BASE, "items.meta.json": meta("B") })), true);
  assert.equal(sameData(old, dir({ ...BASE, "items.meta.json": meta("B", "1.3") })), false);
  assert.equal(sameData(old, dir({ ...BASE, "skills.json": "[4]\n", "items.meta.json": meta("A") })), false);
  assert.equal(sameData(dir({}), dir({ ...BASE, "items.meta.json": meta("A") })), false);
});

test("publish keeps data/ when only fetchedAt changed and writes the release assets with a manifest", () => {
  const dataDir = dir({ ...BASE, "items.meta.json": meta("A") });
  const release = path.join(dir({}), "release");
  let r = publish(dir({ ...BASE, "items.meta.json": meta("B") }), dataDir, release);
  assert.equal(r.changed, false);
  assert.equal(readFileSync(path.join(dataDir, "items.meta.json"), "utf8"), meta("A"));
  const manifest = JSON.parse(readFileSync(path.join(release, MANIFEST_NAME), "utf8"));
  assert.equal(manifest.generatedAt, "A");
  assert.equal(manifest.dakggVersion, "9.9");
  assert.deepEqual(manifest.patch, { version: "1.2" });
  for (const n of FILES) {
    const body = readFileSync(path.join(release, n));
    assert.deepEqual(body, readFileSync(path.join(dataDir, n)));
    assert.equal(manifest.sha256[n], createHash("sha256").update(body).digest("hex"));
  }
  r = publish(dir({ ...BASE, "skills.json": "[5]\n", "items.meta.json": meta("C") }), dataDir, release);
  assert.equal(r.changed, true);
  assert.equal(readFileSync(path.join(dataDir, "skills.json"), "utf8"), "[5]\n");
  assert.equal(r.manifest.generatedAt, "C");
  assert.deepEqual(JSON.parse(readFileSync(path.join(release, MANIFEST_NAME), "utf8")), r.manifest);
});

test("publish refuses an empty or malformed list and leaves data/ and the release dir untouched", () => {
  const dataDir = dir({ ...BASE, "items.meta.json": meta("A") });
  const release = path.join(dir({}), "release");
  assert.throws(() => publish(dir({ ...BASE, "characters.json": "[]\n", "items.meta.json": meta("B") }), dataDir, release),
    /characters\.json is empty or not a list/);
  assert.throws(() => publish(dir({ ...BASE, "items.json": "{}\n", "items.meta.json": meta("B") }), dataDir, release),
    /items\.json is empty or not a list/);
  assert.equal(readFileSync(path.join(dataDir, "characters.json"), "utf8"), "[2]\n");
  assert.equal(existsSync(release), false);
});
