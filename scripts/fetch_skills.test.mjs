// node --test: namu.wiki page fetching (concurrency, spacing, progress, failures) and fetchAll stage errors,
// with globalThis.fetch replaced (no network).
import test from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchPages, ROBOTS_URL } from "./fetch_skills.mjs";
import { describeError } from "./fetch_patchnote.mjs";
import { fetchAll, ITEMS_URL } from "./fetch_items.mjs";

const ROBOTS = "User-agent: *\nAllow: /w/\nDisallow: /\n";

function withFetch(impl, run) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => { globalThis.fetch = real; });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("fetchPages: at most 3 in flight, starts spaced by intervalMs, progress per document", async () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const starts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const events = [];
  const pages = await withFetch(async (url) => {
    if (url === ROBOTS_URL) return new Response(ROBOTS);
    starts.push(performance.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(200);
    inFlight -= 1;
    return new Response(`<html>${decodeURIComponent(url)}</html>`);
  }, () => fetchPages(names, 40, { onPage: (done, total, name) => events.push([done, total, name]) }));
  assert.deepStrictEqual([...pages.keys()], names);
  for (const n of names) assert.match(pages.get(n), new RegExp(`/w/${n}\\(이터널 리턴\\)`));
  assert.strictEqual(maxInFlight, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 38, `gap ${i}: ${starts[i] - starts[i - 1]}`);
  assert.deepStrictEqual(events.map((e) => e[0]), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(events.every((e) => e[1] === 7));
  assert.deepStrictEqual(events.map((e) => e[2]).sort(), names);
});

test("fetchPages: starts stay intervalMs apart even when timers fire late", async () => {
  const starts = [];
  const run = withFetch(async (url) => {
    if (url !== ROBOTS_URL) starts.push(performance.now());
    return new Response(url === ROBOTS_URL ? ROBOTS : "ok");
  }, () => fetchPages(["a", "b", "c", "d", "e", "f"], 50));
  await sleep(5);
  const end = performance.now() + 200; // block the event loop so several turns become due at once
  while (performance.now() < end);
  await run;
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 49, `gap ${i}: ${starts[i] - starts[i - 1]}`);
});

test("fetchPages: a failing document is named, aborts requests in flight and starts no more", async () => {
  const requested = [];
  const aborted = [];
  let failedAt = null;
  await assert.rejects(withFetch(async (url, init) => {
    if (url === ROBOTS_URL) return new Response(ROBOTS);
    requested.push(url);
    if (decodeURIComponent(url).includes("/w/b(")) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 300);
      init.signal.addEventListener("abort", () => { clearTimeout(t); aborted.push(url); reject(init.signal.reason); });
    });
    return new Response("ok");
  }, () => fetchPages(["a", "b", "c", "d", "e", "f", "g", "h"], 10).catch((err) => {
    failedAt = requested.length;
    throw err;
  })), /나무위키 문서 "b": 응답 없음\(20초 초과\)/);
  await sleep(400);
  assert.strictEqual(requested.length, failedAt, "no request starts after the failure");
  assert.ok(aborted.length >= 1, "requests in flight are aborted");
});

test("describeError: timeout, network cause, plain message", () => {
  assert.strictEqual(describeError(new DOMException("x", "TimeoutError")), "응답 없음(20초 초과)");
  assert.strictEqual(describeError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })), "fetch failed (ECONNREFUSED)");
  assert.strictEqual(describeError(new Error("HTTP 500 for u")), "HTTP 500 for u");
});

test("fetchAll: failure names the stage and aborts the other downloads", async () => {
  const events = [];
  const aborted = [];
  await assert.rejects(withFetch(async (url, init) => {
    if (url === ITEMS_URL) {
      await sleep(10);
      throw new DOMException("x", "TimeoutError");
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => { aborted.push(url); reject(init.signal.reason); });
    });
  }, () => fetchAll({ outDir: "unused", onProgress: (p) => events.push(p) })), /아이템 수집\(dak\.gg\) 단계 실패: 응답 없음\(20초 초과\)/);
  assert.deepStrictEqual(events.map((e) => e.stage).sort(), ["characters", "items", "patchnotes"]);
  for (const e of events) assert.deepStrictEqual(Object.keys(e), ["stage", "done", "total", "message"]);
  assert.strictEqual(aborted.length, 3, "masteries, characters and the patch-note list are aborted");
});

test("fetchAll: a processing error is named too", async () => {
  const article = { id: 1, url: "https://example.invalid/1", created_at: "2026-10-14T08:00:00Z", is_hidden: false,
    i18ns: { ko_KR: { title: "2026.10.15 - 12.6 패치노트" } } };
  await assert.rejects(withFetch(async (url) => {
    if (url === ROBOTS_URL) return new Response(ROBOTS);
    if (url === ITEMS_URL) return Response.json({ items: [{ id: 7 }] }); // item without type
    if (url.includes("dakgg")) return Response.json({ masteries: [], characters: [] });
    if (url.includes("posts/news")) return Response.json({ articles: [article], total_page: 1 });
    if (url === article.url) return new Response("<p></p>");
    return new Response("", { status: 404 });
  }, () => fetchAll({ outDir: "unused", intervalMs: 0 })), /^Error: 데이터 처리 단계 실패: item 7 has no type$/);
});

test("fetchAll: signal ends the namu.wiki wait at once, starts no more requests and writes nothing", async () => {
  const article = { id: 1, url: "https://example.invalid/1", created_at: "2026-10-14T08:00:00Z", is_hidden: false,
    i18ns: { ko_KR: { title: "2026.10.15 - 12.6 패치노트" } } };
  const outDir = path.join(os.tmpdir(), `er-cancel-test-${process.pid}-${Date.now()}`);
  const controller = new AbortController();
  const docs = [];
  let abortedAt = 0;
  const run = withFetch(async (url) => {
    if (url === ROBOTS_URL) return new Response(ROBOTS);
    if (url === ITEMS_URL) return Response.json({ items: [] });
    if (url.includes("dakgg")) return Response.json({ masteries: [], characters: [{ id: 1, name: "아르다" }] });
    if (url.includes("posts/news")) return Response.json({ articles: [article], total_page: 1 });
    if (url === article.url) return new Response('<div class="er-article-detail__content"><p></p></div>');
    docs.push(url);
    return new Response("<p></p>");
  }, () => fetchAll({
    outDir, skillsMode: "all", intervalMs: 60000, signal: controller.signal,
    onProgress: (p) => {
      if (p.stage === "skills" && p.done === 0) setTimeout(() => { abortedAt = performance.now(); controller.abort(new Error("취소")); }, 20);
    },
  }));
  await assert.rejects(run, /^Error: 취소$/);
  assert.ok(abortedAt > 0 && performance.now() - abortedAt < 200, `ended ${performance.now() - abortedAt}ms after the abort`);
  assert.deepStrictEqual(docs, [], "the throttled document request never starts");
  assert.ok(!existsSync(outDir), "outDir untouched");
});
