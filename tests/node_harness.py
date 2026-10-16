"""Shared helpers: serve the same HTTP bodies to the Python fetchers (replay)
and to the Node twins (mocked global fetch), so outputs can be compared byte
for byte."""
import json
import os
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import fetch_items as fi  # noqa: E402
import fetch_patchnote as pn  # noqa: E402

NODE_MAIN = r"""
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const bodies = JSON.parse(readFileSync(process.env.NH_BODIES, "utf8"));
globalThis.fetch = async (url) => {
  if (!Object.hasOwn(bodies, url)) throw new Error(`unmocked fetch ${url}`);
  const body = bodies[url];
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
};
const imp = (name) => import(pathToFileURL(process.env.NH_SCRIPTS + "/" + name).href);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const result = await new AsyncFunction("imp", "env", process.env.NH_CODE)(imp, process.env);
process.stdout.write(Buffer.from(JSON.stringify(result ?? null), "utf8"));
"""


def run_node(bodies, code, **env):
    """Run `code` (async function body; imp(name) imports a script) with fetch mocked."""
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "bodies.json"
        src.write_text(json.dumps(bodies, ensure_ascii=False), encoding="utf-8")
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", NODE_MAIN], capture_output=True,
            env={**os.environ, **env, "NH_BODIES": str(src), "NH_SCRIPTS": str(SCRIPTS), "NH_CODE": code},
        )
    if proc.returncode:
        raise AssertionError(proc.stderr.decode("utf-8", "replace"))
    return json.loads(proc.stdout.decode("utf-8"))


@contextmanager
def replay(bodies):
    """Python fetchers read from `bodies` (url -> response text) instead of the network."""
    with mock.patch.object(fi, "fetch_json", lambda url: json.loads(bodies[url])), \
            mock.patch.object(pn, "fetch_text", lambda url: bodies[url]):
        yield


@contextmanager
def record(bodies):
    """Live fetch, storing every response text in `bodies` for a later Node replay."""
    real_json, real_text = fi.fetch_json, pn.fetch_text

    def fetch_json(url):
        data = real_json(url)
        bodies[url] = json.dumps(data, ensure_ascii=False)
        return data

    def fetch_text(url):
        bodies[url] = real_text(url)
        return bodies[url]

    with mock.patch.object(fi, "fetch_json", fetch_json), mock.patch.object(pn, "fetch_text", fetch_text):
        yield


def article(id_, title, hidden=0):
    return {"id": id_, "is_hidden": hidden, "created_at": "2026-10-14T08:00:00.000000Z",
            "url": f"https://playeternalreturn.com/posts/news/{id_}",
            "i18ns": {"ko_KR": {"locale": "ko_KR", "title": title}}}


def patch_bodies(*posts):
    """List page + article bodies for posts [(id, title, html)] (newest first)."""
    bodies = {pn.LIST_URL.format(page=1): json.dumps(
        {"total_page": 1, "articles": [article(i, t) for i, t, _ in posts]}, ensure_ascii=False)}
    for i, _, html in posts:
        bodies[f"https://playeternalreturn.com/posts/news/{i}"] = html
    return bodies


EMPTY_PATCH_HTML = '<div class="er-article-detail__content"><h5>시스템</h5><p>변경 없음</p></div>'
EMPTY_PATCH = patch_bodies((1, "2026.01.01 - 1.0 패치노트", EMPTY_PATCH_HTML))
