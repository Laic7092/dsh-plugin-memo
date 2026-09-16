/**
 * dsh-plugin-memo — the on-disk format.
 *
 * One directory inside the project holds everything, and it is committed with
 * the code: project memory belongs to the repository, not to the machine that
 * happened to write it. Three files, all plain text:
 *
 *   STATUS.md      human- and model-readable: where we are, what is next
 *   journal.jsonl  append-only action log, one JSON object per line
 *   bugs.json      symptom -> cause -> fix, with an occurrence count
 *
 * Nothing here parses code, spawns a process, or depends on another program:
 * this plugin owns the format outright.
 *
 * @module dsh-plugin-memo/store
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const DEFAULT_DIR = ".memo";
/**
 * The index database name inside the memory directory. What goes in it -- and
 * why it is a database at all -- is the subject of \`./db.ts\`.
 */
export const DB_FILE = "index.db";
export const FORMAT_VERSION = 1;
export const DEFAULT_MAX_BYTES = 400_000;
/**
 * Where this call's project is.
 *
 * The nearest ancestor already holding the memory directory wins. Failing
 * that, the nearest ancestor holding `.git` is where a write would create it —
 * so a first `memo handoff` anywhere inside a repository lands at its root
 * rather than in whatever subdirectory the session happened to start in.
 */
export function findProjectRoot(start, dirName = DEFAULT_DIR) {
  const from = resolve(String(start));
  let gitRoot = null;
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, dirName))) return { root: dir, found: true, via: "memory" };
    if (gitRoot === null && existsSync(join(dir, ".git"))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (gitRoot !== null) return { root: gitRoot, found: false, via: "git" };
  return { root: from, found: false, via: "directory" };
}

export function memoPaths(root, dirName = DEFAULT_DIR) {
  const dir = join(root, dirName);
  return {
    dir,
    status: join(dir, "STATUS.md"),
    journal: join(dir, "journal.jsonl"),
    bugs: join(dir, "bugs.json"),
    // The index moved to a local SQLite database. The old path stays because
    // the migration message and the "your old one can go" hint still name it.
    index: join(dir, "index.json"),
    db: join(dir, DB_FILE),
  };
}

/** `statSync` as data: null when the file is not there or not readable. */
export function statOrNull(file) {
  try {
    const stat = statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
  } catch {
    return null;
  }
}

/** Create the memory directory if it is not there yet; idempotent. */
export function createMemoDir(paths) {
  mkdirSync(paths.dir, { recursive: true });
  return paths;
}

export function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Collapse whitespace, so " EADDRINUSE:  address " and "eaddrinuse: address" compare equal. */
export function collapse(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function stamp(ms = Date.now()) {
  return new Date(ms).toISOString();
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function readText(file, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    const raw = readFileSync(file);
    const truncated = raw.length > maxBytes;
    return {
      ok: true,
      text: raw.subarray(0, maxBytes).toString("utf8"),
      bytes: raw.length,
      truncated,
      error: null,
    };
  } catch (error) {
    return { ok: false, text: "", bytes: 0, truncated: false, error: readable(error) };
  }
}

/** tmp + rename: a reader never sees a half-written file. */
export function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: readable(error) };
  }
}

export function appendLine(file, line) {
  try {
    appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`, "utf8");
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: readable(error) };
  }
}

/**
 * maxBytes belongs to the caller: a truncated read is not JSON, so the cap
 * that suits one source file must not decide a larger file's fate.
 */
export function readJson(file, fallback = null, maxBytes = DEFAULT_MAX_BYTES) {
  const text = readText(file, maxBytes);
  if (!text.ok) return { ok: false, value: fallback, present: false, error: text.error };
  if (text.truncated) {
    const capped = file + " exceeds the " + maxBytes + " byte read cap, so only its head was read";
    return { ok: false, value: fallback, present: true, error: capped };
  }
  try {
    return { ok: true, value: JSON.parse(text.text), present: true, error: null };
  } catch (error) {
    return { ok: false, value: fallback, present: true, error: `${file} is not valid JSON: ${readable(error)}` };
  }
}

export function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Keep a relative path inside `dir`; null when it escapes. */
export function resolveInside(dir, relative) {
  const base = resolve(dir);
  const target = resolve(base, String(relative ?? ""));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

function readable(error) {
  return error && error.message ? error.message : String(error);
}
