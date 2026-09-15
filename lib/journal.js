/**
 * journal.jsonl — the action log.
 *
 * Append-only, one JSON object per line, because the writer is a long-running
 * process that must never rewrite a file a reader might be holding. A torn
 * final line (a crash mid-append) is skipped rather than treated as corruption:
 * the previous lines are still perfectly good history.
 *
 * @module dsh-plugin-memo/journal
 */
import { appendLine, readText } from "./store.js";

export function appendNote(paths, note) {
  const line = JSON.stringify({
    at: note.at,
    session: note.session ?? null,
    kind: note.kind ?? "note",
    text: note.text,
  });
  return appendLine(paths.journal, line);
}

/** The newest `limit` notes, newest first. */
export function readNotes(paths, limit = 5) {
  const file = readText(paths.journal);
  if (!file.ok) return { ok: false, present: false, notes: [], total: 0, error: file.error };
  const notes = [];
  for (const line of file.text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") notes.push(parsed);
    } catch {
      // A half-written trailing line; the rest of the log is still history.
    }
  }
  return {
    ok: true,
    present: true,
    notes: notes.slice(-limit).reverse(),
    total: notes.length,
    error: null,
  };
}
