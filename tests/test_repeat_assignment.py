import json
import tempfile
import unittest
from pathlib import Path

import server


class RepeatAssignmentTests(unittest.TestCase):
    def setUp(self):
        test_temp_root = Path(__file__).resolve().parents[1] / ".test_tmp"
        test_temp_root.mkdir(exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=test_temp_root)
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
        server.ASSIGNMENT_RESERVATIONS_FILE = server.ASSIGNMENTS_DIR / "article-reservations.json"
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
        self.save_run("carol", ["1", "3"])
        self.save_run("noam", ["4"])

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
        self.assertNotIn("4", option_ids)  # Read-only test data does not seed the pool.
        self.assertNotIn("1", option_ids)  # It already has three annotators.

    def test_assignment_is_automatic_idempotent_and_reserved(self):
        first = server.assign_article_options(
            {"participantId": "Alice", "runId": "new-run", "round": 1}
        )
        repeated = server.assign_article_options(
            {"participantId": "Alice", "runId": "new-run", "round": 1}
        )

        self.assertEqual(len(first["options"]), 1)
        self.assertEqual(first["options"][0]["row_id"], "3")
        self.assertEqual(repeated["options"][0]["row_id"], "3")
        reservations = json.loads(
            server.ASSIGNMENT_RESERVATIONS_FILE.read_text(encoding="utf-8")
        )
        self.assertEqual(len(reservations), 1)

        # Article 3 has two completed annotators plus Alice's reservation, so a
        # concurrent participant must receive another article.
        concurrent = server.assign_article_options(
            {"participantId": "Dave", "runId": "other-run", "round": 1}
        )
        self.assertEqual(concurrent["options"][0]["row_id"], "2")

    def test_noam_can_use_interface_without_writing_data(self):
        result = server.assign_article_options(
            {"participantId": "NoAm", "runId": "test-run", "round": 1}
        )
        save_result = server.save_annotation_snapshot({
            "participantId": "noam",
            "runId": "test-run",
            "payload": {"articles": []},
        })
        mark_result = server.mark_article_annotated({
            "participantId": "noam",
            "runId": "test-run",
            "round": 1,
            "row_id": result["options"][0]["row_id"],
        })

        self.assertTrue(result["testMode"])
        self.assertTrue(save_result["notSaved"])
        self.assertTrue(mark_result["notSaved"])
        self.assertFalse(server.PRIORITY_COHORT_FILE.exists())
        self.assertFalse(server.ASSIGNMENT_RESERVATIONS_FILE.exists())
        self.assertFalse(server.ASSIGNMENT_EVENTS_FILE.exists())


if __name__ == "__main__":
    unittest.main()
