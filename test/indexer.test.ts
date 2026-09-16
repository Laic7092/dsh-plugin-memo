import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildIndex, buildMap, estimateTokens, fileDetail, findInIndex, INDEX_VERSION, indexMeta, refreshIndex, staleFiles, TS_MIN_TOKENS } from "../src/indexer.ts";
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
    assert.ok(auth <= 1 && server >= 0);
    assert.equal(indexMeta(index).symbolCount, 4);
  } finally {
    rmSync(base, { recursive: true, force: true });
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
    // A plain constant is not a symbol: the declarator's value is not a function.
    const source = `${WIDGET}\nexport const MAX_WIDGETS = 32;\n${FILLER}\n`;
    writeFileSync(join(base, "widget.js"), source, "utf8");
    const again = await buildIndex(base, { analyzer });
    assert.equal(again.files["widget.js"].symbols.some((symbol) => symbol.name === "MAX_WIDGETS"), false);

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
