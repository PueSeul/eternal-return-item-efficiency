// AWS Lambda (ap-northeast-2, EventBridge Scheduler daily 12:00 KST; infra/deploy.ps1 deploys it):
// the same refresh as scripts/refresh_data.mjs — fetchAll skillsMode "all" (namu.wiki 1 s between
// requests) → publish() against data/ of GitHub main → when data changed, one commit of the four
// files to main (Git Data API) → the four files + data-manifest.json replace the assets of the
// fixed release "data-latest" (created as a prerelease when missing). No git CLI, no dependencies
// (the Node 22 runtime provides @aws-sdk/client-ssm). The GitHub token comes from the SSM
// SecureString TOKEN_PARAM. Event {dryRun: true}: collect and compare only (no token, no writes).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchAll } from "../../scripts/fetch_items.mjs";
import { FILES, MANIFEST_NAME, publish } from "../../scripts/refresh_data.mjs";

export const REPO = "PueSeul/eternal-return-item-efficiency";
export const BRANCH = "main";
export const RELEASE_TAG = "data-latest";
export const TOKEN_PARAM = "/er-refresh/github-token";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const REQUEST_TIMEOUT_MS = 60_000;

/** GitHub token from the SSM SecureString `name`; a missing or empty parameter fails as "토큰 없음". */
export async function readToken(name = TOKEN_PARAM, send) {
  if (!send) {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const client = new SSMClient({});
    send = (input) => client.send(new GetParameterCommand(input));
  }
  let value;
  try {
    value = (await send({ Name: name, WithDecryption: true })).Parameter?.Value?.trim();
  } catch (err) {
    if (err && err.name === "ParameterNotFound") throw new Error(`토큰 없음: SSM 파라미터 ${name} 이(가) 없습니다`);
    throw err;
  }
  if (!value) throw new Error(`토큰 없음: SSM 파라미터 ${name} 의 값이 비어 있습니다`);
  return value;
}

/** Minimal GitHub REST client. api() returns parsed JSON (null for 204), raw() the body bytes;
 * a non-2xx answer throws an Error with .status. token null = anonymous (public reads only). */
export function github(token, fetchImpl = fetch) {
  const request = async (method, url, { body, headers = {} } = {}) => {
    const bytes = body instanceof Uint8Array;
    const resp = await fetchImpl(url.startsWith("https://") ? url : API + url, {
      method,
      headers: {
        Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "er-refresh-lambda",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined && !bytes ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : bytes ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const err = new Error(`GitHub ${method} ${url} 실패: HTTP ${resp.status} ${text.slice(0, 300)}`.trim());
      err.status = resp.status;
      throw err;
    }
    return resp;
  };
  return {
    api: async (method, url, body, headers) => {
      const resp = await request(method, url, { body, headers });
      return resp.status === 204 ? null : resp.json();
    },
    raw: async (url) => Buffer.from(await (await request("GET", url, {
      headers: { Accept: "application/vnd.github.raw" } })).arrayBuffer()),
  };
}

/** The four data files of commit `sha` into dir (a file missing there is left out). */
async function downloadData(gh, sha, dir) {
  mkdirSync(dir, { recursive: true });
  for (const n of FILES) {
    try {
      writeFileSync(path.join(dir, n), await gh.raw(`/repos/${REPO}/contents/data/${n}?ref=${sha}`));
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
}

/** One commit of dir's four files as data/ on top of head; moves BRANCH (fast-forward only). */
async function commitData(gh, head, dir, message) {
  const base = await gh.api("GET", `/repos/${REPO}/git/commits/${head}`);
  const tree = [];
  for (const n of FILES) {
    const blob = await gh.api("POST", `/repos/${REPO}/git/blobs`,
      { content: readFileSync(path.join(dir, n)).toString("base64"), encoding: "base64" });
    tree.push({ path: `data/${n}`, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh.api("POST", `/repos/${REPO}/git/trees`, { base_tree: base.tree.sha, tree });
  const commit = await gh.api("POST", `/repos/${REPO}/git/commits`, { message, tree: newTree.sha, parents: [head] });
  try {
    await gh.api("PATCH", `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  } catch (err) {
    if (err.status === 422) err.branchMoved = true; // main moved meanwhile (not a fast-forward)
    throw err;
  }
  return commit.sha;
}

/** Replace the assets of RELEASE_TAG (create it as a prerelease when missing) by releaseDir's
 * four files + manifest; the manifest goes last. Returns the uploaded names. */
async function uploadRelease(gh, releaseDir) {
  let release;
  try {
    release = await gh.api("GET", `/repos/${REPO}/releases/tags/${RELEASE_TAG}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    release = await gh.api("POST", `/repos/${REPO}/releases`, {
      tag_name: RELEASE_TAG, target_commitish: BRANCH, name: "데이터 (자동 갱신)", prerelease: true,
      body: "매일 12:00(KST) 자동 갱신되는 데이터 파일입니다. 프로그램의 아이템 수치 업데이트 버튼이 받습니다.",
    });
  }
  const names = [...FILES, MANIFEST_NAME];
  for (const n of names) {
    const old = (release.assets || []).find((a) => a.name === n);
    if (old) await gh.api("DELETE", `/repos/${REPO}/releases/assets/${old.id}`);
    await gh.api("POST", `${UPLOADS}/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(n)}`,
      readFileSync(path.join(releaseDir, n)), { "Content-Type": "application/json" });
  }
  return names;
}

/** "[data] YYYY-MM-DD 자동 갱신" with the KST date (same subject as scripts/refresh_local.ps1). */
export function commitMessage(now = new Date()) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
  return `[data] ${day} 자동 갱신`;
}

/**
 * Collect, then sync with GitHub: head of BRANCH → its data/ → publish() → commit when changed →
 * release assets. When main moves before the commit lands, the sync (not the collection) runs once
 * more on the new head. Returns a summary object; any failure throws (Lambda logs it, the async
 * invoke config retries once).
 */
export async function refresh({
  dryRun = false, getToken = readToken, fetchImpl = fetch, now = new Date(), workRoot = tmpdir(),
  collect = (outDir) => fetchAll({ outDir, skillsMode: "all" }),
} = {}) {
  const started = Date.now();
  const token = dryRun ? null : await getToken();
  const gh = github(token, fetchImpl);
  const root = mkdtempSync(path.join(workRoot, "er-refresh-"));
  try {
    const fresh = path.join(root, "fresh");
    const { items, characters, skills, meta } = await collect(fresh);
    const sync = async (attempt) => {
      const dir = path.join(root, `data-${attempt}`);
      const releaseDir = path.join(root, `release-${attempt}`);
      const head = (await gh.api("GET", `/repos/${REPO}/git/ref/heads/${BRANCH}`)).object.sha;
      await downloadData(gh, head, dir);
      const { changed, manifest } = publish(fresh, dir, releaseDir);
      if (dryRun) return { head, changed, manifest, commit: null, assets: [] };
      const commit = changed ? await commitData(gh, head, dir, commitMessage(now)) : null;
      return { head, changed, manifest, commit, assets: await uploadRelease(gh, releaseDir) };
    };
    let result;
    try {
      result = await sync(1);
    } catch (err) {
      if (!err.branchMoved) throw err;
      result = await sync(2);
    }
    return {
      ok: true, dryRun, seconds: Math.round((Date.now() - started) / 1000),
      items: items.length, characters: characters.length, skills: skills.length, patch: meta.patch?.version ?? null,
      ...result,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const handler = async (event) => {
  const result = await refresh({ dryRun: Boolean(event && event.dryRun === true) });
  console.log(JSON.stringify(result));
  return result;
};
