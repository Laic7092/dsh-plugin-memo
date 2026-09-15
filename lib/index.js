/**
 * dsh-plugin-memo — host half.
 *
 * Project memory for DeepSeek Harness, owned by this plugin end to end: it
 * defines the format, writes it, reads it, and needs no other program to do
 * either. The value it carries is the one thing a fresh session cannot
 * reconstruct from the code — where the work actually stands.
 *
 * Design rules held by this file:
 *  - it publishes no service, so it needs no `isolate` realm in a preset;
 *  - every write is atomic, and every write tool states in its description that
 *    it writes, because the model is the one deciding to call it;
 *  - all side effects live inside `apply` through Cordis lifecycle APIs, so
 *    stop/update leaves nothing behind;
 *  - the `/memo` human command exists so a person never has to ask a model for
 *    their own project's state.
 *
 * @module dsh-plugin-memo
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { basename, isAbsolute, resolve } from "node:path";
import { appendBug, loadBugs, recentBugs, searchBugs } from "./bugs.js";
import { buildIndex, buildMap, fileDetail, findInIndex, indexMeta, refreshIndex, staleFiles, TOKEN_MODES, TS_MIN_TOKENS } from "./indexer.js";
import { appendNote, readNotes } from "./journal.js";
import { MEMO_TOOL_NAMES, panelConfig, panelScan, panelState } from "./panel.js";
import { createReadTracker, DEFAULT_READ_TOOLS, readTarget } from "./reads.js";
import { readStatus, sectionBody, STATUS_SECTIONS, patchStatus, writeStatus } from "./status.js";
import { DEFAULT_DIR, INDEX_MAX_BYTES, clampInt, createMemoDir, findProjectRoot, isFile, memoPaths, readJson, readText, stamp, statOrNull, writeJsonAtomic } from "./store.js";
import { createTsAnalyzer } from "./ts-symbols.js";

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

function resolveProject(exec, explicitRoot, dirName) {
  if (typeof explicitRoot === "string" && explicitRoot.trim().length > 0) {
    return findProjectRoot(resolve(explicitRoot.trim()), dirName);
  }
  return findProjectRoot(sessionCwd(exec) ?? process.cwd(), dirName);
}

const rootParameter = {
  type: "string",
  description: "Absolute path of the project. Defaults to the calling session's working directory (and its nearest ancestor holding .memo/).",
};

const textOutput = {
  schema: { type: "string" },
  render(_args, value) {
    return [{ type: "text", text: typeof value === "string" ? value : String(value ?? "") }];
  },
};

function lines(...parts) {
  return parts.filter((part) => typeof part === "string" && part.length > 0).join("\n");
}

/** STATUS.md as a model reads it: the four sections, labelled and attributed. */
function renderStatusText(project, paths, status, notes, bugs) {
  const out = [`memo · ${project.root}`];
  const dirName = basename(paths.dir);
  out.push(status.present
    ? `STATUS.md 最后更新：${status.updated ?? "未知"}`
    : `还没有 ${dirName}/STATUS.md —— 用 memo_handoff 写第一份。`);
  out.push("");
  if (status.present) {
    for (const title of STATUS_SECTIONS) {
      const body = sectionBody(status, title);
      out.push(`## ${title}`, body ?? "（空）", "");
    }
    const extra = status.sections.filter((section) => !STATUS_SECTIONS.includes(section.title));
    for (const section of extra) out.push(`## ${section.title}`, section.body || "（空）", "");
  }

  out.push(bugs.present ? `bug 记忆：${bugs.bugs.length} 条` : "bug 记忆：还没建（memo_bug_log 会创建）");
  for (const bug of recentBugs(bugs.bugs, 3)) {
    out.push(`  ${bug.id} ×${bug.occurrences ?? 1}  ${bug.error_message}`);
    if (bug.fix) out.push(`      fix: ${bug.fix}`);
  }

  const indexStat = statOrNull(paths.index);
  out.push(indexStat === null
    ? "代码索引：还没建（memo_scan 会建）"
    : `代码索引：${fmt(indexStat.size)} 字节，改于 ${new Date(indexStat.mtimeMs).toISOString()}`);

  out.push("", notes.present ? `最近动作（${notes.notes.length}/${notes.total} 条）` : "最近动作：还没有");
  for (const note of notes.notes) out.push(`  ${note.at}  [${note.kind}]  ${note.text}`);
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function renderBugs(term, found) {
  if (found.length === 0) return `没有匹配 "${term}" 的历史修复。`;
  const out = [`匹配 "${term}"：${found.length} 条`, ""];
  for (const bug of found) {
    out.push(`${bug.id}  ×${bug.occurrences ?? 1}  ${bug.error_message}`);
    if (bug.root_cause) out.push(`  cause: ${bug.root_cause}`);
    if (bug.fix) out.push(`  fix:   ${bug.fix}`);
    if (bug.file) out.push(`  file:  ${bug.file}${Number.isFinite(bug.line) ? `:${bug.line}` : ""}`);
    if (Array.isArray(bug.tags) && bug.tags.length > 0) out.push(`  tags:  ${bug.tags.join(", ")}`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");

function loadIndex(paths) {
  if (!isFile(paths.index)) return { ok: false, index: null, error: `${paths.index} 还不存在——先跑 memo_scan` };
  const stat = statOrNull(paths.index);
  if (stat !== null && stat.size > INDEX_MAX_BYTES) {
    return { ok: false, index: null, error: "index.json 大得不正常，重新跑一次 memo_scan" };
  }
  const file = readJson(paths.index, null, INDEX_MAX_BYTES);
  if (!file.ok) return { ok: false, index: null, error: file.error };
  const value = file.value;
  if (!value || typeof value !== "object" || typeof value.files !== "object" || value.files === null) {
    return { ok: false, index: null, error: "index.json 的形状看不懂——重新跑一次 memo_scan" };
  }
  return { ok: true, index: value, error: null };
}

/**
 * Load the index and, unless turned off, bring it up to date before answering.
 *
 * Revalidating here rather than in a watcher is deliberate: the read path is
 * the only place that actually needs the index to be right, and a watcher would
 * have to enumerate every way a file can change — while missing the ones that
 * do not go through the harness at all. See `refreshIndex` for what the sweep
 * costs and why it is stronger than a write hook.
 */
async function openIndex(paths, state, analyzer) {
  const loaded = loadIndex(paths);
  if (!loaded.ok || !state.refresh) return { ...loaded, sync: null };
  let fresh;
  try {
    fresh = await refreshIndex(loaded.index, { exclude: state.exclude, analyzer, tokenizer: state.tokenizer });
  } catch (error) {
    // A refresh that throws must not cost the caller its answer: hand back the
    // index we have and say plainly that it may be behind.
    return { ...loaded, sync: { failed: error && error.message ? error.message : String(error) } };
  }
  if (fresh.changed > 0) {
    const write = writeJsonAtomic(paths.index, fresh.index);
    // Answer from memory either way; only the on-disk copy is at stake.
    if (!write.ok) return { ok: true, index: fresh.index, error: null, sync: { ...fresh, writeError: write.error } };
  }
  return { ok: true, index: fresh.index, error: null, sync: fresh };
}

/** One trailing line saying what the automatic revalidation did, or "". */
function renderSync(sync) {
  if (sync === null || sync === undefined) return "";
  if (sync.failed !== undefined) return `（索引自动同步失败：${sync.failed} —— 用 memo_scan 重建）`;
  if (sync.rebuilt === true) return `（索引格式已升级，整份重建：${fmt(sync.changed)} 个文件）`;
  if (sync.changed === 0) return "";
  const parts = [];
  if (sync.added.length > 0) parts.push(`+${sync.added.length} 新文件`);
  if (sync.updated.length > 0) parts.push(`~${sync.updated.length} 改写`);
  if (sync.removed.length > 0) parts.push(`-${sync.removed.length} 移除`);
  return `（索引已自动同步：${parts.join(" · ")}${sync.writeError ? `；但写回失败：${sync.writeError}` : ""}）`;
}

/** Append the sync line to an answer, when there is one. */
function withSync(text, sync) {
  const line = renderSync(sync);
  return line.length === 0 ? text : `${text.trimEnd()}\n${line}\n`;
}

/**
 * A token count, worded for the unit it is actually in. Two counters produce
 * these numbers and they disagree by design, so "约" is not decoration: it is
 * the difference between a measurement and a documented guess. The index says
 * which one it holds; a caller that did not say keeps the hedged form.
 */
function tokenAmount(count, unit) {
  return unit === "exact" ? `${fmt(count)} tokens` : `约 ${fmt(count)} tokens`;
}

function renderScan(paths, index, stale, durationMs) {
  const meta = indexMeta(index);
  const out = [
    `已重建索引 · ${paths.index}`,
    `${fmt(meta.fileCount)} 个文件 · ${fmt(meta.symbolCount)} 个符号 · ${tokenAmount(meta.totalTokens, meta.tokens)} · 用时 ${durationMs} ms`,
    `符号来源：${index.symbolSource ?? "regex"}（tree-sitter 升级 ${TS_MIN_TOKENS} tokens 以上的文件；其余与失败回退都用行内启发式）`,
    "",
  ];
  if (stale.changedCount > 0 || stale.missingCount > 0) {
    out.push(`索引落后于磁盘：${stale.changedCount} 个文件改过、${stale.missingCount} 个已消失。`);
    for (const rel of stale.changed.slice(0, 5)) out.push(`  改过  ${rel}`);
    for (const rel of stale.missing.slice(0, 5)) out.push(`  没了  ${rel}`);
  } else {
    out.push("索引与磁盘一致。");
  }
  const top = Object.entries(index.files)
    .sort((a, b) => b[1].importance - a[1].importance)
    .slice(0, 5);
  if (top.length > 0) {
    out.push("", "最重要的文件（import 图 PageRank）：");
    for (const [rel, file] of top) {
      out.push(`  ${file.importance.toFixed(2)}  ${rel}  ${file.symbols.length} 符号${file.description ? `  ${file.description}` : ""}`);
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function renderFind(query, result, meta) {
  if (result.matches.length === 0) {
    return `索引里没有匹配 "${query}" 的符号或路径（索引共 ${fmt(meta.fileCount)} 个文件，${fmt(meta.symbolCount)} 个符号）。`;
  }
  const out = [
    `匹配 "${query}" · ${result.matches.length}/${fmt(result.total)} 条 · 约 ${fmt(result.spent)}/${fmt(result.budget)} tokens${result.truncated ? "（被预算截断）" : ""}`,
    "",
  ];
  for (const match of result.matches) {
    out.push(`${match.line}  ${match.kind}${match.symbol ? ` ${match.symbol.name}` : ""}  [${match.importance.toFixed(2)}]`);
    if (match.description) out.push(`    ${match.description}`);
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function renderFileDetail(detail) {
  const out = [
    `${detail.relPath}  ${detail.lines} 行 · 约 ${fmt(detail.tokens)} tokens · importance ${Number(detail.importance ?? 0).toFixed(2)}`,
  ];
  if (detail.description) out.push(detail.description);
  out.push("");
  if (detail.symbols.length === 0) out.push("（这个文件里没有提取到符号）");
  for (const symbol of detail.symbols) {
    out.push(`  ${String(symbol.line).padStart(4)}-${String(symbol.endLine).padEnd(4)}  ${symbol.kind.padEnd(9)} ${symbol.name}`);
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function renderMap(map) {
  if (map.mode === "rollup") {
    if (map.dirs.length === 0) return "索引里还没有文件——先跑 memo_scan。";
    const out = [`项目地图（按目录）· ${tokenAmount(map.spent, map.tokens)}/${fmt(map.budget)} tokens`, ""];
    for (const bucket of map.dirs) {
      out.push(`${bucket.dir}/  ${bucket.files} 个文件 · ${tokenAmount(bucket.tokens, map.tokens)} · 代表：${bucket.best ? bucket.best.relPath : "-"}`);
    }
    if (map.truncated) out.push("", `（另有 ${map.total - map.dirs.length} 个目录未列出）`);
    return `${out.join("\n").trimEnd()}\n`;
  }
  if (map.files.length === 0) return `没有匹配 "${map.focus}" 的文件。`;
  const out = [
    `聚焦地图 "${map.focus}" · ${map.files.length}/${fmt(map.total)} 个文件 · ${tokenAmount(map.spent, map.tokens)}/${fmt(map.budget)} tokens${map.truncated ? "（被预算截断）" : ""}`,
    "",
  ];
  for (const file of map.files) {
    out.push(`${file.relPath}  [${Number(file.importance ?? 0).toFixed(2)}]  ${file.symbols} 符号 · ${tokenAmount(file.tokens, map.tokens)}`);
    if (file.description) out.push(`    ${file.description}`);
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** The `/memo` body, shared by the command and the status tool's wording. */
function commandStatus(state, exec, explicitRoot, noteLimit) {
  const project = resolveProject(exec, explicitRoot, state.dirName);
  const paths = memoPaths(project.root, state.dirName);
  return {
    project,
    paths,
    status: readStatus(paths),
    notes: readNotes(paths, noteLimit),
    bugs: loadBugs(paths),
  };
}

export function apply(ctx, config = {}) {
  const log = ctx.logger && typeof ctx.logger.info === "function"
    ? (message) => ctx.logger.info(message)
    : (message) => console.log(`[memo] ${message}`);
  // Which tools this host starts with. A composition pins one off with
  // `tools: { memo_scan: false }`; the Memo view flips them at runtime.
  const pinned = config.tools !== null && typeof config.tools === "object" && !Array.isArray(config.tools) ? config.tools : {};
  const state = {
    dirName: typeof config.dirName === "string" && config.dirName.length > 0 ? config.dirName : DEFAULT_DIR,
    defaultRoot: typeof config.defaultRoot === "string" ? config.defaultRoot : undefined,
    readGuard: config.readGuard !== false,
    readTools: Array.isArray(config.readTools) && config.readTools.length > 0 ? config.readTools : DEFAULT_READ_TOOLS,
    // Extra directory names for the sweep, as the README always claimed.
    exclude: Array.isArray(config.exclude) ? config.exclude : [],
    // Revalidate the index before answering from it. On by default; off makes
    // memo_find/memo_map read exactly what memo_scan last wrote.
    refresh: config.refresh !== false,
    // How every token number in the index is obtained. `estimated` is the
    // 4-chars-per-token guess and the default: an exact index parses a 6MB
    // vocabulary the first time it counts anything, which is a real cost to
    // impose on a project that only asked for a map.
    tokenizer: TOKEN_MODES.includes(config.tokenizer) ? config.tokenizer : "estimated",
    // One switch per tool. Only `false` means anything: a tool is on unless
    // somebody said otherwise.
    tools: Object.fromEntries(MEMO_TOOL_NAMES.map((toolName) => [toolName, pinned[toolName] !== false])),
  };
  for (const name of Object.keys(pinned)) {
    if (!MEMO_TOOL_NAMES.includes(name)) log(`config.tools has an unknown tool ${JSON.stringify(name)} — ignored`);
  }
  const rootFor = (exec, explicit) => explicit ?? (sessionCwd(exec) === undefined ? state.defaultRoot : undefined);

  // Every definition this plugin owns, and the disposer that takes each one back
  // out. `tools.register` returns exactly that disposer, and what it registers
  // belongs to this plugin's fiber — so a tool switched off at runtime and a
  // plugin that is stopped are both served by the same call.
  const toolBook = new Map();
  const toolDisposers = new Map();
  const registerMemoTool = (definition) => {
    toolBook.set(definition.name, definition);
    if (state.tools[definition.name] === false) return;
    toolDisposers.set(definition.name, ctx.tools.register(definition));
  };
  /**
   * Turn one tool on or off in the running host.
   *
   * Making the tool actually leave the registry is the point: a switch that only
   * hid a row in the panel would leave the model reading a description for a
   * tool it can no longer call.
   * @returns false when no such tool exists here.
   */
  const setTool = (toolName, enabled) => {
    const definition = toolBook.get(toolName);
    if (definition === undefined) return false;
    state.tools[toolName] = enabled;
    const existing = toolDisposers.get(toolName);
    if (existing !== undefined) {
      existing();
      toolDisposers.delete(toolName);
    }
    if (enabled) toolDisposers.set(toolName, ctx.tools.register(definition));
    return true;
  };

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

  registerMemoTool(defineTool({
    name: "memo_status",
    description:
      "Show this project's .memo/ memory: STATUS.md (where the work stands, what is next, open questions, do-not-repeat), the newest journal entries and the recorded-bug count. Read this first when resuming work, before re-deriving project state from the code.",
    parameters: {
      notes: { type: "number", description: "How many recent journal entries to include (default 5)." },
      root: rootParameter,
    },
    output: textOutput,
    execute(args, exec) {
      const { project, paths, status, notes, bugs } = commandStatus(state, exec, rootFor(exec, args.root), clampInt(args.notes, 1, 50, 5));
      return renderStatusText(project, paths, status, notes, bugs);
    },
  }));

  registerMemoTool(defineTool({
    name: "memo_handoff",
    description:
      "Write STATUS.md — the handoff a later session reads first. WRITES to <project>/.memo/STATUS.md, creating the directory if needed. Only the sections you pass are replaced, so a section you leave out keeps whatever is already there; call it when a phase of work finishes, not after every step.",
    parameters: {
      now: { type: "string", description: "Where the work stands right now (replaces the 现在在哪 section)." },
      next: { type: "string", description: "What the next session should pick up (replaces the 下一步 section)." },
      open: { type: "string", description: "Questions or decisions still unresolved (replaces the 未决问题 section)." },
      avoid: { type: "string", description: "Approaches already tried and rejected (replaces the 不要重犯 section)." },
      root: rootParameter,
    },
    output: textOutput,
    execute(args, exec) {
      const project = resolveProject(exec, rootFor(exec, args.root), state.dirName);
      const paths = createMemoDir(memoPaths(project.root, state.dirName));
      const at = stamp();
      const existing = readStatus(paths);
      const updated = patchStatus(
        existing.present ? existing.text : "",
        project.root.split("/").pop() || project.root,
        { 现在在哪: args.now, 下一步: args.next, 未决问题: args.open, 不要重犯: args.avoid },
        at,
      );
      const write = writeStatus(paths, updated);
      if (!write.ok) return `写 ${paths.status} 失败：${write.error}`;
      const written = readStatus(paths);
      const notes = readNotes(paths, 3);
      const bugs = loadBugs(paths);
      return lines(`已更新 ${paths.status}`, "", renderStatusText(project, paths, written, notes, bugs));
    },
  }));

  registerMemoTool(defineTool({
    name: "memo_note",
    description:
      "Append one line to the project's journal (<project>/.memo/journal.jsonl) — a decision made, a path taken, something worth remembering next session. WRITES, creating the directory if needed. Cheap and append-only: prefer this over rewriting STATUS.md mid-phase.",
    parameters: {
      text: { type: "string", required: true, description: "One line: what happened or what was decided." },
      kind: { type: "string", enum: ["note", "decision", "todo"], description: "Entry kind (default note)." },
      root: rootParameter,
    },
    output: textOutput,
    execute(args, exec) {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (text.length === 0) return "`text` 不能为空。";
      const project = resolveProject(exec, rootFor(exec, args.root), state.dirName);
      const paths = createMemoDir(memoPaths(project.root, state.dirName));
      const at = stamp();
      const session = exec && exec.agent && exec.agent.session ? exec.agent.session.id ?? null : null;
      const write = appendNote(paths, { at, session: session === null ? null : String(session), kind: args.kind ?? "note", text });
      if (!write.ok) return `写 ${paths.journal} 失败：${write.error}`;
      const notes = readNotes(paths, 1);
      const total = notes.present ? notes.total : 1;
      return `已记录（journal 共 ${total} 条）：${at}  [${args.kind ?? "note"}]  ${text}`;
    },
  }));

  registerMemoTool(defineTool({
    name: "memo_bug_search",
    description:
      "Search the project's recorded fixes (.memo/bugs.json) for a symptom, error text or area, ranked with repeats weighted. Run this before fixing a bug so a previously recorded cause and fix can be reused.",
    parameters: {
      term: { type: "string", required: true, description: "Error text, symptom or area to search for." },
      limit: { type: "number", description: "Maximum matches (default 5)." },
      root: rootParameter,
    },
    output: textOutput,
    execute(args, exec) {
      const project = resolveProject(exec, rootFor(exec, args.root), state.dirName);
      const paths = memoPaths(project.root, state.dirName);
      const bugs = loadBugs(paths);
      if (!bugs.ok) return `这个项目还没有 bug 记忆：${bugs.error}。修完 bug 后用 memo_bug_log 记第一条。`;
      const found = searchBugs(bugs.bugs, args.term, clampInt(args.limit, 1, 25, 5));
      return renderBugs(String(args.term ?? ""), found);
    },
  }));

  registerMemoTool(defineTool({
    name: "memo_bug_log",
    description:
      "Record a fix in <project>/.memo/bugs.json so a later session finds the cause and the fix instead of rediscovering them. WRITES, creating the directory if needed. The symptom is the match key: recording the same error again bumps its occurrence count rather than adding a duplicate.",
    parameters: {
      error_message: { type: "string", required: true, description: "The error text or symptom, as it appeared." },
      root_cause: { type: "string", description: "What actually caused it." },
      fix: { type: "string", description: "What fixed it." },
      file: { type: "string", description: "Project-relative file where it showed up." },
      line: { type: "number", description: "Line number, when known." },
      tags: { type: "array", items: { type: "string" }, description: "Short tags for later retrieval." },
      root: rootParameter,
    },
    output: textOutput,
    execute(args, exec) {
      const project = resolveProject(exec, rootFor(exec, args.root), state.dirName);
      const paths = createMemoDir(memoPaths(project.root, state.dirName));
      const result = appendBug(paths, {
        errorMessage: args.error_message,
        rootCause: args.root_cause,
        fix: args.fix,
        file: args.file,
        line: args.line,
        tags: Array.isArray(args.tags) ? args.tags : [],
      });
      if (!result.ok) return `写 ${paths.bugs} 失败：${result.error}`;
      return result.updated
        ? `已记录：${result.id}（同一症状第 ${result.occurrences} 次；共 ${result.total} 条）`
        : `已记录：${result.id}（共 ${result.total} 条）`;
    },
  }));

  registerMemoTool(defineTool({
    name: "memo_scan",
    description:
      "Build this project's code index (<project>/.memo/index.json): every source file with its line count, token count, opening-comment description, symbols with exact line ranges, and an importance score from the import graph. Tokens are exact DeepSeek V4 tokens when the host is configured with `tokenizer: exact`, and a documented ~4-characters-per-token estimate otherwise — the index records which one it used. WRITES the index. Run it once to create the index; afterwards memo_find and memo_map keep it current on their own, so reach for this again to rebuild from scratch (after a big refactor, a move, or if the index ever looks wrong).",
    parameters: {
      exclude: { type: "array", items: { type: "string" }, description: "Extra directory names to skip, on top of the built-in list (node_modules, .git, dist, build, …)." },
      root: rootParameter,
    },
    output: textOutput,
    async execute(args, exec) {
      const project = resolveProject(exec, rootFor(exec, args.root), state.dirName);
      const started = Date.now();
      const analyzer = await analyzerFor();
      const index = await buildIndex(project.root, {
        exclude: [...state.exclude, ...(Array.isArray(args.exclude) ? args.exclude : [])],
        analyzer,
        tokenizer: state.tokenizer,
        log,
      });
      const paths = createMemoDir(memoPaths(project.root, state.dirName));
      const write = writeJsonAtomic(paths.index, index);
      if (!write.ok) return `写 ${paths.index} 失败：${write.error}`;
      return renderScan(paths, index, staleFiles(index, 5), Date.now() - started);
    },
  }));

  registerMemoTool(defineTool({
    name: "memo_find",
    description:
      "Locate code through the project index instead of reading files: a ranked, token-capped shortlist of symbols and paths, each with its exact line range. Use `query` for a symbol or path fragment, or `file` for one file's description and symbol ranges — then read just that range. Needs an index; run memo_scan first. The index is revalidated before every answer (one stat per file, and only files that moved are re-parsed), so edits made by any means — bash, git, an editor outside this process — are reflected without re-running memo_scan.",
    parameters: {
      query: { type: "string", description: "Symbol or path fragment to look for." },
      file: { type: "string", description: "When set, return the indexed description and symbol ranges for this one project-relative path instead of a search." },
      budget: { type: "number", description: "Output token budget for the shortlist (default 1000)." },
      root: rootParameter,
    },
    output: textOutput,
    async execute(args, exec) {
      const project = resolveProject(exec, rootFor(exec, args.root), state.dirName);
      const paths = memoPaths(project.root, state.dirName);
      const loaded = await openIndex(paths, state, await analyzerFor());
      if (!loaded.ok) return `没有可用的代码索引：${loaded.error}`;

      if (typeof args.file === "string" && args.file.trim().length > 0) {
        const detail = fileDetail(loaded.index, args.file.trim());
        if (detail === null) return `索引里没有 ${args.file}。重新跑 memo_scan，或者直接用 grep/read。`;
        return withSync(renderFileDetail(detail), loaded.sync);
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query.length === 0) return "给一个 `query`（符号名或路径片段），或者用 `file` 传一个具体路径。";
      const result = findInIndex(loaded.index, query, { budgetTokens: clampInt(args.budget, 100, 8000, 1000) });
      return withSync(renderFind(query, result, indexMeta(loaded.index)), loaded.sync);
    },
  }));

  registerMemoTool(defineTool({
    name: "memo_map",
    description:
      "Project map from the index: with `focus`, the best-matching files with their descriptions and importance; without it, a per-directory rollup of file counts and token weight. Cheaper than walking the tree when you need orientation. Needs an index; run memo_scan first. Revalidated before every answer like memo_find — files that did not change are never re-read.",
    parameters: {
      focus: { type: "string", description: "Comma- or space-separated terms (paths, symbols, topics). Omit for a directory rollup." },
      budget: { type: "number", description: "Output token budget (default 1200)." },
      root: rootParameter,
    },
    output: textOutput,
    async execute(args, exec) {
      const project = resolveProject(exec, rootFor(exec, args.root), state.dirName);
      const paths = memoPaths(project.root, state.dirName);
      const loaded = await openIndex(paths, state, await analyzerFor());
      if (!loaded.ok) return `没有可用的代码索引：${loaded.error}`;
      const map = buildMap(loaded.index, args.focus, { budgetTokens: clampInt(args.budget, 100, 8000, 1200) });
      return withSync(renderMap(map), loaded.sync);
    },
  }));

  // `/memo` — a person asking their own project where things stand, without
  // spending a model turn on it. The registry is optional: a composition
  // without human-command adapters still gets every tool above.
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.effect(
      () => commandCtx.commands.register({
        definitionId: "dsh-plugin-memo",
        name: "memo",
        description: "Show this project's .memo/ status (or: /memo note <text>)",
        handler(invocation) {
          const raw = String(invocation.rawInput ?? "").trim();
          const exec = { agent: invocation.agent };
          try {
            if (raw.startsWith("note ")) {
              const text = raw.slice(5).trim();
              if (text.length === 0) return { kind: "error", text: "用法：/memo note <一句话>" };
              const project = resolveProject(exec, undefined, state.dirName);
              const paths = createMemoDir(memoPaths(project.root, state.dirName));
              const write = appendNote(paths, { at: stamp(), session: null, kind: "note", text });
              if (!write.ok) return { kind: "error", text: `写 ${paths.journal} 失败：${write.error}` };
              return { kind: "success", text: `已记录到 ${paths.journal}` };
            }
            const view = commandStatus(state, exec, undefined, 5);
            return { kind: "success", text: renderStatusText(view.project, view.paths, view.status, view.notes, view.bugs) };
          } catch (error) {
            return { kind: "error", text: error && error.message ? error.message : String(error) };
          }
        },
      }),
      "memo: /memo command",
    );
    log("human command registered: /memo");
  });

  // The settings panel's data path. Optional exactly like `commands`: a
  // composition with no web carrier still gets every tool and `/memo`.
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
    const readBody = (req) => new Promise((resolveBody) => {
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
          // overrides it for this one revalidation, the way `memo_find` takes
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
            state.tokenizer = wanted;
          }
          const value = await panelState(
            params.get("root"),
            // The live plugin state itself, not a hand-built snapshot of it. A
            // snapshot has to be kept in step with every switch added later, and
            // the field it forgot is reported to the panel as a wrong value —
            // which is exactly how the tool switches went missing once already.
            // `panelState`/`panelConfig` read only the keys they name.
            params.get("refresh") === "1"
              ? { ...state, refresh: true, tokenizer: wanted ?? state.tokenizer }
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
    // disagrees. `POST` accepts any subset of the keys, including `tools`.
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
            state.exclude = wanted.exclude.filter((name) => typeof name === "string" && name.trim().length > 0).map((name) => name.trim());
          }
          if (wanted.tools !== undefined) {
            const asked = wanted.tools;
            if (asked === null || typeof asked !== "object" || Array.isArray(asked)) {
              return send(res, 400, { ok: false, error: "tools must be an object of tool name -> boolean" });
            }
            const entries = Object.entries(asked);
            // Validate the whole set before applying any of it: a patch that is
            // half in force is worse than one that was refused outright, and a
            // typo must not look like a switch that did nothing.
            for (const [toolName, enabled] of entries) {
              if (typeof enabled !== "boolean") return send(res, 400, { ok: false, error: `tools.${toolName} must be a boolean` });
              if (!Object.hasOwn(state.tools, toolName)) return send(res, 400, { ok: false, error: `unknown tool ${JSON.stringify(toolName)}` });
            }
            for (const [toolName, enabled] of entries) setTool(toolName, enabled);
          }
          const off = MEMO_TOOL_NAMES.filter((toolName) => state.tools[toolName] === false);
          log(`config changed: readGuard=${state.readGuard} refresh=${state.refresh} tokenizer=${state.tokenizer} exclude=[${state.exclude.join(", ")}] toolsOff=[${off.join(", ")}]`);
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
      const sessionKeyOf = (exec) => {
        const agent = exec ? exec.agent : undefined;
        const id = agent ? agent.id ?? (agent.session ? agent.session.id : undefined) : undefined;
        return typeof id === "string" && id.length > 0 ? id : null;
      };
      const absolutePath = (exec, target) => {
        if (isAbsolute(target.path)) return target.path;
        return resolve(sessionCwd(exec) ?? process.cwd(), target.path);
      };

      disposers.push(ctx.on("tools/pre-execute", async (exec, next) => {
        try {
          const target = readTarget(exec.name, exec.arguments, state.readTools);
          if (target !== null) {
            const key = sessionKeyOf(exec);
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
          const key = sessionKeyOf(exec);
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

  const off = MEMO_TOOL_NAMES.filter((toolName) => state.tools[toolName] === false);
  log(
    `${MEMO_TOOL_NAMES.length - off.length}/${MEMO_TOOL_NAMES.length} tools registered` +
      `${off.length > 0 ? ` (off: ${off.join(", ")})` : ""}; project memory in <project>/${state.dirName}/`,
  );
}
