// CQA web server: serves the static frontend (apps/web) and forwards /api/v1/* to the FastAPI service.
//
// Zero dependencies (Node's standard library only). It replaces two things a production deployment needs and the
// static HTML/CSS/JS frontend cannot do on its own: a real HTTP server, and same-origin access to the API, so the
// browser only ever talks to one origin (http://127.0.0.1:3000 locally, https://<public host> behind Cloudflare).
//
// Settings (environment variables):
//   HOST                  interface to bind (default 127.0.0.1; the container sets 0.0.0.0)
//   PORT                  port (default 3000)
//   STATIC_ROOT           directory with index.html (default ../web next to this file)
//   API_UPSTREAM          where /api/v1/* goes (default http://127.0.0.1:8000; Compose sets http://api:8000)
//   API_ALLOWED_PREFIXES  comma-separated API paths that are forwarded (default "/api/v1/health,/api/v1/cqa/");
//                         "/api/v1/" forwards everything. Anything else under /api/ answers 404 without reaching
//                         the API, so the data-studio endpoints (uploads, model training) are not exposed publicly.
//   API_READ_ONLY         "true" forwards only GET/HEAD/OPTIONS (a public, view-only demo)
//   API_TIMEOUT_MS        idle timeout for one upstream request (default 600000)
//   RELEASE_SHA           shown by /healthz (set by the deployment)

import http from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// RFC 9110 §7.6.1: connection-scoped headers that a proxy must not forward.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json",
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function loadConfig(env = process.env) {
  const prefixes = env.API_ALLOWED_PREFIXES ?? "/api/v1/health,/api/v1/cqa/";
  return {
    host: env.HOST || "127.0.0.1",
    port: Number.parseInt(env.PORT || "3000", 10),
    staticRoot: path.resolve(env.STATIC_ROOT || path.join(HERE, "..", "web")),
    apiUpstream: new URL(env.API_UPSTREAM || "http://127.0.0.1:8000"),
    apiPrefixes: prefixes.split(",").map((p) => p.trim()).filter(Boolean),
    readOnly: /^(1|true|yes|on)$/i.test(env.API_READ_ONLY || ""),
    upstreamTimeoutMs: Number.parseInt(env.API_TIMEOUT_MS || "600000", 10),
    release: env.RELEASE_SHA || "dev",
    quiet: /^(1|true)$/i.test(env.QUIET || ""),
  };
}

