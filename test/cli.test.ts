import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MEMO_COMMAND_NAMES, MEMO_COMMANDS, runMemo, splitCommandLine, usageIndex } from "../src/cli.ts";
import type { MemoState } from "../src/types.ts";

/**
 * The grammar both surfaces share.
 *
 * `test/host.test.mjs` drives the tool and `/memo` through the plugin, and
 * `./cordis.test.mjs` proves the registration is really owned. Neither is about
 * the command line itself: the quoting, the flags, the refusals, and the one
 * property the whole design rests on — that a person typing `/memo ...` and a
 * model calling the `memo` tool run the *same* code. That is this file.
 */

/** A scratch project with one source file and no `.memo/` yet. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "memo-cli-"));
  writeFileSync(join(root, "a.ts"), "export function alpha() {}\n", "utf8");
  return root;
}

/** The state a host hands the CLI, at its defaults, with a switch or two moved. */
function hostState(over: Partial<MemoState> = {}) {
  return {
    dirName: ".memo",
    exclude: [],
    refresh: true,
    tokenizer: "estimated" as const,
    defaultRoot: undefined,
    subcommands: Object.fromEntries(MEMO_COMMAND_NAMES.map((name) => [name, true])),
    ...over,
  };
}

/** One command line, run the way the tool and `/memo` both run it. */
function cli(cwd, line, options: { state?: Partial<MemoState> } = {}) {
  return runMemo(line, {
    state: hostState(options.state),
    cwd,
    session: "session-test",
    analyzer: null,
    log: () => {},
  });
}

test("a command line splits the way a person writes it", () => {
  assert.deepEqual(splitCommandLine('note "换掉了 zod" --kind=decision').tokens, ["note", "换掉了 zod", "--kind=decision"]);
  assert.deepEqual(splitCommandLine(`handoff --now 'a b' --next "c'd"`).tokens, ["handoff", "--now", "a b", "--next", "c'd"]);
  assert.deepEqual(splitCommandLine("   ").tokens, [], "whitespace is not an argument");
  assert.deepEqual(splitCommandLine('note ""').tokens, ["note", ""], "an explicit empty word is kept");
  // An unterminated quote is refused rather than guessed at: half a symptom is
  // worse than a syntax error, because it gets written down.
  const torn = splitCommandLine('note "unclosed');
  assert.equal(torn.ok, false);
  assert.match(torn.error, /引号没闭合/);
});

