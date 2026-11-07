// Tests for the CQA web server: static files and the /api/v1 proxy (against a fake upstream). `node --test`.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { apiPathAllowed, createServer, loadConfig } from "./server.mjs";

let root;
let upstream;
let upstreamPort;
let seen = [];
let handler = null;

function request(port, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function start(env = {}) {
  const cfg = loadConfig({ STATIC_ROOT: root, API_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, QUIET: "1", ...env });
  const server = await createServer(cfg);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cqa-web-"));
  await mkdir(path.join(root, "js"));
  await mkdir(path.join(root, "css"));
  await writeFile(path.join(root, "index.html"), "<!DOCTYPE html><title>CQA</title>");
  await writeFile(path.join(root, "js", "app.js"), "export const x = 1;\n");
  await writeFile(path.join(root, "css", "app.css"), "body{}\n");
  await writeFile(path.join(root, ".env"), "SECRET=1\n");
  await writeFile(path.join(os.tmpdir(), "cqa-outside.txt"), "outside\n");

  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (handler) return handler(req, res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamPort = upstream.address().port;
});

after(async () => {
  upstream.close();
  await rm(root, { recursive: true, force: true });
  await rm(path.join(os.tmpdir(), "cqa-outside.txt"), { force: true });
});

beforeEach(() => {
  seen = [];
  handler = null;
});

describe("static files", () => {
  let server;
  let port;
  before(async () => ({ server, port } = await start()));
  after(() => server.close());

  test("serves index.html at / with revalidation headers", async () => {
    const res = await request(port);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^text\/html/);
    assert.equal(res.headers["cache-control"], "no-cache");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.body.toString(), /<title>CQA<\/title>/);
  });

  test("serves ES modules and CSS with the right types, query strings ignored", async () => {
    assert.match((await request(port, { path: "/js/app.js?v=2" })).headers["content-type"], /^text\/javascript/);
    assert.match((await request(port, { path: "/css/app.css?v=4" })).headers["content-type"], /^text\/css/);
  });

  test("answers 304 for a matching ETag and supports HEAD", async () => {
    const first = await request(port, { path: "/js/app.js" });
    const again = await request(port, { path: "/js/app.js", headers: { "If-None-Match": first.headers.etag } });
    assert.equal(again.status, 304);
    const head = await request(port, { method: "HEAD", path: "/js/app.js" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers["content-length"], String(first.body.length));
  });

  test("never serves dotfiles or files outside the root", async () => {
    assert.equal((await request(port, { path: "/.env" })).status, 404);
    assert.equal((await request(port, { path: "/js/../.env" })).status, 404);
    assert.equal((await request(port, { path: "/%2e%2e/cqa-outside.txt" })).status, 404);
    assert.equal((await request(port, { path: "/..%2fcqa-outside.txt" })).status, 400);
    assert.equal((await request(port, { path: "/missing.html" })).status, 404);
  });

  test("refuses writes to static paths", async () => {
    const res = await request(port, { method: "POST", path: "/", body: "x" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "GET, HEAD");
  });

  test("/healthz reports the release without calling the API", async () => {
    const { server: s, port: p } = await start({ RELEASE_SHA: "abc123" });
    const res = await request(p, { path: "/healthz" });
    s.close();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { status: "ok", service: "web", release: "abc123" });
    assert.equal(seen.length, 0);
  });
});

