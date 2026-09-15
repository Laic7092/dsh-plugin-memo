import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  host = await import("../lib/index.js");
} catch (error) {
  importError = error;
}

const skip = importError ? `harness packages not resolvable: ${importError.message}` : false;

function fakeContext(options = {}) {
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
async function request(route, options = {}) {
  const captured = {};
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

/** The tool catalogue as a flat list of names — one row per switch on screen. */
const switchNames = (config) => config.tools.flatMap((group) => group.tools.map((entry) => entry.name));

/** The tool catalogue as `{ name: on }`. */
const switchState = (config) => Object.fromEntries(config.tools.flatMap((group) => group.tools.map((entry) => [entry.name, entry.on])));

/** Everything in `config` except the grouped tool catalogue. */
const readSwitches = (config) => ({ ...config, tools: undefined });

test("host half registers eight tools and one human command", { skip }, () => {
  assert.equal(host.name, "dsh-plugin-memo");
  assert.deepEqual(host.inject, ["tools"]);

  const fake = fakeContext();
  host.apply(fake.ctx, {});
  assert.deepEqual(
    [...fake.tools.keys()],
    ["memo_status", "memo_handoff", "memo_note", "memo_bug_search", "memo_bug_log", "memo_scan", "memo_find", "memo_map"],
  );
  for (const tool of fake.tools.values()) {
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.execute, "function");
  }
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
  assert.equal(fake.tools.size, 8);
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
    const read = fake.tools.get("memo_status");
    assert.ok(read !== undefined);

    // What the panel is told is the host's live state, not its own wish.
    const initial = await request(config);
    assert.equal(initial.status, 200);
    assert.deepEqual(readSwitches(initial.json.config), { readGuard: false, refresh: true, exclude: ["generated"], readTools: ["read"], tools: undefined });

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

test("a tool switch takes the tool out of the registry, and puts it back", { skip }, async () => {
  const base = scratchProject();
  try {
    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    const fake = fakeContext();
    // One tool pinned off by the composition, the rest on.
    host.apply(fake.ctx, { tools: { memo_status: false } });
    assert.equal(fake.tools.size, 7, "a pinned-off tool is never registered at all");
    assert.equal(fake.tools.has("memo_status"), false);

    const config = fake.routes.find((route) => route.path === "/memo/config");
    const panel = fake.routes.find((route) => route.path === "/memo/state");
    const initial = await request(config);
    assert.deepEqual(initial.json.config.tools.find((group) => group.id === "memory").tools, [
      { name: "memo_status", on: false },
      { name: "memo_handoff", on: true },
      { name: "memo_note", on: true },
    ]);

    // On: the tool is back, and it is the same tool — not a stub that refuses.
    const on = await request(config, { method: "POST", body: JSON.stringify({ tools: { memo_status: true } }) });
    assert.equal(on.status, 200);
    assert.equal(fake.tools.size, 8);
    assert.match(await fake.tools.get("memo_status").execute({}, agentIn(base)), /还没有 \.memo\/STATUS\.md/);

    // Off again: it leaves the registry, so the model cannot see or call it.
    const off = await request(config, { method: "POST", body: JSON.stringify({ tools: { memo_status: false } }) });
    assert.equal(off.json.config.tools[0].tools[0].on, false);
    assert.equal(fake.tools.has("memo_status"), false);
    assert.equal(fake.tools.size, 7, "and no registration is left stacked behind it");

    // The panel's state route reports the same live set. It used to be handed a
    // hand-built snapshot of the plugin state, which is how a whole field went
    // missing from the payload once.
    const live = await request(panel, { url: `/memo/state?root=${encodeURIComponent(base)}` });
    assert.equal(switchState(live.json.config).memo_status, false);
    await request(config, { method: "POST", body: JSON.stringify({ tools: { memo_scan: false, memo_bug_log: false } }) });
    assert.equal(fake.tools.size, 5, "one patch can carry several tools");
    assert.equal((await request(panel, { url: `/memo/state?root=${encodeURIComponent(base)}` })).json.config.tools.find((group) => group.id === "bugs").tools[1].on, false);

    // A patch is validated as a whole before any of it lands: a typo must not
    // look like a switch that simply did nothing.
    for (const body of ['{"tools":{"memo_map":false,"memo_nope":false}}', '{"tools":{"memo_map":"no"}}', '{"tools":["memo_map"]}']) {
      const refused = await request(config, { method: "POST", body });
      assert.equal(refused.status, 400, `${body} is refused`);
      assert.equal(fake.tools.has("memo_map"), true, "the valid half of a refused patch is not applied either");
    }
    assert.match((await request(config, { method: "POST", body: '{"tools":{"memo_nope":false}}' })).json.error, /unknown tool/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("every tool still registers when no command registry exists", { skip }, () => {
  const fake = fakeContext({ commands: false });
  host.apply(fake.ctx, {});
  assert.equal(fake.tools.size, 8);
  assert.equal(fake.commands.length, 0);
  assert.equal(fake.injectCalls(), 2, "both optional scopes are still attempted; neither activates without its service");
});

test("handoff writes STATUS.md and status reads it back", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(base);
    const run = (name, args) => fake.tools.get(name).execute(args, exec);

    // Before anything is written the project honestly reports nothing.
    assert.match(await run("memo_status", {}), /还没有 \.memo\/STATUS\.md/);

    const written = await run("memo_handoff", { now: "在把登录换成 token 校验", next: "- 补过期路径的测试", avoid: "别再动 session 中间件" });
    assert.match(written, /已更新/);
    assert.match(written, /在把登录换成 token 校验/);

    const status = await run("memo_status", {});
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
    const run = (name, args) => fake.tools.get(name).execute(args, exec);

    await run("memo_handoff", { now: "第一阶段", next: "往下做 B" });
    await run("memo_handoff", { now: "第二阶段" });
    const status = await run("memo_status", {});
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
    const run = (name, args) => fake.tools.get(name).execute(args, exec);

    assert.match(await run("memo_note", { text: "改用 zod 解析配置" }), /已记录/);
    assert.match(await run("memo_note", { text: "决定不上 redis", kind: "decision" }), /\[decision\]/);
    assert.match(await run("memo_note", { text: "   " }), /不能为空/);

    const status = await run("memo_status", {});
    assert.match(status, /决定不上 redis/);
    assert.match(status, /最近动作（2\/2 条）/);

    assert.match(await run("memo_bug_search", { term: "boom" }), /还没有 bug 记忆/);

    const logged = await run("memo_bug_log", { error_message: "EADDRINUSE: port 3000", root_cause: "旧进程没退", fix: "先 kill" });
    assert.match(logged, /bug-001/);
    const again = await run("memo_bug_log", { error_message: " eaddrinuse:  PORT 3000 " });
    assert.match(again, /同一症状第 2 次/);

    const found = await run("memo_bug_search", { term: "EADDRINUSE" });
    assert.match(found, /bug-001/);
    assert.match(found, /先 kill/);
    assert.match(await run("memo_bug_search", { term: "完全无关的东西" }), /没有匹配/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("/memo answers without spending a model turn", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const definition = fake.commands[0];
    const invocation = (rawInput) => ({ rawInput, agent: { session: { header: { cwd: base }, id: "session-test" } }, signal: new AbortController().signal });

    const empty = await definition.handler(invocation(""));
    assert.equal(empty.kind, "success");
    assert.match(empty.text, /还没有 \.memo\/STATUS\.md/);

    const noted = await definition.handler(invocation("note 从这里开始"));
    assert.equal(noted.kind, "success");

    const shown = await definition.handler(invocation(""));
    assert.match(shown.text, /从这里开始/);
    assert.match(shown.text, /最近动作/);

    const bad = await definition.handler(invocation("note"));
    assert.equal(bad.kind, "success", "`/memo note` without text is a status request, not a crash");
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
    await fake.tools.get("memo_handoff").execute({ root: target, now: "在 target 项目里" }, exec);
    assert.match(await fake.tools.get("memo_status").execute({ root: target }, exec), /在 target 项目里/);
    assert.match(await fake.tools.get("memo_status").execute({}, exec), /还没有 \.memo\/STATUS\.md/);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("memo_find revalidates the index instead of trusting a stale one", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(base);
    const run = (name, args) => fake.tools.get(name).execute(args, exec);

    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    await run("memo_scan", {});

    // A file the scan never saw, written by something that announced nothing —
    // exactly what a hook keyed on this process's own writes would miss.
    writeFileSync(join(base, "b.ts"), "export function beta() {}\n", "utf8");
    const found = await run("memo_find", { query: "beta" });
    assert.match(found, /b\.ts/);
    assert.match(found, /索引已自动同步：\+1 新文件/);

    // An edit to an indexed file is reflected too, and the rest is not re-read.
    const later = new Date(Date.now() + 5000);
    writeFileSync(join(base, "a.ts"), "export function renamed() {}\n", "utf8");
    utimesSync(join(base, "a.ts"), later, later);
    const edited = await run("memo_find", { query: "renamed" });
    assert.match(edited, /a\.ts/);
    assert.match(edited, /索引已自动同步：~1 改写/);

    // Nothing moved: the answer is silent about syncing.
    assert.doesNotMatch(await run("memo_find", { query: "renamed" }), /索引已自动同步/);
    assert.doesNotMatch(await run("memo_map", {}), /索引已自动同步/);

    // With revalidation turned off the index is exactly what the last scan
    // wrote — and the answer says nothing was synced, rather than implying it was.
    writeFileSync(join(base, "c.ts"), "export function gamma() {}\n", "utf8");
    const pinned = fakeContext();
    host.apply(pinned.ctx, { refresh: false });
    const stale = await pinned.tools.get("memo_find").execute({ query: "gamma" }, exec);
    assert.match(stale, /索引里没有匹配/);
    assert.doesNotMatch(stale, /索引已自动同步/);
    assert.match(await run("memo_find", { query: "gamma" }), /c\.ts/, "the default path does see it");
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
    await fake.tools.get("memo_handoff").execute({ now: "面板接线中" }, exec);
    await fake.tools.get("memo_scan").execute({}, exec);

    const filled = await request(state, { url: `/memo/state?root=${encodeURIComponent(base)}` });
    assert.equal(filled.status, 200);
    assert.equal(filled.json.initialized, true);
    assert.equal(filled.json.status.sections[0].body, "面板接线中");
    assert.equal(filled.json.index.present, true);
    assert.equal(filled.json.index.fileCount, 1);
    // The switches ride along with the state the panel is already reading. When
    // they did not, the view crashed on the missing field.
    assert.deepEqual(readSwitches(filled.json.config), { readGuard: true, refresh: true, exclude: [], readTools: ["read"], tools: undefined });
    // The catalogue and the registrations are the same set: a tool with no
    // switch would be unreachable from the panel, and a switch with no tool
    // would be a row that lies about what the host has.
    assert.deepEqual([...switchNames(filled.json.config)].sort(), [...fake.tools.keys()].sort());
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
    assert.match(refused.json.error, /memo_scan once in this project first/);
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

test("a big index is read whole instead of being cut off mid-JSON", { skip }, async () => {
  const base = scratchProject();
  try {
    const fake = fakeContext();
    host.apply(fake.ctx, {});
    const exec = agentIn(base);
    const run = (name, args) => fake.tools.get(name).execute(args, exec);

    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    await run("memo_scan", {});

    // A real repository's index passes 400 KB without trying; pad this one past
    // the per-file read cap, which is not the cap the index is read under.
    const indexFile = join(base, ".memo", "index.json");
    const index = JSON.parse(readFileSync(indexFile, "utf8"));
    index.descriptionPad = "x".repeat(500_000);
    writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf8");
    assert.ok(readFileSync(indexFile).length > 400_000);

    const found = await run("memo_find", { query: "alpha" });
    assert.doesNotMatch(found, /is not valid JSON/);
    assert.match(found, /a\.ts/);
    assert.doesNotMatch(await run("memo_map", {}), /没有可用的代码索引/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
