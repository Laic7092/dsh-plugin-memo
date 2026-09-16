import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildIndex, buildMap, collectCalls, estimateTokens, fileDetail, findInIndex, INDEX_VERSION, indexMeta, refreshIndex, staleFiles, TS_MIN_TOKENS } from "../src/indexer.ts";
import { createTsAnalyzer } from "../src/ts-symbols.ts";

const AUTH = [
  "/**",
  " * Token validation for the auth service.",
  " */",
  "export function validateToken(raw: string): boolean {",
  '  return raw.split(".").length === 3;',
  "}",
  "",
  "export class Session {",
  "  refresh() {}",
  "}",
  "",
].join("\n");

const SERVER = [
  "// HTTP entry point.",
  'import { validateToken } from "./auth";',
  "",
  "export function start(port: number) {",
  '  if (!validateToken("x")) return;',
  "  return port;",
  "}",
  "",
].join("\n");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "memo-index-"));
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(base, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(base, "src", "auth.ts"), AUTH, "utf8");
  writeFileSync(join(base, "src", "server.ts"), SERVER, "utf8");
  writeFileSync(join(base, "README.md"), "# not indexed\n", "utf8");
  writeFileSync(join(base, "node_modules", "junk", "index.js"), "export const junk = 1\n", "utf8");
  return base;
}

