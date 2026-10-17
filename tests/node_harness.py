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
import fetch_skills as fs  # noqa: E402

NODE_MAIN = r"""
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const bodies = JSON.parse(readFileSync(process.env.NH_BODIES, "utf8"));
globalThis.fetch = async (url) => {
  if (!Object.hasOwn(bodies, url)) throw new Error(`unmocked fetch ${url}`);
  // A string is a 200 body; {status, location, body} describes a 404 or a redirect.
  const page = typeof bodies[url] === "string" ? { status: 200, body: bodies[url] } : bodies[url];
  const body = page.body ?? "";
  const headers = { get: (k) => (k.toLowerCase() === "location" ? page.location ?? null : null) };
  return { ok: page.status >= 200 && page.status < 300, status: page.status, url, headers,
    text: async () => body, json: async () => JSON.parse(body) };
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


def _page(value):
    """fetch_skills.fetch_page result for a `bodies` value (string = 200 body)."""
    if isinstance(value, str):
        return {"status": 200, "body": value, "location": None}
    return {"status": value["status"], "body": value.get("body", ""), "location": value.get("location")}


@contextmanager
def replay(bodies):
    """Python fetchers read from `bodies` (url -> response text) instead of the network;
    namu.wiki requests are not spaced out."""
    with mock.patch.object(fi, "fetch_json", lambda url: json.loads(bodies[url])), \
            mock.patch.object(pn, "fetch_text", lambda url: bodies[url]), \
            mock.patch.object(fs, "fetch_page", lambda url: _page(bodies[url])), \
            mock.patch.object(fs, "REQUEST_INTERVAL", 0):
        yield


@contextmanager
def record(bodies):
    """Live fetch, storing every response text in `bodies` for a later Node replay."""
    real_json, real_text, real_page = fi.fetch_json, pn.fetch_text, fs.fetch_page

    def fetch_json(url):
        data = real_json(url)
        bodies[url] = json.dumps(data, ensure_ascii=False)
        return data

    def fetch_text(url):
        bodies[url] = real_text(url)
        return bodies[url]

    def fetch_page(url):
        page = real_page(url)
        bodies[url] = page["body"] if page["status"] == 200 else page
        return page

    with mock.patch.object(fi, "fetch_json", fetch_json), mock.patch.object(pn, "fetch_text", fetch_text), \
            mock.patch.object(fs, "fetch_page", fetch_page):
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


ROBOTS_TXT = "User-agent: *\nDisallow: /\nAllow: /$\nAllow: /w/\n"


def wiki_page(revised, groups, history=()):
    """Minimal namu.wiki document: revision time, 스킬 section with one table per
    (heading, [(image alt, [value rows])]) and an optional 역사 section."""
    parts = [f'<div> 최근 수정 시각: <time datetime="{revised}">{revised}</time></div>',
             "<h2><a>4.</a> <span>스킬<span><a>&#91;편집&#93;</a></span></span></h2>"]
    for n, (heading, subs) in enumerate(groups, 1):
        parts.append(f"<h3><a>4.{n}.</a> <span>{heading}<a>&#91;편집&#93;</a></span></h3><table>")
        for alt, rows in subs:
            parts.append(f"<tr><td><img src='x' alt='{alt}'></td><td><div>설명</div></td></tr><tr><td>")
            parts += [f"<div>{r}</div>" for r in rows]
            parts.append("</td></tr>")
        parts.append("</table>")
    if history:
        parts.append("<h3><a>7.6.</a> 역사<a>&#91;편집&#93;</a></h3>")
        parts += [f"<p>{h}</p>" for h in history]
    parts.append("<h2><a>8.</a> 스킨</h2>")
    return "<html><body>" + "".join(parts) + "</body></html>"


EMPTY_PATCH_HTML ='<div class="er-article-detail__content"><h5>시스템</h5><p>변경 없음</p></div>'
EMPTY_PATCH = patch_bodies((1, "2026.01.01 - 1.0 패치노트", EMPTY_PATCH_HTML))
