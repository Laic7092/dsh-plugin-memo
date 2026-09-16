/**
 * dsh-plugin-memo — host half.
 *
 * Project memory for DeepSeek Harness, owned by this plugin end to end: it
 * defines the format, writes it, reads it, and needs no other program to do
 * either. The value it carries is the one thing a fresh session cannot
 * reconstruct from the code — where the work actually stands.
 *
 * This file is the *surface*: it registers one tool, one human command and the
 * panel routes, and hands every one of them to `./cli.ts`. The grammar and the
 * operations live there, so the model's `memo` tool and a person's `/memo`
 * line cannot drift apart — there is one implementation to keep honest.
 *
 * Why one tool instead of one per operation: a registered tool's description
 * and parameter schema sit in the model's context on *every* request, whether
 * or not the turn uses it. Eight tools bought eight descriptions on every turn
 * for eight operations a session uses a handful of times; one tool with one
 * string argument, and `memo help` on demand, is the same capability at a
 * fraction of the standing cost.
 *
 * Design rules held by this file:
 *  - it publishes no service, so it needs no `isolate` realm in a preset;
 *  - every write is atomic (see `./store.ts`), and every command that writes says
 *    so in its own help, because the model is the one deciding to run it;
 *  - all side effects live inside `apply` through Cordis lifecycle APIs, so
 *    stop/update leaves nothing behind;
 *  - the `/memo` human command exists so a person never has to ask a model for
 *    their own project's state — and it can now run every command the model can.
 *
 * @module dsh-plugin-memo
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isAbsolute, resolve } from "node:path";
import { MEMO_COMMAND_NAMES, MEMO_COMMANDS, runMemo } from "./cli.ts";
import { loadSqlite } from "./db.ts";
import { panelConfig, panelScan, panelState } from "./panel.ts";
import { createReadTracker, DEFAULT_READ_TOOLS, readTarget } from "./reads.ts";
import { DEFAULT_DIR, statOrNull, stamp } from "./store.ts";
import { TOKEN_MODES } from "./indexer.ts";
import { createTsAnalyzer } from "./ts-symbols.ts";
import type { MemoConfig, TokenMode } from "./types.ts";

export const name = "dsh-plugin-memo";
export const inject = ["tools"];

/** The calling session's working directory, read as one leaf scalar. */
function sessionCwd(exec) {
  try {
    const session = exec && exec.agent ? exec.agent.session : undefined;
    const header = session ? session.header : undefined;
    const cwd = header ? header.cwd : undefined;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  } catch {
    // A session shape we do not recognize falls back to the host cwd.
  }
  return undefined;
}

/** The calling session's id, recorded on journal entries and kept by the guard. */
function sessionIdOf(exec) {
  try {
    const agent = exec ? exec.agent : undefined;
    const id = agent ? agent.id ?? (agent.session ? agent.session.id : undefined) : undefined;
    return typeof id === "string" && id.length > 0 ? String(id) : null;
  } catch {
    return null;
  }
}

const textOutput = {
  schema: { type: "string" as const },
  render(_args, value) {
    return [{ type: "text" as const, text: typeof value === "string" ? value : String(value ?? "") }];
  },
};

/**
 * The tool's description — the whole standing cost of this plugin in a model's
 * context. It names the commands and says which of them write; the grammar
 * itself is one `memo help` away, so it does not have to be spent here.
 */
const TOOL_DESCRIPTION = [
  "Read and write this project's memory in <project>/.memo/: STATUS.md (where the work stands, what is next, open questions, approaches already rejected), the append-only journal, the recorded-bug log, and a code index.",
  `Pass one command line — ${MEMO_COMMANDS.map((command) => command.name).join(" · ")}. Run 'memo status' first when resuming work, and 'memo help <command>' to see one command’s own flags. ${MEMO_COMMANDS.filter((command) => command.write).map((command) => command.name).join(", ")} WRITE to disk; the rest only read.`,
  "Examples: 'status --notes 8' · 'find readTarget --budget 600' · 'find damage --callers 10' · \"handoff --now 'wiring the CLI' --next '- update README'\" · 'note decided to drop zod --kind decision' · 'bug-search EADDRINUSE' · \"bug-log --error 'ENOENT: no such file' --fix 'resolve before open'\".",
  "Every command takes --root PATH to point at another project; text with spaces goes in quotes.",
].join(" ");

