import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The host half against a *real* Cordis runtime.
 *
 * `test/host.test.mjs` drives this plugin with a fake Context: fast, and it
 * covers everything the plugin itself decides. But a fake cannot answer the
 * questions ownership rests on — whether a tool this plugin registers is really
 * owned by this plugin's fiber, and whether an effect created *after* `apply`
 * has returned (the read guard, toggled from the panel) really disposes what is
 * inside it. Those are properties of Cordis, not of this plugin, so this file
 * boots the real
 * `@deepseek-ai/cordis` with the real `@deepseek-ai/dsh-tools` registry and
 * stand-ins for the two registries the plugin consumes.
 *
 * A fake that "passes" here would prove nothing, which is exactly why the two
 * registries below are the only fakes left in the picture.
 *
 * Without `node_modules/@deepseek-ai` (a dev symlink to the deployment's own
 * install) the suite reports skipped instead of failing.
 */
let Context = null;
let Tools = null;
let host = null;
let importError = null;
try {
  const require = createRequire(import.meta.url);
  const toolsEntry = require.resolve("@deepseek-ai/dsh-tools");
  // Cordis is not this package's dependency: it is resolved the way the tools
  // package resolves it, so no path in here is tied to one deployment's hash.
  const cordisEntry = require.resolve("@deepseek-ai/cordis", { paths: [dirname(toolsEntry)] });
  ({ Context } = await import(pathToFileURL(cordisEntry).href));
  Tools = (await import("@deepseek-ai/dsh-tools")).default;
  host = await import("../src/index.ts");
} catch (error) {
  importError = error;
}

const skip = importError ? `harness packages not resolvable: ${importError.message}` : false;

/**
 * One plugin that provides one service, so the real runtime has something to
 * satisfy an `inject` with. `ctx.provide` is the same call the harness's own
 * boot uses for `dshHomePath`.
 */
const provider = (name, value) => ({
  name: `test-${name}`,
  apply(ctx) {
    ctx.provide(name, value);
  },
});

/**
 * The tools service is gated on `systemPrompt`; the plugin needs a `webServer`
 * it can register its three JSON routes on. Both are stubs, and both are on the
 * *host* side of the boundary — nothing about the plugin's own behaviour is
 * faked here.
 */
const systemPrompt = {
  tools() {
    return () => {};
  },
  section() {
    return () => {};
  },
  getSectionOrder() {
    return 0;
  },
};

/** Drive one registered route the way the HTTP carrier would. */
async function request(route, options: { body?: string; method?: string; url?: string } = {}) {
  const captured: any = {};
  const res = {
    writeHead(status) {
      captured.status = status;
    },
    end(body) {
      captured.body = body;
    },
  };
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
  return { status: captured.status, headers: captured.headers ?? {}, json: captured.body === undefined ? null : JSON.parse(String(captured.body)) };
}

test("the memo tool and its routes hold under real Cordis ownership", { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-cordis-"));
  const routes = [];
  const ctx = new Context();
  try {
    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    await ctx.plugin(Tools, {});
    await ctx.plugin(provider("systemPrompt", systemPrompt), {});
    await ctx.plugin(provider("webServer", { register: (route) => (routes.push(route), () => {}) }), {});
    // One command pinned off by the composition, which is what a switch has to
    // be able to turn back on afterwards.
    const fiber = await ctx.plugin(host, { subcommands: { scan: false } });

    /** What the model would be offered right now. */
    const offered = () => ctx.tools.schemas().map((schema) => schema.name).sort();
    assert.deepEqual(routes.map((route) => route.path).sort(), ["/memo/config", "/memo/scan", "/memo/state"]);
    assert.deepEqual(offered(), ["memo"], "one tool, whatever the switches say");

    const exec = { agent: { session: { header: { cwd: base }, id: "s1" } } };
    const memo = (command) => ctx.tools.get("memo").execute({ command }, exec);

    // The tool is really registered, and really executes.
    assert.match(await memo("status"), /还没有 \.memo\/STATUS\.md/);

    // The pinned-off command is refused by the host, not by the model's manners.
    assert.match(await memo("scan"), /被关掉了/);

    // Turn it on from the panel and the same call does the work.
    const config = routes.find((route) => route.path === "/memo/config");
    const on = await request(config, { method: "POST", body: JSON.stringify({ subcommands: { scan: true } }) });
    assert.equal(on.status, 200);
    assert.match(await memo("scan"), /已重建索引/);

    // Several at once, and the answer to the panel is the live state.
    const off = await request(config, { method: "POST", body: JSON.stringify({ subcommands: { scan: false, handoff: false } }) });
    assert.equal(off.status, 200);
    assert.deepEqual(off.json.config.subcommands[0], {
      id: "memory",
      commands: [
        { name: "status", on: true },
        { name: "handoff", on: false },
        { name: "note", on: true },
      ],
    });
    assert.match(await memo("handoff --now x"), /被关掉了/);

    // The panel's own state route reports the same switch, through the route
    // the browser actually calls.
    const panel = await request(routes.find((route) => route.path === "/memo/state"), { url: `/memo/state?root=${encodeURIComponent(base)}` });
    assert.equal(panel.json.config.subcommands[1].commands[0].on, false);

    // A patch naming a command this host does not have is refused whole, so a
    // typo cannot look like a switch that simply did nothing.
    const typo = await request(config, { method: "POST", body: JSON.stringify({ subcommands: { scan: true, nope: false } }) });
    assert.equal(typo.status, 400);
    assert.match(typo.json.error, /unknown command/);

    // And the whole thing is owned by this plugin's fiber: stopping it takes
    // every registration with it, which is what makes a reload safe.
    await fiber.dispose();
    assert.deepEqual(offered(), [], "disposing the plugin leaves no memo tool behind");
  } finally {
    await ctx.fiber.dispose();
    rmSync(base, { recursive: true, force: true });
  }
});