test("a bare line is the status, and handoff feeds it", async () => {
  const root = scratch();
  try {
    const empty = await cli(root, "");
    assert.equal(empty.ok, true);
    assert.match(empty.text, /还没有 \.memo\/STATUS\.md/);

    const written = await cli(root, 'handoff --now "在写 CLI" --next "- 更新 README"');
    assert.equal(written.ok, true);
    assert.match(written.text, /已更新/);

    const read = await cli(root, "status");
    assert.match(read.text, /在写 CLI/);
    assert.match(read.text, /更新 README/);

    // A handoff with nothing to write is refused, not turned into a wipe: the
    // sections it was not given must survive.
    const none = await cli(root, "handoff");
    assert.equal(none.ok, false);
    assert.match(none.text, /至少要给一节/);
    assert.match((await cli(root, "status")).text, /在写 CLI/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every command writes the same files the tools used to", async () => {
  const root = scratch();
  try {
    assert.match((await cli(root, "note 改用 zod 解析配置 --kind decision")).text, /\[decision\]/);
    assert.match((await cli(root, 'bug-log --error "EADDRINUSE: port 3000" --cause "旧进程没退" --fix "先 kill" --tag net')).text, /bug-001/);
    assert.match((await cli(root, 'bug-log --error " eaddrinuse:  PORT 3000 "')).text, /同一症状第 2 次/);
    assert.match((await cli(root, "scan")).text, /已重建索引/);
    assert.match((await cli(root, "find alpha")).text, /a\.ts/);
    assert.match((await cli(root, "find --file a.ts")).text, /alpha/, "a file detail names its symbols");
    assert.match((await cli(root, "map")).text, /项目地图/);
    assert.match((await cli(root, "bug-search EADDRINUSE")).text, /先 kill/);
    assert.match((await cli(root, "status")).text, /改用 zod 解析配置/);

    assert.deepEqual(readdirSync(join(root, ".memo")).sort(), ["bugs.json", "index.json", "journal.jsonl"]);
    const bug = JSON.parse(readFileSync(join(root, ".memo", "bugs.json"), "utf8"));
    assert.equal(bug.bugs.length, 1, "one symptom is one entry, however it was spelled");
    assert.equal(bug.bugs[0].occurrences, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags accept both spellings and both orders, and refuse a value they cannot use", async () => {
  const root = scratch();
  try {
    await cli(root, "scan");
    assert.match((await cli(root, "find alpha --budget 200")).text, /200/);
    assert.match((await cli(root, "find --budget=200 alpha")).text, /200/, "--budget=200 is the same flag");
    assert.match((await cli(root, "note 从这里开始 --kind=todo")).text, /\[todo\]/);

    const unknown = await cli(root, "find alpha --nope 1");
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /不认识的选项 --nope/);
    assert.match(unknown.text, /用法：memo find QUERY/);

    const missing = await cli(root, "find alpha --budget");
    assert.equal(missing.ok, false);
    assert.match(missing.text, /缺一个值/);

    const notANumber = await cli(root, "find alpha --budget two");
    assert.equal(notANumber.ok, false);
    assert.match(notANumber.text, /要一个整数/);

    const bare = await cli(root, "note");
    assert.equal(bare.ok, false);
    assert.match(bare.text, /需要一句话/);

    const noQuery = await cli(root, "find");
    assert.equal(noQuery.ok, false);
    assert.match(noQuery.text, /需要 query/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown command is refused with the whole grammar, not with a stack trace", async () => {
  const root = scratch();
  try {
    const unknown = await cli(root, "frobnicate");
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /不认识的子命令/);
    for (const name of MEMO_COMMAND_NAMES) {
      assert.ok(unknown.text.includes(`memo ${name}`), `the refusal must name ${name} so the next try can succeed`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("help explains one command, and says which ones write", async () => {
  const root = scratch();
  try {
    const index = await cli(root, "help");
    assert.equal(index.ok, true);
    for (const name of MEMO_COMMAND_NAMES) assert.ok(index.text.includes(`memo ${name}`));

    const find = await cli(root, "help find");
    assert.match(find.text, /^memo find QUERY/m);
    assert.match(find.text, /--budget/);
    assert.match(find.text, /只读/);

    const scan = await cli(root, "help scan");
    assert.match(scan.text, /会写盘/);
    assert.match(scan.text, /--exclude/);

    // --root is on every command, because the tool has no root parameter: the
    // whole argument surface is the command line.
    for (const command of MEMO_COMMANDS) {
      assert.match((await cli(root, `help ${command.name}`)).text, /--root/);
    }

    // --help is the same page as help <command>.
    assert.equal((await cli(root, "find --help")).text, find.text);

    const missing = await cli(root, "help nope");
    assert.equal(missing.ok, false);
    assert.match(missing.text, /没有 nope 这个子命令/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command the host switched off is refused, and the help says which", async () => {
  const root = scratch();
  try {
    const off = { subcommands: { ...hostState().subcommands, scan: false } };
    const refused = await cli(root, "scan", { state: off });
    assert.equal(refused.ok, false);
    assert.match(refused.text, /被关掉了/);
    assert.equal(readdirSync(root).includes(".memo"), false, "a switched-off command does no work at all");

    const index = usageIndex(hostState(off));
    assert.match(index, /memo scan \[--exclude DIR\]\s+写\s+.*（这个宿主上已关闭）/);
    // The rest are untouched: one switch is not a blanket refusal.
    assert.match((await cli(root, "status", { state: off })).text, /还没有 \.memo\/STATUS\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--root points at another project, the session directory otherwise", async () => {
  const here = scratch();
  const there = scratch();
  try {
    assert.match((await cli(there, 'handoff --now "在那边"')).text, /已更新/);
    assert.match((await cli(here, `status --root ${there}`)).text, /在那边/);
    assert.match((await cli(here, "status")).text, /还没有 \.memo\/STATUS\.md/, "the session's own project is untouched");
  } finally {
    rmSync(here, { recursive: true, force: true });
    rmSync(there, { recursive: true, force: true });
  }
});

test("a host with no session directory falls back to its configured root", async () => {
  const base = scratch();
  try {
    const result = await runMemo("status", { state: hostState({ defaultRoot: base }), cwd: undefined, log: () => {} });
    assert.ok(result.text.includes(base), "the configuration's root is where the answer is about");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("spellings are forgiving: separators, case, and long flag names", async () => {
  const root = scratch();
  try {
    // The aliases exist so a model that remembers memo_bug_search, or writes
    // bug_search, still lands on the same command.
    assert.match((await cli(root, "bug_search boom")).text, /还没有 bug 记忆/);
    assert.match((await cli(root, "BUG-LOG --error-message X --root-cause Y --fix Z")).text, /已记录/);
    assert.match((await cli(root, "bug-log --error X2 --tags one --tags two")).text, /已记录/);
    const bugs = JSON.parse(readFileSync(join(root, ".memo", "bugs.json"), "utf8"));
    const tagged = bugs.bugs.find((bug) => bug.error_message === "X2");
    assert.deepEqual(tagged.tags, ["one", "two"], "a repeatable flag collects every value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the catalogue, the help text and the commands themselves are one list", () => {
  assert.deepEqual(MEMO_COMMAND_NAMES, MEMO_COMMANDS.map((command) => command.name));
  assert.equal(new Set(MEMO_COMMAND_NAMES).size, MEMO_COMMAND_NAMES.length);
  for (const command of MEMO_COMMANDS) {
    assert.ok(command.usage.startsWith(command.name), `usage for ${command.name} must start with its name`);
    assert.ok(command.summary.length > 4, `${command.name} needs a summary worth reading`);
    assert.equal(typeof command.run, "function");
    // The word the tool description and the help page both lean on.
    assert.equal(typeof command.write, "boolean");
  }
});
