import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendBug } from "../src/bugs.ts";
import { closeDb, indexDbPath, openIndexDb } from "../src/db.ts";
import { appendNote } from "../src/journal.ts";
import { panelScan, panelState } from "../src/panel.ts";
import { patchStatus, writeStatus } from "../src/status.ts";
import { createMemoDir, isFile, memoPaths, stamp } from "../src/store.ts";
import { countTokens, loadTokenizer } from "../src/tokenizer.ts";

/** A real directory with one source file and deliberately no `.memo/`. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "memo-panel-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export function alpha() {}\n", "utf8");
  return root;
}

/** The command catalogue as a flat list of names — what the card renders in rows. */
const switchNames = (config) => config.subcommands.flatMap((group) => group.commands.map((entry) => entry.name));

/** The per-file token count as it landed in the project's index database. */
async function indexedTokens(root) {
  const opened = await openIndexDb(memoPaths(root, ".memo"));
  assert.equal(opened.ok, true, "the fixture must have an index database");
  try {
    return Number(opened.db.prepare("SELECT tokens FROM files WHERE path = ?").get("src/a.ts").tokens);
  } finally {
    closeDb(opened.db);
  }
}

/** Everything in `config` except the grouped command catalogue. */
const readSwitches = (config) => ({ ...config, subcommands: undefined });

/** Bring that project to the state the tools leave it in. */
function seed(root) {
  const paths = createMemoDir(memoPaths(root, ".memo"));
  const written = writeStatus(paths, patchStatus("", "demo", {
    现在在哪: "在写设置面板",
    下一步: "重启 profile",
    未决问题: undefined,
    不要重犯: "别用 ctx.get 取 webServer",
  }, stamp()));
  assert.equal(written.ok, true, "fixture STATUS.md must be written");
  appendNote(paths, { at: stamp(), session: null, kind: "decision", text: "面板走宿主自己的 HTTP 路由" });
  appendBug(paths, { errorMessage: "boom", rootCause: "why", fix: "how", tags: ["panel"] });
  return paths;
}