function apiError(res, status, code, message, extraHeaders = {}) {
  const body = JSON.stringify({ error: { code, message, details: null } });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function plain(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(text);
}

/** True when `pathname` is one of the allowed API prefixes ("/api/v1/cqa/" also matches "/api/v1/cqa"). */
export function apiPathAllowed(pathname, prefixes) {
  return prefixes.some((prefix) => {
    const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

/** Encoded slashes/backslashes and dot segments are refused instead of being forwarded ambiguously. */
function suspiciousPath(rawPath) {
  if (/%2f|%5c|\\/i.test(rawPath)) return true;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  return decoded.includes("\0") || decoded.split("/").some((segment) => segment === ".." || segment === ".");
}

// ---- /api/v1/* → FastAPI --------------------------------------------------------------------------------------

function forwardHeaders(req) {
  const headers = {};
  const listed = new Set(
    String(req.headers.connection || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  );
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && !listed.has(name)) headers[name] = value;
  }
  const client = req.socket.remoteAddress || "";
  headers["x-forwarded-for"] = req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${client}` : client;
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] || "http";
  headers["x-forwarded-host"] = req.headers["x-forwarded-host"] || req.headers.host || "";
  // `host` is forwarded unchanged on purpose: the API's DNS-rebinding guard (ATLAS_ALLOWED_HOSTS) and its
  // same-origin check for state-changing requests both compare against the host the browser used.
  return headers;
}

function proxy(req, res, target, cfg, agent, log) {
  const started = Date.now();
  const upstream = http.request(
    {
      protocol: cfg.apiUpstream.protocol,
      hostname: cfg.apiUpstream.hostname,
      port: cfg.apiUpstream.port || 80,
      method: req.method,
      path: target,
      headers: forwardHeaders(req),
      agent,
      timeout: cfg.upstreamTimeoutMs,
    },
    (answer) => {
      const headers = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (!HOP_BY_HOP.has(name)) headers[name] = value;
      }
      res.writeHead(answer.statusCode || 502, answer.statusMessage, headers);
      pipeline(answer, res, (error) => {
        log(`${req.method} ${target.split("?")[0]} ${answer.statusCode} ${Date.now() - started}ms${error ? " (aborted)" : ""}`);
      });
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      log(`${req.method} ${target.split("?")[0]} 502 ${Date.now() - started}ms (${error.code || error.message})`);
      apiError(res, 502, "api_unavailable", "The CQA API is not reachable right now. Try again in a moment.");
    } else {
      res.destroy(error);
    }
  });
  // Stream the request body (uploads are never buffered in memory). If the browser goes away, stop the upstream.
  pipeline(req, upstream, () => {});
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
}

// ---- static files ---------------------------------------------------------------------------------------------

async function serveStatic(req, res, url, cfg) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    plain(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }
  if (suspiciousPath(url.pathname)) {
    plain(res, 400, "Bad request");
    return;
  }
  const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  // Dotfiles (.env, .git, …) are never served, wherever they are.
  if (segments.some((segment) => segment.startsWith("."))) {
    plain(res, 404, "Not found");
    return;
  }
  let file = path.join(cfg.staticRoot, ...segments);
  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        res.writeHead(301, { Location: `${url.pathname}/${url.search}`, "Content-Length": 0 });
        res.end();
        return;
      }
      file = path.join(file, "index.html");
      info = await stat(file);
    }
    const real = await realpath(file);
    if (real !== cfg.realRoot && !real.startsWith(cfg.realRoot + path.sep)) throw new Error("outside root");
  } catch {
    plain(res, 404, "Not found");
    return;
  }
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
    // Always revalidate (cheap 304s), so a new deployment is visible on the next page load.
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  pipeline(createReadStream(file), res, () => {});
}

// ---- server ---------------------------------------------------------------------------------------------------

export async function createServer(cfg = loadConfig()) {
  cfg.realRoot = await realpath(cfg.staticRoot);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const log = cfg.quiet ? () => {} : (line) => console.log(`${new Date().toISOString()} ${line}`);

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://placeholder");
    } catch {
      plain(res, 400, "Bad request");
      return;
    }
    if (url.pathname === "/healthz") {
      const body = JSON.stringify({ status: "ok", service: "web", release: cfg.release });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const raw = (req.url || "").split("?")[0];
      if (suspiciousPath(raw)) {
        apiError(res, 400, "bad_path", "Encoded slashes and dot segments are not allowed in API paths.");
      } else if (!apiPathAllowed(url.pathname, cfg.apiPrefixes)) {
        apiError(res, 404, "not_found", "This API path is not available through the web server.");
      } else if (cfg.readOnly && !SAFE_METHODS.has(req.method || "GET")) {
        apiError(res, 405, "read_only", "This deployment is read-only.", { Allow: "GET, HEAD, OPTIONS" });
      } else {
        proxy(req, res, url.pathname + url.search, cfg, agent, log);
      }
      return;
    }
    serveStatic(req, res, url, cfg).catch((error) => {
      log(`static error ${error.message}`);
      if (!res.headersSent) plain(res, 500, "Internal error");
      else res.destroy(error);
    });
  });

  server.headersTimeout = 60_000;
  server.requestTimeout = 15 * 60_000;
  // Longer than cloudflared's idle keep-alive (90 s), so the tunnel never reuses a connection we just closed.
  server.keepAliveTimeout = 120_000;
  server.on("close", () => agent.destroy());
  return server;
}

async function main() {
  const cfg = loadConfig();
  const server = await createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(
      `CQA web on http://${cfg.host}:${cfg.port} · static ${cfg.staticRoot} · /api → ${cfg.apiUpstream.origin}` +
        ` (${cfg.apiPrefixes.join(", ")})${cfg.readOnly ? " · read-only" : ""} · release ${cfg.release}`,
    );
  });
  const stop = (signal) => {
    console.log(`${signal}: shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