export function apply(ctx: any, config: MemoConfig = {}) {
  const log = ctx.logger && typeof ctx.logger.info === "function"
    ? (message) => ctx.logger.info(message)
    : (message) => console.log(`[memo] ${message}`);
  // Which commands this host starts with. A composition pins one off with
  // `subcommands: { scan: false }`; the Memo view flips them at runtime.
  const pinned = config.subcommands !== null && typeof config.subcommands === "object" && !Array.isArray(config.subcommands) ? config.subcommands : {};
  const state = {
    dirName: typeof config.dirName === "string" && config.dirName.length > 0 ? config.dirName : DEFAULT_DIR,
    defaultRoot: typeof config.defaultRoot === "string" ? config.defaultRoot : undefined,
    readGuard: config.readGuard !== false,
    readTools: Array.isArray(config.readTools) && config.readTools.length > 0 ? config.readTools : DEFAULT_READ_TOOLS,
    // Extra directory names for the sweep, as the README always claimed.
    exclude: Array.isArray(config.exclude) ? config.exclude : [],
    // Revalidate the index before answering from it. On by default; off makes
    // memo find/map read exactly what memo scan last wrote.
    refresh: config.refresh !== false,
    // How every token number in the index is obtained. `estimated` is the
    // 4-chars-per-token guess and the default: an exact index parses a 6MB
    // vocabulary the first time it counts anything, which is a real cost to
    // impose on a project that only asked for a map.
    tokenizer: TOKEN_MODES.includes(config.tokenizer) ? config.tokenizer : "estimated",
    // One switch per command. Only `false` means anything: a command runs
    // unless somebody said otherwise. These no longer add or remove a tool —
    // there is only one tool — they make the CLI refuse that one command with a
    // message saying so, which is what the panel's switches now mean.
    subcommands: Object.fromEntries(MEMO_COMMAND_NAMES.map((commandName) => [commandName, pinned[commandName] !== false])),
  };
  for (const commandName of Object.keys(pinned)) {
    if (!MEMO_COMMAND_NAMES.includes(commandName)) log(`config.subcommands has an unknown command ${JSON.stringify(commandName)} — ignored`);
  }
  // The rename is worth saying out loud: a profile that still carries
  // `tools: { scan: false }` would otherwise look like a switch that did nothing.
  if (config.tools !== undefined) {
    log("config.tools is now config.subcommands — the switch gates one CLI subcommand, not one tool; the old key is ignored");
  }

  // The tree-sitter upgrade is resolved once per plugin instance and never
  // rejects: a missing optional dependency simply leaves the line-based
  // extractor in charge.
  let analyzerPromise = null;
  const analyzerFor = () => {
    if (analyzerPromise === null) analyzerPromise = createTsAnalyzer();
    return analyzerPromise;
  };
  analyzerFor()
    .then((analyzer) => {
      if (analyzer === null) log("code index: line-based extraction only (tree-sitter is unavailable)");
      else log(`code index: tree-sitter upgrade available for ${analyzer.grammars.join(", ")}`);
    })
    .catch(() => {});

  // The index's own capability, probed and reported the same way: a runtime
  // without node:sqlite loses the index commands, never the memory.
  loadSqlite()
    .then((DatabaseSync) => {
      log(DatabaseSync === null
        ? "code index: no node:sqlite in this runtime (Node >= 22.5) -- scan/find/map will say so; the memory commands are unaffected"
        : "code index: SQLite index ready at <project>/.memo/index.db");
    })
    .catch(() => {});

  /** Everything a command needs to run, wherever it was called from. */
  const envFor = async (exec) => ({
    state,
    cwd: sessionCwd(exec),
    session: sessionIdOf(exec),
    analyzer: await analyzerFor(),
    log,
  });

  /**
   * The one tool this plugin registers.
   *
   * Its whole argument surface is a string, which is the point: the schema a
   * model reads once covers every operation, and a new command costs nothing in
   * anyone's context until they ask for it.
   */
  ctx.tools.register(defineTool({
    name: "memo",
    description: TOOL_DESCRIPTION,
    parameters: {
      command: {
        type: "string",
        description: "The command line to run, without the leading 'memo': e.g. 'status', 'find indexer --budget 600', 'note decided to drop zod --kind decision', 'help scan'. Omit it for 'status'.",
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const result = await runMemo(command, await envFor(exec));
      return result.text;
    },
  }));

  /**
   * Turn one command on or off in the running host.
   *
   * The switch is enforced at the CLI, not hidden in the panel: a person who
   * turned `scan` off must not be able to get a scan out of the model by
   * asking nicely, and the model must be told why rather than watching the call
   * fail silently.
   * @returns false when no such command exists here.
   */
  const setCommand = (commandName, enabled) => {
    if (!Object.hasOwn(state.subcommands, commandName)) return false;
    state.subcommands[commandName] = enabled;
    return true;
  };

  // `/memo` — a person asking their own project where things stand, without
  // spending a model turn on it, and now able to run every command the model
  // can because both go through the same grammar. The registry is optional: a
  // composition without human-command adapters still gets the tool.
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.effect(
      () => commandCtx.commands.register({
        definitionId: "dsh-plugin-memo",
        name: "memo",
        description: "项目记忆：/memo [子命令]（不给就是 status），例如 /memo scan、/memo find readTarget、/memo note 一句话、/memo help",
        input: { hint: "status | scan | find <符号> | note <一句话> | help" },
        async handler(invocation) {
          const raw = String(invocation.rawInput ?? "").trim();
          const exec = { agent: invocation.agent };
          try {
            const result = await runMemo(raw, await envFor(exec));
            return result.ok ? { kind: "success", text: result.text } : { kind: "error", text: result.text };
          } catch (error) {
            return { kind: "error", text: error && error.message ? error.message : String(error) };
          }
        },
      }),
      "memo: /memo command",
    );
    log("human command registered: /memo (same grammar as the memo tool)");
  });

  // The settings panel's data path. Optional exactly like `commands`: a
  // composition with no web carrier still gets the tool and `/memo`.
  //
  // Reached through `ctx.inject`, never a `ctx.webServer` sampled once inside
  // `apply`: at profile boot this row activates before the carrier, so a
  // reference captured here would be permanently undefined and every panel
  // request would fall through to the SPA's 404. (That is exactly the bug the
  // OpenWolf plugin shipped with.)
  ctx.inject(["webServer"], (webCtx) => {
    const send = (res, status, value) => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      res.end(body);
    };
    const paramsOf = (req) => {
      try {
        return new URL(req.url ?? "/", "http://localhost").searchParams;
      } catch {
        return new URLSearchParams();
      }
    };
    const fail = (res, error) => send(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });

    // A bounded body reader for the one write route. The panel sends a small
    // JSON object; anything larger is a caller that is not the panel.
    const readBody = (req: any): Promise<{ ok: boolean; value?: any; error?: string }> => new Promise((resolveBody) => {
      let size = 0;
      const chunks = [];
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolveBody(value);
      };
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          finish({ ok: false, error: "body too large" });
          try {
            req.destroy();
          } catch {
            // Already gone.
          }
          return;
        }
        chunks.push(chunk);
      });
      req.on("error", () => finish({ ok: false, error: "request stream failed" }));
      req.on("end", () => {
        try {
          finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          finish({ ok: false, error: "body is not valid JSON" });
        }
      });
    });

    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: "/memo/state",
      async handler(req, res) {
        try {
          const params = paramsOf(req);
          // The live state already carries the counter; a `tokenizer` query
          // overrides it for this one revalidation, the way `memo find` takes
          // one. A value this host does not recognise is dropped, not guessed.
          const asked = params.get("tokenizer");
          const wanted = TOKEN_MODES.includes(asked) ? asked : undefined;
          // A named counter is not just for this one request. The panel asks for
          // the counter it has on every load, so honouring it once and then
          // reverting would rebuild the whole index twice per project open —
          // once up, once back. The host's own value moves instead, which is
          // what a switch that stays flipped is supposed to mean.
          if (wanted !== undefined && wanted !== state.tokenizer) {
            log(`token counter is now ${wanted} (asked for by the panel); the next scan or refresh rebuilds <project>/.memo/index.json`);
            state.tokenizer = wanted as TokenMode;
          }
          const value = await panelState(
            params.get("root"),
            // The live plugin state itself, not a hand-built snapshot of it. A
            // snapshot has to be kept in step with every switch added later, and
            // the field it forgot is reported to the panel as a wrong value —
            // which is exactly how the subcommand switches went missing once
            // already. `panelState`/`panelConfig` read only the keys they name.
            params.get("refresh") === "1"
              ? { ...state, refresh: true, tokenizer: (wanted ?? state.tokenizer) as TokenMode }
              : state,
            await analyzerFor(),
          );
          send(res, value.ok ? 200 : 400, value);
        } catch (error) {
          fail(res, error);
        }
      },
    }), "memo: /memo/state route");

    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: "/memo/scan",
      async handler(req, res) {
        if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST /memo/scan" });
        try {
          const value = await panelScan(
            paramsOf(req).get("root"),
            state,
            await analyzerFor(),
          );
          send(res, value.ok ? 200 : 400, value);
        } catch (error) {
          fail(res, error);
        }
      },
    }), "memo: /memo/scan route");

    // The panel's switches. `GET` reports the configuration actually in force
    // here, not what the panel last asked for: after a profile restart the two
    // can differ, and the panel must never show a switch as on when the host
    // disagrees. `POST` accepts any subset of the keys, including `subcommands`.
    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: "/memo/config",
      async handler(req, res) {
        try {
          if (req.method === "GET") return send(res, 200, { ok: true, config: panelConfig(state) });
          if (req.method !== "POST") return send(res, 405, { ok: false, error: "GET or POST /memo/config" });

          const body = await readBody(req);
          if (!body.ok) return send(res, 400, { ok: false, error: body.error });
          const wanted = body.value;
          if (wanted === null || typeof wanted !== "object" || Array.isArray(wanted)) {
            return send(res, 400, { ok: false, error: "body must be a JSON object" });
          }
          if (typeof wanted.readGuard === "boolean") setGuard(wanted.readGuard);
          if (typeof wanted.refresh === "boolean") state.refresh = wanted.refresh;
          if (wanted.tokenizer !== undefined) {
            if (!TOKEN_MODES.includes(wanted.tokenizer)) {
              return send(res, 400, { ok: false, error: `tokenizer must be one of ${TOKEN_MODES.join(", ")}` });
            }
            const changedCounter = state.tokenizer !== wanted.tokenizer;
            state.tokenizer = wanted.tokenizer;
            // The counts already on disk are in the other unit. Saying so beats
            // letting the panel show a budget spent in a currency it is not
            // holding; the next scan or lookup rebuilds the index.
            if (changedCounter) log(`token counter is now ${state.tokenizer}; the next scan or refresh rebuilds <project>/.memo/index.json`);
          }
          if (Array.isArray(wanted.exclude)) {
            state.exclude = wanted.exclude.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
          }
          if (wanted.subcommands !== undefined) {
            const asked = wanted.subcommands;
            if (asked === null || typeof asked !== "object" || Array.isArray(asked)) {
              return send(res, 400, { ok: false, error: "subcommands must be an object of command name -> boolean" });
            }
            const entries = Object.entries(asked);
            // Validate the whole set before applying any of it: a patch that is
            // half in force is worse than one that was refused outright, and a
            // typo must not look like a switch that did nothing.
            for (const [commandName, enabled] of entries) {
              if (typeof enabled !== "boolean") return send(res, 400, { ok: false, error: `subcommands.${commandName} must be a boolean` });
              if (!Object.hasOwn(state.subcommands, commandName)) return send(res, 400, { ok: false, error: `unknown command ${JSON.stringify(commandName)}` });
            }
            for (const [commandName, enabled] of entries) setCommand(commandName, enabled);
          }
          const off = MEMO_COMMAND_NAMES.filter((commandName) => state.subcommands[commandName] === false);
          log(`config changed: readGuard=${state.readGuard} refresh=${state.refresh} tokenizer=${state.tokenizer} exclude=[${state.exclude.join(", ")}] commandsOff=[${off.join(", ")}]`);
          send(res, 200, { ok: true, config: panelConfig(state) });
        } catch (error) {
          fail(res, error);
        }
      },
    }), "memo: /memo/config route");

    log("panel data routes registered: GET /memo/state, POST /memo/scan, GET|POST /memo/config");
  });

  // Repeated-read interception. This is the half of OpenWolf's read guarding
  // that a spill/dedup plugin does not already cover: a second read of the same
  // unchanged window is refused with a pointer to what the session already has.
  //
  // One tracker and one `setGuard` for the whole plugin lifetime: the listeners
  // are a managed effect so the panel can turn the guard on and off at runtime,
  // while the memory of what was read survives the switch. Rebuilding the
  // tracker on every toggle would hand the caller a free re-read of everything
  // it had already paid for.
  const tracker = createReadTracker();
  let guardEffect = null;
  const setGuard = (enabled) => {
    state.readGuard = enabled;
    if (guardEffect !== null) {
      guardEffect();
      guardEffect = null;
    }
    if (!enabled) {
      log("repeated-read guard off");
      return;
    }
    guardEffect = ctx.effect(() => {
      const disposers = [];
      const absolutePath = (exec, target) => {
        if (isAbsolute(target.path)) return target.path;
        return resolve(sessionCwd(exec) ?? process.cwd(), target.path);
      };

      disposers.push(ctx.on("tools/pre-execute", async (exec, next) => {
        try {
          const target = readTarget(exec.name, exec.arguments, state.readTools);
          if (target !== null) {
            const key = sessionIdOf(exec);
            if (key !== null) {
              const reason = tracker.check(key, target, statOrNull(absolutePath(exec, target)));
              if (reason !== null) return { kind: "deny", reason };
            }
          }
        } catch {
          // A guard that throws must never block the call it was watching.
        }
        return next();
      }));

      // Record only reads that actually succeeded, so a failed read can never
      // make a later legitimate one look like a duplicate.
      disposers.push(ctx.on("tools/result", (exec, result) => {
        try {
          if (result && result.isError === true) return;
          const target = readTarget(exec.name, exec.arguments, state.readTools);
          if (target === null) return;
          const key = sessionIdOf(exec);
          if (key === null) return;
          tracker.remember(key, target, statOrNull(absolutePath(exec, target)), stamp());
        } catch {
          // Bookkeeping only.
        }
      }));

      // A compaction can drop the very content this guard assumes is still in
      // context, so that session's records go with it.
      disposers.push(ctx.on("session/event", (session, event) => {
        try {
          const type = event && typeof event.type === "string" ? event.type : "";
          if (type.startsWith("compaction/") && session && typeof session.id === "string") tracker.clear(session.id);
        } catch {
          // Bookkeeping only.
        }
      }));

      log(`repeated-read guard on for tool(s): ${state.readTools.join(", ")}`);

      // One disposer for the whole guard: `ctx.effect` owns it, and turning the
      // switch off disposes and (if it comes back) re-creates this effect. Being
      // explicit about removing the listeners keeps that reversible regardless
      // of how nested registrations are scoped.
      return () => {
        for (const dispose of disposers.splice(0)) dispose();
      };
    }, "memo: repeated-read guard");
  };

  setGuard(state.readGuard);

  const off = MEMO_COMMAND_NAMES.filter((commandName) => state.subcommands[commandName] === false);
  log(
    `memo CLI: 1 tool, ${MEMO_COMMAND_NAMES.length - off.length}/${MEMO_COMMAND_NAMES.length} subcommands on${off.length > 0 ? ` (off: ${off.join(", ")})` : ""}; project memory in <project>/${state.dirName}/`,
  );
  log(`memo commands: ${MEMO_COMMANDS.map((command) => command.name).join(", ")}`);
}

