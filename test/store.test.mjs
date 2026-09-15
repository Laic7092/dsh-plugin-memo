import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendBug, loadBugs, normalizeSymptom, searchBugs } from "../lib/bugs.js";
import { appendNote, readNotes } from "../lib/journal.js";
import { patchStatus, parseStatus, readStatus, STATUS_SECTIONS } from "../lib/status.js";
import { findProjectRoot, INDEX_MAX_BYTES, memoPaths, readJson, resolveInside } from "../lib/store.js";

/** A project with the memory directory already created, as the host tools leave it. */
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "memo-store-"));
  const paths = memoPaths(base);
  mkdirSync(paths.dir, { recursive: true });
  return { base, paths };
}

test("findProjectRoot prefers the memory directory, then the git root", () => {
  const base = mkdtempSync(join(tmpdir(), "memo-root-"));
  try {
    const nested = join(base, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    // Nothing to find: the caller's own directory is the answer.
    assert.deepEqual(findProjectRoot(nested), { root: nested, found: false, via: "directory" });

    // A repository root is where a first write would land.
    mkdirSync(join(base, ".git"));
    assert.deepEqual(findProjectRoot(nested), { root: base, found: false, via: "git" });

    // An existing memory directory wins over the git root.
    mkdirSync(join(base, "packages", ".memo"));
    assert.deepEqual(findProjectRoot(nested), { root: join(base, "packages"), found: true, via: "memory" });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("patchStatus replaces only the sections it is given", () => {
  const mine = patchStatus("", "/p/demo", { 现在在哪: "在改登录", 下一步: "- 补测试" }, "2026-01-01T00:00:00.000Z");
  for (const title of STATUS_SECTIONS) assert.match(mine, new RegExp(`## ${title}`));
  assert.match(mine, /在改登录/);
  assert.match(mine, /_最后更新：2026-01-01T00:00:00.000Z_/);

  // A hand-written section and the sections not passed survive untouched.
  const typed = mine.replace("## 未决问题", "## 未决问题\n\n- 先问用户\n\n## 我手写的\n\n保留我");
  const next = patchStatus(typed, "/p/demo", { 现在在哪: "在改注册", 未决问题: "" }, "2026-01-02T00:00:00.000Z");
  assert.match(next, /在改注册/);
  assert.doesNotMatch(next, /在改登录/);
  assert.match(next, /先问用户/, "an empty body must not blank the section");
  assert.match(next, /我手写的[\s\S]*保留我/);
  assert.match(next, /_最后更新：2026-01-02T00:00:00.000Z_/);
  assert.equal((next.match(/_最后更新：/g) || []).length, 1, "the stamp is replaced, never duplicated");
});

test("readStatus reports absence without inventing content", () => {
  const { paths } = scratch();
  assert.equal(readStatus(paths).present, false);
  const parsed = parseStatus("# T\n\nintro\n\n## A\n\nbody\n");
  assert.match(parsed.preamble, /intro/);
  assert.deepEqual(
    parsed.sections.map((section) => ({ title: section.title, body: section.body.join("\n").trim() })),
    [{ title: "A", body: "body" }],
  );
});

test("appendBug keys on the symptom and bumps repeats", () => {
  const { paths } = scratch();
  assert.equal(loadBugs(paths).ok, false);

  const first = appendBug(paths, { errorMessage: "EADDRINUSE: address already in use", rootCause: "stale dev server", fix: "kill it first", tags: ["port"] }, "2026-01-01T00:00:00.000Z");
  assert.deepEqual({ ok: first.ok, id: first.id, updated: first.updated }, { ok: true, id: "bug-001", updated: false });

  const repeat = appendBug(paths, { errorMessage: "  eaddrinuse:   ADDRESS already in use " }, "2026-01-02T00:00:00.000Z");
  assert.equal(repeat.id, "bug-001");
  assert.equal(repeat.updated, true);
  assert.equal(repeat.occurrences, 2);

  const second = appendBug(paths, { errorMessage: "TypeError: x is not a function" });
  assert.equal(second.id, "bug-002");
  assert.equal(second.total, 2);

  const stored = JSON.parse(readFileSync(paths.bugs, "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.bugs[0].root_cause, "stale dev server", "a repeat without a cause keeps the recorded one");
  assert.equal(stored.bugs[0].last_seen, "2026-01-02T00:00:00.000Z");
  assert.equal(normalizeSymptom(" A  B "), "a b");
});

test("appendBug refuses a malformed log instead of overwriting it", () => {
  const { paths } = scratch();
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.bugs, "{ not json", "utf8");
  const result = appendBug(paths, { errorMessage: "x" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
  assert.equal(readFileSync(paths.bugs, "utf8"), "{ not json");
});

test("searchBugs ranks a symptom hit above an incidental word", () => {
  const { paths } = scratch();
  appendBug(paths, { errorMessage: "port already in use", rootCause: "stale server", fix: "kill" });
  appendBug(paths, { errorMessage: "canvas resize loop", rootCause: "observer", fix: "guard", tags: ["render"] });
  const bugs = loadBugs(paths).bugs;

  const hits = searchBugs(bugs, "port already in use", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "bug-001");

  assert.deepEqual(searchBugs(bugs, "nothing like this"), []);
  assert.equal(searchBugs(bugs, "render").length, 1);
  assert.equal(searchBugs(bugs, "").length, 0);
});

test("the journal is append-only and survives a torn last line", () => {
  const { paths } = scratch();
  mkdirSync(paths.dir, { recursive: true });
  appendNote(paths, { at: "2026-01-01T00:00:00.000Z", text: "first", kind: "note" });
  appendNote(paths, { at: "2026-01-02T00:00:00.000Z", text: "second", kind: "decision" });
  writeFileSync(paths.journal, `${readFileSync(paths.journal, "utf8")}{"at":"torn"`, "utf8");

  const read = readNotes(paths, 5);
  assert.equal(read.ok, true);
  assert.equal(read.total, 2, "the torn line is skipped, not fatal");
  assert.equal(read.notes[0].text, "second", "newest first");
  assert.equal(readNotes(paths, 1).notes.length, 1);
});

test("resolveInside refuses to escape the memory directory", () => {
  const { paths } = scratch();
  assert.equal(resolveInside(paths.dir, "STATUS.md"), join(paths.dir, "STATUS.md"));
  assert.equal(resolveInside(paths.dir, "../secrets"), null);
  assert.equal(resolveInside(paths.dir, "/etc/passwd"), null);
});

test("readJson only stops early when the caller asks for a small cap", () => {
  const { paths } = scratch();
  const big = { version: 999, files: {}, note: "x".repeat(600_000) };
  writeFileSync(paths.index, JSON.stringify(big), "utf8");

  // The default cap suits one source file, and a read that stopped early says
  // so instead of pretending the file was not JSON.
  const capped = readJson(paths.index, null);
  assert.equal(capped.ok, false);
  assert.equal(capped.present, true);
  assert.match(capped.error, /read cap/);

  // The index is read under its own, larger cap, and arrives whole.
  const whole = readJson(paths.index, null, INDEX_MAX_BYTES);
  assert.equal(whole.ok, true);
  assert.equal(whole.value.note.length, 600_000);
});
