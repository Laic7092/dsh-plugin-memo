import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("a spelled-out newline becomes one, and other backslashes are left alone", async () => {
  // A model spells a line break the way a JSON string does: two characters, not a
  // real one. Read literally it does not fail, it mangles -- a handoff list lands
  // as one line reading "- an- b". Named escapes are therefore decoded, and
  // nothing else is: a Windows path, a regex, or a pasted phrase keeps its backslashes.
  assert.deepEqual(splitCommandLine("handoff --open \"- a\\n- b\"").tokens, ["handoff", "--open", "- a\n- b"]);
  assert.deepEqual(splitCommandLine("handoff --now \"x\\ty\"").tokens, ["handoff", "--now", "x\ty"]);
  assert.deepEqual(splitCommandLine("find \"C:\\\\Users\"").tokens, ["find", "C:\\\\Users"], "a path keeps both separators");
  // The inline spelling never went through the splitter's quoting, so it has to be
  // read the same way where flags are parsed.
  const inline = splitCommandLine("handoff --open=\"- a\\n- b\"").tokens;
  assert.equal(inline[1].split("\\\\n").join(String.fromCharCode(10)), "--open=- a\n- b", "an inline value is decoded too");

  const root = scratch();
  try {
    assert.equal((await cli(root, "handoff --open \"- 调用点默认 6 条\\n- 判不了的只计数\"")).ok, true);
    const status = () => readFileSync(join(root, ".memo/STATUS.md"), "utf8");
    assert.ok(status().includes("- 调用点默认 6 条\n- 判不了的只计数"), "two bullets, not one line with an n in it");
  
    assert.equal((await cli(root, "handoff --next=\"- 一行\\n- 两行\"")).ok, true);
    assert.ok(status().includes("- 一行\n- 两行"), "an inline flag value is read the same way");
    await cli(root, "note \"第一行\\n第二行\"");
  // The journal is JSON lines, so the break is an escape there: read it back
  // through the parser rather than looking for the character in the file.
  const last = readFileSync(join(root, ".memo/journal.jsonl"), "utf8").trim().split(String.fromCharCode(10)).pop();
  assert.equal(JSON.parse(last).text, "第一行\n第二行");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a note that is a report gets refused, and nothing is created for it", async () => {
  // The journal is read back on every resume, so an entry is standing context.
  // A long one is not a bigger memory, it is a tax on every later session --
  // and the refusal has to say where that text belongs instead.
  const root = scratch();
  try {
    const long = "长".repeat(201);
    const refused = await cli(root, `note ${long}`);
    assert.equal(refused.ok, false);
    assert.match(refused.text, /上限 200 字/);
    assert.match(refused.text, /memo handoff/, "the refusal names the right container");
    assert.equal(readdirSync(root).includes(".memo"), false, "a refusal creates no memo directory");

    // A decision is allowed the room its reasoning needs -- but not more.
    assert.equal((await cli(root, `note ${"决".repeat(399)} --kind decision`)).ok, true);
    assert.match((await cli(root, `note ${"决".repeat(401)} --kind decision`)).text, /上限 400 字/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

    // The index is a local database now, and the memory directory carries its
    // own .gitignore saying so: the plain-text files are the part worth keeping.
    assert.deepEqual(readdirSync(join(root, ".memo")).sort(), [".gitignore", "bugs.json", "index.db", "journal.jsonl"]);
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

test("find says who calls the symbol it answers about", async () => {
  const root = mkdtempSync(join(tmpdir(), "memo-cli-calls-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "core.ts"), "export function alpha() { return 1 }\n", "utf8");
  writeFileSync(join(root, "src", "use.ts"), 'import { alpha } from "./core";\nexport function run() { return alpha(); }\n', "utf8");
  try {
    // The scan counts the edges it stored, which is the same number the answer
    // is made of.
    assert.match((await cli(root, "scan")).text, /1 条调用边/);

    const found = await cli(root, "find alpha");
    assert.match(found.text, /谁调它：1 处调用点（全项目唯一 1）/);
    assert.match(found.text, /src\/use\.ts:2 {2}run/, "the caller, the line, and the declaration it sits in");

    // The flag is a switch, not a hint: off means the section is not there.
    const off = await cli(root, "find alpha --callers 0");
    assert.doesNotMatch(off.text, /谁调它/);
    assert.match(off.text, /src\/core\.ts:1-1/, "the answer itself is unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a miss is worded as something the index cannot say, not as absence", async () => {
  // The sentence used to read "索引里没有匹配 X 的符号、路径或正文", which reads as
  // "the project does not mention this" -- the one reading a search surface must
  // never invite, and the one an agent wrote into a report as an existence claim.
  const root = scratch();
  try {
    // The index has to exist before a query can miss it: a missing index is a
    // different message, and it is not this one.
    await cli(root, "scan");
    const miss = await cli(root, "find 北极熊");
    assert.match(miss.text, /索引里没有匹配/);
    assert.match(miss.text, /不等于项目里没有/, "the limit is said out loud");
    assert.match(miss.text, /grep -rn/, "and the way to prove it is named");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("find prints the line a body hit is on, not the first line of the file", async () => {
  // A GDScript file opens with @tool, class_name and extends. Entries used to
  // carry line 0, so every body hit previewed line 1 and a whole Chinese query
  // came back as nine of those -- while the matched line waited in a block at the
  // very end, which is also the first thing the budget cut.
  const root = mkdtempSync(join(tmpdir(), "memo-cli-line-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "clock.gd"), ["@tool", "class_name Clock", "extends Node", "", "# 日结处理：把当天的补算记进存档", "func roll() -> void:", "\tpass", ""].join(String.fromCharCode(10)));
    assert.match((await cli(root, "scan")).text, /已重建索引/);
    const found = await cli(root, "find 日结");
    assert.match(found.text, /src\/clock\.gd:5/, "the heading carries the line the query is on");
    assert.match(found.text, /日结处理/, "and the excerpt is printed with it");
    assert.doesNotMatch(found.text, /1: @tool/, "nothing previews line one any more");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first symbol hit's body is printed once", async () => {
  // The preview window was the symbol's own range, and the body repeated it: a
  // 33-line function arrived twice, at 1,109 tokens, and the duplicate spent half
  // the budget the hit list needed.
  const root = mkdtempSync(join(tmpdir(), "memo-cli-once-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "core.ts"), ["export function alpha() {", "  return 1;", "}", ""].join(String.fromCharCode(10)));
    await cli(root, "scan");
    const found = await cli(root, "find alpha");
    assert.equal(found.text.split("return 1;").length - 1, 1, "once as the body, and not again as a preview");
    assert.match(found.text, /src\/core\.ts:1-3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status says what the index cannot see", async () => {
  const root = mkdtempSync(join(tmpdir(), "memo-cli-blind-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n");
    writeFileSync(join(root, "README.md"), "# 说明\n");
    await cli(root, "scan");
    const status = await cli(root, "status");
    assert.match(status.text, /索引盲区：/, "a miss has to say what the index could not have seen");
    assert.match(status.text, /未索引 1 个/);
    assert.match(status.text, /\.md 1/, "and the suffix says where to look instead");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
