/**
 * dsh-plugin-memo — the CLI half.
 *
 * One grammar, two callers. The model reaches this file through a single tool
 * whose only argument is a command line; a person reaches the same grammar
 * through `/memo <line>` in the input box. Everything either surface can
 * do lives here, so the two can never drift: there is no second implementation
 * of "search the bug log" for the human command to fall behind on.
 *
 * Why a command line rather than one tool per operation: every registered tool
 * is paid for by *every* request — its description and its parameter schema are
 * part of the model's standing context whether or not this turn uses it. Eight
 * tools meant eight descriptions on every turn to buy eight operations that a
 * session uses a handful of times. One tool with one string argument costs one
 * description, and `memo help` hands the grammar over only when it is wanted.
 *
 * The parser is deliberately forgiving — flags in any order, `--flag value`
 * or `--flag=value`, quotes for text with spaces, unquoted words joined for
 * the positional arguments — because a syntax a model gets wrong is a turn
 * spent on nothing. Anything it cannot honour is refused with the usage of the
 * command it was trying to run.
 *
 * @module dsh-plugin-memo/cli
 */
import { basename, resolve } from "node:path";
import { appendBug, loadBugs, recentBugs, searchBugs } from "./bugs.ts";
import { callersOf, sitesFor } from "./calls.ts";
import { buildIndex, buildMap, costUnit, fileDetail, indexMeta, refreshIndex, staleFiles, TS_MIN_TOKENS } from "./indexer.ts";
import { appendNote, readNotes } from "./journal.ts";

/**
 * How long one journal entry may be.
 *
 * The journal is read back to the model -- `memo status` prints the recent ones
 * on every resume -- so an entry is context the next session pays for. A note
 * that restates a commit, a STATUS line or the conversation it came from is
 * that cost and no benefit; what is worth keeping is the one line nobody else
 * holds: the measurement that changed a plan, the approach that turned out to
 * be a dead end, the thing the next session would otherwise redo.
 *
 * A decision gets more room, because a decision without its constraint and its
 * rejected alternative is not a record of a decision, it is a headline.
 */
const NOTE_CHARS = 200;
const DECISION_CHARS = 400;
import { patchStatus, readStatus, sectionBody, STATUS_SECTIONS, writeStatus } from "./status.ts";
import { clampInt, createMemoDir, findProjectRoot, isFile, memoPaths, stamp, statOrNull } from "./store.ts";
import { closeDb, findInDb, indexDbStat, openIndexDb, readIndex, syncIndex, writeIndex } from "./db.ts";
import type { MemoIndex, MemoState } from "./types.ts";

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");

/**
 * What a `memo find` answer is allowed to cost, and what it spends it on.
 *
 * The budget covers the whole answer, bodies included, because the point of a
 * budget is the cost of the turn. One body by default: the first hit is the best
 * answer, and a reader who needs a second one asks for it -- `--bodies`, or the
 * file itself. The caps below are the shape of the shortlist rather than its
 * price: the price is the budget, always.
 */
const FIND_BUDGET = 2000;
const FIND_BODY_LINES = 80;
const FIND_CANDIDATES = 60;
const FIND_TEXT = 5;
/** How many callers the first symbol hit lists, and how they are grouped. */
const FIND_CALLERS = 6;
/** The reasons a call site was attributed, in the order the answer shows them. */
const VIA_ORDER = ["self", "type", "only", "import"];
const VIA_LABEL = { self: "本文件", type: "按类型", only: "全项目唯一", import: "按 import" };

