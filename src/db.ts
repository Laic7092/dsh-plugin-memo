/**
 * dsh-plugin-memo — where the index actually lives.
 *
 * The index is derived data. Everything in it can be rebuilt from the source
 * tree in about a second, and nothing in it was ever meant to be read by a
 * person — yet it lived in a committed `.memo/index.json` as 44,000 lines and
 * ~950 KB of machine JSON, while the two projects that actually ran this plugin
 * gitignored the whole directory. A cache does not belong in a repository, so
 * the index moved here: one local SQLite database, `<project>/.memo/index.db`,
 * beside the memory files — which stay plain text and stay committable.
 *
 * What moving it buys, beyond not pretending a cache is an artifact:
 *
 *  - rows instead of whole-file rewrites, so a refresh writes what changed and
 *    nothing else — no 8 MB ceiling, no re-serializing 12,000 symbols to record
 *    one edited file;
 *  - FTS5 over file bodies, so "which file mentions this string" is answerable
 *    at all. The JSON format could never carry the sources; a local database
 *    carries them for the price of the disk they already occupy;
 *  - a real query surface — recursive CTEs for transitive impact, aggregates
 *    for fan-in — instead of loading a megabyte and walking it in JavaScript.
 *
 * `node:sqlite` is a runtime capability, not a dependency: it is imported
 * dynamically and probed exactly like tree-sitter, and its absence costs the
 * index commands while leaving `status`, `handoff`, `note` and `bug-*`
 * working, because those were always plain text.
 *
 * @module dsh-plugin-memo/db
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INDEX_VERSION } from "./indexer.ts";
import { isFile } from "./store.ts";
import type { IndexEntry, MemoIndex } from "./types.ts";

/** The index database, and the two sidecar files WAL mode adds to it. */
export const DB_FILE = "index.db";
export const DB_FILES = [DB_FILE, DB_FILE + "-wal", DB_FILE + "-shm"];

/**
 * Written into a project's memory directory by the first scan.
 *
 * Committing the index was the old default and the wrong one: it is derived,
 * it is large, and a diff of it tells nobody anything. The memory files are the
 * opposite on all three counts, which is why the note says so — a directory
 * that ignores *everything* would throw away the part worth keeping.
 */
const GITIGNORE_LINES = [
  "# 索引是本地派生缓存，不进版本库；记忆文件（STATUS.md / journal.jsonl / bugs.json）仍应提交。",
  ...DB_FILES,
  "index.json",
];

export function indexDbPath(paths) {
  return join(paths.dir, DB_FILE);
}

/**
 * The runtime's SQLite, or null when this Node does not have one.
 *
 * Loaded once per process and never rejects: `node:sqlite` reached Node 22.5,
 * and a plugin that runs on an older runtime must lose the index commands
 * rather than fail to load.
 */
let sqlitePromise = null;
export function loadSqlite() {
  if (sqlitePromise === null) {
    sqlitePromise = import("node:sqlite")
      .then((mod) => {
        const ctor = mod && (mod.DatabaseSync ?? (mod.default ? mod.default.DatabaseSync : undefined));
        return typeof ctor === "function" ? ctor : null;
      })
      .catch(() => null);
  }
  return sqlitePromise;
}

/** Why the index commands cannot run here, worded for a model and for a person. */
export const NO_SQLITE = "这个运行时没有 node:sqlite（索引需要 Node ≥ 22.5）。记忆命令 status / handoff / note / bug-search / bug-log 不受影响。";

