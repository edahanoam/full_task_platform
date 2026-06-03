const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "saved_annotations");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const EVENTS_FILE = path.join(EVENTS_DIR, "annotation-events.jsonl");
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
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
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

function sanitizeStoragePart(value, fallback) {
  const rawValue = String(value || "").trim() || fallback || randomUUID();
  return rawValue.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function makeRunId(payload) {
  const suppliedRunId = String(payload.runId || payload.payload?.runId || "").trim();
  if (suppliedRunId) {
    return sanitizeStoragePart(suppliedRunId);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return sanitizeStoragePart(`${timestamp}_${randomUUID()}`);
}

function makeStorageKey(payload) {
  const participantId = String(payload.participantId || "").trim();
  const sessionId = String(payload.sessionId || "").trim();
  const rawKey = participantId || sessionId || randomUUID();

  return sanitizeStoragePart(rawKey, randomUUID()).slice(0, 120);
}

function isFinalSave(payload) {
  const reason = String(payload.reason || "").trim();
  const nestedPayload = payload.payload || {};
  return (
    reason === "submission-complete" ||
    Boolean(nestedPayload.endTime) ||
    (
      Number(nestedPayload.totalArticles) > 0 &&
      Number(nestedPayload.completedArticles) === Number(nestedPayload.totalArticles)
    )
  );
}

function saveAnnotationSnapshot(payload) {
  ensureStorage();

  const storageKey = makeStorageKey(payload);
  const runId = makeRunId(payload);
  const runDir = path.join(RUNS_DIR, storageKey, runId);
  const snapshotFile = path.join(runDir, "snapshot.json");
  const finalFile = path.join(runDir, "final.json");
  const targetFile = isFinalSave(payload) ? finalFile : snapshotFile;
  const record = {
    savedAt: new Date().toISOString(),
    storageKey,
    runId,
    participantId: String(payload.participantId || "").trim() || null,
    sessionId: String(payload.sessionId || "").trim() || null,
    reason: String(payload.reason || "snapshot"),
    status: isFinalSave(payload) ? "complete" : "draft",
    payload: payload.payload || null,
  };

  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(record)}\n`, "utf8");
  fs.writeFileSync(targetFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return {
    ok: true,
    storageKey,
    runId,
    status: record.status,
    eventFile: path.relative(ROOT_DIR, EVENTS_FILE),
    runFile: path.relative(ROOT_DIR, targetFile),
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
