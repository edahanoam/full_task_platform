from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import json
import os
import re
import random
import time
import uuid
from datetime import datetime, timedelta, timezone


PORT = int(os.environ.get("PORT", "3000"))
ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "saved_annotations"
RUNS_DIR = DATA_DIR / "runs"
EVENTS_DIR = DATA_DIR / "events"
ASSIGNMENTS_DIR = DATA_DIR / "assignments"
EVENTS_FILE = EVENTS_DIR / "annotation-events.jsonl"
ONLY_ANNOTATIONS_FILE = DATA_DIR / "only-annotations.jsonl"
ONLY_ANNOTATIONS_LOCK_FILE = DATA_DIR / "only-annotations.lock"
ASSIGNMENT_EVENTS_FILE = ASSIGNMENTS_DIR / "article-events.jsonl"
ASSIGNMENT_LOCK_FILE = ASSIGNMENTS_DIR / "article-events.lock"
AVAILABLE_ARTICLES_FILE = ASSIGNMENTS_DIR / "available-articles.json"
PRIORITY_COHORT_FILE = ASSIGNMENTS_DIR / "priority-cohort.json"
ASSIGNMENT_RESERVATIONS_FILE = ASSIGNMENTS_DIR / "article-reservations.json"
ARTICLE_DATASET_PATH = ROOT_DIR / "cleaned2604combined_none_middle50_by_length.jsonl"
ARTICLE_CHOICES_PER_ROUND = 1
PRIORITY_COHORT_SIZE = 100
TARGET_ANNOTATIONS_PER_ARTICLE = 3
ASSIGNMENT_RESERVATION_MINUTES = 120
READ_ONLY_TEST_PARTICIPANT = "noam"
MAX_BODY_BYTES = 5 * 1024 * 1024


def ensure_storage():
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    ASSIGNMENTS_DIR.mkdir(parents=True, exist_ok=True)


def sanitize_storage_part(value, fallback=None):
    raw_value = str(value or "").strip() or fallback or str(uuid.uuid4())
    return re.sub(r"[^a-zA-Z0-9._-]", "_", raw_value)[:160]


def make_storage_key(payload):
    participant_id = str(payload.get("participantId") or "").strip()
    session_id = str(payload.get("sessionId") or "").strip()
    raw_key = participant_id or session_id or str(uuid.uuid4())
    return sanitize_storage_part(raw_key)[:120]


def make_run_id(payload):
    nested_payload = payload.get("payload") or {}
    supplied_run_id = str(payload.get("runId") or nested_payload.get("runId") or "").strip()
    if supplied_run_id:
        return sanitize_storage_part(supplied_run_id)

    timestamp = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    return sanitize_storage_part(f"{timestamp}_{uuid.uuid4()}")


def is_final_save(payload):
    reason = str(payload.get("reason") or "").strip()
    nested_payload = payload.get("payload") or {}
    total_articles = int(nested_payload.get("totalArticles") or 0)
    completed_articles = int(nested_payload.get("completedArticles") or 0)
    return (
        reason == "submission-complete"
        or bool(nested_payload.get("endTime"))
        or (total_articles > 0 and completed_articles == total_articles)
    )


def normalize_article(record, index):
    row_id = int(record.get("row_id") or index + 1)
    return {
        "row_id": str(row_id),
        "originalId": str(record.get("ID") or record.get("id") or record.get("articleId") or index),
        "title": str(record.get("heading") or record.get("title") or record.get("headline") or ""),
        "text": str(record.get("text") or record.get("body") or record.get("articleText") or record.get("content") or ""),
        "source": str(record.get("source") or record.get("publisher") or record.get("outlet") or ""),
        "bias": record.get("bias"),
        "url": record.get("url"),
    }


def parse_article_dataset():
    articles = []
    with ARTICLE_DATASET_PATH.open("r", encoding="utf-8") as dataset:
        for index, line in enumerate(dataset):
            if not line.strip():
                continue
            articles.append(normalize_article(json.loads(line), index))
    return articles


def get_article_map():
    return {article["row_id"]: article for article in parse_article_dataset()}


