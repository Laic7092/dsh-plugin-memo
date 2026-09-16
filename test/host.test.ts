import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { MEMO_COMMAND_NAMES } from "../src/cli.ts";
import { countTokens } from "../src/tokenizer.ts";
import { join } from "node:path";

/**
 * End-to-end check of the host half against the real `@deepseek-ai/dsh-tools`
 * `defineTool`, driven by a fake Context — including the optional `commands`
 * registry, which is reached through a nested injection scope rather than a
 * hard dependency. Without `node_modules/@deepseek-ai` (a dev symlink to the
 * deployment's own install) the suite reports skipped instead of failing.
 */
let host = null;
let importError = null;
try {
  host = await import("../src/index.ts");
} catch (error) {
  importError = error;
}

const skip = importError ? `harness packages not resolvable: ${importError.message}` : false;

function fakeContext(options: { commands?: boolean; webServer?: boolean } = {}) {
  const tools = new Map();
  const commands = [];
  const routes = [];
  const disposers = new Set();
  const listeners = new Map();
  let injectCalls = 0;
  const commandsRegistry = {
    register(definition) {
      commands.push(definition);
      return () => {};
    },
  };
  const webServerRegistry = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  // `ctx.effect` runs its callback synchronously and keeps whatever disposer the
  // callback returns, which is what makes a runtime switch observable: disposing
  // the guard effect must actually unregister its listeners, not merely flag
  // itself as finished.
  const effect = function effect(callback) {
    const dispose = callback();
    if (typeof dispose === "function") disposers.add(dispose);
    return () => {
      disposers.delete(dispose);
      if (typeof dispose === "function") dispose();
    };
  };
  const ctx = {
    logger: { info() {} },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    // Listeners are tracked so a test can prove that disposing an effect really
    // unregisters what it added.
    on(event, handler) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return () => {
        const current = listeners.get(event) ?? [];
        const at = current.indexOf(handler);
        if (at !== -1) current.splice(at, 1);
      };
    },
    get(name) {
      if (name === "commands" && options.commands !== false) return commandsRegistry;
      if (name === "webServer" && options.webServer !== false) return webServerRegistry;
      return undefined;
    },
    inject(deps, callback) {
      injectCalls += 1;
      if (deps.every((dep) => ctx.get(dep) !== undefined)) {
        const scoped = Object.create(ctx);
        scoped.commands = commandsRegistry;
        scoped.webServer = webServerRegistry;
        callback(scoped);
      }
      return { dispose() {} };
    },
    effect,
  };
  return {
    ctx,
    tools,
    commands,
    routes,
    disposers,
    listeners,
    injectCalls: () => injectCalls,
    /**
     * How many handlers are actually registered, across every event. Removing a
     * handler leaves its bucket key in place, so `listeners.keys()` is not a
     * measure of interest — these two are.
     */
    handlerCount: () => [...listeners.values()].reduce((total, bucket) => total + bucket.length, 0),
    events: () => [...listeners.entries()].filter(([, bucket]) => bucket.length > 0).map(([event]) => event).sort(),
    /** Drive one host event through the listeners this plugin registered. */
    async fire(event, ...args) {
      for (const handler of listeners.get(event) ?? []) {
        const result = await handler(...args, async () => ({ kind: "allow" }));
        if (result !== undefined) return result;
      }
      return undefined;
    },
  };
}

/** Drive one registered web route the way the HTTP carrier would. */
async function request(route, options: { body?: string; method?: string; url?: string } = {}) {
  const captured: any = {};
  const res = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body) {
      captured.body = body;
    },
  };
  // A write route reads a bounded request stream; a GET simply never emits.
  const body = options.body === undefined ? [] : [Buffer.from(options.body, "utf8")];
  const req = {
    method: options.method ?? "GET",
    url: options.url ?? route.path,
    on(event, handler) {
      if (event === "data") for (const chunk of body) handler(chunk);
      if (event === "end") handler();
    },
    destroy() {},
  };
  await route.handler(req, res);
  return {
    status: captured.status,
    headers: captured.headers ?? {},
    json: captured.body === undefined ? null : JSON.parse(String(captured.body)),
  };
}

