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

- `saved_annotations/annotation-events.jsonl` for the append-only event log
- `saved_annotations/latest/<participant-or-session-id>.json` for the latest recoverable snapshot

Opening [index.html](C:\Users\edaha\platform\index.html) directly still works for viewing/testing, but server-side autosave only works when the app is served by `server.js`.

## Notes

- The browser keeps the live working state, and `server.js` saves each annotation snapshot locally on the VM.
- Annotation spans are saved as text offsets against the full article body.
- For production use, you would usually replace the sample article with server-provided content and submit the JSON to your API or Prolific completion step.
