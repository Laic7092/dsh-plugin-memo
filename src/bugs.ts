/**
 * bugs.json — "this bit us before, here is what it was".
 *
 * The match key is the *symptom*, whitespace-collapsed and case-folded, so the
 * same failure seen twice bumps `occurrences` instead of filing a duplicate.
 * That is the whole point of the file: the second time should be cheaper than
 * the first.
 *
 * @module dsh-plugin-memo/bugs
 */
import { FORMAT_VERSION, collapse, isFile, readJson, stamp, writeJsonAtomic } from "./store.ts";

export function normalizeSymptom(text) {
  return collapse(text).toLowerCase();
}

function tokenize(text) {
  return normalizeSymptom(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

function bugArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.bugs)) return value.bugs;
  return null;
}

export function loadBugs(paths) {
  if (!isFile(paths.bugs)) {
    return { ok: false, present: false, bugs: [], error: `${paths.bugs} does not exist yet` };
  }
  const file = readJson(paths.bugs, null);
  if (!file.ok) return { ok: false, present: true, bugs: [], error: file.error };
  const raw = bugArray(file.value);
  if (raw === null) {
    return { ok: false, present: true, bugs: [], error: "bugs.json is neither a bare array nor { version, bugs: [...] }" };
  }
  return { ok: true, present: true, bugs: raw.filter((bug) => bug && typeof bug === "object"), error: null };
}

function nextId(bugs) {
  let max = 0;
  for (const bug of bugs) {
    const match = /^bug-(\d+)$/.exec(String(bug.id ?? ""));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `bug-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Record a fix. A repeat of an already-recorded symptom bumps its occurrence
 * count and refreshes the fields the caller supplied.
 */
export function appendBug(paths, entry, at = stamp()) {
  const loaded = loadBugs(paths);
  if (!loaded.ok && loaded.present) return { ok: false, error: loaded.error };
  const bugs = loaded.ok ? loaded.bugs : [];

  const symptom = normalizeSymptom(entry.errorMessage);
  if (symptom.length === 0) return { ok: false, error: "error_message is required" };

  const existing = bugs.find((bug) => normalizeSymptom(bug.error_message) === symptom);
  if (existing) {
    existing.occurrences = (Number.isFinite(existing.occurrences) ? existing.occurrences : 1) + 1;
    existing.last_seen = at;
    if (entry.rootCause) existing.root_cause = collapse(entry.rootCause);
    if (entry.fix) existing.fix = collapse(entry.fix);
    if (entry.file) existing.file = collapse(entry.file);
    if (Number.isFinite(entry.line)) existing.line = entry.line;
    if (Array.isArray(entry.tags) && entry.tags.length > 0) {
      existing.tags = [...new Set([...(existing.tags ?? []), ...entry.tags.map(collapse).filter(Boolean)])];
    }
    const write = writeJsonAtomic(paths.bugs, { version: FORMAT_VERSION, bugs });
    if (!write.ok) return { ok: false, error: write.error };
    return { ok: true, id: existing.id, updated: true, occurrences: existing.occurrences, total: bugs.length, error: null };
  }

  const bug = {
    id: nextId(bugs),
    error_message: collapse(entry.errorMessage),
    root_cause: collapse(entry.rootCause ?? ""),
    fix: collapse(entry.fix ?? ""),
    file: entry.file ? collapse(entry.file) : null,
    line: Number.isFinite(entry.line) ? entry.line : null,
    tags: Array.isArray(entry.tags) ? entry.tags.map(collapse).filter(Boolean) : [],
    occurrences: 1,
    first_seen: at,
    last_seen: at,
  };
  bugs.push(bug);
  const write = writeJsonAtomic(paths.bugs, { version: FORMAT_VERSION, bugs });
  if (!write.ok) return { ok: false, error: write.error };
  return { ok: true, id: bug.id, updated: false, occurrences: 1, total: bugs.length, error: null };
}

/** Rank recorded fixes against a symptom, error text or area. */
export function searchBugs(bugs, term, limit = 5) {
  const needle = normalizeSymptom(term);
  if (needle.length === 0) return [];
  const words = tokenize(term);
  const scored = [];
  for (const bug of bugs) {
    const symptom = normalizeSymptom(bug.error_message);
    const haystack = normalizeSymptom(
      [bug.error_message, bug.root_cause, bug.fix, (bug.tags ?? []).join(" "), bug.file].join(" "),
    );
    let score = 0;
    if (symptom.includes(needle)) score += 20;
    if (haystack.includes(needle)) score += 8;
    for (const word of words) if (haystack.includes(word)) score += 3;
    if (score === 0) continue;
    scored.push({ bug, score: score + Math.min(Number(bug.occurrences) || 1, 5) });
  }
  scored.sort((a, b) =>
    b.score - a.score || String(b.bug.last_seen ?? "").localeCompare(String(a.bug.last_seen ?? "")));
  return scored.slice(0, limit).map((entry) => entry.bug);
}

export function recentBugs(bugs, limit = 3) {
  return [...bugs]
    .sort((a, b) => String(b.last_seen ?? "").localeCompare(String(a.last_seen ?? "")))
    .slice(0, limit);
}
