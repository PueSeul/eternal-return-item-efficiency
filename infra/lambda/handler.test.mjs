// node --test: infra/lambda/handler.mjs against a fake GitHub (mock fetch; no network, no AWS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitMessage, readToken, refresh, REPO, TOKEN_PARAM } from "./handler.mjs";

const meta = (fetchedAt, patch = "1.0") => JSON.stringify({ fetchedAt, patch: { version: patch } }) + "\n";
const DATA = { "items.json": "[1]\n", "characters.json": "[2]\n", "skills.json": "[3]\n" };

// Collector stub: writes the four files like fetchAll and returns its result shape.
const collector = (files) => async (outDir) => {
  mkdirSync(outDir, { recursive: true });
  for (const [n, text] of Object.entries(files)) writeFileSync(path.join(outDir, n), text, "utf8");
  return { items: [1], characters: [2], skills: [3], meta: JSON.parse(files["items.meta.json"]) };
};

// Fake GitHub REST: repo files at head, the data-latest release, and a call log.
function fakeGitHub({ files, release = { id: 7, assets: [] }, moveOnce = false } = {}) {
  const s = { head: "h1", files: { ...files }, release, calls: [], uploads: [], deleted: [], commits: [], auth: [] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  s.fetch = async (url, { method, body, headers }) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO}`, "");
    s.calls.push(`${method} ${p}`);
    s.auth.push(headers.Authorization ?? null);
    if (method === "GET" && p === "/git/ref/heads/main") return json({ object: { sha: s.head } });
    if (method === "GET" && p.startsWith("/contents/data/")) {
      const n = p.slice("/contents/data/".length);
      assert.equal(u.searchParams.get("ref"), s.head);
      return n in s.files ? new Response(s.files[n]) : json({ message: "Not Found" }, 404);
    }
    if (method === "GET" && p.startsWith("/git/commits/")) return json({ tree: { sha: "t-" + p.split("/").pop() } });
    if (method === "POST" && p === "/git/blobs") {
      const b = JSON.parse(body);
      return json({ sha: "blob:" + Buffer.from(b.content, "base64").toString("utf8") }, 201);
    }
    if (method === "POST" && p === "/git/trees") return json({ sha: "tree", ...JSON.parse(body) }, 201);
    if (method === "POST" && p === "/git/commits") {
      const c = JSON.parse(body);
      s.commits.push(c);
      return json({ sha: "c" + s.commits.length }, 201);
    }
    if (method === "PATCH" && p === "/git/refs/heads/main") {
      if (moveOnce) {
        moveOnce = false;
        s.head = "h2";
        return json({ message: "Update is not a fast forward" }, 422);
      }
      s.head = JSON.parse(body).sha;
      return json({ object: { sha: s.head } });
    }
    if (method === "GET" && p === "/releases/tags/data-latest") {
      return s.release ? json(s.release) : json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && p === "/releases") {
      s.created = JSON.parse(body);
      s.release = { id: 9, assets: [] };
      return json(s.release, 201);
    }
    if (method === "DELETE" && p.startsWith("/releases/assets/")) {
      s.deleted.push(Number(p.split("/").pop()));
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && u.host === "uploads.github.com") {
      s.uploads.push({ release: Number(p.split("/")[2]), name: u.searchParams.get("name"), body: Buffer.from(body).toString("utf8") });
      return json({ id: 100 + s.uploads.length }, 201);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return s;
}

const work = () => mkdtempSync(path.join(tmpdir(), "er-lambda-test-"));
const ASSETS = ["items.json", "characters.json", "skills.json", "items.meta.json", "data-manifest.json"];

test("changed data: one commit of the four data/ files on main, then the five assets (manifest last)", async () => {
  const gh = fakeGitHub({
    files: { ...DATA, "items.json": "[0]\n", "items.meta.json": meta("A") },
    release: { id: 7, assets: ASSETS.map((name, i) => ({ id: i + 1, name })).concat([{ id: 50, name: "other.txt" }]) },
  });
  const fresh = { ...DATA, "items.meta.json": meta("B") };
  const r = await refresh({ getToken: async () => "tok", fetchImpl: gh.fetch, collect: collector(fresh),
    workRoot: work(), now: new Date("2026-10-18T03:00:00Z") });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.commit, "c1");
  assert.deepEqual(gh.commits, [{ message: "[data] 2026-10-18 자동 갱신", tree: "tree", parents: ["h1"] }]);
  assert.equal(gh.head, "c1");
  const treeCall = gh.calls.indexOf("POST /git/trees");
  assert.ok(treeCall > 0);
  assert.deepEqual(gh.deleted, [1, 2, 3, 4, 5]);
  assert.deepEqual(gh.uploads.map((u) => u.name), ASSETS);
  assert.ok(gh.uploads.every((u) => u.release === 7));
  assert.equal(gh.uploads[0].body, "[1]\n");
  const manifest = JSON.parse(gh.uploads[4].body);
  assert.equal(manifest.generatedAt, "B");
  assert.deepEqual(Object.keys(manifest.sha256), ASSETS.slice(0, 4));
  assert.ok(gh.auth.filter((a) => a !== null).every((a) => a === "Bearer tok"));
});

test("commit tree carries data/<file> blobs on the head's tree", async () => {
  const gh = fakeGitHub({ files: {} });
  let tree;
  const fetchImpl = async (url, init) => {
    if (init.method === "POST" && url.endsWith("/git/trees")) tree = JSON.parse(init.body);
    return gh.fetch(url, init);
  };
  await refresh({ getToken: async () => "tok", fetchImpl, collect: collector({ ...DATA, "items.meta.json": meta("B") }),
    workRoot: work() });
  assert.equal(tree.base_tree, "t-h1");
  assert.deepEqual(tree.tree.map((e) => [e.path, e.mode, e.type, e.sha]), [
    ["data/items.json", "100644", "blob", "blob:[1]\n"], ["data/characters.json", "100644", "blob", "blob:[2]\n"],
    ["data/skills.json", "100644", "blob", "blob:[3]\n"], ["data/items.meta.json", "100644", "blob", "blob:" + meta("B")],
  ]);
});

test("only fetchedAt changed: no commit, the assets are still replaced with main's files", async () => {
  const gh = fakeGitHub({ files: { ...DATA, "items.meta.json": meta("A") } });
  const r = await refresh({ getToken: async () => "tok", fetchImpl: gh.fetch,
    collect: collector({ ...DATA, "items.meta.json": meta("B") }), workRoot: work() });
  assert.equal(r.changed, false);
  assert.equal(r.commit, null);
  assert.deepEqual(gh.commits, []);
  assert.ok(!gh.calls.some((c) => c.startsWith("PATCH")));
  assert.deepEqual(gh.uploads.map((u) => u.name), ASSETS);
  assert.equal(JSON.parse(gh.uploads[4].body).generatedAt, "A");
});

test("missing data-latest release is created as a prerelease on main", async () => {
  const gh = fakeGitHub({ files: { ...DATA, "items.meta.json": meta("A") }, release: null });
  await refresh({ getToken: async () => "tok", fetchImpl: gh.fetch,
    collect: collector({ ...DATA, "items.meta.json": meta("A") }), workRoot: work() });
  assert.equal(gh.created.tag_name, "data-latest");
  assert.equal(gh.created.target_commitish, "main");
  assert.equal(gh.created.prerelease, true);
  assert.ok(gh.uploads.every((u) => u.release === 9));
  assert.deepEqual(gh.deleted, []);
});

test("main moved before the commit landed: the sync runs once more on the new head", async () => {
  const gh = fakeGitHub({ files: { ...DATA, "items.json": "[0]\n", "items.meta.json": meta("A") }, moveOnce: true });
  let collected = 0;
  const collect = async (dir) => {
    collected++;
    return collector({ ...DATA, "items.meta.json": meta("B") })(dir);
  };
  const r = await refresh({ getToken: async () => "tok", fetchImpl: gh.fetch, collect, workRoot: work() });
  assert.equal(collected, 1);
  assert.equal(r.head, "h2");
  assert.deepEqual(gh.commits.map((c) => c.parents), [["h1"], ["h2"]]);
  assert.equal(gh.head, "c2");
  assert.equal(gh.uploads.length, 5);
});

test("dryRun: no token, anonymous reads only, nothing written to GitHub", async () => {
  const gh = fakeGitHub({ files: { ...DATA, "items.meta.json": meta("A") } });
  const r = await refresh({ dryRun: true, getToken: async () => assert.fail("token read"), fetchImpl: gh.fetch,
    collect: collector({ ...DATA, "items.json": "[9]\n", "items.meta.json": meta("B") }), workRoot: work() });
  assert.equal(r.changed, true);
  assert.equal(r.commit, null);
  assert.ok(gh.calls.every((c) => c.startsWith("GET ")));
  assert.ok(gh.auth.every((a) => a === null));
});

test("failures: token missing stops before collecting; empty collection and GitHub errors throw", async () => {
  let collected = false;
  await assert.rejects(refresh({ getToken: () => readToken(TOKEN_PARAM, async () => {
    throw Object.assign(new Error("x"), { name: "ParameterNotFound" });
  }), collect: async () => { collected = true; }, workRoot: work() }), /^Error: 토큰 없음: SSM 파라미터 \/er-refresh\/github-token/);
  assert.equal(collected, false);

  const empty = fakeGitHub({ files: {} });
  await assert.rejects(refresh({ getToken: async () => "tok", fetchImpl: empty.fetch,
    collect: collector({ ...DATA, "items.json": "[]\n", "items.meta.json": meta("B") }), workRoot: work() }), /items\.json is empty/);
  assert.deepEqual(empty.uploads, []);

  const denied = async (url, init) => (init.method === "GET" ? fakeGitHub({ files: {} }).fetch(url, init)
    : new Response('{"message":"Resource not accessible"}', { status: 403 }));
  await assert.rejects(refresh({ getToken: async () => "tok", fetchImpl: denied,
    collect: collector({ ...DATA, "items.meta.json": meta("B") }), workRoot: work() }), /HTTP 403/);
});

test("readToken: value from SSM with decryption; empty or missing parameter is 토큰 없음; other errors pass", async () => {
  let input;
  assert.equal(await readToken(TOKEN_PARAM, async (i) => { input = i; return { Parameter: { Value: " t \n" } }; }), "t");
  assert.deepEqual(input, { Name: "/er-refresh/github-token", WithDecryption: true });
  await assert.rejects(readToken(TOKEN_PARAM, async () => ({ Parameter: { Value: "" } })), /토큰 없음: .*비어 있습니다/);
  await assert.rejects(readToken(TOKEN_PARAM, async () => {
    throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
  }), { name: "AccessDeniedException", message: "denied" });
});

test("commitMessage uses the KST date", () => {
  assert.equal(commitMessage(new Date("2026-10-17T15:30:00Z")), "[data] 2026-10-18 자동 갱신");
  assert.equal(commitMessage(new Date("2026-10-17T14:59:00Z")), "[data] 2026-10-17 자동 갱신");
});
