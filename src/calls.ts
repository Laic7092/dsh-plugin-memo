/**
 * Who calls what: the question a symbol index cannot answer on its own.
 *
 * This module is the answering half. Recording happens in the indexer, which
 * writes down what each file *says* -- the name it calls, the receiver it wrote
 * on, that receiver's type when the same file declares one, the line, and the
 * declaration the call sits inside. What a name *resolves to* is a fact about
 * the whole project, so it is decided here, when somebody asks, against the
 * symbols as they are at that moment. A stored resolution would tie an untouched
 * file's edges to today's symbol table: add one file declaring the name and
 * every stored edge with that name is wrong, while a refresh that writes only
 * what moved would leave them that way.
 *
 * @module dsh-plugin-memo/calls
 */
import { resolveSpecifier } from "./indexer.ts";
import type { IndexCall, IndexEntry, MemoIndex } from "./types.ts";

/** A call site and the file it was found in: the unit the database stores. */
export interface CallSite extends IndexCall {
  relPath: string;
}

/** One call site that resolved to the symbol that was asked about. */
export interface Caller {
  relPath: string;
  line: number;
  caller: string | null;
  via: string;
}

/**
 * The answer to "who calls this".
 *
 * The two numbers that are *not* callers matter as much as the list: a name
 * shared by several files leaves call sites nobody can attribute, and saying so
 * is the difference between an answer and a guess that reads like one.
 */
export interface CallerReport {
  name: string;
  file: string;
  callers: Caller[];
  /** Same name, but the resolution lands in a different file. */
  elsewhere: number;
  /** Same name, more than one candidate, nothing to choose between them. */
  ambiguous: number;
  /** How many call sites with this name the index holds in total. */
  total: number;
  /** The files that declare the name. */
  candidates: string[];
  /** Resolved callers per reason, counted before the list was cut short. */
  viaCounts: Record<string, number>;
}

/** Whether a file's own symbols include this name. */
function declares(entry: IndexEntry | undefined, name: string): boolean {
  if (entry === undefined) return false;
  for (const symbol of entry.symbols ?? []) if (symbol.name === name) return true;
  return false;
}

/** The files whose symbols include this name. */
function declaringFiles(index: MemoIndex, name: string): string[] {
  const out: string[] = [];
  for (const [rel, entry] of Object.entries(index.files ?? {})) {
    if (declares(entry, name)) out.push(rel);
  }
  return out;
}

/**
 * Type-shaped names to the file that owns them.
 *
 * GDScript's class_name first, because that is how one Godot script names
 * another, then any declaration whose kind is a class -- which covers
 * JavaScript, Python, Go and Rust, where a type and its methods share a file.
 */
function typeOwners(index: MemoIndex): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [rel, entry] of Object.entries(index.files ?? {})) {
    if (typeof entry.className === "string" && entry.className.length > 0 && !owners.has(entry.className)) owners.set(entry.className, rel);
    for (const symbol of entry.symbols ?? []) {
      if (symbol.kind === "class" && !owners.has(symbol.name)) owners.set(symbol.name, rel);
    }
  }
  return owners;
}

/** Where one file's imports point, resolved once and remembered. */
function importTargets(index: MemoIndex, cache: Map<string, Set<string>>, rel: string, owners: Map<string, string>): Set<string> {
  const known = cache.get(rel);
  if (known !== undefined) return known;
  const targets = new Set<string>();
  const entry = index.files?.[rel];
  for (const spec of entry?.imports ?? []) {
    const target = resolveSpecifier(rel, spec, entry?.language, index.files ?? {}, owners);
    if (typeof target === "string" && target.length > 0) targets.add(target);
  }
  cache.set(rel, targets);
  return targets;
}

