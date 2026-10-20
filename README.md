# News Annotation Prototype

Lightweight single-page prototype for a Prolific-style annotation task.

## Included

- Article reader with inline text selection
- `Comment span` annotations with one highlight color
- `Flag issue` annotations with a second color and 1-5 severity slider
- Saved annotation cards and a JSON payload ready to post to a backend

## Run

For VM deployment with local annotation storage:

```powershell
python server.py
```

Then open `http://localhost:3000`.

There is also a Node version available:

```powershell
node server.js
```

The app writes autosaved annotation snapshots to:

- `saved_annotations/events/annotation-events.jsonl` for the append-only save event log
- `saved_annotations/runs/<participant-or-session-id>/<run-id>/snapshot.json` for the latest recoverable draft
- `saved_annotations/runs/<participant-or-session-id>/<run-id>/final.json` for completed submissions
- `saved_annotations/only-annotations.jsonl` for one flat JSON line per finalized annotation

Opening [index.html](C:\Users\edaha\platform\index.html) directly still works for viewing/testing, but server-side autosave only works when the app is served by `server.js`.

## Notes

- The browser keeps the live working state, and `server.js` saves each annotation snapshot locally on the VM.
- Annotation spans are saved as text offsets against the full article body.
- For production use, you would usually replace the sample article with server-provided content and submit the JSON to your API or Prolific completion step.

## Repeat-annotation assignment

The assignment API now builds its pool only from articles that already have saved
annotations. It counts unique participant IDs per article and:

- never shows a participant an article they previously annotated;
- keeps a stable priority cohort in `saved_annotations/assignments/priority-cohort.json`;
- prioritizes bringing up to 100 articles to three unique annotators each;
- moves on to the remaining previously annotated articles after that cohort reaches the target;
- stops offering an article once it has three unique annotators.

The history is reconstructed from `final.json`, `snapshot.json`, and `annotated`
assignment events, so existing saved work seeds the new assignment pool. Participant
IDs must remain unique and consistent for self-exclusion to work correctly.
