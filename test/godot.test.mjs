import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildIndex, refreshIndex } from "../lib/indexer.js";
import { createTsAnalyzer } from "../lib/ts-symbols.js";

/**
 * Godot support: GDScript as a language, and `.tscn`/`.tres` as the resource
 * files that carry a Godot project's real dependency graph.
 *
 * The fixtures below are shaped after a real project (435 scripts, 191 resource
 * files, 100% tab indentation, `class_name` + `extends` inheritance, every
 * dependency a `res://` path). Line ranges are asserted exactly, because the
 * end of a declaration is the part most likely to be quietly wrong.
 *
 * Most of these fixtures pass no analyzer, so they exercise the line-based
 * pass — the floor. The ones at the end pass the tree-sitter analyzer instead:
 * `tree-sitter-wasms` has neither of Godot's languages, so the plugin ships
 * both (`lib/grammars/tree-sitter-gdscript.wasm`,
 * `lib/grammars/tree-sitter-godot_resource.wasm`), and those tests skip when a
 * grammar is missing rather than pretending the ceiling is what they measured.
 */

/** Write a throwaway project from a path -> content map. */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), "memo-godot-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content, "utf8");
  }
  return root;
}

/**
 * Run a body against a throwaway project and always clean up.
 *
 * `await body()` — not `return body()` — is the whole point: returning the
 * promise from inside `try` runs the `finally` before it settles, which deletes
 * the fixture while the indexer is still reading it and leaves only the first
 * walked file indexed. That makes tests pass for the wrong reason.
 */
const withRoot = async (root, body) => {
  try {
    return await body();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** One representative script: every declaration form the census turned up. */
const PLAYER = [
  "class_name Player", // 1
  "extends CharacterBody2D", // 2
  "## The player.", // 3
  "", // 4
  "signal died(reason: String)", // 5
  "", // 6
  "enum State { IDLE, RUN }", // 7
  "", // 8
  "const MAX_SPEED: float = 300.0", // 9
  "", // 10
  "@export var speed: float = 200.0", // 11
  "@onready var sprite: Sprite2D = $Sprite2D", // 12
  "static var instances: int = 0", // 13
  "var _health: int = 100", // 14
  "", // 15
  "func _ready() -> void:", // 16
  "\t_health = 100", // 17
  "\tdied.connect(_on_died)", // 18
  "", // 19
  "static func make() -> Player:", // 20
  "\treturn Player.new()", // 21
  "", // 22
  "func take_damage(amount: int) -> void:", // 23
  "\t_health -= amount", // 24
  "\tif _health <= 0:", // 25
  '\t\tdied.emit("damage")', // 26
  "", // 27
  "class Inventory:", // 28
  "\tvar items: Array = []", // 29
  "", // 30
  "\tfunc add(item) -> void:", // 31
  "\t\titems.append(item)", // 32
  "", // 33
].join("\n");

test("GDScript declarations are found, with exact ranges", async () => {
  const root = project({ "scripts/player.gd": PLAYER });
  await withRoot(root, async () => {
    const index = await buildIndex(root);
    const player = index.files["scripts/player.gd"];
    assert.equal(player.language, "gd");
    assert.equal(player.className, "Player", "class_name is the name other scripts refer to");

    assert.deepEqual(
      player.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.line, symbol.endLine]),
      [
        ["Player", "class", 1, 1],
        ["died", "signal", 5, 5],
        ["State", "enum", 7, 7],
        ["MAX_SPEED", "const", 9, 9],
        // A declaration with no bracket of its own must not swallow the next
        // line that happens to contain one.
        ["speed", "var", 11, 11],
        ["sprite", "var", 12, 12],
        ["instances", "var", 13, 13],
        ["_health", "var", 14, 14],
        ["_ready", "function", 16, 18],
        ["make", "function", 20, 21],
        ["take_damage", "function", 23, 26],
        ["Inventory", "class", 28, 32],
        ["items", "var", 29, 29],
        ["add", "function", 31, 32],
      ],
    );
  });
});

test("a GDScript declaration whose own line opens a bracket runs to its closer", async () => {
  const root = project({
    "a.gd": ["var table := {", '\t"one": 1,', '\t"two": 2,', "}", "", "func after() -> void:", "\tpass", ""].join("\n"),
  });
  await withRoot(root, async () => {
    const index = await buildIndex(root);
    assert.deepEqual(
      index.files["a.gd"].symbols.map((symbol) => [symbol.name, symbol.line, symbol.endLine]),
      [["table", 1, 4], ["after", 6, 7]],
    );
  });
});