/** Keep the memory directory's own .gitignore in step with what we write. */
function ensureGitignore(paths) {
  const file = join(paths.dir, ".gitignore");
  try {
    const existing = isFile(file) ? readFileSync(file, "utf8") : null;
    const lines = existing === null ? [] : existing.split("\n");
    const missing = GITIGNORE_LINES.filter((line) => !lines.includes(line));
    if (existing === null) appendFileSync(file, GITIGNORE_LINES.join("\n") + "\n");
    else if (missing.length > 0) appendFileSync(file, (existing.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n");
  } catch {
    // A .gitignore we cannot write is not a reason to refuse to index.
  }
}

function pragmas(db) {
  // WAL so the panel can read while a scan writes; the timeout so a busy
  // database waits instead of throwing at whoever asked first.
  for (const statement of [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA busy_timeout = 3000",
    "PRAGMA foreign_keys = ON",
  ]) {
    try {
      db.exec(statement);
    } catch {
      // Older runtimes may not know one of these; none of them is load-bearing.
    }
  }
}

function schema(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, bytes INTEGER, lines INTEGER, tokens INTEGER, mtime_ms REAL, language TEXT, description TEXT, sym_source TEXT, importance REAL, class_name TEXT)",
    "CREATE TABLE IF NOT EXISTS symbols (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT, line INTEGER, end_line INTEGER)",
    "CREATE TABLE IF NOT EXISTS imports (file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, spec TEXT NOT NULL, target INTEGER)",
    // Full text over what a file *is*, not only what it declares: the body is
    // what answers "where is this string", and it is the one thing the JSON
    // index could never afford to carry.
    "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, description, body)",
    "CREATE INDEX IF NOT EXISTS i_symbols_name ON symbols(name)",
    "CREATE INDEX IF NOT EXISTS i_symbols_file ON symbols(file_id)",
    "CREATE INDEX IF NOT EXISTS i_imports_file ON imports(file_id)",
    "CREATE INDEX IF NOT EXISTS i_imports_target ON imports(target)",
  ].join(";\n"));
  db.exec("PRAGMA user_version = " + INDEX_VERSION);
}

/**
 * Open this project's index database.
 *
 * @param paths - from `memoPaths`.
 * @param options.create - create (and initialize) a missing database; without
 *   it, a missing file is reported rather than created, because building an
 *   index is a write and writes stay explicit.
 * @returns `{ ok, db, error }`; `error` is already worded for the caller.
 */
export async function openIndexDb(paths, options: { create?: boolean; log?: (message: string) => void } = {}) {
  const DatabaseSync = await loadSqlite();
  if (DatabaseSync === null) return { ok: false, db: null, error: NO_SQLITE };
  const file = indexDbPath(paths);
  const wanted = options.create === true;
  if (!existsSync(file) && !wanted) {
    const legacy = isFile(paths.index)
      ? "（旧的 index.json 已经不再读取，可以删掉；如果它被提交过，用 git rm --cached .memo/index.json 取消跟踪）"
      : "";
    return { ok: false, db: null, error: file + " 还不存在——先跑 memo scan" + legacy };
  }
  let db;
  try {
    db = new DatabaseSync(file);
  } catch (error) {
    return { ok: false, db: null, error: "打不开 " + file + "：" + (error && error.message ? error.message : String(error)) };
  }
  pragmas(db);
  if (wanted) {
    ensureGitignore(paths);
    schema(db);
    return { ok: true, db, error: null };
  }
  let version = null;
  try {
    version = Number(db.prepare("PRAGMA user_version").get().user_version);
  } catch {
    version = null;
  }
  if (version !== INDEX_VERSION) {
    closeDb(db);
    return { ok: false, db: null, error: "索引格式是 " + (version === null ? "未知" : version) + "，当前需要 " + INDEX_VERSION + "——跑一次 memo scan 重建" };
  }
  return { ok: true, db, error: null };
}

export function closeDb(db) {
  try {
    if (db && typeof db.close === "function") db.close();
  } catch {
    // Already closed, or never opened.
  }
}

function writeMeta(db, index) {
  const statement = db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)");
  const values = {
    version: String(INDEX_VERSION),
    analyzerAvailable: index.analyzerAvailable === true ? "1" : "0",
    analyzerGrammars: index.analyzerGrammars ?? "",
    scannedAt: index.scannedAt ?? new Date().toISOString(),
    root: index.root ?? "",
    tokens: index.tokens ?? "estimated",
    excludes: JSON.stringify(Array.isArray(index.excludes) ? index.excludes : []),
    symbolSource: index.symbolSource ?? "regex",
  };
  for (const [key, value] of Object.entries(values)) statement.run(key, value);
}

