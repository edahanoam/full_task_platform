const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "saved_annotations");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const ASSIGNMENTS_DIR = path.join(DATA_DIR, "assignments");
const EVENTS_FILE = path.join(EVENTS_DIR, "annotation-events.jsonl");
const ONLY_ANNOTATIONS_FILE = path.join(DATA_DIR, "only-annotations.jsonl");
const ONLY_ANNOTATIONS_LOCK_FILE = path.join(DATA_DIR, "only-annotations.lock");
const ASSIGNMENT_EVENTS_FILE = path.join(ASSIGNMENTS_DIR, "article-events.jsonl");
const ASSIGNMENT_LOCK_FILE = path.join(ASSIGNMENTS_DIR, "article-events.lock");
const AVAILABLE_ARTICLES_FILE = path.join(ASSIGNMENTS_DIR, "available-articles.json");
const ARTICLE_DATASET_PATH = path.join(ROOT_DIR, "cleaned2604combined_none_middle50_by_length.jsonl");
const ARTICLE_CHOICES_PER_ROUND = 3;
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
  fs.mkdirSync(ASSIGNMENTS_DIR, { recursive: true });
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

function parseArticleDataset() {
  const rawDataset = fs.readFileSync(ARTICLE_DATASET_PATH, "utf8");
  return rawDataset
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => normalizeArticle(JSON.parse(line), index));
}

function normalizeArticle(record, index) {
  const rowId = Number(record.row_id || index + 1);
  return {
    row_id: String(rowId),
    originalId: String(record.ID ?? record.id ?? record.articleId ?? index),
    title: String(record.heading || record.title || record.headline || ""),
    text: String(record.text || record.body || record.articleText || record.content || ""),
    source: String(record.source || record.publisher || record.outlet || ""),
    bias: record.bias || null,
    url: record.url || null,
  };
}

function getArticleMap() {
  return new Map(parseArticleDataset().map((article) => [article.row_id, article]));
}

function initializeAvailableArticlesFile() {
  const articleIds = parseArticleDataset()
    .filter((article) => article.title && article.text)
    .map((article) => article.row_id);
  fs.writeFileSync(AVAILABLE_ARTICLES_FILE, `${JSON.stringify(articleIds, null, 2)}\n`, "utf8");
  return articleIds;
}

function readAvailableArticleIds() {
  if (!fs.existsSync(AVAILABLE_ARTICLES_FILE)) {
    return initializeAvailableArticlesFile();
  }

  const parsedIds = JSON.parse(fs.readFileSync(AVAILABLE_ARTICLES_FILE, "utf8") || "[]");
  if (!Array.isArray(parsedIds)) {
    throw new Error("available-articles.json must contain an array.");
  }

  return parsedIds.map(normalizeArticleId);
}

function writeAvailableArticleIds(articleIds) {
  fs.writeFileSync(AVAILABLE_ARTICLES_FILE, `${JSON.stringify(articleIds, null, 2)}\n`, "utf8");
}

function normalizeArticleId(articleId) {
  const rawArticleId = String(articleId || "").trim();
  const rowMatch = rawArticleId.match(/^row-0*(\d+)$/);
  return rowMatch ? rowMatch[1] : rawArticleId;
}

