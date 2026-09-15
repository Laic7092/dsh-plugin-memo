import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendBug } from "../lib/bugs.js";
import { appendNote } from "../lib/journal.js";
import { panelScan, panelState } from "../lib/panel.js";
import { patchStatus, writeStatus } from "../lib/status.js";
import { createMemoDir, isFile, memoPaths, stamp } from "../lib/store.js";

/** A real directory with one source file and deliberately no `.memo/`. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "memo-panel-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export function alpha() {}\n", "utf8");
  return root;
}

/** The tool catalogue as a flat list of names — what the card renders in rows. */
const switchNames = (config) => config.tools.flatMap((group) => group.tools.map((entry) => entry.name));

/** Everything in `config` except the grouped tool catalogue. */
const readSwitches = (config) => ({ ...config, tools: undefined });

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
    assert.deepEqual(readSwitches(state.config), { readGuard: false, refresh: false, exclude: [], readTools: [], tools: undefined }, "config is present and echoes what the host was handed");
    // A state object that never heard of per-tool switches reports every tool
    // on, which is what the host actually did with it.
    assert.deepEqual(state.config.tools.map((group) => group.id), ["memory", "index", "bugs"]);
    assert.deepEqual(switchNames(state.config), [
      "memo_status",
      "memo_handoff",
      "memo_note",
      "memo_scan",
      "memo_find",
      "memo_map",
      "memo_bug_search",
      "memo_bug_log",
    ]);
    assert.ok(state.config.tools.every((group) => group.tools.every((entry) => entry.on === true)));

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
    const state = await panelState(root, { readGuard: true, refresh: true, exclude: ["addons"], readTools: ["read", "view"], tools: { memo_scan: false } }, null);
    assert.deepEqual(readSwitches(state.config), { readGuard: true, refresh: true, exclude: ["addons"], readTools: ["read", "view"], tools: undefined });
    // The host's live values, not a copy that could drift from them.
    assert.notEqual(state.config.exclude, undefined);
    // One tool switched off, and only that one: the panel is reporting state,
    // not re-deriving "everything is on by default".
    assert.deepEqual(state.config.tools.find((group) => group.id === "index").tools, [
      { name: "memo_scan", on: false },
      { name: "memo_find", on: true },
      { name: "memo_map", on: true },
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

test("panelScan refuses a directory that has no .memo/ yet", async () => {
  const root = project();
  try {
    const refused = await panelScan(root, {}, null);
    assert.equal(refused.ok, false);
    assert.equal(refused.root, root);
    assert.match(refused.error, /run memo_scan once in this project first/);
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
    assert.equal(isFile(paths.index), true);

    writeFileSync(join(root, "src", "b.ts"), "export function beta() {}\n", "utf8");

    // Without refresh the panel shows exactly what the last scan wrote...
    const stale = await panelState(root, {}, null);
    assert.equal(stale.index.fileCount, 1);

    // ...and with it, the panel revalidates the way memo_find does.
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