test("Python and GDScript body ranges stop at the last real body line", async () => {
  const root = project({
    "b.py": ["def outer(a):", "    x = 1", "", "    y = 2", "", "def next_one():", "    pass", ""].join("\n"),
  });
  await withRoot(root, async () => {
    const index = await buildIndex(root);
    // The blank line before `def next_one` must not be part of the range.
    assert.deepEqual(
      index.files["b.py"].symbols.map((symbol) => [symbol.name, symbol.line, symbol.endLine]),
      [["outer", 1, 4], ["next_one", 6, 7]],
    );
  });
});

const SCENE = [
  '[gd_scene load_steps=3 format=3 uid="uid://abc"]', // 1
  "", // 2
  '[ext_resource type="Script" path="res://scripts/player.gd" id="1_abc"]', // 3
  '[ext_resource type="Texture2D" path="res://assets/icon.svg" id="2_def"]', // 4
  "", // 5
  '[sub_resource type="RectangleShape2D" id="RectangleShape2D_xyz"]', // 6
  "size = Vector2(16, 32)", // 7
  "", // 8
  '[node name="Player" type="CharacterBody2D"]', // 9
  'script = ExtResource("1_abc")', // 10
  "", // 11
  '[node name="Sprite" type="Sprite2D" parent="."]', // 12
  "", // 13
  '[node name="Hitbox" type="Area2D" parent="Player"]', // 14
].join("\n");

test("a scene yields its node tree, its sub-resources, and its ext_resource edges", async () => {
  const root = project({ "scenes/main.tscn": SCENE, "scripts/player.gd": "class_name Player\nextends Node\n" });
  await withRoot(root, async () => {
    const index = await buildIndex(root);
    const scene = index.files["scenes/main.tscn"];
    assert.equal(scene.language, "gdres");
    assert.deepEqual(
      scene.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.line, symbol.endLine]),
      [
        ["RectangleShape2D_xyz", "sub_resource", 6, 7],
        // Bare node names repeat inside one scene, so a nested node is named by
        // its path in the tree.
        ["Player", "node", 9, 10],
        ["Sprite", "node", 12, 12],
        ["Player/Hitbox", "node", 14, 14],
      ],
    );
    // `ext_resource` rows are references, not declarations: they are edges.
    assert.deepEqual(scene.imports.sort(), ["res://assets/icon.svg", "res://scripts/player.gd"]);
  });
});

test("a .tres names its resource type and depends on its ext_resource", async () => {
  const root = project({
    "src/data/item_data.tres": [
      '[gd_resource type="Resource" script_class="ItemData" load_steps=2 format=3]',
      "",
      '[ext_resource type="Script" path="res://src/data/item_data.gd" id="1_x"]',
      "",
      "[resource]",
      'name = "Sword"',
      "",
    ].join("\n"),
    "src/data/item_data.gd": "class_name ItemData\nextends Resource\n",
  });
  await withRoot(root, async () => {
    const index = await buildIndex(root);
    const resource = index.files["src/data/item_data.tres"];
    assert.deepEqual(
      resource.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.line]),
      [["Resource", "resource", 1]],
    );
    assert.deepEqual(resource.imports, ["res://src/data/item_data.gd"]);
  });
});

test("res:// and class_name both become edges, and both move importance", async () => {
  const root = project({
    "scripts/player.gd": "class_name Player\nextends CharacterBody2D\n\nfunc _ready() -> void:\n\tpass\n",
    // Inheritance by global name, not by path.
    "scripts/enemy.gd": "class_name Enemy\nextends Player\n\nfunc _ready() -> void:\n\tpass\n",
    // A preload of the same script, by path.
    "scripts/loader.gd": 'const PLAYER = preload("res://scripts/player.gd")\n',
    // And a scene that attaches it.
    "scenes/main.tscn": [
      "[gd_scene load_steps=2 format=3]",
      "",
      '[ext_resource type="Script" path="res://scripts/player.gd" id="1_a"]',
      "",
      '[node name="Main" type="Node"]',
      "",
    ].join("\n"),
  });
  await withRoot(root, async () => {
    const index = await buildIndex(root);
    assert.deepEqual(index.files["scripts/enemy.gd"].imports, ["Player"]);
    assert.deepEqual(index.files["scripts/loader.gd"].imports, ["res://scripts/player.gd"]);
    assert.deepEqual(index.files["scenes/main.tscn"].imports, ["res://scripts/player.gd"]);

    const player = index.files["scripts/player.gd"].importance;
    for (const other of ["scripts/enemy.gd", "scripts/loader.gd", "scenes/main.tscn"]) {
      assert.ok(player > index.files[other].importance, `${other} must rank below the file it depends on`);
    }
  });
});

