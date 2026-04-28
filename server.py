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
LATEST_DIR = DATA_DIR / "latest"
EVENTS_FILE = DATA_DIR / "annotation-events.jsonl"
MAX_BODY_BYTES = 5 * 1024 * 1024


def ensure_storage():
    LATEST_DIR.mkdir(parents=True, exist_ok=True)


def make_storage_key(payload):
    participant_id = str(payload.get("participantId") or "").strip()
    session_id = str(payload.get("sessionId") or "").strip()
    raw_key = participant_id or session_id or str(uuid.uuid4())
    return re.sub(r"[^a-zA-Z0-9._-]", "_", raw_key)[:120]


def save_annotation_snapshot(payload):
    ensure_storage()

    storage_key = make_storage_key(payload)
    latest_file = LATEST_DIR / f"{storage_key}.json"
    record = {
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "storageKey": storage_key,
        "participantId": str(payload.get("participantId") or "").strip() or None,
        "sessionId": str(payload.get("sessionId") or "").strip() or None,
        "reason": str(payload.get("reason") or "snapshot"),
        "payload": payload.get("payload"),
    }

    with EVENTS_FILE.open("a", encoding="utf-8") as event_log:
        event_log.write(json.dumps(record, ensure_ascii=False) + "\n")

    latest_file.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    return {
        "ok": True,
        "storageKey": storage_key,
        "eventFile": str(EVENTS_FILE.relative_to(ROOT_DIR)),
        "latestFile": str(latest_file.relative_to(ROOT_DIR)),
    }


class AnnotationHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def end_headers(self):
        if self.path.endswith(".html") or self.path == "/":
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