test("buildIndex indexes source files and skips everything else", async () => {
  const base = fixture();
  try {
    const index = await buildIndex(base);
    assert.deepEqual(Object.keys(index.files).sort(), ["src/auth.ts", "src/server.ts"]);
    assert.equal(index.version, INDEX_VERSION);
    assert.equal(index.fileCount, 2);

    const auth = index.files["src/auth.ts"];
    assert.equal(auth.language, "js");
    assert.equal(auth.description, "Token validation for the auth service.");
    assert.deepEqual(
      auth.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.line, symbol.endLine]),
      [["validateToken", "function", 4, 6], ["Session", "class", 8, 10], ["Session.refresh", "method", 9, 9]],
    );
    assert.equal(auth.tokens, estimateTokens(AUTH));

    const server = index.files["src/server.ts"];
    assert.equal(server.description, "HTTP entry point.");
    assert.deepEqual(server.symbols.map((symbol) => symbol.name), ["start"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("importance follows the import graph", async () => {
  const base = fixture();
  try {
    const index = await buildIndex(base);
    const auth = index.files["src/auth.ts"].importance;
    const server = index.files["src/server.ts"].importance;
    assert.ok(auth > 0, "an imported file carries rank");
    assert.ok(auth >= server, "the imported file outranks its importer");
    // The scale is "the average file is 1", not "the top file is 1": scaling by
    // the maximum flattened a real project to a single value -- every file at
    // exactly 1.0, so the bonus this feeds ranked nothing.
    assert.ok(auth > 1, "the imported file is above the mean");
    assert.ok(server < 1, "a file nothing imports is below it");
    assert.equal(indexMeta(index).symbolCount, 4);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a comment goes, and the import next to it stays", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-comment-"));
  try {
    // Every one of these has bitten: a comment stripper that neutralizes string
    // literals on its way to the comments deletes the specifier it is looking
    // for, and one that works a line at a time leaves a block comment standing.
    writeFileSync(join(base, "a.ts"), [
      '// import { gone } from "./ghost";',
      'import { kept } from "./b";',
      'const url = "https://example.com/x"; // not a comment, and not an import',
      "/* a block comment",
      '   import { alsoGone } from "./ghost2"; */',
      "export function a() { return url; }",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(base, "b.ts"), "export function kept() {}\n", "utf8");
    const index = await buildIndex(base);
    assert.deepEqual(index.files["a.ts"].imports, ["./b"], "the live specifier survives, and only it");
    assert.ok(index.files["b.ts"].importance > index.files["a.ts"].importance, "the edge is real enough to rank");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a project's own .gitignore keeps generated trees out of the index", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-gitignore-"));
  try {
    mkdirSync(join(base, "lib"), { recursive: true });
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, "anchored"), { recursive: true });
    writeFileSync(join(base, ".gitignore"), ["node_modules/", "lib/", "*.min.js", "!keep.min.js", "# a comment", "/anchored/"].join("\n") + "\n", "utf8");
    writeFileSync(join(base, "lib", "built.js"), "export function built() {}\n", "utf8");
    writeFileSync(join(base, "src", "app.js"), "export function app() {}\n", "utf8");
    writeFileSync(join(base, "vendor.min.js"), "export function min() {}\n", "utf8");
    writeFileSync(join(base, "anchored", "deep.js"), "export function deep() {}\n", "utf8");
    const index = await buildIndex(base);
    assert.deepEqual(Object.keys(index.files).sort(), ["anchored/deep.js", "src/app.js"], "a plain name and a suffix pattern are honoured; an anchored or negated one is left alone rather than guessed at");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("a JSON file is indexed for its keys, and still searchable as a body", async () => {
  // Game data lives in these files and nowhere else: the item ids, the prices,
  // the schedules. Indexing them as code would be a lie; not indexing them at
  // all left `find` unable to answer about the files a data change touches.
  const root = mkdtempSync(join(tmpdir(), "memo-json-"));
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      join(root, "data", "items.json"),
      [
        "{",
        '  "turnip": { "price": 60, "growth_days": 4 },',
        '  "potato": { "price": 80, "growth_days": 6 }',
        "}",
        "",
      ].join(String.fromCharCode(10)),
      "utf8",
    );
    const index = await buildIndex(root, { analyzer: null });
    const entry = index.files["data/items.json"];
    assert.equal(entry.language, "json");
    assert.deepEqual(entry.symbols.map((symbol) => [symbol.name, symbol.line]), [
      ["turnip", 2],
      ["price", 2],
      ["growth_days", 2],
      ["potato", 3],
      ["price", 3],
      ["growth_days", 3],
    ]);
    assert.deepEqual(entry.calls, [], "a data file calls nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findInIndex ranks an exact symbol above a path hit and respects the budget", async () => {
  const base = fixture();
  try {
    const index = await buildIndex(base);

    const exact = findInIndex(index, "validateToken", { budgetTokens: 1000 });
    assert.equal(exact.matches.length, 1);
    assert.equal(exact.matches[0].kind, "function");
    assert.equal(exact.matches[0].line, "src/auth.ts:4-6");
    assert.equal(exact.matches[0].symbol.name, "validateToken");

    // A substring of the symbol name still finds the file, ranked by quality.
    assert.equal(findInIndex(index, "Token", {}).matches[0].relPath, "src/auth.ts");

    // A path fragment matches with a file-level hit and no symbol.
    const byPath = findInIndex(index, "server", {});
    assert.equal(byPath.matches[0].relPath, "src/server.ts");
    assert.equal(byPath.matches[0].symbol, null);

    // A budget smaller than the first hit still returns that one hit.
    const tiny = findInIndex(index, "e", { budgetTokens: 1 });
    assert.equal(tiny.matches.length, 1);

    assert.deepEqual(findInIndex(index, "nothing-matches-this", {}).matches, []);
    assert.deepEqual(findInIndex(index, "   ", {}).matches, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fileDetail resolves an exact path and a bare filename", async () => {
  const base = fixture();
  try {
    const index = await buildIndex(base);
    assert.equal(fileDetail(index, "src/auth.ts").relPath, "src/auth.ts");
    assert.equal(fileDetail(index, "auth.ts").relPath, "src/auth.ts");
    assert.equal(fileDetail(index, "./src/server.ts").relPath, "src/server.ts");
    assert.equal(fileDetail(index, "nope.ts"), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("buildMap rolls up directories, or ranks files against a focus", async () => {
  const base = fixture();
  try {
    const index = await buildIndex(base);

    const rollup = buildMap(index, "", { budgetTokens: 1200 });
    assert.equal(rollup.mode, "rollup");
    assert.deepEqual(rollup.dirs.map((bucket) => bucket.dir), ["src"]);

    const focused = buildMap(index, "token", { budgetTokens: 1200 });
    assert.equal(focused.mode, "focused");
    assert.equal(focused.files[0].relPath, "src/auth.ts");

    assert.deepEqual(buildMap(index, "完全无关", {}).files, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("staleFiles reports changed and vanished files without throwing", async () => {
  const base = fixture();
  try {
    const index = await buildIndex(base);
    assert.equal(staleFiles(index).changedCount, 0);

    const later = new Date(Date.now() + 5000);
    utimesSync(join(base, "src", "auth.ts"), later, later);
    const stale = staleFiles(index);
    assert.equal(stale.changedCount, 1);
    assert.equal(stale.changed[0], "src/auth.ts");

    rmSync(join(base, "src", "server.ts"));
    assert.equal(staleFiles(index).missingCount, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("refreshIndex re-parses only what moved", async () => {
  const base = fixture();
  try {
    const first = await buildIndex(base);
    const auth = first.files["src/auth.ts"];

    // Nothing moved: the sweep is a no-op and every entry is reused.
    const idle = await refreshIndex(first);
    assert.equal(idle.changed, 0);
    assert.equal(idle.reused, 2);
    assert.deepEqual(idle.added, []);
    assert.equal(idle.index.files["src/auth.ts"].symbols.length, auth.symbols.length);
    // Reused entries are copied, so the caller's index is never mutated.
    assert.notEqual(idle.index.files["src/auth.ts"], auth);

    // An edit is picked up, and the file that did not move is not re-read.
    const later = new Date(Date.now() + 5000);
    writeFileSync(join(base, "src", "auth.ts"), `${AUTH}\nexport function extra() {}\n`, "utf8");
    utimesSync(join(base, "src", "auth.ts"), later, later);
    const edited = await refreshIndex(first);
    assert.equal(edited.changed, 1);
    assert.deepEqual(edited.updated, ["src/auth.ts"]);
    assert.equal(edited.reused, 1, "the untouched file was not re-parsed");
    assert.ok(edited.index.files["src/auth.ts"].symbols.some((symbol) => symbol.name === "extra"));

    // A new file is seen without anyone announcing it — the case a write hook
    // driven only by this process's own edits would miss.
    writeFileSync(join(base, "src", "fresh.ts"), "export function brandNew() {}\n", "utf8");
    const grown = await refreshIndex(edited.index);
    assert.deepEqual(grown.added, ["src/fresh.ts"]);
    assert.equal(grown.changed, 1);
    assert.equal(grown.index.fileCount, 3);

    // A deleted file leaves the index.
    rmSync(join(base, "src", "server.ts"));
    const shrunk = await refreshIndex(grown.index);
    assert.deepEqual(shrunk.removed, ["src/server.ts"]);
    assert.equal(shrunk.index.fileCount, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("refreshIndex re-ranks a changed import graph, and rebuilds an old format", async () => {
  const base = fixture();
  try {
    const first = await buildIndex(base);
    assert.ok(first.files["src/auth.ts"].importance >= first.files["src/server.ts"].importance);

    // Drop the only import: ranking must follow, even though one file changed.
    const later = new Date(Date.now() + 5000);
    writeFileSync(join(base, "src", "server.ts"), "export function start(p: number) { return p; }\n", "utf8");
    utimesSync(join(base, "src", "server.ts"), later, later);
    const after = await refreshIndex(first);
    assert.deepEqual(after.updated, ["src/server.ts"]);
    assert.equal(after.index.files["src/auth.ts"].importance, 1, "no edges left: rank flattens");
    assert.equal(after.index.files["src/server.ts"].importance, 1);

    // An index from an older format is rebuilt rather than patched field by field.
    const rebuilt = await refreshIndex({ ...first, version: 1 });
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(rebuilt.index.version, INDEX_VERSION);
    assert.deepEqual(Object.keys(rebuilt.index.files).sort(), ["src/auth.ts", "src/server.ts"]);

    // So is one built by a different extractor: reused entries would otherwise
    // keep symbols the current pass would never produce.
    const switched = await refreshIndex({ ...first, analyzerAvailable: true });
    assert.equal(switched.rebuilt, true);
    assert.equal(switched.index.analyzerAvailable, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const WIDGET = [
  "export class Widget {",
  "  constructor(name) {",
  "    this.name = name;",
  "  }",
  "  render() {",
  "    return this.name;",
  "  }",
  "  async update(next) {",
  "    return next;",
  "  }",
  "  static make() {",
  "    return new Widget('x');",
  "  }",
  "  handle = (e) => e;",
  "}",
  "export function outside() {}",
  "",
].join("\n");

/** Enough filler to push a file over the tree-sitter threshold. */
const FILLER = Array.from({ length: 140 }, (_, i) => `export function filler${i}(a, b) { return a + b + ${i}; }`).join("\n");

test("the line-based pass still finds class members", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-class-"));
  try {
    writeFileSync(join(base, "widget.js"), WIDGET, "utf8");
    const index = await buildIndex(base);
    const file = index.files["widget.js"];
    assert.equal(file.symbolSource, "regex");
    assert.deepEqual(
      file.symbols.map((symbol) => [symbol.name, symbol.kind]),
      [
        ["Widget", "class"],
        ["Widget.constructor", "method"],
        ["Widget.render", "method"],
        ["Widget.update", "method"],
        ["Widget.make", "method"],
        ["Widget.handle", "method"],
        ["outside", "function"],
      ],
    );
    const render = file.symbols.find((symbol) => symbol.name === "Widget.render");
    assert.deepEqual([render.line, render.endLine], [5, 7], "a method's range is its own body, not the class's");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("tree-sitter replaces the guesses where a grammar exists", async (t) => {
  const analyzer = await createTsAnalyzer();
  if (analyzer === null) {
    t.skip("web-tree-sitter or tree-sitter-wasm is not installed");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "memo-ts-"));
  try {
    writeFileSync(join(base, "widget.js"), `${WIDGET}\n${FILLER}\n`, "utf8");
    writeFileSync(join(base, "tiny.js"), WIDGET, "utf8");
    const index = await buildIndex(base, { analyzer });

    const big = index.files["widget.js"];
    assert.equal(big.symbolSource, "ts");
    assert.ok(big.tokens >= TS_MIN_TOKENS);
    const names = big.symbols.map((symbol) => symbol.name);
    for (const expected of ["Widget", "Widget.constructor", "Widget.render", "Widget.update", "Widget.make", "Widget.handle"]) {
      assert.ok(names.includes(expected), `tree-sitter must find ${expected}`);
    }
    // A module-level constant *is* a declaration — it is what other files
    // import — so the grammar keeps it, and only the function's insides are
    // left out. The rule used to be "a declarator is a symbol only when its
    // value is a function", which silently dropped every other export.
    const source = `${WIDGET}\nexport const MAX_WIDGETS = 32;\n${FILLER}\n`;
    writeFileSync(join(base, "widget.js"), source, "utf8");
    const again = await buildIndex(base, { analyzer });
    const constants = again.files["widget.js"].symbols.filter((symbol) => symbol.kind === "const");
    assert.deepEqual(constants.map((symbol) => symbol.name), ["MAX_WIDGETS"]);
    assert.deepEqual(constants.map((symbol) => symbol.line), [source.split("\n").findIndex((line) => line.includes("MAX_WIDGETS")) + 1]);
    // Nothing from inside a body: locals are not declarations this index owes
    // anyone, and `FILLER` holds plenty of them.
    assert.equal(again.files["widget.js"].symbols.some((symbol) => symbol.name === "Widget.render"), true);
    assert.equal(again.files["widget.js"].symbols.some((symbol) => symbol.line > source.split("\n").length), false);

    // Below the threshold the file keeps its line-based symbols.
    assert.equal(index.files["tiny.js"].symbolSource, "regex");
    assert.equal(index.symbolSource.startsWith("ts"), true);

    // Refreshing with the same analyzer keeps the upgrade rather than quietly
    // falling back to the line-based pass for untouched files.
    const refreshed = await refreshIndex(again, { analyzer });
    assert.equal(refreshed.rebuilt, false);
    assert.equal(refreshed.changed, 0);
    assert.equal(refreshed.index.analyzerAvailable, true);
    assert.equal(refreshed.index.files["widget.js"].symbolSource, "ts");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a refresh rebuilds when the analyzer's grammars change", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-grammars-"));
  try {
    writeFileSync(join(base, "a.js"), "export function a() {}\n", "utf8");
    // A stub ceiling: the parsers are not what this test is about, the stamp is.
    const smaller = { grammars: ["javascript"], analyze: async () => null };
    const larger = { grammars: ["javascript", "gdscript"], analyze: async () => null };

    const first = await buildIndex(base, { analyzer: smaller });
    assert.equal(first.analyzerGrammars, "javascript");

    // Entries built by a smaller ceiling cannot be reused by a larger one: they
    // would keep symbols the new grammar would never have produced.
    const upgraded = await refreshIndex(first, { analyzer: larger });
    assert.equal(upgraded.rebuilt, true);
    assert.equal(upgraded.index.analyzerGrammars, "gdscript,javascript");

    // The same ceiling twice is not a reason to re-parse anything.
    const steady = await refreshIndex(upgraded.index, { analyzer: larger });
    assert.equal(steady.rebuilt, false);
    assert.equal(steady.changed, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an index from before the grammar stamp rebuilds itself once", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-legacy-"));
  try {
    writeFileSync(join(base, "a.js"), "export function a() {}\n", "utf8");
    const analyzer = { grammars: ["javascript"], analyze: async () => null };
    const first = await buildIndex(base, { analyzer });
    const legacy = { ...first };
    delete legacy.analyzerGrammars; // what an older build of this plugin wrote

    const refreshed = await refreshIndex(legacy, { analyzer });
    assert.equal(refreshed.rebuilt, true, "an index with no stamp cannot vouch for its entries");
    assert.equal(refreshed.index.analyzerGrammars, "javascript");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("a call is reported on the line it is written on, comments or not", () => {
  const source = [
    "/**",
    " * A block comment of the kind every module here opens with.",
    " * It spans several lines, and nothing in it is code.",
    " */",
    "export function run() {",
    "  const s = new Set();",
    "  s.add(1);",
    "}",
    "",
    "// A whole-line comment, one line long.",
    "run();",
  ].join(String.fromCharCode(10));
  const rows = collectCalls(source.split(String.fromCharCode(10)), "js", [
    { name: "run", kind: "function", line: 5, endLine: 8 },
  ]);
  const lineOf = (name: string) => rows.find((call) => call.name === name)?.line;
  // Before the comment pass kept its newlines these were 3, 4 and 6: every call
  // below a block comment slid up by the height of the comment, and the answer
  // to "who calls this" pointed at a line that is prose.
  assert.equal(lineOf("Set"), 6, "the constructor is on line 6");
  assert.equal(lineOf("add"), 7);
  assert.equal(lineOf("run"), 11, "a call after a one-line comment is exact too");
  assert.equal(rows.find((call) => call.name === "run")?.caller, null, "a top-level call has no enclosing function");
});
