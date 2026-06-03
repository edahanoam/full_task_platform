from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import json
import os
import re
import uuid
from datetime import datetime, timezone


PORT = int(os.environ.get("PORT", "3000"))
ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "saved_annotations"
RUNS_DIR = DATA_DIR / "runs"
EVENTS_DIR = DATA_DIR / "events"
EVENTS_FILE = EVENTS_DIR / "annotation-events.jsonl"
MAX_BODY_BYTES = 5 * 1024 * 1024


def ensure_storage():
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)


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


def save_annotation_snapshot(payload):
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

    return {
        "ok": True,
        "storageKey": storage_key,
        "runId": run_id,
        "status": record["status"],
        "eventFile": str(EVENTS_FILE.relative_to(ROOT_DIR)),
        "runFile": str(target_file.relative_to(ROOT_DIR)),
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
        if urlparse(self.path).path != "/api/annotations/save":
            self.send_error(404, "Not found")
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length > MAX_BODY_BYTES:
                raise ValueError("Request body is too large.")

            raw_body = self.rfile.read(content_length)
            payload = json.loads(raw_body.decode("utf-8") or "{}")
            self.send_json(200, save_annotation_snapshot(payload))
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