describe("API proxy", () => {
  let server;
  let port;
  before(async () => ({ server, port } = await start()));
  after(() => server.close());

  test("keeps path, query, Host and adds X-Forwarded-*", async () => {
    const res = await request(port, {
      path: "/api/v1/cqa/conversations?limit=5&q=%D0%B0%20b&status=failed",
      headers: { Host: "cqa.example.com", "X-Forwarded-Proto": "https" },
    });
    assert.equal(res.status, 200);
    const [hit] = seen;
    assert.equal(hit.url, "/api/v1/cqa/conversations?limit=5&q=%D0%B0%20b&status=failed");
    assert.equal(hit.headers.host, "cqa.example.com");
    assert.equal(hit.headers["x-forwarded-proto"], "https");
    assert.equal(hit.headers["x-forwarded-host"], "cqa.example.com");
    assert.equal(hit.headers["x-forwarded-for"], "127.0.0.1");
  });

  test("forwards every method with its body byte for byte", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, "a");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      seen = [];
      const body = method === "POST" ? big : Buffer.from(JSON.stringify({ method }));
      const res = await request(port, {
        method,
        path: "/api/v1/cqa/checklists/x",
        headers: { "Content-Type": "application/json", "Content-Length": body.length, Origin: "http://127.0.0.1:3000" },
        body,
      });
      assert.equal(res.status, 200);
      assert.equal(seen[0].method, method);
      assert.ok(seen[0].body.equals(body), `${method} body differs`);
      assert.equal(seen[0].headers.origin, "http://127.0.0.1:3000");
    }
  });

  test("passes status codes, headers and Set-Cookie through; strips hop-by-hop headers", async () => {
    handler = (req, res) => {
      res.writeHead(201, { "Content-Type": "application/json", "X-Custom": "yes", "Set-Cookie": ["a=1", "b=2"] });
      res.end('{"created":true}');
    };
    const res = await request(port, {
      method: "POST",
      path: "/api/v1/cqa/imports",
      headers: { Connection: "keep-alive, X-Secret-Hop", "X-Secret-Hop": "1", "Content-Length": 2 },
      body: "{}",
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers["x-custom"], "yes");
    assert.deepEqual(res.headers["set-cookie"], ["a=1", "b=2"]);
    assert.equal(seen[0].headers["x-secret-hop"], undefined);
    assert.equal(seen[0].headers.connection, "keep-alive"); // the proxy's own upstream connection, not the client's
  });

  test("supports HTTP range requests (206 Partial Content)", async () => {
    const audio = Buffer.from("0123456789abcdefghij");
    handler = (req, res) => {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
      const part = audio.subarray(Number(start), Number(end) + 1);
      res.writeHead(206, {
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${audio.length}`,
        "Content-Length": part.length,
      });
      res.end(part);
    };
    const res = await request(port, { path: "/api/v1/cqa/conversations/c1/audio", headers: { Range: "bytes=10-14" } });
    assert.equal(seen[0].headers.range, "bytes=10-14");
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], "bytes 10-14/20");
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(res.body.toString(), "abcde");
  });

  test("streams responses instead of buffering them", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    handler = async (req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("first,");
      await gate;
      res.end("second");
    };
    const firstChunk = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/v1/cqa/stream", agent: false }, (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
          if (text === "first,") {
            resolve(text); // arrived while the upstream is still holding the rest
            release();
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(firstChunk, "first,");
  });

  test("blocks API paths outside the allowlist without calling the API", async () => {
    for (const target of ["/api/v1/datasets", "/api/v1/experiments/x", "/api/v2/cqa/x", "/api/v1/healthcheck"]) {
      const res = await request(port, { path: target });
      assert.equal(res.status, 404, target);
      assert.equal(JSON.parse(res.body).error.code, "not_found");
    }
    assert.equal(seen.length, 0);
  });

  test("refuses encoded slashes and dot segments in API paths", async () => {
    for (const target of ["/api/v1/cqa/..%2f..%2fdatasets", "/api/v1/cqa/%2e%2e/datasets", "/api/v1/cqa/a%5cb"]) {
      assert.equal((await request(port, { path: target })).status, 400, target);
    }
    assert.equal(seen.length, 0);
  });

  test("answers 502 in the API's error format when the API is down", async () => {
    const { server: s, port: p } = await start({ API_UPSTREAM: "http://127.0.0.1:9" });
    const res = await request(p, { path: "/api/v1/health" });
    s.close();
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error.code, "api_unavailable");
  });

  test("read-only mode forwards reads and refuses writes", async () => {
    const { server: s, port: p } = await start({ API_READ_ONLY: "true" });
    assert.equal((await request(p, { path: "/api/v1/cqa/info" })).status, 200);
    const res = await request(p, { method: "POST", path: "/api/v1/cqa/imports", body: "{}" });
    s.close();
    assert.equal(res.status, 405);
    assert.equal(JSON.parse(res.body).error.code, "read_only");
    assert.equal(seen.length, 1);
  });

  test('"/api/v1/" in API_ALLOWED_PREFIXES forwards the whole API', async () => {
    const { server: s, port: p } = await start({ API_ALLOWED_PREFIXES: "/api/v1/" });
    const res = await request(p, { path: "/api/v1/datasets?x=1" });
    s.close();
    assert.equal(res.status, 200);
    assert.equal(seen[0].url, "/api/v1/datasets?x=1");
  });
});

test("apiPathAllowed matches whole path segments only", () => {
  const prefixes = ["/api/v1/health", "/api/v1/cqa/"];
  assert.ok(apiPathAllowed("/api/v1/health", prefixes));
  assert.ok(apiPathAllowed("/api/v1/cqa", prefixes));
  assert.ok(apiPathAllowed("/api/v1/cqa/conversations/1", prefixes));
  assert.ok(!apiPathAllowed("/api/v1/healthz", prefixes));
  assert.ok(!apiPathAllowed("/api/v1/cqa-admin", prefixes));
  assert.ok(!apiPathAllowed("/api/v1/datasets", prefixes));
});
