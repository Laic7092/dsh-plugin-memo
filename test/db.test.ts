import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { closeDb, findInDb, dbStaleFiles, indexDbPath, openIndexDb, readIndex, readIndexSummary, searchText, syncIndex, writeIndex } from "../src/db.ts";
import { buildIndex, findInIndex, refreshIndex } from "../src/indexer.ts";
import { createMemoDir, memoPaths } from "../src/store.ts";

/** A project with two source files, one of them calling the other. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "memo-db-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export function alpha() { return helper(); }\n// only the body carries this: ZEBRA-CROSSING\n");
  writeFileSync(join(root, "src", "helper.ts"), "export function helper() { return 1 }\n");
  return root;
}

/** Scan once into a fresh database, the way the scan command does. */
async function scanned(paths, root) {
  const index = await buildIndex(root, { analyzer: null });
  const opened = await openIndexDb(paths, { create: true });
  assert.equal(opened.ok, true, "the database must open for writing");
  writeIndex(opened.db, index);
  return { index, db: opened.db };
}

test("an identifier search matches the identifier, not two words near each other", async () => {
  // FTS5 tokenizes on the underscore, so `migrate_save` used to be the phrase
  // `migrate save`: a regex literal reading migrate|save_version|upgrade_save
  // answered a question about the function migrate_save. The phrase finds the
  // words; the boundary check is what makes it the identifier.
  const root = mkdtempSync(join(tmpdir(), "memo-ident-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "save.gd"), "func migrate_save() -> void:" + String.fromCharCode(10) + "	pass" + String.fromCharCode(10), "utf8");
    writeFileSync(join(root, "src", "audit.py"), "PATTERNS = [r\"migrate|save_version|upgrade_save\"]\n", "utf8");
    const index = await buildIndex(root, { analyzer: null });
    // The memo directory is what the database lives in, so it has to exist first --
    // which is what createMemoDir is for, and what the plugin does before a scan.
    const paths = createMemoDir(memoPaths(root));
    const opened = await openIndexDb(paths, { create: true });
    assert.equal(opened.ok, true);
    try {
      writeIndex(opened.db, index);
      const ident = findInDb(opened.db, "migrate_save", { limit: 10, textLimit: 2 });
      assert.deepEqual(ident.files.map((file) => file.relPath), ["src/save.gd"], "the regex literal is not an answer");
      const word = findInDb(opened.db, "migrate", { limit: 10, textLimit: 2 });
      assert.equal(word.files.some((file) => file.relPath === "src/audit.py"), true, "a plain word is still a word search");
    } finally {
      closeDb(opened.db);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the index round-trips through the database", async () => {
  const root = project();
  const paths = createMemoDir(memoPaths(root, ".memo"));
  const { index, db } = await scanned(paths, root);
  try {
    const back = readIndex(db);
    assert.equal(back.fileCount, index.fileCount);
    assert.deepEqual(Object.keys(back.files).sort(), ["src/a.ts", "src/helper.ts"]);
    const was = index.files["src/a.ts"];
    const now = back.files["src/a.ts"];
    assert.deepEqual(now.symbols, was.symbols);
    assert.equal(now.mtimeMs, was.mtimeMs);
    assert.equal(now.tokens, was.tokens);
    assert.equal(now.description, was.description);
    assert.equal(now.importance, was.importance, "the ranking survives the medium");
    assert.equal(back.totalTokens, index.totalTokens);
    assert.equal(back.symbolSource, index.symbolSource);
    assert.equal(back.root, index.root);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refresh writes what moved and nothing else", async () => {
  const root = project();
  const paths = createMemoDir(memoPaths(root, ".memo"));
  const { db } = await scanned(paths, root);
  try {
    // One edit, one new file, one deletion -- the three shapes a refresh has.
    writeFileSync(join(root, "src", "a.ts"), "export function alpha() { return 2 }\nexport function added() { return 3 }\n");
    writeFileSync(join(root, "src", "c.ts"), "export function gamma() { return 3 }\n");
    rmSync(join(root, "src", "helper.ts"));

    const fresh = await refreshIndex(readIndex(db), { analyzer: null });
    assert.equal(fresh.changed, 3);
    const written = syncIndex(db, fresh.index, { added: fresh.added, updated: fresh.updated, removed: fresh.removed });
    assert.deepEqual(
      { added: written.added, updated: written.updated, removed: written.removed },
      { added: 1, updated: 1, removed: 1 },
    );

    const back = readIndex(db);
    assert.deepEqual(Object.keys(back.files).sort(), ["src/a.ts", "src/c.ts"]);
    assert.deepEqual(back.files["src/a.ts"].symbols.map((symbol) => symbol.name).sort(), ["added", "alpha"]);
    // The removed file left nothing behind -- not its rows, not its text.
    assert.deepEqual(searchText(db, "helper"), [], "the term is gone: not the deleted file, not the old text");
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});


test("text search answers what the symbol index cannot", async () => {
  const root = project();
  const paths = createMemoDir(memoPaths(root, ".memo"));
  const { index, db } = await scanned(paths, root);
  try {
    // The contrast this whole medium exists for: a marker that lives only in a
    // comment is invisible to symbol search and plain to full text.
    assert.equal(findInIndex(index, "ZEBRA-CROSSING").matches.length, 0);
    assert.deepEqual(searchText(db, "ZEBRA-CROSSING").map((row) => row.path), ["src/a.ts"]);
    assert.deepEqual(searchText(db, "ZEBRA").map((row) => row.path), ["src/a.ts"]);
    // Two words mean both of them, in any file that has them.
    assert.deepEqual(searchText(db, "function alpha").map((row) => row.path), ["src/a.ts"]);
    assert.deepEqual(searchText(db, "alpha gamma"), []);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("find answers from SQL, and says which kind of match won", async () => {
  const root = project();
  const paths = createMemoDir(memoPaths(root, ".memo"));
  const { db } = await scanned(paths, root);
  try {
    const exact = findInDb(db, "helper", { limit: 10, textLimit: 2 });
    const top = exact.files[0];
    assert.equal(top.relPath, "src/helper.ts");
    assert.equal(top.symbol, "helper");
    assert.equal(top.kind, "function");
    assert.equal(top.source, "symbol");
    assert.equal(top.endLine, 1, "the row carries the declaration's own range");

    // Case folds both ways: SQLite equality does not, and a caller who types
    // the name the other way means the same symbol.
    const folded = findInDb(db, "HELPER", { limit: 10, textLimit: 0 });
    assert.equal(folded.files[0].symbol, "helper");

    // A path hit is a file hit. It must not be dressed up as a symbol that
    // happens to live in the file.
    const byPath = findInDb(db, "helper.ts", { limit: 10, textLimit: 0 });
    const pathHit = byPath.files.find((file) => file.relPath === "src/helper.ts");
    assert.equal(pathHit.symbol, null);
    assert.equal(pathHit.kind, "file");
    assert.equal(pathHit.source, "path");

    // The question the symbol index cannot answer at all: a phrase that only
    // exists in a body. It comes back with the line it is on and the lines
    // around it, because "which file" is half an answer.
    const body = findInDb(db, "ZEBRA-CROSSING", { limit: 10, textLimit: 2 });
    assert.equal(body.files[0].relPath, "src/a.ts");
    assert.equal(body.files[0].source, "text");
    assert.equal(body.text.length, 1);
    assert.equal(body.text[0].relPath, "src/a.ts");
    assert.equal(body.text[0].excerpt.some((line) => line.startsWith("2:")), true, "the excerpt is numbered from the file, not from the match");
    assert.match(body.text[0].excerpt.join(String.fromCharCode(10)), /ZEBRA-CROSSING/);

    // A query with nothing in it is not a query, and neither is one that
    // matches nothing: both answer empty rather than throwing.
    assert.deepEqual(findInDb(db, "   ", { limit: 5 }).files, []);
    assert.deepEqual(findInDb(db, "no-such-thing-anywhere", { limit: 5 }).files, []);

    // Percent is a LIKE wildcard, and a caller searching for one means it.
    assert.deepEqual(findInDb(db, "%", { limit: 5, textLimit: 0 }).files, []);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});
test("the first scan leaves a .gitignore that says what is local", async () => {
  const root = project();
  const paths = createMemoDir(memoPaths(root, ".memo"));
  // A project that already has its own opinion must keep it.
  appendFileSync(join(paths.dir, ".gitignore"), "my-own-line\n");
  const { db } = await scanned(paths, root);
  closeDb(db);
  try {
    const lines = readFileSync(join(paths.dir, ".gitignore"), "utf8").split("\n");
    assert.equal(lines.includes("my-own-line"), true, "an existing line is not clobbered");
    assert.equal(lines.includes("index.db"), true);
    assert.equal(lines.includes("index.json"), true, "the old name is ignored too, for projects that committed it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing index is reported, and a format it cannot read is refused", async () => {
  const root = project();
  const paths = createMemoDir(memoPaths(root, ".memo"));
  try {
    const missing = await openIndexDb(paths);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /先跑 memo scan/);

    // A project that still carries the old JSON index is told where it went.
    writeFileSync(paths.index, JSON.stringify({ version: 4, files: {} }));
    const legacy = await openIndexDb(paths);
    assert.equal(legacy.ok, false);
    assert.match(legacy.error, /index.json 已经不再读取/);

    // An index written by a different format is refused rather than read.
    const built = await openIndexDb(paths, { create: true });
    closeDb(built.db);
    const wrong = new DatabaseSync(indexDbPath(paths));
    wrong.exec("PRAGMA user_version = 99");
    wrong.close();
    const refused = await openIndexDb(paths);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /索引格式是 99/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness comes from the rows", async () => {
  const root = project();
  const paths = createMemoDir(memoPaths(root, ".memo"));
  const { db } = await scanned(paths, root);
  try {
    assert.equal(readIndexSummary(db).fileCount, 2);
    const clean = dbStaleFiles(db, root, 5);
    assert.equal(clean.changedCount, 0);
    assert.equal(clean.missingCount, 0);

    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "src", "a.ts"), later, later);
    rmSync(join(root, "src", "helper.ts"));
    const stale = dbStaleFiles(db, root, 5);
    assert.deepEqual(stale.changed, ["src/a.ts"]);
    assert.deepEqual(stale.missing, ["src/helper.ts"]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});


test("CJK text is searchable, and the excerpt is the text the file has", async () => {
  // The failure this guards was measured on a real GDScript project: FTS5 tokenizes
  // with unicode61, which makes a run of Chinese ONE token -- so a two-character
  // phrase out of the middle of one matched nothing, and the answer read as "the
  // project does not mention this". The CJK runs are padded on both sides now.
  const root = mkdtempSync(join(tmpdir(), "memo-cjk-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const body = ["func _ready() -> void:", "	# 日结处理：把当天的补算记进存档", "	pass", ""].join(String.fromCharCode(10));
    writeFileSync(join(root, "src", "calendar.gd"), body, "utf8");
    writeFileSync(join(root, "src", "helper.ts"), "export function helper() { return 1 }", "utf8");
    const index = await buildIndex(root, { analyzer: null });
    const paths = createMemoDir(memoPaths(root, ".memo"));
    const opened = await openIndexDb(paths, { create: true });
    assert.equal(opened.ok, true);
    try {
      writeIndex(opened.db, index);
      const phrase = findInDb(opened.db, "日结", { limit: 10, textLimit: 3 });
      assert.deepEqual(phrase.files.map((file) => file.relPath), ["src/calendar.gd"]);
      assert.equal(phrase.text.length, 1, "the hit comes with an excerpt");
      assert.equal(phrase.text[0].line, 2, "the line is the one the file has");
      assert.equal(phrase.text[0].excerpt.some((line) => line.includes("日结处理")), true, "the excerpt is the original text");
      assert.deepEqual(searchText(opened.db, "补算").map((row) => row.path), ["src/calendar.gd"]);
      assert.deepEqual(findInDb(opened.db, "北极熊", { limit: 10, textLimit: 3 }).files, [], "a word that is absent stays absent");
      assert.deepEqual(findInDb(opened.db, "helper", { limit: 10, textLimit: 3 }).files.map((file) => file.relPath), ["src/helper.ts"], "ASCII is untouched");
    } finally {
      closeDb(opened.db);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one file can answer with more than one symbol, and nothing more unless asked", async () => {
  // The query that motivated this: a catalog file holding thirty-one SFX_* constants
  // answered with exactly one of them, so a model asking about a constant had to
  // guess ten more times for names the index already held.
  const root = mkdtempSync(join(tmpdir(), "memo-perfile-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const body = ["const SFX_DIR := 0", "const SFX_HIT := 1", "const SFX_MISS := 2", ""].join(String.fromCharCode(10));
    writeFileSync(join(root, "src", "audio.gd"), body, "utf8");
    const index = await buildIndex(root, { analyzer: null });
    const paths = createMemoDir(memoPaths(root, ".memo"));
    const opened = await openIndexDb(paths, { create: true });
    assert.equal(opened.ok, true);
    try {
      writeIndex(opened.db, index);
      const one = findInDb(opened.db, "SFX", { limit: 20, textLimit: 1 });
      assert.equal(one.files.length, 1, "one answer per file, as before");
      assert.deepEqual(one.extra, [], "and nothing extra unless it was asked for");
      const many = findInDb(opened.db, "SFX", { limit: 20, textLimit: 1, perFile: 5, allMatches: true });
      assert.deepEqual(many.extra.map((entry) => entry.symbol), ["SFX_DIR", "SFX_HIT", "SFX_MISS"]);
      const capped = findInDb(opened.db, "SFX", { limit: 20, textLimit: 1, perFile: 2, allMatches: true });
      assert.deepEqual(capped.extra.map((entry) => entry.symbol), ["SFX_DIR", "SFX_HIT"], "the cap is the count");
    } finally {
      closeDb(opened.db);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("match quality comes first, and the file's own standing only breaks a tie", async () => {
  // The ladder used to be a weighted sum with importance added at ten points a
  // unit, and importance is PageRank normalized against the mean -- 4.42 on a
  // measured project, so 44 points, more than any two rungs are apart. This is
  // that shape: the hub holds the *weakest* match, and it used to answer first.
  const root = mkdtempSync(join(tmpdir(), "memo-rank-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "leaf.ts"), "export function helper() { return 1 }\n");
    writeFileSync(join(root, "src", "pre.ts"), "export const helperThing = 2\n");
    writeFileSync(join(root, "src", "mid.ts"), "export const my_helper = 3\nexport const HUB = 4\n");
    for (const name of ["u1", "u2", "u3", "u4"]) {
      writeFileSync(join(root, "src", name + ".ts"), "import { HUB } from \"./mid\";\nexport function " + name + "() { return HUB }\n");
    }
    const index = await buildIndex(root, { analyzer: null });
    assert.ok(index.files["src/mid.ts"].importance > index.files["src/leaf.ts"].importance, "the hub has to really be the hub");
    const paths = createMemoDir(memoPaths(root, ".memo"));
    const opened = await openIndexDb(paths, { create: true });
    try {
      writeIndex(opened.db, index);
      const found = findInDb(opened.db, "helper", { limit: 10, textLimit: 0 });
      assert.deepEqual(found.files.slice(0, 3).map((file) => file.relPath), ["src/leaf.ts", "src/pre.ts", "src/mid.ts"], "the hub does not jump the ladder");
      assert.deepEqual(found.files.slice(0, 3).map((file) => file.tier), [100, 70, 45], "exact, then a prefix, then a substring");
    } finally {
      closeDb(opened.db);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the file that says the query most often answers first", async () => {
  // A body hit used to be one flat score for every matching file, ordered by the
  // file's importance -- so a hub that mentions a term once outranked the file
  // that is about it. For a Chinese query, where the body is the only source that
  // can answer at all, that made the whole answer a list of important files.
  const root = mkdtempSync(join(tmpdir(), "memo-weight-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "many.ts"), "// 日结处理：日结 hooks，日结存档\nexport const MANY = 1\n");
    writeFileSync(join(root, "src", "once.ts"), "// 日结 只提一次\nexport const ONCE = 1\n");
    for (const name of ["v1", "v2", "v3", "v4"]) {
      writeFileSync(join(root, "src", name + ".ts"), "import { ONCE } from \"./once\";\nexport function " + name + "() { return ONCE }\n");
    }
    const index = await buildIndex(root, { analyzer: null });
    assert.ok(index.files["src/once.ts"].importance > index.files["src/many.ts"].importance, "the single mention is in the hub");
    const paths = createMemoDir(memoPaths(root, ".memo"));
    const opened = await openIndexDb(paths, { create: true });
    try {
      writeIndex(opened.db, index);
      const found = findInDb(opened.db, "日结", { limit: 10, textLimit: 3 });
      assert.equal(found.files[0].relPath, "src/many.ts", "three mentions beat one, hub or no hub");
      assert.equal(found.files[0].line, 1, "the entry carries the line the query is on, not line 0");
      assert.equal(found.files[0].endLine, 1);
      assert.equal(found.files[0].excerpt.some((line) => line.includes("日结处理")), true, "and the excerpt is the text around it");
      assert.equal(found.files[1].relPath, "src/once.ts");
    } finally {
      closeDb(opened.db);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scan records what it did not index, and the database keeps it", async () => {
  const root = mkdtempSync(join(tmpdir(), "memo-cover-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n");
    writeFileSync(join(root, "README.md"), "# 说明\n");
    writeFileSync(join(root, "notes.txt"), "x\n");
    writeFileSync(join(root, "make.sh"), "#!/bin/sh\n");
    const index = await buildIndex(root, { analyzer: null });
    assert.equal(index.coverage.seen, 4, "every file the sweep looked at is counted");
    assert.equal(index.coverage.candidates, 1);
    assert.equal(index.coverage.skipped, 3);
    assert.deepEqual(index.coverage.suffixes.map((entry) => entry[0]).sort(), [".md", ".sh", ".txt"]);
    const paths = createMemoDir(memoPaths(root, ".memo"));
    const opened = await openIndexDb(paths, { create: true });
    try {
      writeIndex(opened.db, index);
      const summary = readIndexSummary(opened.db);
      assert.equal(summary.coverage.seen, 4, "the counts survive the database");
      assert.equal(summary.coverage.skipped, 3);
      assert.deepEqual(summary.coverage.suffixes.map((entry) => entry[0]).sort(), [".md", ".sh", ".txt"]);
    } finally {
      closeDb(opened.db);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