def initialize_available_articles_file():
    article_ids = [
        article["row_id"]
        for article in parse_article_dataset()
        if article["title"] and article["text"]
    ]
    AVAILABLE_ARTICLES_FILE.write_text(
        json.dumps(article_ids, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return article_ids


def read_available_article_ids():
    if not AVAILABLE_ARTICLES_FILE.exists():
        return initialize_available_articles_file()

    article_ids = json.loads(AVAILABLE_ARTICLES_FILE.read_text(encoding="utf-8") or "[]")
    if not isinstance(article_ids, list):
        raise ValueError("available-articles.json must contain an array.")

    return [normalize_article_id(article_id) for article_id in article_ids]


def write_available_article_ids(article_ids):
    AVAILABLE_ARTICLES_FILE.write_text(
        json.dumps(article_ids, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def normalize_article_id(article_id):
    raw_article_id = str(article_id or "").strip()
    match = re.match(r"^row-0*(\d+)$", raw_article_id)
    return match.group(1) if match else raw_article_id


def participant_key(value):
    """Normalize participant IDs for reliable self-exclusion and deduplication."""
    return str(value or "").strip().casefold()


def is_read_only_test_participant(value):
    return participant_key(value) == READ_ONLY_TEST_PARTICIPANT


def add_saved_articles_to_history(history, save_file):
    try:
        record = json.loads(save_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return

    task_payload = record.get("payload") or {}
    annotator = participant_key(
        record.get("participantId")
        or task_payload.get("participantId")
        or record.get("storageKey")
        or record.get("sessionId")
    )
    if not annotator or is_read_only_test_participant(annotator):
        return

    for article in task_payload.get("articles") or []:
        article_id = normalize_article_id(article.get("row_id"))
        annotations = article.get("annotations") or []
        # Only a genuinely annotated article seeds or advances the repeat pool.
        if article_id and annotations:
            history.setdefault(article_id, set()).add(annotator)


def read_annotation_history():
    """Return {row_id: {participant IDs}} from saved runs and assignment events."""
    history = {}

    if RUNS_DIR.exists():
        for final_file in RUNS_DIR.glob("*/*/final.json"):
            add_saved_articles_to_history(history, final_file)
        # Include finalized articles in tasks that have not completed all rounds.
        for snapshot_file in RUNS_DIR.glob("*/*/snapshot.json"):
            add_saved_articles_to_history(history, snapshot_file)

    if ASSIGNMENT_EVENTS_FILE.exists():
        try:
            with ASSIGNMENT_EVENTS_FILE.open("r", encoding="utf-8") as event_log:
                for line in event_log:
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") != "annotated":
                        continue
                    article_id = normalize_article_id(
                        event.get("row_id") or event.get("articleId")
                    )
                    annotator = participant_key(event.get("participantId"))
                    if article_id and annotator and not is_read_only_test_participant(annotator):
                        history.setdefault(article_id, set()).add(annotator)
        except OSError:
            pass

    return history


def read_priority_cohort(history, article_map, persist=True):
    """Create once, then preserve a stable cohort of up to 100 seeded articles."""
    cohort = []
    if PRIORITY_COHORT_FILE.exists():
        try:
            saved = json.loads(PRIORITY_COHORT_FILE.read_text(encoding="utf-8") or "[]")
            if isinstance(saved, list):
                cohort = [normalize_article_id(article_id) for article_id in saved]
        except (OSError, json.JSONDecodeError):
            cohort = []

    cohort = list(dict.fromkeys(
        article_id
        for article_id in cohort
        if article_id in history and article_id in article_map
    ))
    candidates = [
        article_id
        for article_id in history
        if article_id in article_map and article_id not in cohort
    ]
    # Start with articles closest to three annotations to reach the first 100 quickly.
    candidates.sort(key=lambda article_id: (-len(history[article_id]), article_id))
    cohort.extend(candidates[:max(0, PRIORITY_COHORT_SIZE - len(cohort))])
    if persist:
        PRIORITY_COHORT_FILE.write_text(
            json.dumps(cohort, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return cohort


def read_assignment_reservations():
    if not ASSIGNMENT_RESERVATIONS_FILE.exists():
        return []
    try:
        reservations = json.loads(
            ASSIGNMENT_RESERVATIONS_FILE.read_text(encoding="utf-8") or "[]"
        )
    except (OSError, json.JSONDecodeError):
        return []
    return reservations if isinstance(reservations, list) else []


def active_assignment_reservations(reservations, now=None):
    now = now or datetime.now(timezone.utc)
    active = []
    for reservation in reservations:
        try:
            expires_at = datetime.fromisoformat(
                str(reservation.get("expiresAt") or "").replace("Z", "+00:00")
            )
        except ValueError:
            continue
        if expires_at > now:
            active.append(reservation)
    return active


def write_assignment_reservations(reservations):
    ASSIGNMENT_RESERVATIONS_FILE.write_text(
        json.dumps(reservations, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def append_assignment_event(event):
    record = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **event,
    }
    with ASSIGNMENT_EVENTS_FILE.open("a", encoding="utf-8") as event_log:
        event_log.write(json.dumps(record, ensure_ascii=False) + "\n")


class file_lock:
    def __init__(self, lock_file, lock_name):
        self.lock_file = lock_file
        self.lock_name = lock_name
        self.lock_fd = None

    def __enter__(self):
        ensure_storage()
        started_at = time.time()
        while time.time() - started_at < 5:
            try:
                self.lock_fd = os.open(str(self.lock_file), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(
                    self.lock_fd,
                    f"{os.getpid()}\n{datetime.now(timezone.utc).isoformat()}\n".encode("utf-8"),
                )
                return self
            except FileExistsError:
                try:
                    lock_age = time.time() - self.lock_file.stat().st_mtime
                    if lock_age > 30:
                        self.lock_file.unlink()
                except FileNotFoundError:
                    pass
                time.sleep(0.05)

        raise TimeoutError(f"Could not acquire {self.lock_name} lock.")

    def __exit__(self, exc_type, exc_value, traceback):
        os.close(self.lock_fd)
        try:
            self.lock_file.unlink()
        except FileNotFoundError:
            pass


def assign_article_options(payload):
    participant_id = str(payload.get("participantId") or "").strip()
    run_id = str(payload.get("runId") or "").strip()
    round_number = int(payload.get("round") or 1)

    if not participant_id or not run_id:
        raise ValueError("participantId and runId are required.")

    test_mode = is_read_only_test_participant(participant_id)

    with file_lock(ASSIGNMENT_LOCK_FILE, "article assignment"):
        article_map = get_article_map()
        history = read_annotation_history()
        priority_cohort = read_priority_cohort(history, article_map, persist=not test_mode)
        current_participant = participant_key(participant_id)
        reservations = active_assignment_reservations(read_assignment_reservations())

        existing_reservation = next((
            reservation
            for reservation in reservations
            if participant_key(reservation.get("participantId")) == current_participant
            and str(reservation.get("runId") or "") == run_id
            and int(reservation.get("round") or 0) == round_number
            and normalize_article_id(reservation.get("row_id")) in article_map
        ), None)

        reserved_annotators = {}
        for reservation in reservations:
            article_id = normalize_article_id(reservation.get("row_id"))
            annotator = participant_key(reservation.get("participantId"))
            if article_id and annotator:
                reserved_annotators.setdefault(article_id, set()).add(annotator)

        def is_eligible(article_id):
            annotators = history.get(article_id, set())
            effective_annotators = annotators | reserved_annotators.get(article_id, set())
            return (
                article_id in article_map
                and 0 < len(annotators) < TARGET_ANNOTATIONS_PER_ARTICLE
                and len(effective_annotators) < TARGET_ANNOTATIONS_PER_ARTICLE
                and (test_mode or current_participant not in effective_annotators)
            )

        priority_ids = [article_id for article_id in priority_cohort if is_eligible(article_id)]
        remaining_ids = [
            article_id
            for article_id in history
            if article_id not in set(priority_cohort) and is_eligible(article_id)
        ]
        priority_set = set(priority_cohort)
        candidate_ids = priority_ids + remaining_ids
        if existing_reservation and not test_mode:
            chosen_article_ids = [normalize_article_id(existing_reservation.get("row_id"))]
        elif not candidate_ids:
            raise ValueError(
                "No eligible previously annotated articles remain for this participant."
            )
        else:
            # Prefer articles nearest the target; randomize ties so participants vary.
            random.shuffle(candidate_ids)
            candidate_ids.sort(key=lambda article_id: (
                0 if article_id in priority_set else 1,
                -len(history[article_id]),
            ))
            chosen_article_ids = candidate_ids[:ARTICLE_CHOICES_PER_ROUND]

        if not test_mode and not existing_reservation:
            reservations.append({
                "participantId": participant_id,
                "runId": run_id,
                "round": round_number,
                "row_id": chosen_article_ids[0],
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "expiresAt": (
                    datetime.now(timezone.utc)
                    + timedelta(minutes=ASSIGNMENT_RESERVATION_MINUTES)
                ).isoformat(),
            })
            write_assignment_reservations(reservations)

        options = [article_map[article_id] for article_id in chosen_article_ids]
        if not test_mode and not existing_reservation:
            append_assignment_event({
                "type": "assigned",
                "participantId": participant_id,
                "runId": run_id,
                "round": round_number,
                "row_id": chosen_article_ids[0],
            })

    return {
        "ok": True,
        "status": "test" if test_mode else "assigned",
        "testMode": test_mode,
        "round": round_number,
        "options": options,
        "eligibleArticleCount": len(candidate_ids),
        "priorityCohortSize": len(priority_cohort),
        "priorityArticlesAtTarget": sum(
            1
            for article_id in priority_cohort
            if len(history.get(article_id, set())) >= TARGET_ANNOTATIONS_PER_ARTICLE
        ),
        "targetAnnotationsPerArticle": TARGET_ANNOTATIONS_PER_ARTICLE,
        "assignmentEventFile": str(ASSIGNMENT_EVENTS_FILE.relative_to(ROOT_DIR)),
        "priorityCohortFile": str(PRIORITY_COHORT_FILE.relative_to(ROOT_DIR)),
    }


def mark_article_annotated(payload):
    participant_id = str(payload.get("participantId") or "").strip()
    run_id = str(payload.get("runId") or "").strip()
    article_id = normalize_article_id(payload.get("row_id") or payload.get("articleId"))
    round_number = int(payload.get("round") or 1)

    if not participant_id or not run_id or not article_id:
        raise ValueError("participantId, runId, and articleId are required.")

    if is_read_only_test_participant(participant_id):
        return {
            "ok": True,
            "status": "test",
            "testMode": True,
            "notSaved": True,
            "row_id": article_id,
        }

    with file_lock(ASSIGNMENT_LOCK_FILE, "article assignment"):
        append_assignment_event({
            "type": "annotated",
            "participantId": participant_id,
            "runId": run_id,
            "round": round_number,
            "row_id": article_id,
        })
        reservations = active_assignment_reservations(read_assignment_reservations())
        reservations = [
            reservation
            for reservation in reservations
            if not (
                participant_key(reservation.get("participantId")) == participant_key(participant_id)
                and normalize_article_id(reservation.get("row_id")) == article_id
            )
        ]
        write_assignment_reservations(reservations)

    return {
        "ok": True,
        "status": "annotated",
        "row_id": article_id,
        "assignmentEventFile": str(ASSIGNMENT_EVENTS_FILE.relative_to(ROOT_DIR)),
    }


def build_only_annotation_records(record):
    if record["reason"] != "article-finalized":
        return []

    task_payload = record.get("payload") or {}
    articles = task_payload.get("articles") if isinstance(task_payload.get("articles"), list) else []
    article = articles[-1] if articles else {}
    annotations = article.get("annotations") if isinstance(article.get("annotations"), list) else []

    return [
        {
            "exportedAt": record["savedAt"],
            "participantId": record["participantId"],
            "sessionId": record["sessionId"],
            "runId": record["runId"],
            "storageKey": record["storageKey"],
            "taskVersion": task_payload.get("taskVersion"),
            "datasetVersion": task_payload.get("datasetVersion"),
            "completedArticles": task_payload.get("completedArticles"),
            "totalArticles": task_payload.get("totalArticles"),
            "row_id": article.get("row_id"),
            "originalArticleId": article.get("originalArticleId"),
            "annotationId": annotation.get("id"),
            "type": annotation.get("type"),
            "scope": annotation.get("scope"),
            "section": annotation.get("section"),
            "selectedText": annotation.get("text"),
            "start": annotation.get("start"),
            "end": annotation.get("end"),
            "primaryCommentLabel": annotation.get("primaryCommentLabel"),
            "primaryComment": annotation.get("primaryComment"),
            "secondaryComment": annotation.get("secondaryComment"),
            "severity": annotation.get("severity"),
            "createdAt": annotation.get("createdAt"),
            "updatedAt": annotation.get("updatedAt"),
        }
        for annotation in annotations
    ]


def append_only_annotation_records(record):
    annotation_records = build_only_annotation_records(record)
    if not annotation_records:
        return {
            "count": 0,
            "file": str(ONLY_ANNOTATIONS_FILE.relative_to(ROOT_DIR)),
        }

    with file_lock(ONLY_ANNOTATIONS_LOCK_FILE, "only annotations"):
        with ONLY_ANNOTATIONS_FILE.open("a", encoding="utf-8") as only_annotations:
            for annotation_record in annotation_records:
                only_annotations.write(json.dumps(annotation_record, ensure_ascii=False) + "\n")

    return {
        "count": len(annotation_records),
        "file": str(ONLY_ANNOTATIONS_FILE.relative_to(ROOT_DIR)),
    }


def save_annotation_snapshot(payload):
    participant_id = str(payload.get("participantId") or "").strip()
    if is_read_only_test_participant(participant_id):
        return {
            "ok": True,
            "status": "test",
            "testMode": True,
            "notSaved": True,
            "message": "Read-only test participant; annotation data was not saved.",
        }

    ensure_storage()

    storage_key = make_storage_key(payload)
    run_id = make_run_id(payload)
    run_dir = RUNS_DIR / storage_key / run_id
    snapshot_file = run_dir / "snapshot.json"
    final_file = run_dir / "final.json"
    is_complete = is_final_save(payload)
    target_file = final_file if is_complete else snapshot_file
    record = {
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "storageKey": storage_key,
        "runId": run_id,
        "participantId": str(payload.get("participantId") or "").strip() or None,
        "sessionId": str(payload.get("sessionId") or "").strip() or None,
        "reason": str(payload.get("reason") or "snapshot"),
        "status": "complete" if is_complete else "draft",
        "payload": payload.get("payload"),
    }

    run_dir.mkdir(parents=True, exist_ok=True)

    with EVENTS_FILE.open("a", encoding="utf-8") as event_log:
        event_log.write(json.dumps(record, ensure_ascii=False) + "\n")

    target_file.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    only_annotations = append_only_annotation_records(record)

    return {
        "ok": True,
        "storageKey": storage_key,
        "runId": run_id,
        "status": record["status"],
        "eventFile": str(EVENTS_FILE.relative_to(ROOT_DIR)),
        "runFile": str(target_file.relative_to(ROOT_DIR)),
        "onlyAnnotationsFile": only_annotations["file"],
        "onlyAnnotationsAdded": only_annotations["count"],
    }


class AnnotationHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def end_headers(self):
        clean_path = urlparse(self.path).path
        if clean_path == "/" or clean_path.endswith((".html", ".js", ".jsonl")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            self.send_json(200, {"ok": True})
            return

        super().do_GET()

    def do_POST(self):
        clean_path = urlparse(self.path).path
        if clean_path not in {
            "/api/annotations/save",
            "/api/articles/options",
            "/api/articles/annotated",
        }:
            self.send_error(404, "Not found")
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length > MAX_BODY_BYTES:
                raise ValueError("Request body is too large.")

            raw_body = self.rfile.read(content_length)
            payload = json.loads(raw_body.decode("utf-8") or "{}")
            if clean_path == "/api/annotations/save":
                self.send_json(200, save_annotation_snapshot(payload))
            elif clean_path == "/api/articles/options":
                self.send_json(200, assign_article_options(payload))
            else:
                self.send_json(200, mark_article_annotated(payload))
        except Exception as error:
            self.send_json(400, {"ok": False, "error": str(error)})

    def send_json(self, status_code, payload):
        response = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


if __name__ == "__main__":
    ensure_storage()
    server = ThreadingHTTPServer(("", PORT), AnnotationHandler)
    print(f"Annotation app running at http://localhost:{PORT}")
    print(f"Saving annotation snapshots under {DATA_DIR}")
    server.serve_forever()