test("a commented-out dependency is not a dependency", async () => {
  const root = project({
    "a.gd": ['# preload("res://ghost.gd")', "var x: int = 1", ""].join("\n"),
    "ghost.gd": "class_name Ghost\n",
    "b.py": ["# import os", "import sys", "", "def f():", "    pass", ""].join("\n"),
  });
  await withRoot(root, async () => {
    const index = await buildIndex(root);
    // `#` starts a comment in both languages, and an edge nobody wrote would
    // silently inflate the ranked file's importance.
    assert.deepEqual(index.files["a.gd"].imports, []);
    assert.deepEqual(index.files["b.py"].imports, ["sys"]);
  });
});

test("an index remembers its exclusions, and a refresh does not undo them", async () => {
  const root = project({
    "src/keep.gd": "class_name Keep\nextends Node\n",
    "addons/vendor.gd": "class_name Vendor\nextends Node\n",
  });
  await withRoot(root, async () => {
    const first = await buildIndex(root, { exclude: ["addons"] });
    assert.deepEqual(first.excludes, ["addons"]);
    assert.equal(first.files["addons/vendor.gd"], undefined);

    // The lookup path revalidates through refreshIndex with no exclude of its
    // own; inheriting the index's set is what keeps `addons` out.
    const refreshed = await refreshIndex(first, {});
    assert.equal(refreshed.index.files["addons/vendor.gd"], undefined, "a refresh must not resurrect an excluded directory");
    assert.deepEqual(refreshed.index.excludes, ["addons"]);

    // An explicit full scan is the place a new exclusion set starts.
    const rescanned = await buildIndex(root, {});
    assert.notEqual(rescanned.files["addons/vendor.gd"], undefined);
    assert.deepEqual(rescanned.excludes, []);
  });
});

/**
 * Enough GDScript to push a file over the tree-sitter threshold: the upgrade is
 * skipped below {@link TS_MIN_TOKENS} (500), so a fixture that stayed under it
 * would measure the line-based pass while claiming to measure the grammar.
 */
const FILLER = Array.from(
  { length: 200 },
  (_, i) => `func filler${i}(a: int, b: int) -> int:
	return a + b + ${i}`,
).join("\n\n");

/** The analyzer with one grammar behind it, or a skipped test. */
async function godotAnalyzer(t, grammar) {
  const analyzer = await createTsAnalyzer();
  if (analyzer === null) {
    t.skip("web-tree-sitter is not installed");
    return null;
  }
  if (!analyzer.grammars.includes(grammar)) {
    t.skip(`lib/grammars/tree-sitter-${grammar}.wasm is missing`);
    return null;
  }
  return analyzer;
}

test("the shipped GDScript grammar replaces the line-based guesses", async (t) => {
  const analyzer = await godotAnalyzer(t, "gdscript");
  if (analyzer === null) return;
  const root = project({ "scripts/player.gd": `${PLAYER}\n${FILLER}\n`, "tiny.gd": PLAYER });
  await withRoot(root, async () => {
    const index = await buildIndex(root, { analyzer });
    const player = index.files["scripts/player.gd"];
    assert.equal(player.symbolSource, "ts");
    // The filler is weight, not subject matter: the fixture's own declarations
    // are the table.
    assert.deepEqual(
      player.symbols
        .filter((symbol) => !symbol.name.startsWith("filler"))
        .map((symbol) => [symbol.name, symbol.kind, symbol.line, symbol.endLine]),
      [
        ["Player", "class", 1, 1],
        ["died", "signal", 5, 5],
        ["State", "enum", 7, 7],
        ["MAX_SPEED", "const", 9, 9],
        ["speed", "var", 11, 11],
        ["sprite", "var", 12, 12],
        ["instances", "var", 13, 13],
        ["_health", "var", 14, 14],
        ["_ready", "function", 16, 18],
        ["make", "function", 20, 21],
        ["take_damage", "function", 23, 26],
        ["Inventory", "class", 28, 32],
        // A nested class qualifies its members, and only a function becomes a
        // method: the variable keeps its kind.
        ["Inventory.items", "var", 29, 29],
        ["Inventory.add", "method", 31, 32],
      ],
    );
    // Below the threshold nothing is parsed, which is what keeps a scan cheap.
    assert.equal(index.files["tiny.gd"].symbolSource, "regex");
  });
});

test("\`func _init\` is named by the spec, because the grammar names it nothing", async (t) => {
  const analyzer = await godotAnalyzer(t, "gdscript");
  if (analyzer === null) return;
  const root = project({
    "actor.gd": `class_name Actor
extends Node

func _init(name: String) -> void:
	_name = name

func _ready() -> void:
	pass

${FILLER}
`,
  });
  await withRoot(root, async () => {
    const index = await buildIndex(root, { analyzer });
    const actor = index.files["actor.gd"];
    assert.equal(actor.symbolSource, "ts");
    assert.deepEqual(
      actor.symbols
        .filter((symbol) => !symbol.name.startsWith("filler"))
        .map((symbol) => [symbol.name, symbol.kind, symbol.line, symbol.endLine]),
      [
        ["Actor", "class", 1, 1],
        ["_init", "function", 4, 5],
        ["_ready", "function", 7, 8],
      ],
    );
  });
});