/** The body of one indexed file, for the full-text table. */
function readBody(root, rel) {
  try {
    const file = join(root, rel);
    const stat = statSync(file);
    if (stat.size > 1024 * 1024) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function insertEntry(db, root, rel, entry, statements, bodies) {
  const id = Number(statements.file.run(
    rel,
    Number(entry.bytes ?? 0),
    Number(entry.lines ?? 0),
    Number(entry.tokens ?? 0),
    Number(entry.mtimeMs ?? 0),
    entry.language ?? null,
    entry.description ?? null,
    entry.symbolSource ?? "regex",
    Number(entry.importance ?? 0),
    entry.className ?? null,
  ).lastInsertRowid);
  let symbols = 0;
  for (const symbol of entry.symbols ?? []) {
    statements.symbol.run(id, String(symbol.name), symbol.kind ?? null, Number(symbol.line ?? 0), Number(symbol.endLine ?? 0));
    symbols += 1;
  }
  for (const spec of entry.imports ?? []) statements.import.run(id, String(spec));
  // Unchanged files keep the body row they already have: a refresh must not
  // re-read a megabyte of sources to record that one file moved.
  statements.doc.run(rel, entry.description ?? "", bodies ? readBody(root, rel) : "");
  return symbols;
}

function statementsFor(db) {
  return {
    file: db.prepare("INSERT INTO files(path, bytes, lines, tokens, mtime_ms, language, description, sym_source, importance, class_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    symbol: db.prepare("INSERT INTO symbols(file_id, name, kind, line, end_line) VALUES (?, ?, ?, ?, ?)"),
    import: db.prepare("INSERT INTO imports(file_id, spec, target) VALUES (?, ?, NULL)"),
    doc: db.prepare("INSERT INTO docs(path, description, body) VALUES (?, ?, ?)"),
    dropFile: db.prepare("DELETE FROM files WHERE path = ?"),
    dropDoc: db.prepare("DELETE FROM docs WHERE path = ?"),
  };
}

/**
 * Write a whole index: the full-scan path.
 *
 * Replaces every row in one transaction — a scan is already a full sweep, and a
 * half-written index is worse than an old one.
 *
 * @returns `{ files, symbols }` as written.
 */
export function writeIndex(db, index, options: { bodies?: boolean } = {}) {
  const bodies = options.bodies !== false;
  const statements = statementsFor(db);
  let symbols = 0;
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM symbols; DELETE FROM imports; DELETE FROM docs; DELETE FROM files; DELETE FROM meta");
    for (const [rel, entry] of Object.entries(index.files ?? {})) {
      symbols += insertEntry(db, index.root, rel, entry, statements, bodies);
    }
    writeMeta(db, index);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nothing left to roll back.
    }
    throw error;
  }
  const files = Object.keys(index.files ?? {}).length;
  return { files, symbols };
}

/**
 * Write only what a refresh found: the incremental path.
 *
 * The three lists come from `refreshIndex`, which is the only thing that knows
 * what actually moved. Reused files are not touched at all — not their rows and
 * not their bodies — so a refresh costs what it found, not what the project
 * weighs.
 */
export function syncIndex(db, index, diff: { added?: string[]; updated?: string[]; removed?: string[] }, options: { bodies?: boolean } = {}) {
  const bodies = options.bodies !== false;
  const statements = statementsFor(db);
  const added = Array.isArray(diff.added) ? diff.added : [];
  const updated = Array.isArray(diff.updated) ? diff.updated : [];
  const removed = Array.isArray(diff.removed) ? diff.removed : [];
  let symbols = 0;
  db.exec("BEGIN");
  try {
    for (const rel of removed) {
      statements.dropFile.run(rel);
      statements.dropDoc.run(rel);
    }
    for (const rel of [...added, ...updated]) {
      const entry = index.files[rel];
      if (entry === undefined) continue;
      statements.dropFile.run(rel);
      statements.dropDoc.run(rel);
      symbols += insertEntry(db, index.root, rel, entry, statements, bodies);
    }
    writeMeta(db, index);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nothing left to roll back.
    }
    throw error;
  }
  return { added: added.length, updated: updated.length, removed: removed.length, symbols };
}

