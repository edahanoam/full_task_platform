const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "saved_annotations");
const LATEST_DIR = path.join(DATA_DIR, "latest");
const EVENTS_FILE = path.join(DATA_DIR, "annotation-events.jsonl");
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function ensureStorage() {
  fs.mkdirSync(LATEST_DIR, { recursive: true });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let receivedBytes = 0;

    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }

      body += chunk;
    });

    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

function makeStorageKey(payload) {
  const participantId = String(payload.participantId || "").trim();
  const sessionId = String(payload.sessionId || "").trim();
  const rawKey = participantId || sessionId || randomUUID();

  return rawKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function saveAnnotationSnapshot(payload) {
  ensureStorage();

  const storageKey = makeStorageKey(payload);
  const latestFile = path.join(LATEST_DIR, `${storageKey}.json`);
  const record = {
    savedAt: new Date().toISOString(),
    storageKey,
    participantId: String(payload.participantId || "").trim() || null,
    sessionId: String(payload.sessionId || "").trim() || null,
    reason: String(payload.reason || "snapshot"),
    payload: payload.payload || null,
  };

  fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(record)}\n`, "utf8");
  fs.writeFileSync(latestFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return {
    ok: true,
    storageKey,
    eventFile: path.relative(ROOT_DIR, EVENTS_FILE),
    latestFile: path.relative(ROOT_DIR, latestFile),
  };
}

async function handleSaveAnnotations(request, response) {
  try {
    const payload = await readRequestJson(request);
    const result = saveAnnotationSnapshot(payload);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message || String(error),
    });
  }
}

function getStaticFilePath(urlPath) {
  const requestedPath = decodeURIComponent(urlPath.split("?")[0]);
  const normalizedPath = requestedPath === "/" ? "/index.html" : requestedPath;
  const absolutePath = path.resolve(ROOT_DIR, `.${normalizedPath}`);
  const relativePath = path.relative(ROOT_DIR, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return absolutePath;
}

function serveStaticFile(request, response) {
  const filePath = getStaticFilePath(request.url || "/");
  if (!filePath) {
    sendText(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(response, error.code === "ENOENT" ? 404 : 500, "Not found");
      return;
    }

    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const shouldAvoidCache =
      contentType.startsWith("text/html") ||
      contentType.startsWith("text/javascript") ||
      contentType.startsWith("application/x-ndjson");

    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": shouldAvoidCache ? "no-store" : "public, max-age=60",
    });
    response.end(data);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && request.url === "/api/annotations/save") {
    handleSaveAnnotations(request, response);
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    serveStaticFile(request, response);
    return;
  }

  sendText(response, 405, "Method not allowed");
});

server.listen(PORT, () => {
  ensureStorage();
  console.log(`Annotation app running at http://localhost:${PORT}`);
  console.log(`Saving annotation snapshots under ${DATA_DIR}`);
});
