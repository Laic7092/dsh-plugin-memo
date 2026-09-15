/**
 * The settings panel's data half.
 *
 * The panel is a browser surface, but everything it shows lives in files on
 * disk, so the host answers with plain JSON it built itself: no Cordis object,
 * no live session, nothing that would not survive `JSON.stringify`.
 *
 * Project selection is explicit and narrow. `.memo/` is per project, and the
 * host process's cwd is only a guess about which project the person means, so
 * the panel passes `?root=` and falls back to the host default. Nothing here
 * walks the filesystem hunting for projects, and the write action refuses a
 * directory that has no `.memo/` yet — initializing a project stays the
 * `memo_scan` tool's job, which is the only place that decides to create one.
 *
 * @module dsh-plugin-memo/panel
 */
import { isAbsolute, resolve } from "node:path";
import { buildIndex, indexMeta, refreshIndex, staleFiles } from "./indexer.js";
import { recentBugs, loadBugs } from "./bugs.js";
import { readNotes } from "./journal.js";
import { readStatus, sectionBody, STATUS_SECTIONS } from "./status.js";
import { DEFAULT_DIR, INDEX_MAX_BYTES, findProjectRoot, isFile, memoPaths, readJson, statOrNull, writeJsonAtomic } from "./store.js";

/** How much of the journal and the bug log one panel render carries. */
export const PANEL_JOURNAL = 12;
export const PANEL_BUGS = 6;

/**
 * Every tool this plugin registers, grouped the way a person thinks about the
 * memory rather than the order the definitions happen to appear in.
 *
 * This is the one list the switch card renders, so a tool that is registered
 * but missing here would silently have no switch — which is why the host suite
 * asserts this catalogue and the registrations are the same set. Keeping it
 * here rather than deriving it from the live registrations also means the panel
 * can name a tool that is currently switched off, since a tool that is off is
 * exactly the one not registered.
 */
export const MEMO_TOOL_GROUPS = [
  { id: "memory", tools: ["memo_status", "memo_handoff", "memo_note"] },
  { id: "index", tools: ["memo_scan", "memo_find", "memo_map"] },
  { id: "bugs", tools: ["memo_bug_search", "memo_bug_log"] },
];

/** Every tool name in the catalogue, in presentation order. */
export const MEMO_TOOL_NAMES = MEMO_TOOL_GROUPS.flatMap((group) => group.tools);

/** Resolve the project a panel request is about, or why it cannot. */
function projectFor(root, dirName) {
  const asked = typeof root === "string" && root.trim().length > 0 ? root.trim() : null;
  if (asked !== null && !isAbsolute(asked)) {
    return { ok: false, error: `root must be an absolute path, got ${JSON.stringify(asked)}` };
  }
  return { ok: true, project: findProjectRoot(asked === null ? process.cwd() : resolve(asked), dirName) };
}

/** The index as the panel needs it: counts, freshness, and nothing else. */
function indexView(paths) {
  if (!isFile(paths.index)) return { present: false };
  const file = readJson(paths.index, null, INDEX_MAX_BYTES);
  const value = file.ok ? file.value : null;
  if (value === null || typeof value !== "object" || value.files === null || typeof value.files !== "object") {
    return { present: true, readable: false, error: file.ok ? "index.json is not the shape this plugin writes" : file.error };
  }
  const stat = statOrNull(paths.index);
  const meta = indexMeta(value);
  const stale = staleFiles(value, 8);
  return {
    present: true,
    readable: true,
    bytes: stat === null ? null : stat.size,
    scannedAt: meta.scannedAt ?? null,
    fileCount: meta.fileCount,
    symbolCount: meta.symbolCount,
    totalTokens: meta.totalTokens,
    // Which counter produced `totalTokens`. Without it the panel has a number
    // and no idea whether it is a measurement or a guess.
    tokens: meta.tokens,
    symbolSource: value.symbolSource ?? "regex",
    analyzerAvailable: value.analyzerAvailable === true,
    staleChanged: stale.changedCount,
    staleMissing: stale.missingCount,
    staleChangedFiles: stale.changed,
    staleMissingFiles: stale.missing,
  };
}

/**
 * Everything the panel renders, as owned JSON.
 * @param root - the project the panel is looking at, or null for the host default.
 * @param options - `dirName`, and `refresh` to revalidate the index first.
 * @param analyzer - the tree-sitter analyzer, or null.
 */