function metaOf(db): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of db.prepare("SELECT k, v FROM meta").all()) out[row.k] = row.v;
  return out;
}

function excludesOf(meta) {
  try {
    const parsed = JSON.parse(meta.excludes ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The index as the rest of the plugin already thinks about it.
 *
 * Rebuilding the in-memory shape keeps every existing reader — the ranker, the
 * budgeted search, the tree-sitter refresh — working unchanged against the new
 * medium. The summary below is the cheaper door for callers that only need
 * counts; this one is for callers that need the index itself.
 */
export function readIndex(db): MemoIndex | null {
  let rows;
  try {
    rows = db.prepare("SELECT id, path, bytes, lines, tokens, mtime_ms, language, description, sym_source, importance, class_name FROM files ORDER BY path").all();
  } catch {
    return null;
  }
  const meta = metaOf(db);
  const files: Record<string, IndexEntry> = {};
  const byId = new Map<number, IndexEntry>();
  for (const row of rows) {
    const entry = {
      bytes: Number(row.bytes ?? 0),
      lines: Number(row.lines ?? 0),
      tokens: Number(row.tokens ?? 0),
      mtimeMs: Number(row.mtime_ms ?? 0),
      language: row.language ?? null,
      description: row.description ?? null,
      symbols: [],
      symbolSource: row.sym_source ?? "regex",
      importance: Number(row.importance ?? 0),
      imports: [],
      className: row.class_name ?? null,
    };
    files[row.path] = entry;
    byId.set(Number(row.id), entry);
  }
  for (const row of db.prepare("SELECT file_id, name, kind, line, end_line FROM symbols ORDER BY file_id, line, name").all()) {
    const entry = byId.get(Number(row.file_id));
    if (entry === undefined) continue;
    entry.symbols.push({ name: row.name, kind: row.kind ?? "symbol", line: Number(row.line ?? 0), endLine: Number(row.end_line ?? 0) });
  }
  for (const row of db.prepare("SELECT file_id, spec FROM imports").all()) {
    const entry = byId.get(Number(row.file_id));
    if (entry !== undefined) entry.imports.push(row.spec);
  }
  const fileCount = Object.keys(files).length;
  return {
    version: Number(meta.version ?? INDEX_VERSION),
    analyzerAvailable: meta.analyzerAvailable === "1",
    analyzerGrammars: meta.analyzerGrammars ? meta.analyzerGrammars : null,
    scannedAt: meta.scannedAt ?? "",
    root: meta.root ?? "",
    tokens: meta.tokens ?? "estimated",
    excludes: excludesOf(meta),
    fileCount,
    totalTokens: Object.values(files).reduce((sum, entry) => sum + entry.tokens, 0),
    symbolSource: meta.symbolSource ?? "regex",
    files,
  };
}

/**
 * The counts, without reconstructing anything: what MEMO status and the panel
 * need, and what `readIndex` should not be asked for when a number is all that
 * is wanted.
 */
export function readIndexSummary(db) {
  const meta = metaOf(db);
  const files = Number(db.prepare("SELECT count(*) AS n FROM files").get().n ?? 0);
  const symbols = Number(db.prepare("SELECT count(*) AS n FROM symbols").get().n ?? 0);
  const totalTokens = Number(db.prepare("SELECT coalesce(sum(tokens), 0) AS n FROM files").get().n ?? 0);
  return {
    present: true,
    scannedAt: meta.scannedAt ?? null,
    root: meta.root ?? null,
    fileCount: files,
    symbolCount: symbols,
    totalTokens,
    tokens: meta.tokens ?? "estimated",
    symbolSource: meta.symbolSource ?? "regex",
    analyzerAvailable: meta.analyzerAvailable === "1",
    analyzerGrammars: meta.analyzerGrammars ? meta.analyzerGrammars : null,
    excludes: excludesOf(meta),
  };
}

/** Freshness as the panel reports it: which indexed files moved or vanished. */
export function dbStaleFiles(db, root, limit = 10) {
  const changed = [];
  const missing = [];
  for (const row of db.prepare("SELECT path, mtime_ms FROM files").all()) {
    try {
      const stat = statSync(join(root, row.path));
      if (stat.mtimeMs !== Number(row.mtime_ms)) changed.push(row.path);
    } catch {
      missing.push(row.path);
    }
  }
  return { changed: changed.slice(0, limit), missing: missing.slice(0, limit), changedCount: changed.length, missingCount: missing.length };
}

/**
 * One person's phrase as an FTS5 query: every word quoted, all of them required.
 *
 * FTS5's own syntax is not what a caller means. A hyphen is a column filter, a
 * quote opens a phrase, and AND/OR/NOT are operators -- so ZEBRA-CROSSING, an
 * ordinary thing to search for, parses as "ZEBRA but not CROSSING" and answers
 * nothing. Quoting each word keeps punctuation inside the term and still lets a
 * two-word query mean "both of these", which is what a search box owes anyone
 * who types two words into it.
 */
function ftsQuery(text) {
  return String(text)
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => '"' + word.replace(/"/g, '""') + '"')
    .join(" AND ");
}

/**
 * Files whose *text* matches a query, which is the question the symbol index
 * cannot answer. A malformed query returns an empty result rather than throwing
 * into a tool call.
 */
export function searchText(db, query, limit = 10) {
  const text = String(query ?? "").trim();
  if (text.length === 0) return [];
  try {
    return db.prepare("SELECT path, snippet(docs, 2, '', '', '…', 12) AS excerpt FROM docs WHERE docs MATCH ? LIMIT ?").all(ftsQuery(text), Math.max(1, Number(limit) || 10));
  } catch {
    return [];
  }
}

//#region the read side, answered by SQL

/**
 * The file and keyword search behind `memo find`, as one query surface.
 *
 * Everything the in-memory ranker used to do happens here instead, in SQL,
 * against files/symbols/docs. What that buys is not only speed: the caller no
 * longer reconstructs the whole index -- every file, every symbol, every import --
 * to answer a question about a handful of rows, and the panel and the CLI finally
 * ask the database the same questions the same way.
 *
 * Four independent sources, each with the score this codebase has always given
 * it, and the best answer per file wins:
 *
 *  - a symbol whose name is the query exactly (100), starts with it (70), or
 *    contains it (45);
 *  - a file whose path contains it (30);
 *  - a file whose opening description contains it (12);
 *  - a file whose *body* matches it (20) -- the one question a symbol index can
 *    never answer, and the reason the sources are kept at all.
 *
 * Importance (the import graph's PageRank, 0..1) is added as a ten-point bonus
 * in every case, so a hub file edges out a leaf when the match is as good.
 *
 * @param db - an open index database.
 * @param query - one person's phrase; see {@link ftsQuery} for what is done to it.
 * @param options.limit - how many rows each source may return (default 60).
 * @param options.textLimit - how many body matches to read back (default 6).
 * @returns the file list ordered by score, plus the body matches with their
 *   excerpts already cut.
 */
export function findInDb(db, query, options: { limit?: number; textLimit?: number } = {}) {
  const needle = String(query ?? "").trim();
  if (needle.length === 0) return { query: needle, limit: 0, files: [], text: [], total: 0 };
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 60));
  const textLimit = Math.max(0, Math.min(50, options.textLimit ?? 6));
  const pattern = likePattern(needle);
  const lower = needle.toLowerCase();
  const best = new Map();
  const keep = (row) => {
    const current = best.get(row.relPath);
    if (current === undefined || row.score > current.score) best.set(row.relPath, row);
  };

  for (const row of queryRows(db, SYMBOL_QUERY, [needle, pattern, pattern, pattern, pattern, pattern, needle, pattern, pattern, pattern, limit])) {
    // The score already came back from SQL, ladder included, so this only adds
    // the file's own standing and says which kind of match won.
    const named = Number(row.named ?? 0) === 1;
    keep({
      relPath: row.relPath,
      score: Number(row.score ?? 0) + Number(row.importance ?? 0) * 10,
      symbol: named ? row.name : null,
      kind: named ? row.kind : "file",
      line: named ? Number(row.line ?? 0) : 0,
      endLine: named ? Number(row.endLine ?? 0) : 0,
      importance: Number(row.importance ?? 0),
      description: row.description,
      source: named ? "symbol" : "path",
    });
  }
  for (const row of queryRows(db, PATH_QUERY, [pattern, pattern, pattern, limit])) {
    keep({
      relPath: row.relPath,
      score: (row.path ? 30 : 12) + Number(row.importance ?? 0) * 10,
      symbol: null,
      kind: "file",
      line: 0,
      endLine: 0,
      importance: Number(row.importance ?? 0),
      description: row.description,
      source: row.path ? "path" : "description",
    });
  }
  for (const row of queryRows(db, TEXT_QUERY, [ftsQuery(needle), limit])) {
    keep({
      relPath: row.relPath,
      score: 20 + Number(row.importance ?? 0) * 10,
      symbol: null,
      kind: "text",
      line: 0,
      endLine: 0,
      importance: Number(row.importance ?? 0),
      description: row.description,
      source: "text",
      text: true,
    });
  }

  const files = [...best.values()].sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
  const text = [];
  if (textLimit > 0) {
    // Only the files whose best answer *is* the body text: where a symbol
    // already answers the query, an excerpt of the same file says it twice.
    // Only the files whose *body* is where the query was found: a candidate
    // that matched through the full-text index but then won on a symbol or a
    // path has already answered, and an excerpt of it would be the same answer
    // twice.
    for (const file of files.filter((candidate) => candidate.text === true)) {
      if (text.length >= textLimit) break;
      const body = bodyOf(db, file.relPath);
      if (body === null) continue;
      const at = body.toLowerCase().indexOf(lower);
      if (at === -1) continue;
      text.push({ relPath: file.relPath, line: lineAt(body, at), excerpt: excerptAround(body, at) });
    }
  }
  return { query: needle, limit, files, text, total: files.length };
}

/**
 * The rows behind one source.
 *
 * A named function so the prepare-execute path is written once: `all()` returns
 * null-prototype objects, and this is what turns them into the plain objects the
 * rest of the module hands around.
 */
function queryRows(db, sql, params) {
  let rows;
  try {
    rows = db.prepare(sql).all(...params);
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows ?? []) {
    const plain = {};
    for (const [key, value] of Object.entries(row)) plain[key] = value;
    out.push(plain);
  }
  return out;
}

/**
 * One row per symbol that scored, plus one per path that scored with no symbol.
 *
 * The path is carried on the symbol row so a file whose *path* matches -- but
 * which holds no matching symbol -- still answers: the name test keeps the row,
 * and `s.name` is then whatever symbol the LIMIT happened to land on, which is
 * why the caller only reads the symbol fields when the symbol itself scored.
 */
const SYMBOL_QUERY = [
  "SELECT f.path AS relPath, f.description AS description, f.importance AS importance,",
  "       s.name AS name, s.kind AS kind, s.line AS line, s.end_line AS endLine,",
  // The score ladder lives here, beside the *kind* of match it came from, so a
  // file whose path matched is never reported as if one of its symbols had.
  // Every comparison folds case: SQLite equality does not, and a caller who
  // types rankbyimportance for rankByImportance means the same symbol.
  "       CASE",
  "         WHEN s.name = ? COLLATE NOCASE THEN 100",
  "         WHEN s.name LIKE ? ESCAPE '\\' THEN 70",
  "         WHEN s.name LIKE ? ESCAPE '\\' THEN 45",
  "         WHEN f.path LIKE ? ESCAPE '\\' THEN 30",
  "         ELSE 12",
  "       END AS score,",
  "       (s.name = ? COLLATE NOCASE OR s.name LIKE ? ESCAPE '\\') AS named,",
  "       (f.path LIKE ? ESCAPE '\\') AS path",
  "  FROM symbols s JOIN files f ON f.id = s.file_id",
  " WHERE s.name LIKE ? ESCAPE '\\' OR f.path LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\'",
  " ORDER BY score DESC, f.importance DESC, f.path, s.line",
  " LIMIT ?",
].join(String.fromCharCode(10));

/** Path and description hits: the file-level answers, with no symbol involved. */
const PATH_QUERY = [
  "SELECT path AS relPath, description, importance, (path LIKE ? ESCAPE '\\') AS path",
  "  FROM files",
  " WHERE path LIKE ? ESCAPE '\\' OR coalesce(description, '') LIKE ? ESCAPE '\\'",
  " ORDER BY path DESC, importance DESC, path",
  " LIMIT ?",
].join(String.fromCharCode(10));

/**
 * Body hits, one row per file.
 *
 * Which files match is FTS5's business -- it tokenizes, and it is fast -- but
 * the *excerpt* is not: a snippet window counts tokens, not lines, and what a
 * reader of a code index needs is the line number and the lines around it. So
 * this query only decides which files matched; where and what is read back from
 * the body.
 */
const TEXT_QUERY = [
  "SELECT d.path AS relPath, f.description AS description, f.importance AS importance",
  "  FROM docs d JOIN files f ON f.path = d.path",
  " WHERE docs MATCH ?",
  " GROUP BY d.path",
  " ORDER BY importance DESC, relPath",
  " LIMIT ?",
].join(String.fromCharCode(10));

/** A file's stored body, or null when it has none. */
function bodyOf(db, relPath) {
  let row = null;
  try {
    row = db.prepare("SELECT body FROM docs WHERE path = ?").get(relPath);
  } catch {
    return null;
  }
  const body = row === null || row === undefined ? null : row.body;
  return typeof body === "string" && body.length > 0 ? body : null;
}

/** The 1-based line an offset falls on, counted without splitting the body. */
function lineAt(body, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (body.charCodeAt(i) === 10) line += 1;
  return line;
}

/** How many lines of context an excerpt carries on either side of the match. */
const EXCERPT_MARGIN = 2;

/**
 * The lines around a match: the answer to "where is this string", in the form a
 * reader can use. Rendered as `N: text` rows rather than a raw slice, so the line
 * numbers survive after the surrounding context is cut away.
 */
function excerptAround(body, offset, margin = EXCERPT_MARGIN) {
  const lines = body.split("\n");
  let seen = 0;
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (seen + lines[i].length >= offset) {
      at = i;
      break;
    }
    seen += lines[i].length + 1;
  }
  const first = Math.max(0, at - margin);
  const last = Math.min(lines.length - 1, at + margin);
  const out = [];
  for (let i = first; i <= last; i++) out.push(String(i + 1) + ": " + lines[i].trimEnd());
  return out;
}

/**
 * A query as a LIKE pattern, with the wildcards escaped.
 *
 * SQLite's LIKE has no escape character by default, so one is declared at every
 * use site (`ESCAPE` with a backslash), and a literal backslash in the query -- a
 * Windows path, a regex fragment -- is escaped too rather than swallowing
 * whatever follows it.
 */
export function likePattern(text) {
  return "%" + String(text).replace(/[\\%_]/g, "\\$&") + "%";
}

//#endregion

/** Bytes on disk, sidecars included, for the surfaces that report a size. */
export function indexDbStat(paths) {
  let bytes = 0;
  let mtimeMs = 0;
  for (const name of DB_FILES) {
    const file = join(paths.dir, name);
    try {
      const stat = statSync(file);
      bytes += stat.size;
      if (stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
    } catch {
      // Not there, or not ours.
    }
  }
  return bytes === 0 ? null : { bytes, mtimeMs };
}