test("panelState reports an initialized project", async () => {
  const root = project();
  try {
    seed(root);
    const built = await panelScan(root, {}, null);
    assert.equal(built.ok, true);

    const state = await panelState(root, {}, null);
    assert.equal(state.ok, true);
    assert.equal(state.root, root);
    assert.equal(state.dir, ".memo");
    assert.equal(state.initialized, true);
    // The switches travel with the state, because the panel renders them from
    // this one response. A missing `config` took the whole view down once.
    assert.deepEqual(readSwitches(state.config), { readGuard: false, refresh: false, tokenizer: "estimated", exclude: [], readTools: [], subcommands: undefined }, "config is present and echoes what the host was handed");
    // A state object that never heard of per-command switches reports every
    // command on, which is what the host actually did with it.
    assert.deepEqual(state.config.subcommands.map((group) => group.id), ["memory", "index", "bugs"]);
    assert.deepEqual(switchNames(state.config), [
      "status",
      "handoff",
      "note",
      "scan",
      "find",
      "map",
      "bug-search",
      "bug-log",
    ]);
    assert.ok(state.config.subcommands.every((group) => group.commands.every((entry) => entry.on === true)));

    assert.equal(state.status.present, true);
    assert.deepEqual(state.status.sections.map((section) => section.title), ["现在在哪", "下一步", "未决问题", "不要重犯"]);
    assert.equal(state.status.sections[0].body, "在写设置面板");
    assert.equal(state.status.sections[2].body, null, "a section that was never written is null, not invented");
    assert.match(state.status.updated, /^\d{4}-/);

    assert.equal(state.journal.present, true);
    assert.equal(state.journal.total, 1);
    assert.equal(state.journal.notes[0].kind, "decision");
    assert.match(state.journal.notes[0].text, /HTTP/);

    assert.equal(state.bugs.present, true);
    assert.equal(state.bugs.total, 1);
    assert.equal(state.bugs.recent[0].id, "bug-001");
    assert.equal(state.bugs.recent[0].errorMessage, "boom");
    assert.equal(state.bugs.recent[0].fix, "how");

    assert.equal(state.index.present, true);
    assert.equal(state.index.readable, true);
    assert.equal(state.index.fileCount, 1);
    assert.equal(state.index.symbolCount, 1);
    assert.equal(state.index.staleChanged, 0);
    assert.equal(state.index.staleMissing, 0);
    assert.ok(state.index.bytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the panel reports the switches it was handed, not its own defaults", async () => {
  const root = project();
  try {
    seed(root);
    const state = await panelState(root, { readGuard: true, refresh: true, exclude: ["addons"], readTools: ["read", "view"], subcommands: { scan: false } }, null);
    assert.deepEqual(readSwitches(state.config), { readGuard: true, refresh: true, tokenizer: "estimated", exclude: ["addons"], readTools: ["read", "view"], subcommands: undefined });
    // The host's live values, not a copy that could drift from them.
    assert.notEqual(state.config.exclude, undefined);
    // One command switched off, and only that one: the panel is reporting
    // state, not re-deriving "everything is on by default".
    assert.deepEqual(state.config.subcommands.find((group) => group.id === "index").commands, [
      { name: "scan", on: false },
      { name: "find", on: true },
      { name: "map", on: true },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("panelState neither invents memory nor creates it", async () => {  const root = project();
  try {
    const state = await panelState(root, {}, null);
    assert.equal(state.ok, true);
    assert.equal(state.root, root);
    assert.equal(state.initialized, false);
    assert.equal(state.status.present, false);
    assert.deepEqual(state.status.sections, []);
    assert.equal(state.journal.total, 0);
    assert.equal(state.bugs.total, 0);
    assert.deepEqual(state.index, { present: false });
    // Reading a project's panel must not be what brings its memory into being.
    assert.equal(existsSync(join(root, ".memo")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("panelState refuses a root it cannot interpret", async () => {
  const relative = await panelState("some/relative/path", {}, null);
  assert.equal(relative.ok, false);
  assert.match(relative.error, /absolute/);

  const scanned = await panelScan("some/relative/path", {}, null);
  assert.equal(scanned.ok, false);
  assert.match(scanned.error, /absolute/);
});

test("panelScan counts exactly when the panel asks for it", async () => {
  const root = project();
  try {
    seed(root);
    const built = await panelScan(root, { tokenizer: "exact" }, null);
    assert.equal(built.ok, true);
    assert.equal(built.index.tokens, "exact");
    // The count in the index is the tokenizer's, not the 4-chars estimate the
    // host would have used by default — this is the whole wiring under test.
    const source = readFileSync(join(root, "src", "a.ts"), "utf8");
    const counted = loadTokenizer().encode(source).length;
    assert.notEqual(counted, Math.ceil(source.length / 4), "the fixture must tell the two counters apart");
    assert.equal(await indexedTokens(root), counted);
    // And the panel's own config echo carries the switch, so the card can state it.
    const state = await panelState(root, { tokenizer: "exact" }, null);
    assert.equal(state.config.tokenizer, "exact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the panel revalidates in the counter it is told to, and says which one it has", async () => {
  const root = project();
  try {
    seed(root);
    const source = readFileSync(join(root, "src", "a.ts"), "utf8");
    const exact = countTokens(source);
    const estimate = Math.ceil(source.length / 4);
    assert.notEqual(exact, estimate, "the fixture must tell the two counters apart");

    // Built the default way, and the panel reports the guess as a guess.
    await panelScan(root, {}, null);
    assert.equal(await indexedTokens(root), estimate);
    const guessed = await panelState(root, {}, null);
    assert.equal(guessed.index.tokens, "estimated");
    assert.equal(guessed.index.totalTokens, estimate);

    // Asked to revalidate exactly, the panel does not merely re-read: nothing
    // moved on disk, so this has to rebuild because the unit changed.
    const switched = await panelState(root, { refresh: true, tokenizer: "exact" }, null);
    assert.equal(switched.index.tokens, "exact");
    assert.equal(switched.index.totalTokens, exact, "the number on screen is the new count");
    assert.equal(await indexedTokens(root), exact, "and it was written back, not just reported");

    // Back the other way needs no special case: the stamp decides.
    const back = await panelState(root, { refresh: true, tokenizer: "estimated" }, null);
    assert.equal(back.index.tokens, "estimated");
    assert.equal(back.index.totalTokens, estimate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("panelScan refuses a directory that has no .memo/ yet", async () => {
  const root = project();
  try {
    const refused = await panelScan(root, {}, null);
    assert.equal(refused.ok, false);
    assert.equal(refused.root, root);
    assert.match(refused.error, /run memo scan once in this project first/);
    // The refusal is the point: a settings page must not be able to initialize
    // a project's memory in a directory it was merely pointed at.
    assert.equal(existsSync(join(root, ".memo")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("panelScan writes an index, and refresh picks up a file nobody announced", async () => {
  const root = project();
  try {
    const paths = seed(root);
    const built = await panelScan(root, {}, null);
    assert.equal(built.ok, true);
    assert.equal(built.index.fileCount, 1);
    assert.equal(typeof built.durationMs, "number");
    assert.equal(isFile(indexDbPath(paths)), true);

    writeFileSync(join(root, "src", "b.ts"), "export function beta() {}\n", "utf8");

    // Without refresh the panel shows exactly what the last scan wrote...
    const stale = await panelState(root, {}, null);
    assert.equal(stale.index.fileCount, 1);

    // ...and with it, the panel revalidates the way `memo find` does.
    const fresh = await panelState(root, { refresh: true }, null);
    assert.equal(fresh.index.fileCount, 2);
    assert.equal(fresh.index.staleChanged, 0);
    assert.equal(fresh.index.staleMissing, 0);

    // The refresh is durable: the on-disk index moved with it.
    const reread = await panelState(root, {}, null);
    assert.equal(reread.index.fileCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