function scratchProject() {
  return mkdtempSync(join(tmpdir(), "memo-host-"));
}

const agentIn = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd }, id: "session-test" } } });

/** The command catalogue as a flat list of names — one row per switch on screen. */
const switchNames = (config) => config.subcommands.flatMap((group) => group.commands.map((entry) => entry.name));

/** The command catalogue as `{ name: on }`. */
const switchState = (config) => Object.fromEntries(config.subcommands.flatMap((group) => group.commands.map((entry) => [entry.name, entry.on])));

/** Everything in `config` except the grouped command catalogue. */
const readSwitches = (config) => ({ ...config, subcommands: undefined });

test("the state route revalidates in the counter it is asked for", { skip }, async () => {
  const base = scratchProject();
  try {
    const root = join(base, "proj");
    mkdirSync(join(root, ".memo"), { recursive: true });
    const source = "export function alpha() {\n  return 1;\n}\n";
    writeFileSync(join(root, "a.ts"), source, "utf8");
    const exact = countTokens(source);
    const estimate = Math.ceil(source.length / 4);
    assert.notEqual(exact, estimate, "the fixture must tell the two counters apart");

    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const state = fake.routes.find((route) => route.path === "/memo/state");
    const scan = fake.routes.find((route) => route.path === "/memo/scan");
    assert.ok(state !== undefined && scan !== undefined, "both routes are registered");

    const built = await request(scan, { method: "POST", url: `/memo/scan?root=${encodeURIComponent(root)}` });
    assert.equal(built.status, 200);
    assert.equal(built.json.index.tokens, "estimated");

    // The panel names the counter in the same request that asks for the sweep.
    const asked = await request(state, { url: `/memo/state?refresh=1&tokenizer=exact&root=${encodeURIComponent(root)}` });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.index.tokens, "exact", "the index was rebuilt in the unit the panel asked for");
    assert.equal(asked.json.index.totalTokens, exact);

    // The counter the panel names is the host's counter from then on, so the
    // next plain load does not rebuild the index back to the other unit.
    const plain = await request(state, { url: `/memo/state?refresh=1&root=${encodeURIComponent(root)}` });
    assert.equal(plain.json.config.tokenizer, "exact", "the choice stuck");
    assert.equal(plain.json.index.tokens, "exact", "and nothing was rebuilt back");

    // A counter this host cannot honour is dropped, not guessed at.
    const nonsense = await request(state, { url: `/memo/state?refresh=1&tokenizer=wordpiece&root=${encodeURIComponent(root)}` });
    assert.equal(nonsense.status, 200);
    assert.equal(nonsense.json.config.tokenizer, "exact", "a nonsense name changes nothing");
    assert.equal(nonsense.json.index.tokens, "exact");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the settings route round-trips the token counter and refuses a name it does not know", { skip }, async () => {
  const base = scratchProject();
  try {
    writeFileSync(join(base, "a.ts"), "export const a = 1\n", "utf8");
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const config = fake.routes.find((route) => route.path === "/memo/config");
    assert.ok(config !== undefined, "the config route is registered");

    // The default is the estimate, and it says so.
    const initial = await request(config);
    assert.equal(initial.json.config.tokenizer, "estimated");

    const exact = await request(config, { method: "POST", body: JSON.stringify({ tokenizer: "exact" }) });
    assert.equal(exact.status, 200);
    assert.equal(exact.json.config.tokenizer, "exact");

    // A tokenizer this host cannot honour is refused, not silently downgraded:
    // the panel would otherwise show a switch that is on and doing nothing.
    const wrong = await request(config, { method: "POST", body: JSON.stringify({ tokenizer: "wordpiece" }) });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /tokenizer must be one of/);
    const after = await request(config);
    assert.equal(after.json.config.tokenizer, "exact", "a refused patch changes nothing");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("host half registers one tool and one human command", { skip }, () => {
  assert.equal(host.name, "dsh-plugin-memo");
  assert.deepEqual(host.inject, ["tools"]);

  const fake = fakeContext();
  host.apply(fake.ctx, {});
  // One tool for the whole grammar: that is the standing context cost, and it
  // is one description plus one string parameter rather than one schema per
  // operation.
  assert.deepEqual([...fake.tools.keys()], ["memo"]);
  const tool = fake.tools.get("memo");
  assert.ok(tool.description.length > 20);
  assert.equal(typeof tool.execute, "function");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["command"]);
  assert.equal(tool.parameters.required, undefined, "the command line is optional: omitting it is \`status\`");
  assert.match(tool.description, /memo status/);
  assert.equal(fake.commands.length, 1);
  assert.equal(fake.commands[0].name, "memo");
  assert.equal(fake.commands[0].definitionId, "dsh-plugin-memo");
  assert.deepEqual(fake.events(), ["session/event", "tools/pre-execute", "tools/result"]);
});

test("the repeated-read guard refuses a second read of an unchanged window", { skip }, async () => {
  const base = scratchProject();
  try {
    writeFileSync(join(base, "a.ts"), "export const a = 1\n", "utf8");
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = { name: "read", arguments: { file_path: join(base, "a.ts") }, agent: { id: "s1", session: { header: { cwd: base }, id: "s1" } } };

    // Nothing recorded yet: the first read is allowed.
    assert.deepEqual(await fake.fire("tools/pre-execute", exec), { kind: "allow" });
    await fake.fire("tools/result", exec, { isError: false });

    // The same unchanged window now gets refused, with the escape hatch spelled out.
    const denied = await fake.fire("tools/pre-execute", exec);
    assert.equal(denied.kind, "deny");
    assert.match(denied.reason, /already read in this session/);
    assert.match(denied.reason, /offset\/limit/);

    // A different window is fine.
    const other = { ...exec, arguments: { file_path: join(base, "a.ts"), offset: 2, limit: 5 } };
    assert.deepEqual(await fake.fire("tools/pre-execute", other), { kind: "allow" });

    // A failed read is never recorded, so it cannot poison a later one.
    const failed = { ...exec, arguments: { file_path: join(base, "missing.ts") } };
    await fake.fire("tools/result", failed, { isError: true });
    assert.deepEqual(await fake.fire("tools/pre-execute", failed), { kind: "allow" });

    // Compaction drops what the guard was assuming is still in context.
    await fake.fire("session/event", { id: "s1" }, { type: "compaction/end" });
    assert.deepEqual(await fake.fire("tools/pre-execute", exec), { kind: "allow" });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the guard can be turned off, and then no listener is installed", { skip }, () => {
  const fake = fakeContext();
  host.apply(fake.ctx, { readGuard: false });
  assert.equal(fake.tools.size, 1, "the tool does not depend on the guard");
  assert.equal(fake.handlerCount(), 0, "no read guard handler when it is disabled");
});

test("the switches change the host at runtime, and the guard really comes back", { skip }, async () => {
  const base = scratchProject();
  try {
    writeFileSync(join(base, "a.ts"), "export const a = 1\n", "utf8");
    const fake = fakeContext();
    // Start from the composition's off switch, then turn it on from the panel.
    host.apply(fake.ctx, { readGuard: false, exclude: ["generated"] });
    const config = fake.routes.find((route) => route.path === "/memo/config");
    assert.ok(config !== undefined, "the config route is registered");

    assert.equal(fake.handlerCount(), 0, "off means no listener at all");
    assert.ok(fake.tools.get("memo") !== undefined);

    // What the panel is told is the host's live state, not its own wish.
    const initial = await request(config);
    assert.equal(initial.status, 200);
    assert.deepEqual(readSwitches(initial.json.config), { readGuard: false, refresh: true, tokenizer: "estimated", exclude: ["generated"], readTools: ["read"], subcommands: undefined });

    // Flip it on: the listeners appear, and the guard actually refuses.
    const on = await request(config, { method: "POST", body: JSON.stringify({ readGuard: true }) });
    assert.equal(on.status, 200);
    assert.equal(on.json.config.readGuard, true);
    assert.deepEqual(fake.events(), ["session/event", "tools/pre-execute", "tools/result"]);

    const exec = { name: "read", arguments: { file_path: join(base, "a.ts") }, agent: { id: "s1", session: { id: "s1" } } };
    assert.deepEqual(await fake.fire("tools/pre-execute", exec), { kind: "allow" });
    await fake.fire("tools/result", exec, { isError: false });
    assert.equal((await fake.fire("tools/pre-execute", exec)).kind, "deny", "the re-enabled guard refuses the second read");

    // And off again: disposing the effect must unregister, not just flag itself.
    const off = await request(config, { method: "POST", body: JSON.stringify({ readGuard: false }) });
    assert.equal(off.json.config.readGuard, false);
    assert.equal(fake.handlerCount(), 0, "disabling removes the handlers, not just the flag");
    assert.deepEqual(await fake.fire("tools/pre-execute", exec), undefined, "with no listener the call is simply not intercepted");

    // The other two switches are persisted in the host's state, not re-read from disk.
    const rest = await request(config, { method: "POST", body: JSON.stringify({ refresh: false, exclude: ["", "addons", " "] }) });
    assert.deepEqual(rest.json.config.exclude, ["addons"], "blank names are dropped, not stored");
    assert.equal(rest.json.config.refresh, false);

    // A refused body leaves the state alone.
    const bad = await request(config, { method: "POST", body: "[" });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /valid JSON/);
    const notObject = await request(config, { method: "POST", body: "3" });
    assert.equal(notObject.status, 400);
    assert.equal((await request(config)).json.config.refresh, false, "a rejected write changes nothing");
    assert.equal((await request(config, { method: "PUT", body: "{}" })).status, 405, "only GET and POST are served");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a command switch is enforced at the CLI, and lifted again", { skip }, async () => {
  const base = scratchProject();
  try {
    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    const fake = fakeContext();
    // One command pinned off by the composition, the rest on.
    host.apply(fake.ctx, { subcommands: { scan: false } });
    assert.equal(fake.tools.size, 1, "there is one tool whatever the switches say");

    const exec = agentIn(base);
    const memo = (command) => fake.tools.get("memo").execute({ command }, exec);
    const config = fake.routes.find((route) => route.path === "/memo/config");
    const panel = fake.routes.find((route) => route.path === "/memo/state");
    const initial = await request(config);
    assert.deepEqual(initial.json.config.subcommands.find((group) => group.id === "index").commands, [
      { name: "scan", on: false },
      { name: "find", on: true },
      { name: "map", on: true },
    ]);
    // Off means the host refuses the command, for the model and for /memo
    // alike — a switch that only hid a row would be a lie about what runs.
    assert.match(await memo("scan"), /被关掉了/);

    // On: the same call does the real work, not a stub that pretends.
    const on = await request(config, { method: "POST", body: JSON.stringify({ subcommands: { scan: true } }) });
    assert.equal(on.status, 200);
    assert.match(await memo("scan"), /已重建索引/);

    // Off again, and the reason is in the answer rather than in a failed call.
    const off = await request(config, { method: "POST", body: JSON.stringify({ subcommands: { scan: false } }) });
    assert.equal(off.json.config.subcommands[1].commands[0].on, false);
    assert.match(await memo("scan"), /被关掉了/);

    // The panel's state route reports the same live set. It used to be handed a
    // hand-built snapshot of the plugin state, which is how a whole field went
    // missing from the payload once.
    const live = await request(panel, { url: `/memo/state?root=${encodeURIComponent(base)}` });
    assert.equal(switchState(live.json.config).scan, false);
    await request(config, { method: "POST", body: JSON.stringify({ subcommands: { find: false, "bug-log": false } }) });
    assert.equal((await request(panel, { url: `/memo/state?root=${encodeURIComponent(base)}` })).json.config.subcommands.find((group) => group.id === "bugs").commands[1].on, false);

    // A patch is validated as a whole before any of it lands: a typo must not
    // look like a switch that simply did nothing.
    for (const body of ['{"subcommands":{"map":false,"nope":false}}', '{"subcommands":{"map":"no"}}', '{"subcommands":["map"]}']) {
      const refused = await request(config, { method: "POST", body });
      assert.equal(refused.status, 400, `${body} is refused`);
      assert.equal(switchState((await request(config)).json.config).map, true, "the valid half of a refused patch is not applied either");
    }
    assert.match((await request(config, { method: "POST", body: '{"subcommands":{"nope":false}}' })).json.error, /unknown command/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the tool still registers when no command registry exists", { skip }, () => {
  const fake = fakeContext({ commands: false });
  host.apply(fake.ctx, {});
  assert.equal(fake.tools.size, 1);
  assert.equal(fake.commands.length, 0);
  assert.equal(fake.injectCalls(), 2, "both optional scopes are still attempted; neither activates without its service");
});

test("handoff writes STATUS.md and status reads it back", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(base);
    const run = (command) => fake.tools.get("memo").execute({ command }, exec);

    // Before anything is written the project honestly reports nothing.
    assert.match(await run("status"), /还没有 \.memo\/STATUS\.md/);

    const written = await run('handoff --now "在把登录换成 token 校验" --next "- 补过期路径的测试" --avoid "别再动 session 中间件"');
    assert.match(written, /已更新/);
    assert.match(written, /在把登录换成 token 校验/);

    const status = await run("status");
    assert.match(status, /在把登录换成 token 校验/);
    assert.match(status, /补过期路径的测试/);
    assert.match(status, /别再动 session 中间件/);
    assert.match(status, /（空）/, "sections that were never written report as empty");

    const file = readFileSync(join(base, ".memo", "STATUS.md"), "utf8");
    assert.match(file, /## 现在在哪/);
    assert.match(file, /_最后更新：\d{4}-/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a second handoff updates only what it passes", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(base);
    const run = (command) => fake.tools.get("memo").execute({ command }, exec);

    await run('handoff --now "第一阶段" --next "往下做 B"');
    await run('handoff --now "第二阶段"');
    const status = await run("status");
    assert.match(status, /第二阶段/);
    assert.match(status, /往下做 B/, "the untouched section survives");
    assert.doesNotMatch(status, /第一阶段/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the journal and the bug log round-trip", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(base);
    const run = (command) => fake.tools.get("memo").execute({ command }, exec);

    assert.match(await run("note 改用 zod 解析配置"), /已记录/);
    assert.match(await run("note 决定不上 redis --kind decision"), /\[decision\]/);
    assert.match(await run("note"), /需要一句话/);

    const status = await run("status");
    assert.match(status, /决定不上 redis/);
    assert.match(status, /最近动作（2\/2 条）/);

    assert.match(await run("bug-search boom"), /还没有 bug 记忆/);

    const logged = await run('bug-log --error "EADDRINUSE: port 3000" --cause "旧进程没退" --fix "先 kill"');
    assert.match(logged, /bug-001/);
    const again = await run('bug-log --error " eaddrinuse:  PORT 3000 "');
    assert.match(again, /同一症状第 2 次/);

    const found = await run("bug-search EADDRINUSE");
    assert.match(found, /bug-001/);
    assert.match(found, /先 kill/);
    assert.match(await run("bug-search 完全无关的东西"), /没有匹配/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("/memo runs the same grammar as the tool, without spending a model turn", { skip }, async () => {
  const base = scratchProject();
  try {
    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const definition = fake.commands[0];
    const invocation = (rawInput) => ({ rawInput, agent: { session: { header: { cwd: base }, id: "session-test" } }, signal: new AbortController().signal });

    // Bare /memo is the status, which is what a person types most.
    const empty = await definition.handler(invocation(""));
    assert.equal(empty.kind, "success");
    assert.match(empty.text, /还没有 \.memo\/STATUS\.md/);

    // The write side a person can now reach directly, and the kind flag with it.
    const noted = await definition.handler(invocation("note 从这里开始 --kind decision"));
    assert.equal(noted.kind, "success");
    assert.match(noted.text, /\[decision\]/);

    const handed = await definition.handler(invocation('handoff --now "在写 /memo"'));
    assert.equal(handed.kind, "success");
    assert.match(handed.text, /已更新/);

    const scanned = await definition.handler(invocation("scan"));
    assert.equal(scanned.kind, "success");
    assert.match(scanned.text, /已重建索引/);

    const found = await definition.handler(invocation("find alpha"));
    assert.equal(found.kind, "success");
    assert.match(found.text, /a\.ts/);

    const shown = await definition.handler(invocation(""));
    assert.match(shown.text, /从这里开始/);
    assert.match(shown.text, /最近动作/);
    assert.match(shown.text, /在写 \/memo/);

    // A refusal is an error result carrying the reason, not a silent success.
    const bad = await definition.handler(invocation("note"));
    assert.equal(bad.kind, "error");
    assert.match(bad.text, /需要一句话/);

    const unknown = await definition.handler(invocation("frobnicate"));
    assert.equal(unknown.kind, "error");
    assert.match(unknown.text, /不认识的子命令/);

    const help = await definition.handler(invocation("help"));
    assert.equal(help.kind, "success");
    assert.match(help.text, /memo scan/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an explicit root overrides the session directory", { skip }, async () => {
  const sessionDir = scratchProject();
  const target = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(sessionDir);
    const memo = (command) => fake.tools.get("memo").execute({ command }, exec);
    await memo(`handoff --root ${target} --now "在 target 项目里"`);
    assert.match(await memo(`status --root ${target}`), /在 target 项目里/);
    assert.match(await memo("status"), /还没有 \.memo\/STATUS\.md/);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("`memo find` revalidates the index instead of trusting a stale one", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(base);
    const run = (command) => fake.tools.get("memo").execute({ command }, exec);

    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    await run("scan");

    // A file the scan never saw, written by something that announced nothing —
    // exactly what a hook keyed on this process's own writes would miss.
    writeFileSync(join(base, "b.ts"), "export function beta() {}\n", "utf8");
    const found = await run("find beta");
    assert.match(found, /b\.ts/);
    assert.match(found, /索引已自动同步：\+1 新文件/);

    // An edit to an indexed file is reflected too, and the rest is not re-read.
    const later = new Date(Date.now() + 5000);
    writeFileSync(join(base, "a.ts"), "export function renamed() {}\n", "utf8");
    utimesSync(join(base, "a.ts"), later, later);
    const edited = await run("find renamed");
    assert.match(edited, /a\.ts/);
    assert.match(edited, /索引已自动同步：~1 改写/);

    // Nothing moved: the answer is silent about syncing.
    assert.doesNotMatch(await run("find renamed"), /索引已自动同步/);
    assert.doesNotMatch(await run("map"), /索引已自动同步/);

    // With revalidation turned off the index is exactly what the last scan
    // wrote — and the answer says nothing was synced, rather than implying it was.
    writeFileSync(join(base, "c.ts"), "export function gamma() {}\n", "utf8");
    const pinned = fakeContext();
    host.apply(pinned.ctx, { refresh: false });
    const stale = await pinned.tools.get("memo").execute({ command: "find gamma" }, exec);
    assert.match(stale, /索引里没有匹配/);
    assert.doesNotMatch(stale, /索引已自动同步/);
    assert.match(await run("find gamma"), /c\.ts/, "the default path does see it");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the settings panel routes answer JSON, and the write route is guarded", { skip }, async () => {
  const base = scratchProject();
  const other = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const state = fake.routes.find((route) => route.path === "/memo/state");
    const scan = fake.routes.find((route) => route.path === "/memo/scan");
    assert.ok(state !== undefined && scan !== undefined, "both panel routes are registered");
    assert.equal(state.kind, "exact");

    // A project with no memory yet is a valid answer, not an error.
    const empty = await request(state, { url: `/memo/state?root=${encodeURIComponent(other)}` });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.ok, true);
    assert.equal(empty.json.root, other);
    assert.equal(empty.json.initialized, false);
    assert.deepEqual(empty.json.status.sections, [], "no STATUS.md reports no sections, not four empty ones");
    assert.equal(empty.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(existsSync(join(other, ".memo")), false, "reading the panel must not initialize a project");

    // Build real memory through the tools, then read it back through the route.
    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    const exec = agentIn(base);
    await fake.tools.get("memo").execute({ command: 'handoff --now "面板接线中"' }, exec);
    await fake.tools.get("memo").execute({ command: "scan" }, exec);

    const filled = await request(state, { url: `/memo/state?root=${encodeURIComponent(base)}` });
    assert.equal(filled.status, 200);
    assert.equal(filled.json.initialized, true);
    assert.equal(filled.json.status.sections[0].body, "面板接线中");
    assert.equal(filled.json.index.present, true);
    assert.equal(filled.json.index.fileCount, 1);
    // The switches ride along with the state the panel is already reading. When
    // they did not, the view crashed on the missing field.
    assert.deepEqual(readSwitches(filled.json.config), { readGuard: true, refresh: true, tokenizer: "estimated", exclude: [], readTools: ["read"], subcommands: undefined });
    // The catalogue is the CLI's own command list rather than a second copy of
    // it, and the host has exactly one tool however many commands there are.
    assert.deepEqual(switchNames(filled.json.config), MEMO_COMMAND_NAMES);
    assert.deepEqual([...fake.tools.keys()], ["memo"]);
    assert.ok(Object.values(switchState(filled.json.config)).every((on) => on === true));

    // A relative root is refused rather than resolved against the host's cwd.
    const bad = await request(state, { url: "/memo/state?root=relative" });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /absolute/);

    // The mutating route needs POST...
    const wrongMethod = await request(scan, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.match(wrongMethod.json.error, /POST/);

    // ...and refuses a directory with no .memo/ instead of creating one there.
    const refused = await request(scan, { method: "POST", url: `/memo/scan?root=${encodeURIComponent(other)}` });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /memo scan once in this project first/);
    assert.equal(existsSync(join(other, ".memo")), false);

    // A real scan answers with what it built.
    const built = await request(scan, { method: "POST", url: `/memo/scan?root=${encodeURIComponent(base)}` });
    assert.equal(built.status, 200);
    assert.equal(built.json.ok, true);
    assert.equal(built.json.index.fileCount, 1);
    assert.equal(typeof built.json.durationMs, "number");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("a big index is not cut off by the cap that guards the memory files", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(base);
    const run = (command) => fake.tools.get("memo").execute({ command }, exec);

    // Past the 400 KB per-file read cap the memory files are read under, and
    // past what the old JSON index carried comfortably. Neither cap is the
    // index's any more: a database reads rows, not one document, so a large
    // project cannot be silently truncated into a smaller answer.
    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n// " + "x".repeat(500_000) + "\n", "utf8");
    writeFileSync(join(base, "b.ts"), "export function beta() {}\n", "utf8");
    assert.match(await run("scan"), /已重建索引/);

    const found = await run("find alpha");
    assert.match(found, /a\.ts/);
    assert.doesNotMatch(found, /is not valid JSON/);
    assert.match(await run("find beta"), /b\.ts/, "the second file is in the same index");
    assert.match(await run("map"), /项目地图/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