function appendAssignmentEvent(event) {
  fs.appendFileSync(
    ASSIGNMENT_EVENTS_FILE,
    `${JSON.stringify({ createdAt: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withFileLock(lockFile, lockName, callback) {
  ensureStorage();
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5000) {
    let lockHandle = null;
    try {
      lockHandle = fs.openSync(lockFile, "wx");
      fs.writeFileSync(lockHandle, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      return await callback();
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      try {
        const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (lockAge > 30000) {
          fs.unlinkSync(lockFile);
        }
      } catch {
        // Another request may have released the lock between checks.
      }

      await sleep(50);
    } finally {
      if (lockHandle !== null) {
        fs.closeSync(lockHandle);
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // The lock was already cleaned up.
        }
      }
    }
  }

  throw new Error(`Could not acquire ${lockName} lock.`);
}

async function withAssignmentLock(callback) {
  return withFileLock(ASSIGNMENT_LOCK_FILE, "article assignment", callback);
}

async function withOnlyAnnotationsLock(callback) {
  return withFileLock(ONLY_ANNOTATIONS_LOCK_FILE, "only annotations", callback);
}

function pickRandomArticles(articles, count) {
  return [...articles]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
}

async function assignArticleOptions(payload) {
  const participantId = String(payload.participantId || "").trim();
  const runId = String(payload.runId || "").trim();
  const round = Number(payload.round || 1);

  if (!participantId || !runId) {
    throw new Error("participantId and runId are required.");
  }

  return withAssignmentLock(() => {
    const articleMap = getArticleMap();
    const availableArticleIds = readAvailableArticleIds().filter((articleId) => articleMap.has(articleId));
    if (availableArticleIds.length < ARTICLE_CHOICES_PER_ROUND) {
      throw new Error("There are not enough available articles to assign.");
    }

    const chosenArticleIds = pickRandomArticles(availableArticleIds, ARTICLE_CHOICES_PER_ROUND);
    const chosenArticleIdSet = new Set(chosenArticleIds);
    const options = chosenArticleIds.map((articleId) => articleMap.get(articleId));
    writeAvailableArticleIds(
      availableArticleIds.filter((articleId) => !chosenArticleIdSet.has(articleId)),
    );

    appendAssignmentEvent({
      type: "shown_unselected",
      participantId,
      runId,
      round,
      row_ids: options.map((article) => article.row_id),
    });

    return {
      ok: true,
      status: "shown_unselected",
      round,
      options,
      availableArticleCount: availableArticleIds.length - options.length,
      assignmentEventFile: path.relative(ROOT_DIR, ASSIGNMENT_EVENTS_FILE),
      availableArticlesFile: path.relative(ROOT_DIR, AVAILABLE_ARTICLES_FILE),
    };
  });
}

async function markArticleAnnotated(payload) {
  const participantId = String(payload.participantId || "").trim();
  const runId = String(payload.runId || "").trim();
  const articleId = normalizeArticleId(payload.row_id || payload.articleId);
  const round = Number(payload.round || 1);

  if (!participantId || !runId || !articleId) {
    throw new Error("participantId, runId, and articleId are required.");
  }

  return withAssignmentLock(() => {
    appendAssignmentEvent({
      type: "annotated",
      participantId,
      runId,
      round,
      row_id: articleId,
    });

    return {
      ok: true,
      status: "annotated",
      row_id: articleId,
      assignmentEventFile: path.relative(ROOT_DIR, ASSIGNMENT_EVENTS_FILE),
    };
  });
}

function buildOnlyAnnotationRecords(record) {
  if (record.reason !== "article-finalized") {
    return [];
  }

  const taskPayload = record.payload || {};
  const articles = Array.isArray(taskPayload.articles) ? taskPayload.articles : [];
  const article = articles[articles.length - 1];
  const annotations = Array.isArray(article?.annotations) ? article.annotations : [];

  return annotations.map((annotation) => ({
    exportedAt: record.savedAt,
    participantId: record.participantId,
    sessionId: record.sessionId,
    runId: record.runId,
    storageKey: record.storageKey,
    taskVersion: taskPayload.taskVersion || null,
    datasetVersion: taskPayload.datasetVersion || null,
    completedArticles: taskPayload.completedArticles ?? null,
    totalArticles: taskPayload.totalArticles ?? null,
    row_id: article.row_id ?? null,
    originalArticleId: article.originalArticleId ?? null,
    annotationId: annotation.id ?? null,
    type: annotation.type ?? null,
    scope: annotation.scope ?? null,
    section: annotation.section ?? null,
    selectedText: annotation.text ?? null,
    start: annotation.start ?? null,
    end: annotation.end ?? null,
    primaryCommentLabel: annotation.primaryCommentLabel ?? null,
    primaryComment: annotation.primaryComment ?? null,
    secondaryComment: annotation.secondaryComment ?? null,
    severity: annotation.severity ?? null,
    createdAt: annotation.createdAt ?? null,
    updatedAt: annotation.updatedAt ?? null,
  }));
}

async function appendOnlyAnnotationRecords(record) {
  const annotationRecords = buildOnlyAnnotationRecords(record);
  if (annotationRecords.length === 0) {
    return { count: 0, file: path.relative(ROOT_DIR, ONLY_ANNOTATIONS_FILE) };
  }

  await withOnlyAnnotationsLock(() => {
    fs.appendFileSync(
      ONLY_ANNOTATIONS_FILE,
      `${annotationRecords.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    );
  });

  return {
    count: annotationRecords.length,
    file: path.relative(ROOT_DIR, ONLY_ANNOTATIONS_FILE),
  };
}

async function saveAnnotationSnapshot(payload) {
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
  const onlyAnnotations = await appendOnlyAnnotationRecords(record);

  return {
    ok: true,
    storageKey,
    runId,
    status: record.status,
    eventFile: path.relative(ROOT_DIR, EVENTS_FILE),
    runFile: path.relative(ROOT_DIR, targetFile),
    onlyAnnotationsFile: onlyAnnotations.file,
    onlyAnnotationsAdded: onlyAnnotations.count,
  };
}

async function handleSaveAnnotations(request, response) {
  try {
    const payload = await readRequestJson(request);
    const result = await saveAnnotationSnapshot(payload);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleArticleOptions(request, response) {
  try {
    const payload = await readRequestJson(request);
    sendJson(response, 200, await assignArticleOptions(payload));
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleArticleAnnotated(request, response) {
  try {
    const payload = await readRequestJson(request);
    sendJson(response, 200, await markArticleAnnotated(payload));
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

  if (request.method === "POST" && request.url === "/api/articles/options") {
    handleArticleOptions(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/articles/annotated") {
    handleArticleAnnotated(request, response);
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
