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
const PRIORITY_COHORT_FILE = path.join(ASSIGNMENTS_DIR, "priority-cohort.json");
const ASSIGNMENT_RESERVATIONS_FILE = path.join(ASSIGNMENTS_DIR, "article-reservations.json");
const ARTICLE_DATASET_PATH = path.join(ROOT_DIR, "cleaned2604combined_none_middle50_by_length.jsonl");
const ARTICLE_CHOICES_PER_ROUND = 1;
const PRIORITY_COHORT_SIZE = 100;
const TARGET_ANNOTATIONS_PER_ARTICLE = 3;
const ASSIGNMENT_RESERVATION_MINUTES = 120;
const READ_ONLY_TEST_PARTICIPANT = "noam";
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

function participantKey(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function isReadOnlyTestParticipant(value) {
  return participantKey(value) === READ_ONLY_TEST_PARTICIPANT;
}

function addSavedArticlesToHistory(history, saveFile) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(saveFile, "utf8"));
  } catch {
    return;
  }

  const taskPayload = record.payload || {};
  const annotator = participantKey(
    record.participantId || taskPayload.participantId || record.storageKey || record.sessionId,
  );
  if (!annotator || isReadOnlyTestParticipant(annotator)) return;

  for (const article of taskPayload.articles || []) {
    const articleId = normalizeArticleId(article.row_id);
    if (!articleId || !(article.annotations || []).length) continue;
    if (!history.has(articleId)) history.set(articleId, new Set());
    history.get(articleId).add(annotator);
  }
}

function readAnnotationHistory() {
  const history = new Map();
  if (fs.existsSync(RUNS_DIR)) {
    for (const participantEntry of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
      if (!participantEntry.isDirectory()) continue;
      const participantDir = path.join(RUNS_DIR, participantEntry.name);
      for (const runEntry of fs.readdirSync(participantDir, { withFileTypes: true })) {
        if (!runEntry.isDirectory()) continue;
        const runDir = path.join(participantDir, runEntry.name);
        for (const fileName of ["final.json", "snapshot.json"]) {
          const saveFile = path.join(runDir, fileName);
          if (fs.existsSync(saveFile)) addSavedArticlesToHistory(history, saveFile);
        }
      }
    }
  }

  if (fs.existsSync(ASSIGNMENT_EVENTS_FILE)) {
    for (const line of fs.readFileSync(ASSIGNMENT_EVENTS_FILE, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "annotated") continue;
      const articleId = normalizeArticleId(event.row_id || event.articleId);
      const annotator = participantKey(event.participantId);
      if (!articleId || !annotator || isReadOnlyTestParticipant(annotator)) continue;
      if (!history.has(articleId)) history.set(articleId, new Set());
      history.get(articleId).add(annotator);
    }
  }
  return history;
}

function readPriorityCohort(history, articleMap, persist = true) {
  let cohort = [];
  if (fs.existsSync(PRIORITY_COHORT_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(PRIORITY_COHORT_FILE, "utf8") || "[]");
      if (Array.isArray(saved)) cohort = saved.map(normalizeArticleId);
    } catch {
      cohort = [];
    }
  }

  cohort = [...new Set(cohort.filter((articleId) => history.has(articleId) && articleMap.has(articleId)))];
  const cohortSet = new Set(cohort);
  const candidates = [...history.keys()]
    .filter((articleId) => articleMap.has(articleId) && !cohortSet.has(articleId))
    .sort((left, right) => history.get(right).size - history.get(left).size || left.localeCompare(right));
  cohort.push(...candidates.slice(0, Math.max(0, PRIORITY_COHORT_SIZE - cohort.length)));
  if (persist) {
    fs.writeFileSync(PRIORITY_COHORT_FILE, `${JSON.stringify(cohort, null, 2)}\n`, "utf8");
  }
  return cohort;
}

function readAssignmentReservations() {
  if (!fs.existsSync(ASSIGNMENT_RESERVATIONS_FILE)) return [];
  try {
    const reservations = JSON.parse(fs.readFileSync(ASSIGNMENT_RESERVATIONS_FILE, "utf8") || "[]");
    return Array.isArray(reservations) ? reservations : [];
  } catch {
    return [];
  }
}