export async function panelState(root, options = {}, analyzer = null) {
  const dirName = typeof options.dirName === "string" && options.dirName.length > 0 ? options.dirName : DEFAULT_DIR;
  const found = projectFor(root, dirName);
  if (!found.ok) return { ok: false, error: found.error };

  const project = found.project;
  const paths = memoPaths(project.root, dirName);
  const status = readStatus(paths);
  const notes = readNotes(paths, PANEL_JOURNAL);
  const bugs = loadBugs(paths);

  // The panel is the one surface that shows the index without spending a model
  // turn, so it revalidates when asked — the same sweep memo_find does.
  if (options.refresh === true && isFile(paths.index)) {
    const loaded = readJson(paths.index, null, INDEX_MAX_BYTES);
    if (loaded.ok && loaded.value !== null && typeof loaded.value === "object") {
      try {
        // `options.tokenizer` is the host's live counter here, not a default:
        // this is the same sweep memo_find runs, and an index counted in the
        // other unit has to be rebuilt rather than reused.
        const fresh = await refreshIndex(loaded.value, { exclude: options.exclude, analyzer, tokenizer: options.tokenizer });
        if (fresh.changed > 0) writeJsonAtomic(paths.index, fresh.index);
      } catch {
        // A refresh that fails must not take the panel down with it.
      }
    }
  }

  return {
    ok: true,
    root: project.root,
    dir: dirName,
    initialized: isFile(paths.status) || isFile(paths.journal) || isFile(paths.bugs) || isFile(paths.index),
    status: {
      present: status.present,
      updated: status.updated ?? null,
      // Absent memory reports no sections rather than the four empty ones: a
      // consumer must never have to distinguish "never written" from "written
      // and cleared", and the panel owns its own "no STATUS.md yet" copy.
      sections: status.present
        ? STATUS_SECTIONS.map((title) => ({ title, body: sectionBody(status, title) ?? null }))
        : [],
      extra: status.present
        ? status.sections
            .filter((section) => !STATUS_SECTIONS.includes(section.title))
            .map((section) => ({ title: section.title, body: section.body || null }))
        : [],
    },
    journal: {
      present: notes.present,
      total: notes.present ? notes.total : 0,
      notes: notes.notes.map((note) => ({ at: note.at, kind: note.kind, text: note.text })),
    },
    bugs: {
      present: bugs.ok,
      total: bugs.ok ? bugs.bugs.length : 0,
      recent: recentBugs(bugs.ok ? bugs.bugs : [], PANEL_BUGS).map((bug) => ({
        id: bug.id,
        occurrences: bug.occurrences ?? 1,
        errorMessage: bug.error_message,
        fix: bug.fix ?? null,
      })),
    },
    index: indexView(paths),
    // The switches travel with the state the panel is looking at, so the card
    // always has the host's live values and never needs a second request just to
    // render itself.
    config: panelConfig(options),
  };
}

/**
 * The panel's own switches, as the host currently has them in force.
 *
 * Deliberately not the whole plugin state: the panel shows these and must not
 * be handed the rest. `dirName` and `defaultRoot` stay composition facts —
 * moving the memory directory out from under the tools that read it is not
 * something a page should do at runtime.
 *
 * `tools` arrives grouped and in this module's own order so the card renders
 * the list as it stands: a tool the host does not have can never show a switch,
 * and a switch the person can see always names a tool that exists.
 * @param state - the live plugin state.
 */
export function panelConfig(state) {
  return {
    readGuard: state.readGuard === true,
    refresh: state.refresh === true,
    tokenizer: state.tokenizer === "exact" ? "exact" : "estimated",
    exclude: Array.isArray(state.exclude) ? state.exclude.slice() : [],
    readTools: Array.isArray(state.readTools) ? state.readTools.slice() : [],
    tools: MEMO_TOOL_GROUPS.map((group) => ({
      id: group.id,
      // On unless the host says otherwise: a state object without `tools` is a
      // host that has not been told about switches, and its tools are all on.
      tools: group.tools.map((name) => ({ name, on: state.tools === undefined || state.tools[name] !== false })),
    })),
  };
}

/**
 * Rebuild one project's index from the panel.
 *
 * Refuses a directory with no `.memo/` yet: creating a project's memory is the
 * `memo_scan` tool's decision to make, and this route is reachable by anything
 * on the machine that can open a local socket. Reading an arbitrary tree is the
 * tool's existing power; *creating* memory in an arbitrary tree is not
 * something a settings page should be able to do.
 */
export async function panelScan(root, options = {}, analyzer = null) {
  const dirName = typeof options.dirName === "string" && options.dirName.length > 0 ? options.dirName : DEFAULT_DIR;
  const found = projectFor(root, dirName);
  if (!found.ok) return { ok: false, error: found.error };

  const project = found.project;
  const paths = memoPaths(project.root, dirName);
  const dir = statOrNull(paths.dir);
  if (dir === null || dir.isFile === true) {
    return { ok: false, error: `${paths.dir} does not exist — run memo_scan once in this project first`, root: project.root };
  }

  const started = Date.now();
  const index = await buildIndex(project.root, {
    exclude: Array.isArray(options.exclude) ? options.exclude : [],
    analyzer,
    tokenizer: options.tokenizer,
  });
  const write = writeJsonAtomic(paths.index, index);
  if (!write.ok) return { ok: false, error: write.error, root: project.root };
  return { ok: true, root: project.root, durationMs: Date.now() - started, index: indexMeta(index) };
}
