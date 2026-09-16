import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildIndex, refreshIndex } from "../src/indexer.ts";
import { callersOf, sitesFor } from "../src/calls.ts";
import { closeDb, openIndexDb, readIndex, readIndexSummary, syncIndex, writeIndex } from "../src/db.ts";
import { createMemoDir, memoPaths } from "../src/store.ts";

/**
 * Call sites: what a file calls, and who a call belongs to.
 *
 * The two halves are tested apart on purpose, because they fail differently. A
 * recording bug shows up as a call that was never written down -- which looks
 * exactly like a function nobody calls -- and an attribution bug shows up as a
 * plausible caller list with the wrong file in it. The first half is asserted
 * against line numbers and receivers, the second against the reason each call
 * was attributed.
 */

/** Write a throwaway project from a path -> content map. */
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "memo-calls-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }
  return root;
}

/** The call sites recorded for one file, as the index holds them. */
async function callsOf(root: string, rel: string) {
  const index = await buildIndex(root, { analyzer: null });
  return { index, calls: index.files[rel]?.calls ?? [] };
}

test("a call is read out of the code, not out of the prose", async () => {
  const root = project({
    "a.gd": [
      "extends Node",
      "",
      "# retry() in a comment is not a call",
      'const NOTE := "press start() to begin"',
      '"""',
      "docs: documented()",
      '"""',
      "",
      "func _ready() -> void:",
      "\tvar player: Player = Player.new()",
      "\tplayer.take_damage(3)",
      "\t_save(player)",
      "",
    ].join("\n"),
  });
  try {
    const { calls } = await callsOf(root, "a.gd");
    assert.deepEqual(
      calls.map((call) => [call.name, call.receiver, call.receiverType, call.line, call.caller]),
      [
        // Foo.new() is Godot's constructor: the thing being used is Foo.
        ["Player", null, null, 10, "_ready"],
        // The receiver's type is declared two lines up, in the same file.
        ["take_damage", "player", "Player", 11, "_ready"],
        ["_save", null, null, 12, "_ready"],
      ],
      "a comment, a string and a docstring are not calls, and a declaration is not one either",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every caller is attributed for a stated reason", async () => {
  const root = project({
    "game/player.gd": [
      "class_name Player",
      "extends Node",
      "",
      "func take_damage(amount: int) -> void:",
      "\t_apply(amount)",
      "",
      "func kill() -> void:",
      "\ttake_damage(999)",
      "",
      "func _apply(amount: int) -> void:",
      "\tpass",
      "",
    ].join("\n"),
    "game/enemy.gd": [
      "extends Node",
      "",
      "func hit(target: Player) -> void:",
      "\ttarget.take_damage(3)",
      "\t_apply()",
      "",
      "func poke(player) -> void:",
      "\tplayer.take_damage(1)",
      "",
    ].join("\n"),
    "game/spawner.gd": [
      "extends Node",
      "",
      "func spawn() -> void:",
      "\tvar player: Player = Player.new()",
      "\tplayer.take_damage(1)",
      "",
    ].join("\n"),
    // One name, three declarations, no type and no import to choose between
    // them: the case that must be counted rather than guessed.
    "game/a.gd": "func reset() -> void:\n\tpass\n",
    "game/b.gd": "func reset() -> void:\n\tpass\n",
    "game/c.gd": "func go() -> void:\n\treset()\n",
    "game/d.gd": "func reset() -> void:\n\tpass\n\nfunc again() -> void:\n\treset()\n",
  });
  try {
    const index = await buildIndex(root, { analyzer: null });
    const report = (name: string, file: string) => callersOf(sitesFor(index, name), index, { name, file }, { limit: 20 });

    const damage = report("take_damage", "game/player.gd");
    assert.deepEqual(
      damage.callers.map((caller) => [caller.relPath, caller.line, caller.caller, caller.via]),
      [
        // Equal importance, so path order; the reasons are what is asserted.
        // A parameter's annotation gives the receiver its type, on the line
        // right above the call.
        ["game/enemy.gd", 4, "hit", "type"],
        // The same method on an untyped receiver: with one declaration in the
        // whole project, the name alone settles it.
        ["game/enemy.gd", 8, "poke", "only"],
        // The file's own call, on itself: lexical scope, not a guess.
        ["game/player.gd", 8, "kill", "self"],
        // The receiver's declared type names the file that owns the method.
        ["game/spawner.gd", 5, "spawn", "type"],
      ],
    );
    assert.deepEqual(damage.viaCounts, { self: 1, only: 1, type: 2 });
    assert.equal(damage.elsewhere, 0);
    assert.equal(damage.ambiguous, 0);

    const reset = report("reset", "game/a.gd");
    assert.deepEqual(reset.callers, [], "nobody calls this one, and that is the answer");
    assert.equal(reset.elsewhere, 1, "the call inside d.gd belongs to d.gd's own declaration");
    assert.equal(reset.ambiguous, 1, "c.gd's call has three candidates and nothing to choose with");
    assert.deepEqual(reset.candidates, ["game/a.gd", "game/b.gd", "game/d.gd"]);
    assert.equal(reset.total, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an import is the clue when the name alone is not", async () => {
  const root = project({
    "src/a.ts": 'import { helper } from "./x/helper";\nexport function run() { return helper(); }\n',
    "src/x/helper.ts": "export function helper() { return 1 }\n",
    "src/y/helper.ts": "export function helper() { return 2 }\n",
  });
  try {
    const index = await buildIndex(root, { analyzer: null });
    const report = callersOf(sitesFor(index, "helper"), index, { name: "helper", file: "src/x/helper.ts" }, { limit: 20 });
    assert.deepEqual(
      report.callers.map((caller) => [caller.relPath, caller.line, caller.caller, caller.via]),
      [["src/a.ts", 2, "run", "import"]],
    );
    assert.equal(report.ambiguous, 0, "the import settles a name two files both declare");

    // The same call asked about the other file that declares the name: it is
    // not a caller of that one, and the answer has to say so rather than list it.
    const other = callersOf(sitesFor(index, "helper"), index, { name: "helper", file: "src/y/helper.ts" }, { limit: 20 });
    assert.deepEqual(other.callers, []);
    assert.equal(other.elsewhere, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the database keeps the calls, and drops the ones nothing answers for", async () => {
  const root = project({
    "src/a.ts": 'export function alpha() { return beta(); }\nexport function beta() { console.log("x") }\n',
  });
  const paths = createMemoDir(memoPaths(root, ".memo"));
  const index = await buildIndex(root, { analyzer: null });
  const opened = await openIndexDb(paths, { create: true });
  assert.equal(opened.ok, true);
  try {
    writeIndex(opened.db, index);
    const back = readIndex(opened.db);
    assert.deepEqual(
      back.files["src/a.ts"].calls.map((call) => [call.name, call.line, call.caller]),
      [["beta", 1, "alpha"]],
      "beta is declared here; log is not declared anywhere and is not an edge",
    );
    assert.equal(readIndexSummary(opened.db).callCount, 1);

    // Rename the only declaration and the stored edge has to go with it: this
    // is the refresh path, where only the changed file is written.
    writeFileSync(join(root, "src/a.ts"), "export function alpha() { return beta(); }\nexport function gamma() { return 1 }\n");
    const fresh = await refreshIndex(readIndex(opened.db), { analyzer: null });
    syncIndex(opened.db, fresh.index, { added: fresh.added, updated: fresh.updated, removed: fresh.removed });
    assert.equal(readIndexSummary(opened.db).callCount, 0, "a name no declaration answers for is not an edge any more");
  } finally {
    closeDb(opened.db);
    rmSync(root, { recursive: true, force: true });
  }
});