function lines(...parts) {
  return parts.filter((part) => typeof part === "string" && part.length > 0).join("\n");
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

//#region rendering — the text both callers read

/** STATUS.md as a reader takes it: the four sections, labelled and attributed. */
function renderStatusText(project, paths, status, notes, bugs) {
  const out = [`memo · ${project.root}`];
  const dirName = basename(paths.dir);
  out.push(status.present
    ? `STATUS.md 最后更新：${status.updated ?? "未知"}`
    : `还没有 ${dirName}/STATUS.md —— 用 memo handoff 写第一份。`);
  out.push("");
  if (status.present) {
    for (const title of STATUS_SECTIONS) {
      const body = sectionBody(status, title);
      out.push(`## ${title}`, body ?? "（空）", "");
    }
    const extra = status.sections.filter((section) => !STATUS_SECTIONS.includes(section.title));
    for (const section of extra) out.push(`## ${section.title}`, section.body || "（空）", "");
  }

  out.push(bugs.present ? `bug 记忆：${bugs.bugs.length} 条` : "bug 记忆：还没建（memo bug-log 会创建）");
  for (const bug of recentBugs(bugs.bugs, 3)) {
    out.push(`  ${bug.id} ×${bug.occurrences ?? 1}  ${bug.error_message}`);
    if (bug.fix) out.push(`      fix: ${bug.fix}`);
  }

  const indexStat = indexDbStat(paths);
  out.push(indexStat === null
    ? "代码索引：还没建（memo scan 会建）"
    : `代码索引：${fmt(indexStat.bytes)} 字节，改于 ${new Date(indexStat.mtimeMs).toISOString()}`);

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
    if (bug.file) out.push(`  file:  ${bug.file}${Number.isFinite(bug.line) ? ":" + bug.line : ""}`);
    if (Array.isArray(bug.tags) && bug.tags.length > 0) out.push(`  tags:  ${bug.tags.join(", ")}`);
    out.push("");
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


/**
 * `memo find` as a reader takes it: the shortlist, then the bodies behind the
 * first hit and behind whatever the shortlist could not name.
 *
 * The shortlist is cheap -- a path, a kind, a line range -- and the bodies are
 * not, so exactly one of them is spent by default. That is the shape a reader
 * actually needs: enough to know where to look, and one readable copy of the
 * thing itself. The first hit is the best answer, so it is the one that gets a
 * body; a best answer with no body (a path hit) leaves the budget to the first
 * hit that has one.
 */
function renderFind(query, result, meta, db, options: { budgetTokens?: number; bodies?: number; callers?: number; full?: boolean; index?: MemoIndex | null } = {}) {
  const budget = Number.isFinite(options.budgetTokens) ? options.budgetTokens : FIND_BUDGET;
  const bodies = clampInt(options.bodies, 0, 8, 1);
  const callers = clampInt(options.callers, 0, 50, FIND_CALLERS);
  // `--full` is the only thing that lifts the per-body line cap; the count is the
  // count of bodies. Both spend the same budget, which is what makes the number
  // in the footer true.
  const bodyLines = options.full === true ? Number.MAX_SAFE_INTEGER : FIND_BODY_LINES;
  let moreBodies = false;
  const index = options.index ?? null;
  if (result.files.length === 0 && result.text.length === 0) {
    return `索引里没有匹配 "${query}" 的符号、路径或正文（索引共 ${fmt(meta.fileCount)} 个文件，${fmt(meta.symbolCount)} 个符号）。`;
  }
  const unit = meta.tokens === "exact" ? "exact" : "estimated";
  const counter = costUnit(unit);
  // The two chrome lines are part of every answer, so they are reserved before
  // anything is chosen rather than discovered at the end.
  const chromeReserve = 40;
  let spent = chromeReserve;
  let shown = 0;
  let truncated = false;
  const out = [];
  for (const file of result.files) {
    const heading = [
      file.symbol ? `${file.relPath}:${file.line}-${file.endLine}` : file.relPath,
      file.kind + (file.symbol ? " " + file.symbol : ""),
      `[${Number(file.importance ?? 0).toFixed(2)}]`,
    ].join("  ");
    const cost = counter(heading) + 2;
    if (spent + cost > budget && shown > 0) {
      truncated = true;
      break;
    }
    spent += cost;
    shown += 1;
    out.push(heading);
    if (file.description) out.push("    " + file.description);
    // Who calls it, and before the body on purpose: whether the body needs
    // reading at all depends on who is already calling it. This is the question
    // a symbol index could not answer, and the calls table exists for it.
    if (shown === 1 && file.symbol && callers > 0 && bodies > 0 && index !== null) {
      const report = callersOf(sitesFor(index, file.symbol), index, { name: file.symbol, file: file.relPath }, { limit: callers });
      if (report.total > 0) {
        const resolved = VIA_ORDER.reduce((sum, via) => sum + (report.viaCounts[via] ?? 0), 0);
        const parts = VIA_ORDER.filter((via) => (report.viaCounts[via] ?? 0) > 0).map((via) => VIA_LABEL[via] + " " + fmt(report.viaCounts[via]));
        const head = "谁调它：" + fmt(resolved) + " 处调用点" + (parts.length > 0 ? "（" + parts.join(" · ") + "）" : "");
        spent += counter(head) + 2;
        out.push(head);
        for (const caller of report.callers) {
          const line = "  " + caller.relPath + ":" + caller.line + "  " + (caller.caller === null ? "(文件级)" : caller.caller);
          const lineCost = counter(line) + 1;
          if (spent + lineCost > budget) {
            truncated = true;
            break;
          }
          spent += lineCost;
          out.push(line);
        }
        const callerMore = resolved > report.callers.length ? "    ... 还有 " + fmt(resolved - report.callers.length) + " 处，--callers 可以加" : "";
        if (callerMore.length > 0 && spent + counter(callerMore) + 1 <= budget) { spent += counter(callerMore) + 1; out.push(callerMore); }
        else if (callerMore.length > 0) truncated = true;
        const notes = [];
        if (report.elsewhere > 0) notes.push(fmt(report.elsewhere) + " 处同名调用落在别的文件");
        if (report.ambiguous > 0) {
          notes.push(report.candidates.length > 1
            ? fmt(report.ambiguous) + " 处无法判定（名字在 " + fmt(report.candidates.length) + " 个文件里都有，且没有类型或 import 线索）"
            : fmt(report.ambiguous) + " 处无法判定");
        }
        if (notes.length > 0) out.push("    " + notes.join("；"));
      }
    }
    // The body, for the first hit that has one and no more unless asked.
    if (shown > bodies || !file.symbol) continue;
    const body = symbolBody(db, file.relPath, file.line, file.endLine, bodyLines);
    if (body === null) continue;
    const bodyCost = counter(body.text) + 2;
    if (spent + bodyCost > budget) {
      truncated = true;
      continue;
    }
    spent += bodyCost;
    // The range is already in the heading above; the body speaks for itself.
    out.push(body.text);
    // Both tails are measured like everything else: they are part of the answer a
    // reader pays for, and one that does not fit is said in the footer instead.
    const bodyMore = body.more > 0 ? `    ... 还有 ${body.more} 行，用 --full 或 --file ${file.relPath}` : "";
    if (bodyMore.length > 0 && spent + counter(bodyMore) + 1 <= budget) { spent += counter(bodyMore) + 1; out.push(bodyMore); }
    else if (body.more > 0) truncated = true;
  }
  if (bodies > 0 && shown > bodies && result.files.slice(bodies).some((file) => file.symbol)) moreBodies = true;
  // Body excerpts answer the same question as a body does, so they spend the
  // same budget and obey the same count. This used to be bolted on after the
  // budget was settled, which is how a 100-token answer arrived at 1561
  // characters.
  for (const hit of result.text) {
    if (bodies <= 0) break;
    const headLine = `${hit.relPath}:${hit.line}  正文命中`;
    const cost = counter(headLine) + hit.excerpt.reduce((sum, line) => sum + counter(line), 0) + 2;
    if (spent + cost > budget && shown > 0) { truncated = true; break; }
    spent += cost;
    out.push(headLine);
    for (const excerpt of hit.excerpt) out.push("    " + excerpt);
  }
  // Everything a reader pays for is measured, this line included: the number in
  // it used to be the sum of the headings and bodies, so a 100-token answer
  // reported 84 and arrived at 121.
  // Everything a reader pays for is measured, this line included. The number it
  // reports is the real cost of the answer -- headings, bodies, excerpts and the
  // two lines of chrome -- because a budget that under-reports itself is not a
  // budget: a 100-token answer used to say 84 and arrive at 119.
  const head = [
    `${fmt(result.total)} 个文件命中 · 列出 ${fmt(shown)} 个`,
    result.text.length > 0 ? `${result.text.length} 处正文命中` : "",
    truncated ? "被预算截断，--budget 可加" : "",
    !truncated && moreBodies ? "还有命中有正文，--bodies 可加" : "",
  ].filter((part) => part.length > 0).join(" · ");
  // What the reader actually gets, counted rather than estimated: the reserve came
  // off, the chrome goes on, and the number in the line is the cost of the line
  // that carries it.
  const content = Math.max(0, spent - chromeReserve);
  const reported = content + counter(head) + counter(`${tokenAmount(content, unit)}/${fmt(budget)}`);
  const totalLine = `共 ${tokenAmount(reported, unit)}/${fmt(budget)}${reported > budget ? "（超：第一条命中无法再切）" : ""}`;
  const headFull = head + " · " + totalLine;
  const body = [headFull, "", ...out].join(String.fromCharCode(10)).trimEnd();
  return `${body}${String.fromCharCode(10)}`;

}

/**
 * A symbol's own lines, as a reader takes them.
 *
 * The body has been in the database since the index moved there -- it is what
 * makes "where is this string" answerable -- and this is the other half of that
 * purchase: the lines a symbol names, read back for the one hit worth reading.
 * A symbol is capped so one enormous function cannot spend the whole answer.
 */
function symbolBody(db, relPath, startLine, endLine, maxLines) {
  const first = Math.max(1, Number(startLine) || 1);
  const last = Math.max(first, Number(endLine) || first);
  const lines = readFileLines(db, relPath, first, Math.min(last, first + maxLines - 1));
  if (lines.length === 0) return null;
  return {
    range: `${relPath}:${first}-${Math.min(last, first + maxLines - 1)}`,
    text: lines.join(String.fromCharCode(10)),
    more: Math.max(0, last - (first + maxLines - 1)),
  };
}

/**
 * Lines `from`..`to` of a stored body, inclusive and 1-based.
 *
 * Read from the database rather than the disk: the body already passed the size
 * and binary checks when the scan stored it, and a file that vanished since is
 * still answerable -- with what the index last saw, which is the honest answer
 * for an index.
 */
function readFileLines(db, relPath, from, to) {
  let row = null;
  try {
    row = db.prepare("SELECT body FROM docs WHERE path = ?").get(relPath);
  } catch {
    return [];
  }
  const body = row === null || row === undefined ? null : row.body;
  if (typeof body !== "string" || body.length === 0) return [];
  return body.split(String.fromCharCode(10)).slice(from - 1, to);
}

function renderMap(map) {
  if (map.mode === "rollup") {
    if (map.dirs.length === 0) return "索引里还没有文件——先跑 memo scan。";
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

function renderScan(paths, index: MemoIndex, stale, durationMs, written = null) {
  const meta = indexMeta(index);
  // The rows the scan actually wrote, not the sites it found: a call whose name
  // no declaration answers for is not stored, and this number is the table's.
  const edges = written !== null && written.calls !== undefined
    ? Number(written.calls)
    : Object.values(index.files ?? {}).reduce((sum, file) => sum + (file.calls?.length ?? 0), 0);
  const out = [
    `已重建索引 · ${paths.db}`,
    `${fmt(meta.fileCount)} 个文件 · ${fmt(meta.symbolCount)} 个符号 · ${fmt(edges)} 条调用边 · ${tokenAmount(meta.totalTokens, meta.tokens)} · 用时 ${durationMs} ms`,
    `符号来源：${index.symbolSource ?? "regex"}（tree-sitter 升级 ${TS_MIN_TOKENS} tokens 以上的文件；其余与失败回退都用行内启发式）`,
    "",
  ];
  if (isFile(paths.index)) {
    out.push("旧的 index.json 还在（已经不再读写）：删掉它即可；如果它被提交过，用 git rm --cached .memo/index.json 取消跟踪。");
  }
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
      out.push(`  ${file.importance.toFixed(2)}  ${rel}  ${file.symbols.length} 符号${file.description ? "  " + file.description : ""}`);
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** One trailing line saying what the automatic revalidation did, or "". */
function renderSync(sync) {
  if (sync === null || sync === undefined) return "";
  if (sync.failed !== undefined) return `（索引自动同步失败：${sync.failed} —— 用 memo scan 重建）`;
  if (sync.rebuilt === true) return `（索引格式已升级，整份重建：${fmt(sync.changed)} 个文件）`;
  if (sync.changed === 0) return "";
  const parts = [];
  if (sync.added.length > 0) parts.push(`+${sync.added.length} 新文件`);
  if (sync.updated.length > 0) parts.push(`~${sync.updated.length} 改写`);
  if (sync.removed.length > 0) parts.push(`-${sync.removed.length} 移除`);
  return `（索引已自动同步：${parts.join(" · ")}${sync.writeError ? "；但写回失败：" + sync.writeError : ""}）`;
}

/** Append the sync line to an answer, when there is one. */
function withSync(text, sync) {
  const line = renderSync(sync);
  return line.length === 0 ? text : `${text.trimEnd()}\n${line}`;
}

//#endregion

//#region the index — read side

/**
 * An index session: the index, what the automatic revalidation did, and the
 * handle that closes the database when the answer is written.
 *
 * One transaction, not one helper per command: the read commands all need the
 * same three things, and the refresh has to happen on the same connection the
 * query then runs on. Closing is the caller's -- a command waits until its text
 * exists before it lets go of the database.
 */
async function openIndexSession(paths, state, analyzer) {
  const opened = await openIndexDb(paths);
  if (!opened.ok) return { ok: false, db: null, index: null, sync: null, error: opened.error };
  let index = readIndex(opened.db);
  if (index === null) {
    closeDb(opened.db);
    return { ok: false, db: null, index: null, sync: null, error: paths.db + " 读不出内容——重新跑一次 memo scan" };
  }
  if (!state.refresh) return { ok: true, db: opened.db, index, sync: null, error: null };
  let fresh;
  try {
    fresh = await refreshIndex(index, { exclude: state.exclude, analyzer, tokenizer: state.tokenizer });
  } catch (error) {
    // A refresh that throws must not cost the caller its answer: hand back the
    // index we have and say plainly that it may be behind.
    const failed = error && error.message ? error.message : String(error);
    return { ok: true, db: opened.db, index, sync: { failed }, error: null };
  }
  let sync = fresh;
  if (fresh.changed > 0) {
    const write = await writeRefresh(paths, fresh);
    // Answer from memory either way; only the on-disk copy is at stake.
    if (!write.ok) sync = { ...fresh, writeError: write.error };
  }
  return { ok: true, db: opened.db, index: fresh.index, sync, error: null };
}

async function loadIndex(paths) {
  const opened = await openIndexDb(paths);
  if (!opened.ok) return { ok: false, index: null, error: opened.error };
  try {
    const index = readIndex(opened.db);
    if (index === null) return { ok: false, index: null, error: paths.db + " 读不出内容——重新跑一次 memo scan" };
    return { ok: true, index, error: null };
  } finally {
    closeDb(opened.db);
  }
}

/**
 * Put a refresh's findings back on disk.
 *
 * Only what the sweep found is written: a rebuilt index writes everything, a
 * patch writes the three lists. Bodies are re-read for whatever is written and
 * for nothing else, which is what keeps a refresh proportional to the edit
 * rather than to the project.
 */
async function writeRefresh(paths, fresh) {
  const opened = await openIndexDb(paths, { create: true });
  if (!opened.ok) return { ok: false, error: opened.error };
  try {
    if (fresh.rebuilt === true) writeIndex(opened.db, fresh.index);
    else syncIndex(opened.db, fresh.index, { added: fresh.added, updated: fresh.updated, removed: fresh.removed });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  } finally {
    closeDb(opened.db);
  }
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

/**
 * The query half of `memo find`, on an open session.
 *
 * Everything it needs comes from SQL: the shortlist, the first hit's body, and
 * the excerpts behind a phrase that only appears in the text. The in-memory
 * index is read only for its counts -- the answer has to say how big the haystack
 * was -- which is why this is a few queries rather than a reconstruction.
 */
async function runFind(session, args) {
  const file = typeof args.flags.file === "string" ? args.flags.file.trim() : "";
  if (file.length > 0) {
    const detail = fileDetail(session.index, file);
    if (detail === null) return { ok: false, text: `索引里没有 ${file}。重新跑 memo scan，或者直接用 grep/read。` };
    return { ok: true, text: renderFileDetail(detail) };
  }
  const query = phrase(args.rest);
  if (query.length === 0) return { ok: false, text: "find 需要 query（符号名、路径片段，或正文里的任意词），或者 --file 一个具体路径" };
  const full = args.flags.full === true;
  const result = findInDb(session.db, query, { limit: FIND_CANDIDATES, textLimit: FIND_TEXT });
  const meta = indexMeta(session.index);
  const budget = clampInt(args.flags.budget, 100, 20000, FIND_BUDGET);
  // The count is the count; `--full` only lifts the per-body line cap, so
  // `--bodies 2 --full` means two whole bodies rather than sixteen halves.
  const bodies = args.flags.bodies === undefined ? 1 : clampInt(args.flags.bodies, 0, 8, 1);
  const callers = args.flags.callers === undefined ? FIND_CALLERS : clampInt(args.flags.callers, 0, 50, FIND_CALLERS);
  return { ok: true, text: renderFind(query, result, meta, session.db, { budgetTokens: budget, bodies, callers, full, index: session.index }) };
}

//#endregion

//#region the grammar

/**
 * Command and flag names are matched with their separators removed, so
 * `bug-search`, `bug_search` and `bugsearch` are one command. A model that
 * reaches for a spelling it saw somewhere else still gets its answer, and the
 * help text keeps one spelling because that is the one worth learning.
 */
function loose(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A flag value, coerced the way its flag says. */
function coerceFlag(value, flag, given) {
  if (flag.kind === "int") {
    const parsed = Number.parseInt(String(value).trim(), 10);
    if (!Number.isFinite(parsed)) return { ok: false, error: `--${given} 要一个整数，收到 ${JSON.stringify(value)}` };
    return { ok: true, value: parsed };
  }
  return { ok: true, value: decodeEscapes(value) };
}

/** The `--root` flag every command accepts, kept out of each command's own list. */
const ROOT_FLAG = { root: { kind: "string", hint: "PATH", description: "项目根目录（绝对路径）。默认：会话工作目录，再往上找最近的 .memo/ 或 .git" } };

/**
 * The escape sequences a text value may spell out: \n, \t, \r.
 *
 * A model rarely types a real newline inside a quoted value -- it writes the
 * two characters, because that is what a JSON string looks like. Taken
 * literally they do not fail; they quietly mangle the text, and a handoff list
 * typed as "- a\n- b" lands as one line reading "- an- b". So a two-character
 * escape is read as the character it names. Nothing else is: a Windows path's
 * backslashes, a regex, a quoted phrase someone pasted -- all of it survives,
 * and a caller who really wants a literal backslash-n writes two backslashes.
 */
function decodeEscapes(value) {
  return String(value ?? "").replace(/\\[ntr]/g, (match) => (match === "\\n" ? "\n" : match === "\\t" ? "\t" : "\r"));
}
/**
 * Split a command line into words, honouring quotes.
 *
 * Text with spaces is the common case for this plugin — a symptom, a handoff
 * paragraph — so quotes matter more here than they do in a shell that mostly
 * passes paths around. An unterminated quote is an error rather than a silent
 * best-effort split: guessing would run a command with half its text.
 */
export function splitCommandLine(line) {
  const tokens = [];
  const text = String(line ?? "");
  /** What a backslash escapes to, for the two characters it can name. */
  const NAMED = { n: "\n", t: "\t", r: "\r" };
  let current = null;
  let quote = null;
  const add = (ch) => { current = (current ?? "") + ch; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null && ch === quote) { quote = null; continue; }
    if (quote === null && (ch === '"' || ch === "'")) { quote = ch; current = current ?? ""; continue; }
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      // A backslash that escapes the closing quote is punctuation and goes
      // away; one that names a character is that character. Anything else is
      // kept as the two characters it is -- a Windows path, a regex.
      if (next === quote || (quote === '"' && next === '"')) { i += 1; add(next); continue; }
      if (quote !== null && NAMED[next] !== undefined) { i += 1; add(NAMED[next]); continue; }
      if (quote === null) { i += 1; add(next); continue; }
      add(ch);
      continue;
    }
    if (quote === null && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")) {
      if (current !== null) { tokens.push(current); current = null; }
      continue;
    }
    add(ch);
  }
  if (quote !== null) return { ok: false, error: `引号没闭合：${quote}` };
  if (current !== null) tokens.push(current);
  return { ok: true, tokens };
}

/** Parse one command's arguments against its own flag list. */
function parseArgs(tokens, command) {
  const flags: Record<string, any> = {};
  const rest = [];
  const known = { ...command.flags, ...ROOT_FLAG };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--help" || token === "-h") return { help: true };
    if (token.startsWith("--") && token.length > 2) {
      let name = token.slice(2);
      let inline = null;
      const eq = name.indexOf("=");
      if (eq !== -1) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
      const asked = loose(name);
      const canonical = Object.keys(known).find((key) => loose(key) === asked || (known[key].aliases ?? []).some((alias) => loose(alias) === asked));
      if (canonical === undefined) return { error: `不认识的选项 --${name}` };
      const flag = known[canonical];
      let value = inline;
      if (value === null) {
        if (i + 1 >= tokens.length) return { error: `--${name} 后面缺一个值` };
        i += 1;
        value = tokens[i];
      }
      const coerced = coerceFlag(value, flag, name);
      if (!coerced.ok) return { error: coerced.error };
      if (flag.kind === "list") flags[canonical] = [...(flags[canonical] ?? []), coerced.value];
      else flags[canonical] = coerced.value;
      continue;
    }
    // A bare `-` or a negative number is text, not a flag.
    if (token.startsWith("-") && token.length > 1 && !/^-\d/.test(token)) return { error: `不认识的选项 ${token}` };
    rest.push(token);
  }
  return { flags, rest };
}

/** The words a command was given after its flags, joined back into one argument. */
function phrase(rest) {
  return rest.join(" ").trim();
}

//#endregion

//#region the commands

/**
 * Every operation this plugin has, in one table.
 *
 * `write` is not decoration: it is what the help text and the tool description
 * promise about which commands touch the disk, and it is why a person reading
 * `memo help` can tell at a glance what is safe to run.
 */
export const MEMO_COMMANDS = [
  {
    name: "status",
    group: "memory",
    write: false,
    usage: "status [--notes N]",
    summary: "读此项目的 .memo/：STATUS 四节、最近动作、bug 数、索引状态",
    flags: { notes: { kind: "int", hint: "N", description: "带出最近几条 journal（默认 5）" } },
    run(ctx, args) {
      const paths = memoPaths(ctx.project.root, ctx.state.dirName);
      return renderStatusText(
        ctx.project,
        paths,
        readStatus(paths),
        readNotes(paths, clampInt(args.flags.notes, 1, 50, 5)),
        loadBugs(paths),
      );
    },
  },
  {
    name: "handoff",
    group: "memory",
    write: true,
    usage: "handoff [--now T] [--next T] [--open T] [--avoid T]",
    summary: "写 STATUS.md（只替换你传的那几节）：现在在哪 / 下一步 / 未决问题 / 不要重犯",
    flags: {
      now: { kind: "string", hint: "T", description: "现在在哪（替换 现在在哪 一节）" },
      next: { kind: "string", hint: "T", description: "下一步（替换 下一步 一节）" },
      open: { kind: "string", hint: "T", aliases: ["questions"], description: "未决问题（替换 未决问题 一节）" },
      avoid: { kind: "string", hint: "T", aliases: ["do-not-repeat"], description: "试过不行的路（替换 不要重犯 一节）" },
    },
    run(ctx, args) {
      const sections = ["now", "next", "open", "avoid"];
      if (!sections.some((key) => typeof args.flags[key] === "string" && args.flags[key].length > 0)) {
        return { ok: false, text: "handoff 至少要给一节：--now / --next / --open / --avoid（没传的节保持原样）" };
      }
      const { project, state } = ctx;
      const paths = createMemoDir(memoPaths(project.root, state.dirName));
      const existing = readStatus(paths);
      const at = stamp();
      const updated = patchStatus(
        existing.present ? existing.text : "",
        basename(project.root) || project.root,
        { 现在在哪: args.flags.now, 下一步: args.flags.next, 未决问题: args.flags.open, 不要重犯: args.flags.avoid },
        at,
      );
      const write = writeStatus(paths, updated);
      if (!write.ok) return { ok: false, text: `写 ${paths.status} 失败：${write.error}` };
      return lines(`已更新 ${paths.status}`, "", renderStatusText(project, paths, readStatus(paths), readNotes(paths, 3), loadBugs(paths)));
    },
  },
  {
    name: "note",
    group: "memory",
    write: true,
    usage: "note TEXT [--kind note|decision|todo]",
    summary: "往 journal.jsonl 追加一行；一条一句，note " + NOTE_CHARS + " 字 / decision " + DECISION_CHARS + " 字封顶——这些行每次恢复都会被读出来",
    flags: { kind: { kind: "string", hint: "KIND", description: "条目类型：note / decision / todo（默认 note）；decision 的 400 字预算给约束和否决的方案" } },
    run(ctx, args) {
      const text = phrase(args.rest);
      if (text.length === 0) return { ok: false, text: "note 需要一句话：memo note <text> [--kind decision]" };
      // The budget is enforced, not advised: the reader of this file is the next
      // session, and it reads every recent line on every resume.
      const kind = args.flags.kind ?? "note";
      const budget = kind === "decision" ? DECISION_CHARS : NOTE_CHARS;
      if (text.length > budget) {
        return {
          ok: false,
          text: lines(
            `这一条 ${text.length} 字，上限 ${budget} 字（--kind ${kind}）——写不进去。`,
            "",
            "journal 是给下一个会话读的：memo status 每次恢复都会把这些行打出来。压缩它，或者换个容器：",
            "  · 只留接下来那个人要用的一句：数字、结论、哪条路试过不行；",
            "  · 已经提交的写提交号，不要把 diff 复述一遍；",
            "  · 要留下的现状写 memo handoff，长报告放别处（提交信息、issue、README）。",
          ),
        };
      }
      const paths = createMemoDir(memoPaths(ctx.project.root, ctx.state.dirName));
      const at = stamp();
      const write = appendNote(paths, { at, session: ctx.session, kind, text });
      if (!write.ok) return { ok: false, text: "写 " + paths.journal + " 失败：" + write.error };
      const notes = readNotes(paths, 1);
      const total = notes.present ? notes.total : 1;
      return "已记录（journal 共 " + total + " 条）：" + at + "  [" + kind + "]  " + text;
    },
  },
  {
    name: "scan",
    group: "index",
    write: true,
    usage: "scan [--exclude DIR]",
    summary: "重建代码索引 .memo/index.db（本地 SQLite）：文件、行数、tokens、开头注释当描述、符号+行范围、调用点、import 图排名",
    flags: { exclude: { kind: "list", hint: "DIR", description: "额外跳过的目录名，可重复；叠加在内置表之上" } },
    async run(ctx, args) {
      const started = Date.now();
      const index = await buildIndex(ctx.project.root, {
        exclude: [...ctx.state.exclude, ...(args.flags.exclude ?? [])],
        analyzer: ctx.analyzer,
        tokenizer: ctx.state.tokenizer,
        log: ctx.log,
      });
      const paths = createMemoDir(memoPaths(ctx.project.root, ctx.state.dirName));
      const opened = await openIndexDb(paths, { create: true, log: ctx.log });
      if (!opened.ok) return { ok: false, text: opened.error };
      let written = null;
      try {
        written = writeIndex(opened.db, index);
      } catch (error) {
        return { ok: false, text: "写 " + paths.db + " 失败：" + (error && error.message ? error.message : String(error)) };
      } finally {
        closeDb(opened.db);
      }
      return renderScan(paths, index, staleFiles(index, 5), Date.now() - started, written);
    },
  },
  {
    name: "find",
    group: "index",
    write: false,
    usage: "find QUERY [--file PATH] [--budget N] [--bodies N] [--callers N] [--full]",
    summary: "在索引里定位符号/路径/正文：给行号，首个命中给正文和调用点；回答前自动复核索引",
    flags: {
      file: { kind: "string", hint: "PATH", description: "改成一个具体文件：给它的描述和符号行范围" },
      budget: { kind: "int", hint: "N", description: "整个答案的 token 预算（默认 2000）：清单、正文、调用点、正文摘录都算在里面" },
      bodies: { kind: "int", hint: "N", description: "展开几段正文（默认 1；0 = 不要正文，也不要正文摘录，只要行号）" },
      full: { kind: "bool", description: "正文不截断（默认每段 80 行；段数仍由 --bodies 决定，总量仍受 --budget 限制）" },
      callers: { kind: "int", hint: "N", description: "首个命中的符号列几个调用点（默认 6；0 = 不列）" },
    },
    async run(ctx, args) {
      const paths = memoPaths(ctx.project.root, ctx.state.dirName);
      const session = await openIndexSession(paths, ctx.state, ctx.analyzer);
      if (!session.ok) return { ok: false, text: `没有可用的代码索引：${session.error}` };
      try {
        const answer = await runFind(session, args);
        // A refusal is already worded for the caller; only an answer gets the
        // automatic-sync line appended.
        return answer.ok ? { ok: true, text: withSync(answer.text, session.sync) } : answer;
      } finally {
        closeDb(session.db);
      }
    },
  },
  {
    name: "map",
    group: "index",
    write: false,
    usage: "map [FOCUS] [--budget N]",
    summary: "项目地图：按目录汇总，或聚焦一个主题的文件清单",
    flags: { budget: { kind: "int", hint: "N", description: "token 预算（默认 1200）" } },
    async run(ctx, args) {
      const paths = memoPaths(ctx.project.root, ctx.state.dirName);
      const session = await openIndexSession(paths, ctx.state, ctx.analyzer);
      if (!session.ok) return { ok: false, text: `没有可用的代码索引：${session.error}` };
      try {
        const map = buildMap(session.index, phrase(args.rest) || undefined, { budgetTokens: clampInt(args.flags.budget, 100, 8000, 1200) });
        return withSync(renderMap(map), session.sync);
      } finally {
        closeDb(session.db);
      }
    },
  },
  {
    name: "bug-search",
    group: "bugs",
    write: false,
    usage: "bug-search TERM [--limit N]",
    summary: "按症状/报错文本检索记过的修复，重复次数参与排序",
    flags: { limit: { kind: "int", hint: "N", description: "最多几条（默认 5）" } },
    run(ctx, args) {
      const term = phrase(args.rest);
      if (term.length === 0) return { ok: false, text: "bug-search 需要一个词：memo bug-search <症状或报错文本>" };
      const paths = memoPaths(ctx.project.root, ctx.state.dirName);
      const bugs = loadBugs(paths);
      if (!bugs.ok) return `这个项目还没有 bug 记忆：${bugs.error}。修完 bug 后用 memo bug-log 记第一条。`;
      return renderBugs(term, searchBugs(bugs.bugs, term, clampInt(args.flags.limit, 1, 25, 5)));
    },
  },
  {
    name: "bug-log",
    group: "bugs",
    write: true,
    usage: "bug-log --error TEXT [--cause T] [--fix T] [--file P] [--line N] [--tag T]",
    summary: "记一条修复；同一症状再记是累加次数，不是新增一条",
    flags: {
      error: { kind: "string", hint: "TEXT", aliases: ["error-message", "message", "symptom"], description: "报错文本或症状，按它匹配" },
      cause: { kind: "string", hint: "T", aliases: ["root-cause"], description: "真正的原因" },
      fix: { kind: "string", hint: "T", description: "怎么修的" },
      file: { kind: "string", hint: "P", description: "项目内相对路径" },
      line: { kind: "int", hint: "N", description: "行号" },
      tag: { kind: "list", hint: "T", aliases: ["tags"], description: "标签，可重复" },
    },
    run(ctx, args) {
      const error = args.flags.error;
      if (typeof error !== "string" || error.trim().length === 0) {
        return { ok: false, text: "bug-log 需要症状：memo bug-log --error \"<报错文本>\" [--cause T] [--fix T]" };
      }
      const paths = createMemoDir(memoPaths(ctx.project.root, ctx.state.dirName));
      const result = appendBug(paths, {
        errorMessage: error,
        rootCause: args.flags.cause,
        fix: args.flags.fix,
        file: args.flags.file,
        line: args.flags.line,
        tags: args.flags.tag ?? [],
      });
      if (!result.ok) return { ok: false, text: `写 ${paths.bugs} 失败：${result.error}` };
      return result.updated
        ? `已记录：${result.id}（同一症状第 ${result.occurrences} 次；共 ${result.total} 条）`
        : `已记录：${result.id}（共 ${result.total} 条）`;
    },
  },
];

/** Commands in the order the help text and the switch card present them. */
export const MEMO_COMMAND_GROUPS = [
  { id: "memory", commands: ["status", "handoff", "note"] },
  { id: "index", commands: ["scan", "find", "map"] },
  { id: "bugs", commands: ["bug-search", "bug-log"] },
];

/** Every command name, in presentation order. */
export const MEMO_COMMAND_NAMES = MEMO_COMMAND_GROUPS.flatMap((group) => group.commands);

const BY_NAME = new Map(MEMO_COMMANDS.map((command) => [loose(command.name), command]));

//#endregion

//#region help

/** One command's own page: what it does, how to spell it, what every flag means. */
export function commandHelp(name) {
  const command = BY_NAME.get(loose(name));
  if (command === undefined) {
    return { ok: false, text: `没有 ${name} 这个子命令。` + "\n\n" + usageIndex() };
  }
  const flags = { ...command.flags, ...ROOT_FLAG };
  const width = Math.max(...Object.keys(flags).map((key) => key.length));
  const out = [
    `memo ${command.usage}`,
    "",
    command.summary,
    "",
    command.write ? "会写盘：改的是 <项目>/.memo/ 里的文件。" : "只读：不写任何文件。",
    "",
    "选项：",
  ];
  for (const [key, flag] of Object.entries(flags)) out.push(`  --${key.padEnd(width)}  ${flag.description}`);
  return { ok: true, text: `${out.join("\n").trimEnd()}\n` };
}

/** Every command, one line each, with the ones this host has switched off marked. */
export function usageIndex(state: Partial<MemoState> = {}) {
  const off = new Set(MEMO_COMMANDS.filter((command) => state && state.subcommands && state.subcommands[command.name] === false).map((command) => command.name));
  const width = Math.max(...MEMO_COMMANDS.map((command) => command.usage.length));
  const out = ["memo <子命令> [选项] —— 一个命令行，做一件事。", ""];
  for (const command of MEMO_COMMANDS) {
    out.push(`  memo ${command.usage.padEnd(width)}  ${command.write ? "写" : "读"}  ${command.summary}${off.has(command.name) ? "（这个宿主上已关闭）" : ""}`);
  }
  out.push(
    "",
    "memo help <子命令>     看一个子命令的全部选项",
    "--root PATH            指到别的项目（默认：会话工作目录）",
    "引号                   text 里有空格就加引号，例如 memo note \"换掉了 zod\"",
  );
  return `${out.join("\n").trimEnd()}\n`;
}

//#endregion

//#region the entry point both surfaces call

/** Resolve the project a command is about: an explicit --root, the session cwd, then the host. */
export function projectFor(env, explicitRoot) {
  const asked = typeof explicitRoot === "string" && explicitRoot.trim().length > 0 ? explicitRoot.trim() : null;
  const fallback = asked ?? env.cwd ?? (env.state ? env.state.defaultRoot : undefined) ?? process.cwd();
  return findProjectRoot(resolve(fallback), env.state ? env.state.dirName : undefined);
}

/**
 * Run one command line.
 *
 * @param line - the command line, without the `memo` word itself.
 * @param env - `{ state, cwd, session, analyzer, log }`: the live plugin state, the
 *   calling session's working directory (undefined is allowed, and falls back the
 *   way `projectFor` documents), its session id (recorded on journal entries),
 *   the tree-sitter analyzer or null, and a sink for scan progress.
 * @returns `{ ok, text }` — `ok: false` is a refusal with the reason spelled
 *   out, never a throw and never an empty answer.
 */
export async function runMemo(line, env) {
  const state = env.state ?? {};
  const split = splitCommandLine(line);
  if (!split.ok) return { ok: false, text: `${split.error}（命令行的引号要成对）` };

  const tokens = split.tokens;
  if (tokens.length === 0) tokens.push("status");
  const verb = tokens[0];

  if (verb === "--help" || verb === "-h" || loose(verb) === "help") {
    const about = tokens[1];
    return about === undefined ? { ok: true, text: usageIndex(state) } : commandHelp(about);
  }

  const command = BY_NAME.get(loose(verb));
  if (command === undefined) {
    return { ok: false, text: `不认识的子命令 “${verb}”。` + "\n\n" + usageIndex(state) };
  }
  if (state.subcommands !== undefined && state.subcommands[command.name] === false) {
    return { ok: false, text: `memo ${command.name} 在这个宿主上被关掉了（Memo 视图 → 子命令开关）。` };
  }

  const parsed = parseArgs(tokens.slice(1), command);
  if (parsed.help === true) return commandHelp(command.name);
  if (parsed.error !== undefined) {
    return { ok: false, text: `memo ${command.name}: ${parsed.error}\n用法：memo ${command.usage}` };
  }

  const ctx = {
    state,
    session: env.session ?? null,
    project: projectFor(env, parsed.flags.root),
    analyzer: env.analyzer ?? null,
    log: env.log ?? (() => {}),
  };
  try {
    const result = await command.run(ctx, parsed);
    return typeof result === "string" ? { ok: true, text: result } : result;
  } catch (error) {
    return { ok: false, text: `memo ${command.name} 失败：${error && error.message ? error.message : String(error)}` };
  }
}

//#endregion