/**
 * Who calls the symbol in target.
 *
 * The reasons a call site is attributed are kept apart, because they do not
 * carry the same weight: a call on a receiver whose type the caller itself
 * declares is a fact, a call in the file that declares the name is the
 * language's own scoping rule, a name declared once in the whole project is
 * unambiguous by arithmetic, and a name reached through an import is as good as
 * the import graph. What none of those settles stays out of the list and is
 * counted instead -- an answer that names its own uncertainty is worth more than
 * one that hides it behind a longer list.
 *
 * @param sites - the call rows for this name, from the index database.
 * @param index - the live index, for declarations, types and imports.
 * @param target.name - the symbol whose callers are wanted.
 * @param target.file - the file that declares it.
 * @param options.limit - how many callers to list (default 20).
 */
export function callersOf(sites: CallSite[], index: MemoIndex, target: { name: string; file: string }, options: { limit?: number } = {}): CallerReport {
  const files = index.files ?? {};
  const candidates = declaringFiles(index, target.name);
  const owners = typeOwners(index);
  const imports = new Map<string, Set<string>>();
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : 20;
  const found: Array<Caller & { importance: number }> = [];
  const viaCounts: Record<string, number> = {};
  let elsewhere = 0;
  let ambiguous = 0;
  for (const site of sites) {
    const declaredHere = declares(files[site.relPath], target.name);
    // A receiver the project uses as a type is a type here too: that is how a
    // static call (Player.take_damage()) is written in every language indexed,
    // and it needs no declaration in this file to be true.
    const type = site.receiverType ?? (site.receiver !== null && owners.has(site.receiver) ? site.receiver : null);
    // A call with no receiver, or on this object, is answered by this file's own
    // declaration before anything else: that is what lexical scope means. A call
    // on some other object is not, because that object's type is exactly what is
    // unknown, and guessing the file that happens to share the name would be a
    // guess dressed as an answer.
    const bare = site.receiver === null || site.receiverType === "self";
    let resolved: { file: string; via: string } | null = null;
    if (type === "self") {
      if (declaredHere) resolved = { file: site.relPath, via: "self" };
    } else if (type !== null) {
      const owner = owners.get(type);
      if (owner !== undefined && declares(files[owner], target.name)) resolved = { file: owner, via: "type" };
    }
    if (resolved === null && bare && declaredHere) resolved = { file: site.relPath, via: "self" };
    if (resolved === null && candidates.length === 1) resolved = { file: candidates[0], via: "only" };
    if (resolved === null && candidates.length > 1) {
      const reached = [...importTargets(index, imports, site.relPath, owners)].filter((path) => candidates.includes(path));
      if (reached.length === 1) resolved = { file: reached[0], via: "import" };
    }
    if (resolved === null) {
      ambiguous += 1;
      continue;
    }
    if (resolved.file !== target.file) {
      elsewhere += 1;
      continue;
    }
    viaCounts[resolved.via] = (viaCounts[resolved.via] ?? 0) + 1;
    found.push({
      relPath: site.relPath,
      line: site.line,
      caller: site.caller,
      via: resolved.via,
      importance: Number(files[site.relPath]?.importance ?? 0),
    });
  }
  // The most important caller first, then by path and line. A call from a hub
  // file says more than one from a leaf, and a list with a limit has to cut
  // something -- cutting the least significant is the only defensible choice.
  found.sort((a, b) => b.importance - a.importance || a.relPath.localeCompare(b.relPath) || a.line - b.line);
  const callers: Caller[] = found.slice(0, limit).map((one) => ({ relPath: one.relPath, line: one.line, caller: one.caller, via: one.via }));
  return { name: target.name, file: target.file, callers, elsewhere, ambiguous, total: sites.length, candidates, viaCounts };
}

/** Every call site in the index that uses this name, as the resolver wants them. */
export function sitesFor(index: MemoIndex, name: string): CallSite[] {
  const out: CallSite[] = [];
  for (const [relPath, entry] of Object.entries(index.files ?? {})) {
    for (const call of entry.calls ?? []) {
      if (call.name === name) out.push({ ...call, relPath });
    }
  }
  return out;
}