function activeAssignmentReservations(reservations, now = Date.now()) {
  return reservations.filter((reservation) => {
    const expiresAt = Date.parse(String(reservation.expiresAt || ""));
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
}

function writeAssignmentReservations(reservations) {
  fs.writeFileSync(
    ASSIGNMENT_RESERVATIONS_FILE,
    `${JSON.stringify(reservations, null, 2)}\n`,
    "utf8",
  );
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
  const excludedArticleIds = new Set((payload.excludedRowIds || []).map(normalizeArticleId));

  if (!participantId || !runId) {
    throw new Error("participantId and runId are required.");
  }

  const testMode = isReadOnlyTestParticipant(participantId);

  return withAssignmentLock(() => {
    const articleMap = getArticleMap();
    const history = readAnnotationHistory();
    const priorityCohort = readPriorityCohort(history, articleMap, !testMode);
    const prioritySet = new Set(priorityCohort);
    const currentParticipant = participantKey(participantId);
    const reservations = activeAssignmentReservations(readAssignmentReservations());
    const existingReservation = reservations.find((reservation) => (
      participantKey(reservation.participantId) === currentParticipant &&
      String(reservation.runId || "") === runId &&
      Number(reservation.round || 0) === round &&
      articleMap.has(normalizeArticleId(reservation.row_id))
    ));
    const reservedAnnotators = new Map();
    for (const reservation of reservations) {
      const articleId = normalizeArticleId(reservation.row_id);
      const annotator = participantKey(reservation.participantId);
      if (!articleId || !annotator) continue;
      if (!reservedAnnotators.has(articleId)) reservedAnnotators.set(articleId, new Set());
      reservedAnnotators.get(articleId).add(annotator);
    }
    const isEligible = (articleId) => {
      const annotators = history.get(articleId) || new Set();
      const effectiveAnnotators = new Set([
        ...annotators,
        ...(reservedAnnotators.get(articleId) || new Set()),
      ]);
      return (
        articleMap.has(articleId) &&
        !excludedArticleIds.has(articleId) &&
        annotators.size > 0 &&
        annotators.size < TARGET_ANNOTATIONS_PER_ARTICLE &&
        effectiveAnnotators.size < TARGET_ANNOTATIONS_PER_ARTICLE &&
        (testMode || !effectiveAnnotators.has(currentParticipant))
      );
    };
    const priorityIds = priorityCohort.filter(isEligible);
    const remainingIds = [...history.keys()].filter(
      (articleId) => !prioritySet.has(articleId) && isEligible(articleId),
    );
    const candidateIds = [...priorityIds, ...remainingIds];
    let chosenArticleIds;
    if (existingReservation && !testMode) {
      chosenArticleIds = [normalizeArticleId(existingReservation.row_id)];
    } else if (!candidateIds.length) {
      throw new Error("No eligible previously annotated articles remain for this participant.");
    } else {
      chosenArticleIds = [...candidateIds]
        .sort(() => Math.random() - 0.5)
        .sort((left, right) => {
          const cohortDifference = Number(!prioritySet.has(left)) - Number(!prioritySet.has(right));
          return cohortDifference || history.get(right).size - history.get(left).size;
        })
        .slice(0, ARTICLE_CHOICES_PER_ROUND);
    }

    if (!testMode && !existingReservation) {
      const now = new Date();
      reservations.push({
        participantId,
        runId,
        round,
        row_id: chosenArticleIds[0],
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ASSIGNMENT_RESERVATION_MINUTES * 60000).toISOString(),
      });
      writeAssignmentReservations(reservations);
    }
    const options = chosenArticleIds.map((articleId) => articleMap.get(articleId));

    if (!testMode && !existingReservation) {
      appendAssignmentEvent({
        type: "assigned",
        participantId,
        runId,
        round,
        row_id: chosenArticleIds[0],
      });
    }

    return {
      ok: true,
      status: testMode ? "test" : "assigned",
      testMode,
      round,
      options,
      eligibleArticleCount: candidateIds.length,
      priorityCohortSize: priorityCohort.length,
      priorityArticlesAtTarget: priorityCohort.filter(
        (articleId) => (history.get(articleId) || new Set()).size >= TARGET_ANNOTATIONS_PER_ARTICLE,
      ).length,
      targetAnnotationsPerArticle: TARGET_ANNOTATIONS_PER_ARTICLE,
      assignmentEventFile: path.relative(ROOT_DIR, ASSIGNMENT_EVENTS_FILE),
      priorityCohortFile: path.relative(ROOT_DIR, PRIORITY_COHORT_FILE),
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

  if (isReadOnlyTestParticipant(participantId)) {
    return {
      ok: true,
      status: "test",
      testMode: true,
      notSaved: true,
      row_id: articleId,
    };
  }

  return withAssignmentLock(() => {
    appendAssignmentEvent({
      type: "annotated",
      participantId,
      runId,
      round,
      row_id: articleId,
    });
    const reservations = activeAssignmentReservations(readAssignmentReservations()).filter(
      (reservation) => !(
        participantKey(reservation.participantId) === participantKey(participantId) &&
        normalizeArticleId(reservation.row_id) === articleId
      ),
    );
    writeAssignmentReservations(reservations);

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
  const participantId = String(payload.participantId || "").trim();
  if (isReadOnlyTestParticipant(participantId)) {
    return {
      ok: true,
      status: "test",
      testMode: true,
      notSaved: true,
      message: "Read-only test participant; annotation data was not saved.",
    };
  }

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
