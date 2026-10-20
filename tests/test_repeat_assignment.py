import json
import tempfile
import unittest
from pathlib import Path

import server


class RepeatAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        server.ROOT_DIR = root
        server.DATA_DIR = root / "saved_annotations"
        server.RUNS_DIR = server.DATA_DIR / "runs"
        server.EVENTS_DIR = server.DATA_DIR / "events"
        server.ASSIGNMENTS_DIR = server.DATA_DIR / "assignments"
        server.EVENTS_FILE = server.EVENTS_DIR / "annotation-events.jsonl"
        server.ASSIGNMENT_EVENTS_FILE = server.ASSIGNMENTS_DIR / "article-events.jsonl"
        server.ASSIGNMENT_LOCK_FILE = server.ASSIGNMENTS_DIR / "article-events.lock"
        server.PRIORITY_COHORT_FILE = server.ASSIGNMENTS_DIR / "priority-cohort.json"
        server.ARTICLE_DATASET_PATH = root / "articles.jsonl"
        server.ensure_storage()

        articles = [
            {"row_id": row_id, "heading": f"Article {row_id}", "text": "Body"}
            for row_id in range(1, 5)
        ]
        server.ARTICLE_DATASET_PATH.write_text(
            "".join(json.dumps(article) + "\n" for article in articles),
            encoding="utf-8",
        )

        self.save_run("alice", ["1", "2"])
        self.save_run("bob", ["1", "3"])
        self.save_run("carol", ["1"])

    def tearDown(self):
        self.temp_dir.cleanup()

    def save_run(self, participant_id, article_ids):
        run_dir = server.RUNS_DIR / participant_id / "run"
        run_dir.mkdir(parents=True, exist_ok=True)
        record = {
            "participantId": participant_id,
            "payload": {
                "participantId": participant_id,
                "articles": [
                    {"row_id": article_id, "annotations": [{"id": "annotation"}]}
                    for article_id in article_ids
                ],
            },
        }
        (run_dir / "final.json").write_text(json.dumps(record), encoding="utf-8")

    def test_excludes_self_unannotated_and_already_at_target(self):
        result = server.assign_article_options(
            {"participantId": "Alice", "runId": "new-run", "round": 1}
        )
        option_ids = {article["row_id"] for article in result["options"]}

        self.assertEqual(option_ids, {"3"})
        self.assertNotIn("2", option_ids)  # Alice already annotated it.
        self.assertNotIn("4", option_ids)  # Nobody has annotated it.
        self.assertNotIn("1", option_ids)  # It already has three annotators.


if __name__ == "__main__":
    unittest.main()