test("a GDScript file the grammar cannot read keeps its line-based symbols", async (t) => {
  const analyzer = await godotAnalyzer(t, "gdscript");
  if (analyzer === null) return;
  const root = project({ "broken.gd": `var kept: int = 1

func broken(:
	pass

${FILLER}
` });
  await withRoot(root, async () => {
    const index = await buildIndex(root, { analyzer });
    const broken = index.files["broken.gd"];
    // A tree with errors is not an upgrade: replacing the line-based symbols
    // with the handful the grammar salvaged would lose declarations and say
    // nothing about it. The floor is what such a file deserves.
    assert.equal(broken.symbolSource, "regex");
    const names = broken.symbols.map((symbol) => symbol.name);
    assert.ok(names.includes("kept"), "the declaration above the error is still found");
    assert.ok(names.includes("broken"), "and so is the one that carries it");
  });
});

/**
 * A scene big enough to be worth parsing: the upgrade is skipped below
 * {@link TS_MIN_TOKENS}, and a small scene would measure the floor while
 * claiming to measure the grammar. Real scenes cross this line by themselves —
 * 200 nodes is an ordinary level.
 */
const SCENE_FILLER = Array.from(
  { length: 200 },
  (_, i) => `[node name="Filler${i}" type="Node" parent="."]`,
).join("\n");

test("the shipped resource grammar reads nodes the line-based pass cannot", async (t) => {
  const analyzer = await godotAnalyzer(t, "godot_resource");
  if (analyzer === null) return;
  // `type` before `name`: the line-based pass reads a node header with a regex
  // that wants `name` first, so this node is invisible to the floor.
  const scene = [
    "[gd_scene load_steps=2 format=3]", // 1
    "", // 2
    '[ext_resource type="Script" path="res://player.gd" id="1_a"]', // 3
    "", // 4
    '[sub_resource type="RectangleShape2D" id="Shape_1"]', // 5
    "size = Vector2(16, 32)", // 6
    "", // 7
    '[node type="CharacterBody2D" name="Player"]', // 8
    'script = ExtResource("1_a")', // 9
    "", // 10
    '[node name="Sprite" type="Sprite2D" parent="."]', // 11
    "", // 12
    '[node name="Hitbox" type="Area2D" parent="Player"]', // 13
    "", // 14
  ].join("\n");
  const root = project({ "scenes/main.tscn": `${scene}\n${SCENE_FILLER}\n` });
  await withRoot(root, async () => {
    const index = await buildIndex(root, { analyzer });
    const parsed = index.files["scenes/main.tscn"];
    assert.equal(parsed.symbolSource, "ts");
    assert.deepEqual(
      parsed.symbols
        .filter((symbol) => !symbol.name.startsWith("Filler"))
        .map((symbol) => [symbol.name, symbol.kind, symbol.line, symbol.endLine]),
      [
        ["Shape_1", "sub_resource", 5, 6],
        ["Player", "node", 8, 9],
        ["Sprite", "node", 11, 11],
        ["Player/Hitbox", "node", 13, 13],
      ],
    );

    // The same file through the floor: the same sub-resource and the same node
    // paths, but the node whose header is written the other way round is simply
    // not there — which is the whole reason for shipping this grammar.
    const floor = await buildIndex(root);
    assert.equal(floor.files["scenes/main.tscn"].symbolSource, "regex");
    const names = floor.files["scenes/main.tscn"].symbols.map((symbol) => symbol.name);
    assert.equal(names.includes("Player"), false, "a regex needs name first in a node header");
    for (const expected of ["Shape_1", "Sprite", "Player/Hitbox"]) {
      assert.ok(names.includes(expected), `the line-based pass still finds ${expected}`);
    }
  });
});

test("a .tres names its resource type through the grammar", async (t) => {
  const analyzer = await godotAnalyzer(t, "godot_resource");
  if (analyzer === null) return;
  const text = [
    '[gd_resource type="Resource" script_class="ItemData" load_steps=2 format=3]',
    "",
    '[ext_resource type="Script" path="res://src/data/item_data.gd" id="1_x"]',
    "",
    "[resource]",
    'name = "Sword"',
    "",
  ].join("\n");
  // Small enough that the indexer would never parse it, so this asks the
  // analyzer directly rather than pretending otherwise.
  const symbols = await analyzer.analyze(text, ".tres");
  assert.notEqual(symbols, null, "the grammar has to read a plain .tres");
  assert.deepEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind, symbol.line, symbol.endLine]),
    [["Resource", "resource", 1, 1]],
  );
});
