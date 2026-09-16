/**
 * The project index behind `memo find` and `memo map`.
 *
 * The point is not to know everything about the code — it is to answer "where
 * is X" without paying for a directory walk, and "what matters here" without
 * reading twenty files. So the index keeps, per file: size, estimated tokens,
 * a one-line description, the symbols with their line ranges, the call sites as
 * they were written, and an importance score derived from the import graph
 * (PageRank, the same shape OpenWolf uses).
 *
 * There is no parser here and no tree-sitter: extraction is line-based and
 * deliberately conservative. A heuristic that misses an exotic declaration is
 * acceptable; one that invents a symbol is not.
 *
 * @module dsh-plugin-memo/indexer
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { countTokens } from "./tokenizer.ts";
import type { IndexCall, IndexCoverage, IndexEntry, IndexSymbol, MemoIndex, TokenMode, TsAnalyzer } from "./types.ts";

/** What {@link buildIndex} and {@link refreshIndex} accept. */
export interface IndexOptions {
  exclude?: string[];
  maxFileBytes?: number;
  analyzer?: TsAnalyzer | null;
  tokenizer?: TokenMode | ((text: string) => number) | string;
  log?: (message: string) => void;
  root?: string;
}

/** A token budget, as a caller can spend one. */
export interface BudgetOptions {
  budgetTokens?: number;
}

/**
 * 2 added `imports` to every file, so the ranking pass can re-run over an
 * incrementally refreshed index without re-reading what did not change — the
 * whole point of {@link refreshIndex}.
 *
 * 3 added GDScript and Godot's text resource formats, `res://` resolution, the
 * `className` a GDScript global name resolves through, and the `excludes` an
 * index was built with. An index stamped with an older version is rebuilt
 * rather than patched.
 *
 * 4 can count tokens for real. The field was always called `tokens` and always
 * held a guess; now it holds the DeepSeek V4 tokenizer's answer when the index
 * was built with `tokenizer: "exact"`, and the index says which of the two it
 * is in `tokens`. A refresh whose counter differs from the stamp rebuilds,
 * because a reused entry would otherwise keep a count from the other unit.
 *
 * 5 moved the index out of \`index.json\` and into a local SQLite database
 * (\`./db.ts\`). The rows carry the same fields, so extraction and ranking did
 * not change -- but the medium did, and an index written in the old one cannot
 * be read from the new one, which is exactly what a version is for.
 *
 * 6 is what 5 was, searched by a full-text table that could not read CJK.
 *
 * 7 can search CJK text at all. FTS5 tokenizes with unicode61 by default, and
 * unicode61 does not segment CJK: a run of Chinese is *one* token, so a query
 * for a two-character phrase out of the middle of one matched nothing. The
 * answer then read as "the project does not mention this" rather than "the
 * index cannot say" -- the one failure a search surface must not have. On a
 * measured GDScript project such a term lived in 26 files, was in the index in
 * all of them, and matched none. The body, the path and the description are now
 * stored pre-tokenized (see padCjk in the tokenizer) and a query is padded the
 * same way, so a CJK phrase is the consecutive run of one-character tokens
 * that a phrase query already means. A version 6 database is rescanned rather
 * than read: only a scan writes the new columns, and the old ones cannot answer
 * a CJK query at all.
 */
export const INDEX_VERSION = 7;
export const DEFAULT_EXCLUDES = [
  "node_modules", ".git", ".memo", "dist", "build", "out", "target", "vendor",
  ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".idea", ".vscode",
];
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_FILES = 20_000;
/** How many unindexed suffixes a coverage report names; the rest are counted, not named. */
export const COVERAGE_SUFFIXES = 24;

/** Below this many estimated tokens a file is not worth a tree-sitter parse. */
export const TS_MIN_TOKENS = 500;

/** Language by extension. Anything not listed is not indexed. */
const LANGUAGE = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js",
  ".ts": "js", ".mts": "js", ".cts": "js", ".tsx": "js",
  ".py": "py", ".go": "go", ".rs": "rs",
  ".gd": "gd",
  // Godot's text resource formats. Not code, but they carry the scene tree and
  // every `res://` dependency a Godot project actually runs on.
  ".tscn": "gdres", ".tres": "gdres",
  // Game and tool data. Not code, and often the only place a project's real
  // vocabulary lives: an item id, a drop table, an NPC's schedule. Indexed for
  // the same reason the scene formats are -- `find` has to answer about the
  // files a change actually touches.
  ".json": "json",
};

/**
 * Declaration rules, first match wins per line. `group` is the capture holding
 * the name. Deliberately narrow: `export const x =` is a symbol only when it is
 * actually assigned a function.
 */
const RULES = {
  js: [
    { kind: "function", re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: "function", re: /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: "class", re: /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "class", re: /^\s*class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[={]/ },
    { kind: "enum", re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/ },
    { kind: "function", re: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/ },
    { kind: "const", re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  ],
  py: [
    { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: "method", re: /^\s*func\s+\([^)]*\)\s*([A-Za-z_]\w*)/ },
    { kind: "function", re: /^\s*func\s+([A-Za-z_]\w*)/ },
    { kind: "type", re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/ },
  ],
  rs: [
    { kind: "function", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: "type", re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/ },
  ],
  gd: [
    // `class_name` is matched before `class`, and the function rules after
    // both: only one rule wins per line, and when a script declares both a
    // global name and a class body the global name is the one other files
    // refer to. `class_name` cannot also match the `class` rule, because that
    // one requires whitespace after `class`.
    { kind: "class", re: /^\s*class_name\s+([A-Za-z_]\w*)/ },
    { kind: "function", re: /^\s*static\s+func\s+([A-Za-z_]\w*)/ },
    { kind: "function", re: /^\s*func\s+([A-Za-z_]\w*)/ },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)\s*(?::|extends\b)/ },
    { kind: "signal", re: /^\s*signal\s+([A-Za-z_]\w*)/ },
    { kind: "enum", re: /^\s*enum\s+([A-Za-z_]\w*)/ },
    { kind: "const", re: /^\s*const\s+([A-Za-z_]\w*)/ },
    // Annotations stack and may carry arguments (`@export_range(0, 100, 1)`),
    // so they are consumed rather than required to be absent.
    { kind: "var", re: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:static\s+)?var\s+([A-Za-z_]\w*)/ },
  ],
};

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  js: [/from\s+["']([^"']+)["']/g, /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s+["']([^"']+)["']/gm],
  // Two shapes only: `from x import ...` (which is also the relative form,
  // `from .util import x`) and a bare `import a, b`. A dotted absolute name is
  // resolved from the project root, the same way the interpreter's own search
  // path starts there — see {@link moduleCandidates}.
  py: [/^\s*from\s+([.\w]+)\s+import\b/gm, /^\s*import\s+([.\w]+)/gm],
  // One import path per line inside a block, and the quoted path otherwise.
  // A Go import path carries no extension and is rooted at the module, so the
  // last segment is a directory name (vendor/... included).
  go: [/^\s*import\s+(?:[.\w]+\s+)?["`]([^"`]+)["`]/gm, /^\s*(?:[.\w]+\s+)?["`]([^"`]+)["`]\s*$/gm],
  // `use a::b::{c, d}` is kept whole: the resolver trims the brace list, and
  // the stem search below no longer needs `mod x;` to find a module file.
  rs: [/^\s*use\s+([^;]+);/gm],
};

/** The token an import statement puts the name in. */
function aliasFree(spec) {
  const at = spec.search(/\s+as\s+/);
  return (at === -1 ? spec : spec.slice(0, at)).trim().replace(/[",;]+$/, "");
}
/**
 * GDScript dependencies. `res://` is kept in the capture so
 * {@link resolveSpecifier} can tell a project path from a global class name;
 * the bare-identifier form is `extends Player`, where `Player` is another
 * script's `class_name`.
 */
IMPORT_PATTERNS.gd = [
  /preload\(\s*"(res:\/\/[^"]+)"/g,
  /load\(\s*"(res:\/\/[^"]+)"/g,
  /^\s*extends\s+"(res:\/\/[^"]+)"/gm,
  /^\s*extends\s+([A-Za-z_]\w*)/gm,
];
/** Godot resource files depend on everything their `ext_resource` rows name. */
IMPORT_PATTERNS.gdres = [
  /^\[ext_resource[^\]]*?path="(res:\/\/[^"]+)"/gm,
];

/** Rough, honest, and documented as rough: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text).length / 4);
}

/**
 * The two ways this index can count a file. `estimated` is the 4-characters-per
 * -token guess and costs nothing; `exact` runs the shipped DeepSeek V4
 * tokenizer and costs a 6MB vocabulary parse per process plus real encoding
 * time. Both are honest about what they are — the index records which one it
 * used, and no output ever calls a guess a count.
 */
export const TOKEN_MODES = Object.freeze(["estimated", "exact"]);

/**
 * Resolve the `tokenizer` option into a counter. A function is taken as-is so
 * tests can substitute one; a mode name maps to a counter; anything else is the
 * cheap default. An unrecognised name is worth saying out loud rather than
 * silently downgrading a caller who thought they asked for exact counts.
 */
function resolveTokenCounter(options: IndexOptions, log?: (message: string) => void) {
  const asked = options.tokenizer;
  if (typeof asked === "function") return { mode: "custom", count: asked };
  if (asked === "exact") return { mode: "exact", count: exactTokens };
  if (asked !== undefined && asked !== "estimated" && asked !== null) {
    const say = typeof log === "function" ? log : () => {};
    say(`unknown tokenizer ${JSON.stringify(asked)} — using the 4-chars-per-token estimate`);
  }
  return { mode: "estimated", count: estimateTokens };
}

/**
 * The mode an index was counted in. Tri-state on purpose: `null` means the
 * index predates the field, and that is not the same answer as "estimated".
 * An index from an older format has to rebuild once, because nothing in it says
 * which unit its `tokens` are in — defaulting the question would read those
 * numbers as exact tokens the moment the exact counter is switched on.
 */
function countingMode(index: MemoIndex): TokenMode | null {
  return index?.tokens === "exact" || index?.tokens === "estimated" ? index.tokens : null;
}

/**
 * The cost of one shortlist hit, in the same unit the index was built in. A
 * hit's cost is a string this module makes up (`path Name`), so it is measured
 * with whichever counter produced the counts being spent against -- spending a
 * budget of exact tokens with a rough estimate of the hits would drift.
 */
export function costUnit(tokens: TokenMode): (text: string) => number {
  return tokens === "exact" ? exactTokens : estimateTokens;
}

/** Exact counts, loaded on first use: no project pays for the vocabulary twice. */
function exactTokens(text: string): number {
  return countTokens(text);
}

function stripLine(line) {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/**
 * `#`-comment stripping, for the languages where `#` starts a comment. It runs
 * after {@link stripLine} has already neutralized string literals, so a `#`
 * inside one is gone before this could mistake it for a comment — and this
 * cannot truncate code that merely contains a `#`.
 */
function stripHash(line) {
  return stripLine(line).replace(/#.*$/, "");
}

/**
 * Remove a `#` comment while leaving string literals intact.
 *
 * Import scanning needs the literals — `preload("res://a.gd")` is precisely
 * what is being looked for — so this cannot reuse {@link stripHash}, which
 * neutralizes strings on the way to stripping comments and would delete the
 * very path being searched for. A `#` inside a quoted string is skipped rather
 * than treated as a comment.
 */
function stripHashComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** The languages whose comment character is `#` rather than `//`. */
const HASH_COMMENT = new Set(["py", "gd"]);

/**
 * The languages whose comments are the slash kind: two slashes to the end of
 * the line, or a slash-star pair closed by its mirror.
 *
 * Named rather than assumed: {@link stripLine} neutralizes string literals on its
 * way to the comments, which is exactly wrong for the two formats whose
 * dependencies *are* string literals — Godot's `preload("res://...")` and the
 * `ext_resource path="..."` rows of a scene. Those keep their literals and lose
 * nothing, because neither language has a `//` comment to strip.
 */
const SLASH_COMMENT = new Set(["js", "go", "rs"]);

/** The doc for commentFree is below, next to the code it explains. */
/**
 * A file's lines joined with its own comments removed, for import scanning.
 *
 * Deliberately string-preserving where the older {@link stripHash} is not: the
 * patterns below read import specifiers *out of* string literals, so a pass that
 * neutralized strings on the way to the comments would delete exactly what is
 * being looked for. It did, once: `from "./auth"` became `from ""` and every
 * JavaScript import edge vanished while the suite stayed green. Comments go,
 * literals stay, and `#` languages keep their own reader for the same reason.
 */
function commentFree(lines, language) {
  const body = HASH_COMMENT.has(language) ? lines.map(stripHashComment) : lines;
  const joined = body.join(String.fromCharCode(10));
  return SLASH_COMMENT.has(language) ? stripComments(joined, false) : joined;
}

/**
 * A file's lines with its comments gone and its string literals emptied: the
 * text a call-site scan can trust.
 *
 * Stricter than {@link commentFree}, and for the opposite reason. An import
 * specifier *is* a string literal, while a call written inside one is not a call
 * at all -- and neither is a line of prose that happens to read retry(). The
 * hash languages keep their own reader for the same reason {@link stripHash}
 * exists, and a triple-quoted block is tracked because a docstring is a string
 * that spans lines, which is the one thing a line-at-a-time stripper cannot see
 * close.
 */
export function codeOnly(lines, language) {
  if (language === "js" || language === "go" || language === "rs") {
    return stripComments(lines.join(String.fromCharCode(10)), true).split(String.fromCharCode(10));
  }
  if (language !== "py" && language !== "gd") return [];
  const out = [];
  let fence = null;
  for (const line of lines) {
    if (fence !== null) {
      const close = line.indexOf(fence);
      if (close === -1) {
        out.push("");
        continue;
      }
      fence = null;
      out.push(stripHash(line.slice(close + 3)));
      continue;
    }
    const opened = fenceAt(line);
    if (opened !== null && line.indexOf(opened.marker, opened.at + 3) === -1) {
      fence = opened.marker;
      out.push(stripHash(line.slice(0, opened.at)));
      continue;
    }
    out.push(stripHash(line));
  }
  return out;
}

/** The first triple-quote in a line, and which of the two markers it is. */
function fenceAt(line) {
  const at = line.search(/"""|'''/);
  return at === -1 ? null : { at, marker: line.slice(at, at + 3) };
}

/**
 * Remove `//` and block comments from a whole file, leaving strings intact.
 *
 * One scan over the text rather than one regex per line, because the two things
 * this must not confuse are the ones a line-at-a-time pass cannot tell apart: a
 * `//` inside a string is not a comment, and a `/* *` + `/` that opens on one line
 * and closes on another is a comment that a per-line pass would leave standing.
 * The closing marker is written as `*` + `/` here for the same reason this whole
 * function exists -- prose about comment syntax is still prose.
 *
 * @param text - the file, lines joined with newlines.
 * Lines are preserved: a comment leaves as many newlines as it spanned, because
 * the call-site pass counts by line index and a collapsed comment would move
 * every call below it onto a line the file does not have.
 *
 * @param neutralize - when true, string contents are replaced with empty
 *   quotations. Off for import scanning (the specifier *is* the string) and on
 *   for the declaration pass, which wants a literal to stop looking like code.
 */
export function stripComments(text: string, neutralize: boolean): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== String.fromCharCode(10)) i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = text.indexOf("*" + "/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      const inside = text.slice(i, end);
      // The comment goes; the lines it occupied stay. A caller told a call is
      // on line 12 of a file where line 12 is still a comment has been handed a
      // wrong answer, and call sites are counted by line index.
      for (let k = inside.indexOf(String.fromCharCode(10)); k !== -1; k = inside.indexOf(String.fromCharCode(10), k + 1)) out += String.fromCharCode(10);
      i = end;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        j += 1;
      }
      if (neutralize) out += quote + quote;
      else out += text.slice(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The line where a brace-delimited body closes, or the declaration line. */
function braceEnd(lines, start) {
  // A declaration that opens no brace on its own line (`const X = [1, 2]`, a
  // one-line `type`) ends there. Without this the scan would run on to the next
  // brace anywhere below and report a range that belongs to some later symbol.
  if (!stripLine(lines[start]).includes("{")) return start;
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of stripLine(lines[i])) {
      if (ch === "{") {
        depth += 1;
        seen = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (seen && depth <= 0) return i;
  }
  return start;
}

/**
 * The last line of an indentation-delimited body.
 *
 * It returns the last *non-blank* body line, not `i - 1`: blank lines are
 * skipped while scanning, so `i - 1` can land on one and report a range that
 * ends a line past the body.
 */
function indentEnd(lines, start) {
  const indent = lines[start].match(/^\s*/)[0].length;
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    if (lines[i].match(/^\s*/)[0].length <= indent) return last;
    last = i;
  }
  return last;
}

/**
 * GDScript: a declaration with a trailing `:` opens an indentation block, and
 * one with an unclosed bracket opens a bracketed literal. Everything else is a
 * single line — which is what stops `const MAX := 300.0` from swallowing the
 * function beneath it.
 */
function gdBodyEnd(lines, start) {
  const first = stripHash(lines[start]);
  if (first.trimEnd().endsWith(":")) return indentEnd(lines, start);
  // Only a bracket left open by the declaration's OWN line continues the
  // declaration. Scanning on regardless would let a declaration with no
  // brackets at all (`const MAX_SPEED := 300.0`) swallow the next line that
  // happens to contain a parenthesis.
  let depth = 0;
  for (const ch of first) {
    if (ch === "[" || ch === "{" || ch === "(") depth += 1;
    else if (ch === "]" || ch === "}" || ch === ")") depth -= 1;
  }
  if (depth <= 0) return start;
  for (let i = start + 1; i < lines.length; i++) {
    for (const ch of stripHash(lines[i])) {
      if (ch === "[" || ch === "{" || ch === "(") depth += 1;
      else if (ch === "]" || ch === "}" || ch === ")") depth -= 1;
    }
    if (depth <= 0) return i;
  }
  return start;
}

/**
 * Godot resource files: a `[block]` runs to the next `[block]` at column 0,
 * with the blank separator lines before it trimmed off the reported range.
 */
function sectionEnd(lines, start) {
  const trim = (end) => {
    let at = end;
    while (at > start && lines[at].trim().length === 0) at -= 1;
    return at;
  };
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith("[")) return trim(i - 1);
  return trim(lines.length - 1);
}

/** The end line of one declaration, per language. */
function endFor(language, lines, start) {
  if (language === "py") return indentEnd(lines, start);
  if (language === "gd") return gdBodyEnd(lines, start);
  if (language === "gdres") return sectionEnd(lines, start);
  return braceEnd(lines, start);
}

/**
 * Class members for JS/TS.
 *
 * This needs brace depth, not just a per-line regex: a method is a declaration
 * only at the exact depth of its class body. Matching by indentation alone would
 * list every function call inside every method body.
 */
const MEMBER_MODIFIERS = /^\s*(?:(?:public|private|protected|static|async|readonly|abstract|declare|override|accessor)\s+)*(?:get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*[\(<]/;
const MEMBER_PROPERTY = /^\s*(?:(?:public|private|protected|static|readonly|declare|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/;
const CLASS_HEAD = /(?:^|\s)class\s+([A-Za-z_$][\w$]*)/;
const MEMBER_SKIP = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "typeof", "else", "do", "try", "with", "await"]);

function extractClassMembers(lines) {
  const members = [];
  const stack = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = stripLine(lines[i]);

    while (stack.length > 0 && depth < stack[stack.length - 1].memberDepth) stack.pop();
    const enclosing = stack[stack.length - 1];
    if (enclosing !== undefined && depth === enclosing.memberDepth) {
      const match = MEMBER_MODIFIERS.exec(code) ?? MEMBER_PROPERTY.exec(code);
      if (match !== null && !MEMBER_SKIP.has(match[1])) {
        members.push({
          name: `${enclosing.name}.${match[1]}`,
          kind: "method",
          line: i + 1,
          endLine: braceEnd(lines, i) + 1,
        });
      }
    }

    for (const ch of code) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }

    // Recorded after the brace count: members of this class sit one level in.
    const head = code.includes("{") ? CLASS_HEAD.exec(code) : null;
    if (head !== null) stack.push({ name: head[1], memberDepth: depth });
  }
  return members;
}

/**
 * Symbols for Godot's text resource format (`.tscn` scenes, `.tres` resources).
 *
 * These files are not code, but they carry the structure a code map needs: a
 * scene's node tree and the sub-resources it declares. Nodes are named by their
 * place in the tree (`Player/Sprite`) because bare node names repeat heavily
 * inside one scene, and every `res://` path is left to {@link IMPORT_PATTERNS}
 * so the dependency edges come from one place.
 */
const GD_NODE = /^\[node\s+name="([^"]+)"(?:[^\]]*?\bparent="([^"]+)")?[^\]]*\]/;
const GD_SUB_RESOURCE = /^\[sub_resource\s+type="([^"]+)"(?:[^\]]*?\bid="([^"]+)")?[^\]]*\]/;
const GD_RESOURCE = /^\[gd_resource\s+type="([^"]+)"/;

function extractGdResourceSymbols(lines) {
  const symbols = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("[")) continue;
    const node = GD_NODE.exec(lines[i]);
    if (node !== null) {
      const parent = node[2];
      const name = parent === undefined || parent === "" || parent === "." ? node[1] : `${parent}/${node[1]}`;
      symbols.push({ name, kind: "node", line: i + 1, endLine: sectionEnd(lines, i) + 1 });
      continue;
    }
    const sub = GD_SUB_RESOURCE.exec(lines[i]);
    if (sub !== null) {
      symbols.push({ name: sub[2] ?? sub[1], kind: "sub_resource", line: i + 1, endLine: sectionEnd(lines, i) + 1 });
      continue;
    }
    const resource = GD_RESOURCE.exec(lines[i]);
    if (resource !== null) symbols.push({ name: resource[1], kind: "resource", line: i + 1, endLine: sectionEnd(lines, i) + 1 });
  }
  return symbols;
}

/**
 * The keys of a JSON document, as symbols.
 *
 * Depth is the whole question here. A top-level key is the file's shape --
 * `items`, `villagers` -- and is what a reader means by "what is in this file";
 * the entries inside it are what somebody actually searches for by name. So the
 * top level is always taken, the strings directly inside those objects are taken
 * as well, and the two together are capped: a 4000-entry localisation table is a
 * body to search, not a symbol list to print.
 *
 * Lines are found by scanning the text for the key, because JSON.parse does not
 * report positions and a pretty-printed file puts one key per line. A key the
 * scan cannot place keeps the last position it saw rather than a guess.
 */
// A file's own shape is what `map`/`find --file` read, and it is what has to stay
// intact however big the file is: 40 top-level keys for a data file's entries, 4
// nested keys per entry to say what one entry holds, and a hard ceiling so a
// texture atlas cannot pour a hundred identical `name`/`icon` keys into search.
const JSON_TOP_KEYS = 40;
const JSON_ENTRY_KEYS = 4;
const JSON_KEYS = 400;
function extractJsonSymbols(lines: string[]): IndexSymbol[] {
  const text = lines.join(String.fromCharCode(10));
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const keyLine = (key: string, from: number): { line: number; endLine: number } => {
    const pattern = new RegExp("[\\\"\\\\]" + key.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\function extractSymbols(lines, language) {") + "[\\\"\\\\]\\s*:");
    for (let i = from; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return { line: i + 1, endLine: i + 1 };
  }
    return { line: from + 1 > 0 ? from + 1 : 1, endLine: from + 1 > 0 ? from + 1 : 1 };
  };
  const symbols: IndexSymbol[] = [];
  let cursor = 0;
  const top = Object.entries(parsed).slice(0, JSON_TOP_KEYS);
  for (const [key, value] of top) {
    const at = keyLine(key, cursor);
    cursor = Math.max(0, at.line - 1);
    symbols.push({ name: key, kind: "key", line: at.line, endLine: at.line });
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const child of Object.keys(value).slice(0, JSON_ENTRY_KEYS)) {
      if (symbols.length >= JSON_KEYS) break;
      const where = keyLine(child, cursor);
      cursor = Math.max(cursor, where.line - 1);
      symbols.push({ name: child, kind: "key", line: where.line, endLine: where.line });
    }
  }
  return symbols;
}
function extractSymbols(lines, language) {
  if (language === "gdres") return extractGdResourceSymbols(lines);
  if (language === "json") return extractJsonSymbols(lines);
  const rules = RULES[language] ?? [];
  const symbols = [];
  for (let i = 0; i < lines.length; i++) {
    for (const rule of rules) {
      const match = rule.re.exec(lines[i]);
      if (!match) continue;
      symbols.push({
        name: match[1],
        kind: rule.kind,
        line: i + 1,
        endLine: endFor(language, lines, i) + 1,
      });
      break;
    }
  }
  if (language === "js") symbols.push(...extractClassMembers(lines));
  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/** A one-line description: the file's own opening comment block, if it has one. */
function describe(lines) {
  const collected = [];
  let started = false;
  for (const raw of lines.slice(0, 40)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      if (started && collected.length > 0) break;
      continue;
    }
    // A shebang is not a comment: it carries the interpreter, and `#!/usr/bin/env
    // python3` read as a hash comment loses the `#` and describes the file as
    // "!/usr/bin/env python3".
    const isComment = !trimmed.startsWith("#!") && /^(\/\/|\/\*|\*|#|"""|--)/.test(trimmed);
    if (!started) {
      if (!isComment) return null;
      started = true;
    } else if (!isComment) {
      break;
    }
    const text = trimmed.replace(/^[/#*\s"-]+/, "").replace(/\*\/"?$/, "").trim();
    if (text.length > 0) collected.push(text);
    if (collected.length >= 2) break;
  }
  return collected.length === 0 ? null : collected.join(" ").slice(0, 200);
}

/**
 * The names a project's own `.gitignore` says are not source, as a set to skip.
 *
 * Deliberately narrow: this reads the plain names out of the file -- `lib/`,
 * `build`, `*.min.js` -- and ignores everything that would need git's matching
 * rules to get right (globs with slashes, negations, nested `.gitignore` files).
 * The point is the ordinary case that keeps biting: a directory the project
 * itself calls generated, which the built-in table does not know about and which
 * nothing else will remind anyone of. A name ignored by mistake costs an entry
 * in the index; a name *not* ignored by mistake costs the ranking, because a
 * vendored tree's symbols and imports drown out the project's own.
 *
 * Returns an empty set when there is no file, which is every test fixture and
 * most scratch directories.
 */
function gitignoredNames(root) {
  const names = new Set();
  let text;
  try {
    text = readFileSync(join(root, ".gitignore"), "utf8");
  } catch {
    return names;
  }
  for (const raw of String(text).split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    // A pattern with a slash is anchored somewhere this does not model; the
    // basename form is the one worth having.
    if (line.slice(0, -1).includes("/")) continue;
    const name = line.replace(/\/$/, "");
    if (name.length === 0 || name === "." || name === "..") continue;
    names.add(name);
  }
  return names;
}

/**
 * Whether a directory or file name is one the project itself ignores.
 *
 * `*.min.js` is matched as the suffix it is, a bare name as exactly itself, and
 * a name with a `*` anywhere else is left alone rather than guessed at.
 */
function ignoredName(name, ignored) {
  if (ignored.size === 0) return false;
  if (ignored.has(name)) return true;
  for (const pattern of ignored) {
    if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/**
 * One sweep tally: what the walk looked at, and what the extension table kept.
 *
 * A walk that returns only the files it accepted cannot say what it dropped, and
 * the difference is the whole of what a search can answer about. Counting it
 * costs nothing beyond the readdir the scan was doing anyway.
 */
function newTally() {
  return { seen: 0, candidates: 0, failed: 0, skipped: 0, suffixes: new Map() };
}

/** A file the extension table does not accept, counted under its suffix. */
function countSkipped(tally, ext) {
  const suffix = ext.length > 0 ? ext : "(无后缀)";
  tally.skipped += 1;
  tally.suffixes.set(suffix, (tally.suffixes.get(suffix) ?? 0) + 1);
}

/** The tally as the index carries it: biggest suffixes first, capped. */
function coverageOf(tally: { seen: number; candidates: number; failed: number; skipped: number; suffixes: Map<string, number> }): IndexCoverage {
  const suffixes = [...tally.suffixes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, COVERAGE_SUFFIXES);
  return { seen: tally.seen, candidates: tally.candidates, failed: tally.failed, skipped: tally.skipped, suffixes };
}

/**
 * Every file worth considering, in one sweep.
 *
 * @param tally - when given, filled in with what was seen and skipped. A capped
 *   walk (MAX_FILES) fills in what it managed to visit, which is the honest
 *   number for the index that walk produced.
 */
function walk(root, excludes, ignored, files, depth = 0, tally = null) {
  if (files.length >= MAX_FILES || depth > 24) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") && entry.name !== ".") {
      if (excludes.has(entry.name)) continue;
      if (entry.isDirectory()) continue; // dot-directories are configuration, not source
    }
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (excludes.has(entry.name)) continue;
      if (ignoredName(entry.name, ignored)) continue;
      walk(full, excludes, ignored, files, depth + 1, tally);
      continue;
    }
    if (!entry.isFile()) continue;
    if (ignoredName(entry.name, ignored)) continue;
    const language = LANGUAGE[extname(entry.name)];
    if (tally !== null) tally.seen += 1;
    if (language === undefined) {
      if (tally !== null) countSkipped(tally, extname(entry.name).toLowerCase());
      continue;
    }
    if (tally !== null) tally.candidates += 1;
    files.push({ full, language, ext: extname(entry.name).toLowerCase() });
  }
}

/**
 * Build the index for one project. Never throws: an unreadable file is skipped,
 * because a partial index still answers most questions.
 *
 * `options.analyzer` is the optional tree-sitter upgrade (see `ts-symbols.ts`).
 * Where it returns symbols, they replace the line-based ones for that file; a
 * `null` return — unsupported extension, grammar missing, parse failure — keeps
 * the regex result. Files below {@link TS_MIN_TOKENS} are never upgraded, which
 * is the same trade OpenWolf makes: small files are not worth a parse.
 */
/**
 * Index one source file. Returns null when the file cannot be indexed at all —
 * unreadable, over the size cap, or binary behind a source extension — so the
 * caller skips it rather than inventing an entry.
 *
 * Both the full scan and the incremental refresh come through here, so a file
 * means the same thing however it entered the index.
 */
async function indexOneFile(root, full, language, ext, maxBytes, analyzer, counter): Promise<{ rel: string; entry: IndexEntry } | null> {
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return null;
  }
  if (stat.size > maxBytes) return null;
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return null;
  }
  if (text.includes("\u0000")) return null; // binary that happens to carry a source extension
  const lines = text.split("\n");
  // The threshold below decides whether a tree-sitter parse is worth starting,
  // so it is asked of the cheap counter no matter which one fills the index: a
  // 6MB vocabulary parse may not be paid for a decision the guess settles.
  const rough = estimateTokens(text);
  const tokens = counter.count(text);
  let symbols: IndexSymbol[] = extractSymbols(lines, language);
  let symbolSource = "regex";
  if (analyzer !== null && rough >= TS_MIN_TOKENS) {
    try {
      const upgraded = await analyzer.analyze(text, ext);
      if (upgraded !== null && upgraded.length > 0) {
        symbols = upgraded;
        symbolSource = "ts";
      }
    } catch {
      // The upgrade is optional by construction: keep what the regex found.
    }
  }
  return {
    rel: relative(root, full).split("\\").join("/"),
    entry: {
      bytes: stat.size,
      lines: lines.length,
      tokens,
      mtimeMs: stat.mtimeMs,
      language,
      description: describe(lines),
      symbols,
      symbolSource,
      importance: 0,
      imports: collectImports(lines, language),
      // The calls this file makes, as written. What they resolve to is a fact
      // about the whole project, so it is decided when somebody asks -- see
      // calls.ts for why storing it here would rot.
      calls: collectCalls(lines, language, symbols),
      // Only GDScript has one; the field is always present so the entry shape
      // does not depend on the language.
      className: globalNameOf(text, language),
    },
  };
}

/** `ts (N files)` or `regex`, derived from the entries rather than tracked. */
function symbolSourceOf(files: Record<string, IndexEntry>): string {
  const tsFiles = Object.values(files).filter((file) => file.symbolSource === "ts").length;
  return tsFiles === 0 ? "regex" : `ts (${tsFiles} files)`;
}

/**
 * What the index was built with. A refresh reuses unchanged entries verbatim,
 * so if the tree-sitter analyzer appears or disappears between scans those
 * reused entries would keep the old extractor's symbols indefinitely and the
 * index would sit in a mixed state nothing explains. Stamping the capability
 * lets a change force a full rebuild, exactly like a format change.
 *
 * Deliberately not derived from the entries. A project can have the analyzer
 * available and still upgrade nothing — every file under the size threshold —
 * in which case `symbolSource` honestly reads `regex` while the capability was
 * present, and a single field could not say both without looking contradictory.
 * Deriving it from what happened is wrong the other way too: a file whose parse
 * failed, whose grammar did not load, or which simply holds no symbols never
 * becomes `ts`, so every refresh would re-parse it and report churn forever.
 * The stamp records the capability, `symbolSource` records the outcome, and the
 * two are allowed to differ.
 */
function analyzerAvailableOf(analyzer) {
  return analyzer !== null;
}

/**
 * The other half of the capability stamp: *which* grammars the ceiling had. The
 * boolean cannot say that the ceiling changed shape, and a plugin update that
 * ships one more grammar — Godot's resource format, say — would otherwise keep
 * every entry the smaller build produced, for as long as those files do not
 * change. Old indexes have no such field, so they rebuild once and say so.
 */
function analyzerGrammarsOf(analyzer) {
  return analyzer === null ? null : [...analyzer.grammars].sort().join(",");
}

export async function buildIndex(root: string, options: IndexOptions = {}): Promise<MemoIndex> {
  const resolved = resolve(root);
  const requested = Array.isArray(options.exclude) ? options.exclude : [];
  const excludes = new Set([...DEFAULT_EXCLUDES, ...requested]);
  const maxBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : MAX_FILE_BYTES;
  const analyzer = options.analyzer ?? null;
  const counter = resolveTokenCounter(options, options.log);
  const found: Array<{ full: string; language: string; ext: string }> = [];
  const tally = newTally();
  walk(resolved, excludes, gitignoredNames(resolved), found, 0, tally);

  const files: Record<string, IndexEntry> = {};
  for (const { full, language, ext } of found) {
    const one = await indexOneFile(resolved, full, language, ext, maxBytes, analyzer, counter);
    if (one !== null) files[one.rel] = one.entry;
    else tally.failed += 1;
  }

  rankByImportance(files);
  return {
    version: INDEX_VERSION,
    analyzerAvailable: analyzerAvailableOf(analyzer),
    analyzerGrammars: analyzerGrammarsOf(analyzer),
    scannedAt: new Date().toISOString(),
    root: resolved,
    // What `tokens` in every entry means. Not derived from the entries: a
    // project under the size cap can be counted exactly and still hold nothing
    // but single-digit files.
    tokens: counter.mode,
    // Remembered, not just applied: a refresh inherits them, so an exclusion
    // chosen for one scan is not silently undone by the next lookup.
    excludes: [...requested],
    fileCount: Object.keys(files).length,
    totalTokens: Object.values(files).reduce((sum, file) => sum + file.tokens, 0),
    symbolSource: symbolSourceOf(files),
    // What this scan could not see, kept with the index rather than recomputed by
    // whoever asks: only a scan is walking the tree anyway.
    coverage: coverageOf(tally),
    files,
  };
}

/**
 * Bring an existing index up to date, re-parsing only what actually changed.
 *
 * The sweep walks the tree and stats every candidate, but reads and re-parses a
 * file only when its mtime or size moved, or when the file is new. That makes
 * it strictly stronger than writing a notification hook: an edit made through
 * `bash`, by git, or by an editor outside this process is seen too, and so is a
 * file that appeared without anyone announcing it. A hook would have to
 * enumerate every way a file can change, and would still miss the ones that do
 * not go through the harness.
 *
 * Cost is one readdir sweep plus one `statSync` per candidate — measured at
 * roughly 2.5µs each, so single-digit milliseconds for an ordinary project and
 * tens of milliseconds at {@link MAX_FILES}. Reading and parsing, the expensive
 * part, happens only for files that moved.
 *
 * @param index - the previously loaded index: its `version`, `root` and `files`.
 * @param options - `exclude`, `maxFileBytes`, `analyzer`, `tokenizer`, and an
 *   optional `root` override.
 * @returns `{ index, added, updated, removed, reused, changed, rebuilt }`; an
 *   empty `changed` means nothing on disk moved and every entry was reused as-is.
 */
export async function refreshIndex(index: MemoIndex, options: IndexOptions = {}) {
  const root = resolve(options.root ?? index.root ?? ".");
  const analyzer = options.analyzer ?? null;
  const counter = resolveTokenCounter(options, options.log);
  // What the entries will be counted in. For a named mode that is the mode. For
  // a substituted counter it is whatever the index already holds: the caller's
  // function is not something the index can describe, and re-counting files
  // just to keep a stamp current is not what a refresh is for.
  const resulting = counter.mode === "custom" ? countingMode(index) : counter.mode;
  const maxBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : MAX_FILE_BYTES;
  // Inheritance, not replacement: a caller that passes nothing (or nothing
  // extra) keeps whatever the index was built with. Only `buildIndex` — the
  // explicit full scan — starts a new exclusion set.
  const requested = Array.isArray(options.exclude) && options.exclude.length > 0
    ? options.exclude
    : (Array.isArray(index.excludes) ? index.excludes : []);

  // An older format cannot be patched field by field — it is missing fields —
  // and neither can an index built by a different extractor, because the reused
  // entries would keep symbols the current analyzer would not produce.
  if (
    index.version !== INDEX_VERSION ||
    (index.analyzerAvailable === true) !== analyzerAvailableOf(analyzer) ||
    index.analyzerGrammars !== analyzerGrammarsOf(analyzer) ||
    // Counts from the other unit are not comparable with the budget this
    // refresh is being asked to spend, and reused entries would mix the two.
    countingMode(index) !== resulting
  ) {
    const rebuilt = await buildIndex(root, {
      exclude: requested,
      maxFileBytes: maxBytes,
      analyzer,
      tokenizer: resulting === "exact" ? "exact" : "estimated",
      log: options.log,
    });
    return {
      index: rebuilt,
      added: Object.keys(rebuilt.files),
      updated: [],
      removed: [],
      reused: 0,
      changed: rebuilt.fileCount,
      rebuilt: true,
    };
  }

  const excludes = new Set([...DEFAULT_EXCLUDES, ...requested]);
  const found: Array<{ full: string; language: string; ext: string }> = [];
  const tally = newTally();
  walk(root, excludes, gitignoredNames(root), found, 0, tally);

  const previous: Record<string, IndexEntry> = index.files ?? {};
  const files: Record<string, IndexEntry> = {};
  const added = [];
  const updated = [];
  let reused = 0;

  for (const { full, language, ext } of found) {
    const rel = relative(root, full).split("\\").join("/");
    const before = previous[rel];
    if (before !== undefined) {
      let stat = null;
      try {
        stat = statSync(full);
      } catch {
        stat = null;
      }
      // Unmoved since the scan: reuse the entry without reading the file. Copied
      // so the caller's index is never mutated by the re-ranking below.
      if (stat !== null && stat.mtimeMs === before.mtimeMs && stat.size === before.bytes) {
        files[rel] = { ...before };
        reused += 1;
        continue;
      }
    }
    const one = await indexOneFile(root, full, language, ext, maxBytes, analyzer, counter);
    if (one === null) {
      tally.failed += 1; // over the cap, binary, or unreadable
      continue;
    }
    files[one.rel] = one.entry;
    if (before === undefined) added.push(one.rel);
    else updated.push(one.rel);
  }

  // Anything the sweep did not produce either vanished or stopped being indexable.
  const removed = Object.keys(previous).filter((rel) => files[rel] === undefined);
  const changed = added.length + updated.length + removed.length;
  if (changed > 0) rankByImportance(files);

  return {
    index: {
      version: INDEX_VERSION,
      analyzerAvailable: analyzerAvailableOf(analyzer),
      analyzerGrammars: analyzerGrammarsOf(analyzer),
      scannedAt: changed > 0 ? new Date().toISOString() : index.scannedAt,
      root,
      tokens: resulting,
      excludes: [...requested],
      fileCount: Object.keys(files).length,
      totalTokens: Object.values(files).reduce((sum, file) => sum + file.tokens, 0),
      symbolSource: symbolSourceOf(files),
      coverage: coverageOf(tally),
      files,
    },
    added,
    updated,
    removed,
    reused,
    changed,
    rebuilt: false,
  };
}

/**
 * A language's project-global name, where it has one.
 *
 * GDScript's `class_name` is how one script refers to another by identifier, so
 * the name is the edge (`extends Player`) and the file declaring it is the
 * target. Nothing else indexed here has an equivalent.
 */
const GLOBAL_NAME = { gd: /^\s*class_name\s+([A-Za-z_]\w*)/m };

function globalNameOf(text, language) {
  const pattern = GLOBAL_NAME[language];
  if (pattern === undefined) return null;
  const match = pattern.exec(text);
  return match === null ? null : match[1];
}

/**
 * The import specifiers one file names, for the ranking graph. Pure: the full
 * scan and the incremental refresh both need it, and the refresh needs the
 * answer for files it deliberately did not re-read.
 */
function collectImports(lines, language) {
  const text = commentFree(lines, language);
  const specs = new Set<string>();
  for (const pattern of IMPORT_PATTERNS[language] ?? []) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // One statement can name several modules — Python's `import a, b`, Go's
      // block form. Every language that spells it that way separates the names
      // with a comma, and none of the path-shaped ones may contain one.
      for (const part of String(match[1]).split(",")) {
        const spec = aliasFree(part);
        if (spec.length > 0) specs.add(spec);
      }
    }
  }
  return [...specs];
}

/** Syntax that looks like a call: if( is not a call to if. */
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "sizeof", "new",
  "delete", "await", "yield", "else", "do", "try", "with", "case", "match",
  "in", "is", "not", "and", "or", "lambda", "function", "class", "def", "func",
  "fn", "var", "const", "let", "signal", "super", "when", "where", "until",
]);

/** The word before a name that means it is being declared, not called. */
const DECLARED_AFTER = new Set([
  "func", "def", "fn", "function", "class", "struct", "enum", "interface",
  "type", "signal", "var", "const", "let", "static", "import", "from", "use",
  "extends", "implements", "sub", "macro", "operator", "property", "namespace",
  "typedef", "trait", "impl", "mod",
]);

/** Receivers that mean "this object", where the file itself is the candidate. */
const SELF_RECEIVER = new Set(["self", "this", "cls"]);

/**
 * One call as a person writes it: an optional receiver, the name, an opening
 * parenthesis.
 *
 * The receiver capture is deliberately one segment deep, and it is the segment
 * nearest the call. In a.b.c() the call is on c and the object it was written on
 * is b -- the one whose type decides what c is. Keeping the whole chain would
 * store a string no resolver can use, and the leading capture exists so that a
 * match is found without also matching the tail of a longer identifier.
 */
const CALL = /(^|[^\w$])(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;

/** The word immediately before a match, to tell a declaration from a call. */
const WORD_BEFORE = /([A-Za-z_$][\w$]*)\s*$/;

/**
 * The local declarations that give a receiver its type: var p: Player,
 * p := Player.new(), const p = new Player(), p := &Player{}.
 *
 * Local by construction, which is why this can be settled while indexing: no
 * other file can change what p is. Only type-shaped names are kept -- a receiver
 * is a variable far more often than it is a type, and the uppercase convention
 * is the only signal a regex has for telling them apart.
 */
const TYPE_RULES = {
  gd: [
    // The name-colon-Type annotation, wherever it is written: a var, an
    // exported var, a function parameter, an @onready. It is the most common way
    // a Godot project states a type, and a parameter is where a method call's
    // receiver usually comes from.
    /([A-Za-z_]\w*)\s*:\s*([A-Z]\w*)/,
    /\bvar\s+([A-Za-z_]\w*)\s*(?::=|=)\s*([A-Za-z_]\w*)\s*\.\s*new\b/,
  ],
  py: [
    // The same two shapes: an annotated name (parameter or local) and a
    // constructor whose class name is right there.
    /([A-Za-z_]\w*)\s*:\s*([A-Z]\w*)/,
    /\b([A-Za-z_]\w*)\s*(?::\s*[A-Za-z_][\w.]*)?\s*=\s*([A-Z]\w*)\s*\(/,
  ],
  js: [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)/,
  ],
  go: [
    /\bvar\s+([A-Za-z_]\w*)\s+\*?([A-Z]\w*)/,
    /\b([A-Za-z_]\w*)\s*:=\s*&?([A-Z]\w*)\s*\{/,
  ],
  rs: [
    /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*&?(?:mut\s+)?([A-Z]\w*)/,
    /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*=\s*&?([A-Z]\w*)\s*::/,
  ],
};

/** The receivers whose type this file declares, as a variable-to-type map. */
function declaredTypes(code, language) {
  const rules = TYPE_RULES[language] ?? [];
  const types = new Map();
  for (const line of code) {
    for (const rule of rules) {
      const match = rule.exec(line);
      if (match === null) continue;
      if (/^[A-Z]/.test(match[2])) types.set(match[1], match[2]);
      break;
    }
  }
  return types;
}

/**
 * The kinds whose body a call can sit in.
 *
 * A call written in the initializer of a variable is inside that variable's
 * range, and naming the variable as the caller would be a small lie: nothing
 * calls from a var. So only a declaration that can call anything is looked at,
 * and a call outside all of them -- module level, or a const holding a function
 * the line pass could not recognize as one -- is attributed to the file.
 */
const CALLABLE = new Set(["function", "method"]);

/** The callable declaration a line sits inside: the innermost one covering it. */
function enclosingName(symbols: IndexSymbol[], line: number): string | null {
  let best: IndexSymbol | null = null;
  for (const symbol of symbols) {
    if (!CALLABLE.has(symbol.kind)) continue;
    if (symbol.line > line || line > symbol.endLine) continue;
    if (best === null || symbol.line >= best.line) best = symbol;
  }
  return best === null ? null : best.name;
}

/**
 * Every call site in one file, each with the declaration it sits inside.
 *
 * What this deliberately does not do is decide what the name refers to. A file's
 * calls are a local fact; which declaration answers them is not, and a table of
 * stale resolutions is worse than no table at all.
 *
 * @param lines - the file's lines.
 * @param language - from the index's language table; gdres files carry no calls.
 * @param symbols - what the same file declared, for the enclosing declaration.
 */
export function collectCalls(lines, language, symbols: IndexSymbol[]): IndexCall[] {
  if (language === "gdres") return [];
  const code = codeOnly(lines, language);
  const types = declaredTypes(code, language);
  const calls: IndexCall[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < code.length; i += 1) {
    const text = code[i];
    if (text.indexOf("(") === -1) continue;
    CALL.lastIndex = 0;
    let match = CALL.exec(text);
    while (match !== null) {
      const before = WORD_BEFORE.exec(text.slice(0, match.index + match[1].length));
      if (before !== null && DECLARED_AFTER.has(before[1])) {
        match = CALL.exec(text);
        continue;
      }
      let receiver = match[2] === undefined ? null : match[2];
      let name = match[3];
      if (KEYWORDS.has(name)) {
        // Foo.new() is GDScript's constructor: what is being used is Foo.
        if (name === "new" && receiver !== null && /^[A-Z]/.test(receiver)) {
          name = receiver;
          receiver = null;
        } else {
          match = CALL.exec(text);
          continue;
        }
      }
      const line = i + 1;
      const key = line + " " + name + " " + (receiver === null ? "" : receiver);
      if (seen.has(key)) {
        match = CALL.exec(text);
        continue;
      }
      seen.add(key);
      calls.push({
        name,
        receiver,
        receiverType: receiver === null ? null : SELF_RECEIVER.has(receiver) ? "self" : types.get(receiver) ?? null,
        line,
        caller: enclosingName(symbols, line),
      });
      match = CALL.exec(text);
    }
  }
  return calls;
}

/**
 * Resolve one specifier against the index, in the importing file's own language.
 *
 * Four shapes reach here:
 *
 *  - a `res://` project path (Godot, always carrying its extension);
 *  - a relative path -- `./auth`, `../pkg/mod`, Python's `from .util import x`,
 *    where the leading dots are the whole notation and carry no slashes;
 *  - an absolute module name -- Python's `from app.models import User`, Go's
 *    `example.com/x/pkg`, Rust's `crate::a::b` -- rooted at the project (Python)
 *    or the crate (Rust), and for Go naming a *directory* whose package is what
 *    the file imports;
 *  - a bare identifier, which is only ever a GDScript global class name, because
 *    no other indexed language refers to a sibling file by a name the file
 *    itself declares.
 *
 * Every one of these is resolved *against the index*: nothing is invented, an
 * ambiguous or unseen target yields null, and a language this index cannot
 * resolve contributes no edge at all. The ranking is what the answer feeds, and
 * a wrong edge is worse there than a missing one.
 *
 * @param fromRel - the importing file, project-relative with "/" separators.
 * @param spec - the specifier as the source spelled it.
 * @param language - the importing file's language, from the index entry.
 * @param files - every indexed path.
 * @param byClassName - GDScript global name -> path, built once per ranking pass.
 */
export function resolveSpecifier(fromRel, spec, language, files, byClassName) {
  if (spec.startsWith("res://")) {
    const target = posix.normalize(spec.slice("res://".length));
    return files[target] === undefined || files[target] === null ? null : target;
  }
  if (spec.startsWith(".") && (language === "js" || language === "gd")) {
    return matchFile(jsCandidates(fromRel, spec), files);
  }
  if (language === "py") {
    // A single dot is `from . import x` -- a level, not a path segment. More
    // than one is a parent traversal, and the notation is the same either way.
    const dots = /^\.+/.exec(spec);
    if (dots !== null) {
      const parents = dots[0].length - 1;
      const base = posix.dirname(fromRel);
      const up = parents === 0 ? base : posix.normalize(posix.join(base, ...Array(parents).fill("..")));
      const head = up === "." ? "" : up;
      const parts = spec.slice(dots[0].length).split(".").filter((part) => part.length > 0);
      // A list that empties out here means "the package itself", which is a
      // directory; the import names a module inside it.
      if (parts.length === 0) return null;
      return matchFile([posix.join(head, ...parts)], files);
    }
    return matchFile(partsFor(spec), files);
  }
  if (language === "go") return matchFile(goCandidates(spec), files);
  if (language === "rs") return matchFile(rustCandidates(fromRel, spec, files), files);
  if (files[spec] !== undefined && files[spec] !== null) return spec;
  return byClassName !== undefined && byClassName.has(spec) ? byClassName.get(spec) : null;
}

/** A relative path run through the extension/index table: the JS and Godot rule. */
function jsCandidates(fromRel, spec) {
  const base = posix.dirname(fromRel);
  const target = posix.normalize(posix.join(base === "." ? "" : base, spec));
  return [
    target,
    ...EXTENSIONS.map((ext) => target + ext),
    ...EXTENSIONS.map((ext) => posix.join(target, "index" + ext)),
    ...EXTENSIONS.map((ext) => posix.join(target, "__init__" + ext)),
  ];
}

/** Dots to slashes: Python's absolute form, rooted where a run from the root is. */
function partsFor(spec) {
  return spec.split(".").filter((part) => part.length > 0);
}

/** Escape a literal so it can stand inside a regular expression. */
function literal(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The path a bare module stem names, whichever file or package carries it. */
function stemToPath(stem) {
  return "^(?:.*/)?" + literal(stem) + "(?:\\.\\w+|/__init__\\.py)$";
}

/**
 * Go import paths name a directory, and the package inside it is matched by
 * *file*, never by module path -- so the last segment is the directory and any
 * file in it is the answer.
 *
 * `example.com/x/pkg`, `x/pkg` and `pkg` all bottom out the same way, which
 * is also what makes a `vendor/`-nested dependency resolve: the vendored copy
 * is an indexed directory with that name, and the module path above it is not in
 * the index at all.
 */
function goCandidates(spec) {
  const segments = String(spec).split("/").filter((part) => part.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : "";
  const out = [];
  if (last.length > 0 && !last.includes(".")) out.push("^(?:.*/)?" + literal(last) + "/[^/]+\\.go$");
  if (last.length > 0) out.push(stemToPath(last));
  return out;
}

/**
 * Rust paths bottom out at a module file, and how the path is rooted depends on
 * the shape of the crate: a `src/` layout, or `main.rs`/`lib.rs` at the root.
 *
 * `crate::`, `self::` and `super::` are relative to the importing module's own
 * path, so they are resolved by *shape* -- the segments after the keyword,
 * joined -- which lands on `a/b/mod.rs` as readily as on `a/b.rs`. Everything
 * else is an absolute path from a crate root, or a module stem.
 */
function rustCandidates(fromRel, spec, files) {
  const clean = String(spec).split("{")[0].trim().replace(/::$/, "");
  if (clean.length === 0) return [];
  if (clean === "crate" || clean.startsWith("crate::")) {
    const rest = clean === "crate" ? "" : clean.slice("crate::".length);
    return packageCandidates(partsOf(rest));
  }
  if (clean === "self" || clean.startsWith("self::")) {
    const rest = clean === "self" ? "" : clean.slice("self::".length);
    return packageCandidates(partsOf(rest));
  }
  if (clean === "super" || clean.startsWith("super::")) {
    const rest = clean === "super" ? "" : clean.slice("super::".length);
    const base = posix.dirname(fromRel);
    // From a module file, `super` is the package above it; from a crate root it
    // is the directory the file lives in.
    const dir = posix.basename(base) === "src" ? base : posix.dirname(base);
    const head = dir === "." ? "" : dir;
    return packageCandidates(partsOf(rest).map((part) => posix.join(head, part)));
  }
  return matchSpecs([stemToPath(clean), ...packageCandidates(partsOf(clean))], files);
}

/** `a::b::c` as path segments; a `*` glob is not a path. */
function partsOf(spec) {
  return String(spec)
    .split("::")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "*");
}

/** Every file path a module path could mean: the module file, or the directory's own. */
function packageCandidates(segments) {
  if (segments.length === 0) return [];
  const joined = posix.join(...segments);
  return [
    ...EXTENSIONS.map((ext) => joined + ext),
    ...EXTENSIONS.map((ext) => posix.join(joined, "mod" + ext)),
    ...EXTENSIONS.map((ext) => posix.join(joined, "lib" + ext)),
    ...EXTENSIONS.map((ext) => posix.join(joined, "main" + ext)),
    ...EXTENSIONS.map((ext) => posix.join(joined, "__init__" + ext)),
  ];
}

/**
 * The one file a candidate list names, or null.
 *
 * A list mixes exact paths -- which decide on the spot -- with patterns that
 * stand for a package or a module stem and can match several files. Patterns are
 * ranked by shape (the module file itself, then a directory's `mod`/`__init__`,
 * then a same-named file anywhere) and an outright tie is a miss rather than a
 * coin flip: the edge is only worth having if the index knows which file it goes
 * to.
 */
function matchFile(candidates, files) {
  const patterns = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    if (files[candidate] !== undefined && files[candidate] !== null) return candidate;
    patterns.push("^" + literal(candidate) + "$");
  }
  return matchSpecs(patterns, files);
}

/** The winning path for a group of patterns, or null when they name several. */
function matchSpecs(patterns, files) {
  if (patterns.length === 0) return null;
  const hits = new Map();
  for (let rank = 0; rank < patterns.length; rank++) {
    let re;
    try {
      re = new RegExp(patterns[rank]);
    } catch {
      continue;
    }
    for (const rel of Object.keys(files)) {
      if (files[rel] === undefined || files[rel] === null) continue;
      if (hits.has(rel) && hits.get(rel).rank <= rank) continue;
      if (re.test(rel)) hits.set(rel, { rel, rank });
    }
  }
  if (hits.size === 0) return null;
  let best = null;
  for (const hit of hits.values()) if (best === null || hit.rank < best) best = hit.rank;
  let found = null;
  let seen = 0;
  for (const hit of hits.values()) {
    if (hit.rank === best) {
      seen += 1;
      found = hit.rel;
    }
  }
  return seen === 1 ? found : null;
}

/** Extensions a relative specifier may leave implicit, in the order tried. */
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".gd", ".tscn", ".tres"];

/** Personalized PageRank over the import graph, normalized to 0..1. */
function rankByImportance(files: Record<string, IndexEntry>) {
  const names = Object.keys(files);
  if (names.length === 0) return;
  // One pass to index every declared global name, so resolving `extends Player`
  // is a lookup rather than a scan of every file per edge.
  const byClassName = new Map();
  for (const name of names) {
    const declared = files[name].className;
    if (typeof declared === "string" && declared.length > 0 && !byClassName.has(declared)) byClassName.set(declared, name);
  }
  const out = new Map(names.map((name) => [name, []]));
  for (const name of names) {
    const entry = files[name];
    for (const spec of entry.imports ?? []) {
      const target = resolveSpecifier(name, spec, entry.language, files, byClassName);
      if (target !== null) out.get(name).push(target);
    }
  }

  const damping = 0.85;
  let rank = new Map(names.map((name) => [name, 1 / names.length]));
  for (let iteration = 0; iteration < 20; iteration++) {
    let dangling = 0;
    const next = new Map(names.map((name) => [name, (1 - damping) / names.length]));
    for (const name of names) {
      const targets = out.get(name);
      const current = rank.get(name);
      if (targets.length === 0) {
        dangling += current;
        continue;
      }
      const share = (damping * current) / targets.length;
      for (const target of targets) next.set(target, next.get(target) + share);
    }
    const spread = (damping * dangling) / names.length;
    for (const name of names) next.set(name, next.get(name) + spread);
    rank = next;
  }
  // Normalized against the mean, not the maximum. PageRank on a real project is
  // flat -- half the files are imported by nobody -- so scaling by the top score
  // hands them all the same 1.0 and the bonus this feeds stops telling anything
  // apart, which is exactly what a ranking signal must not do. Against the mean
  // an ordinary file sits near 1, an unimported one below it, and a hub well
  // above, and the number means the same thing from project to project.
  const total = [...rank.values()].reduce((sum, value) => sum + value, 0);
  const mean = names.length > 0 ? total / names.length : 0;
  for (const name of names) {
    files[name].importance = mean > 0 ? Number((rank.get(name) / mean).toFixed(4)) : 0;
  }
}

const DEFAULT_BUDGET = 1000;

/** Cost of one hit in the emitted shortlist, in estimated tokens. */
function hitCost(relPath: string, name: string | null, tokens: TokenMode): number {
  return costUnit(tokens)(`${relPath} ${name ?? ""}`) + 6;
}

/**
 * Rank files and symbols against a query, stopping at the token budget.
 * Exact symbol names beat prefixes, which beat substrings, which beat paths.
 */
export function findInIndex(index: MemoIndex, query: string, options: BudgetOptions = {}) {
  const budget = Number.isFinite(options.budgetTokens) ? options.budgetTokens : DEFAULT_BUDGET;
  // The unit is whatever the index says it is; a caller cannot spend a budget in
  // a currency the numbers were not counted in.
  const tokens = countingMode(index) === "exact" ? "exact" : "estimated";
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle.length === 0) return { matches: [], spent: 0, budget, truncated: false, total: 0 };

  const candidates = [];
  for (const [relPath, file] of Object.entries(index.files)) {
    const path = relPath.toLowerCase();
    let best = 0;
    let symbol = null;
    for (const candidate of file.symbols) {
      const name = candidate.name.toLowerCase();
      let score = 0;
      if (name === needle) score = 100;
      else if (name.startsWith(needle)) score = 70;
      else if (name.includes(needle)) score = 45;
      if (score > 0 && (symbol === null || score > best)) {
        best = score;
        symbol = candidate;
      }
    }
    if (best === 0 && path.includes(needle)) {
      best = 30;
      symbol = null;
    }
    if (best === 0 && (file.description ?? "").toLowerCase().includes(needle)) best = 12;
    if (best === 0) continue;
    candidates.push({
      relPath,
      score: best + file.importance * 10,
      symbol,
      kind: symbol ? symbol.kind : "file",
      quality: best,
      importance: file.importance,
      line: symbol ? `${relPath}:${symbol.line}-${symbol.endLine}` : relPath,
      description: file.description,
      tokens: file.tokens,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
  const matches = [];
  let spent = 0;
  for (const candidate of candidates) {
    const cost = hitCost(candidate.relPath, candidate.symbol ? candidate.symbol.name : null, tokens);
    if (spent + cost > budget && matches.length > 0) break;
    spent += cost;
    matches.push(candidate);
  }
  return { matches, spent, budget, truncated: matches.length < candidates.length, total: candidates.length };
}

/** Description and symbol ranges for one indexed path. */
export function fileDetail(index: MemoIndex, relPath: string) {
  const wanted = String(relPath ?? "").replace(/^\.\//, "");
  const exact = index.files[wanted];
  if (exact !== undefined) return { relPath: wanted, ...exact };
  const lower = wanted.toLowerCase();
  const hit = Object.keys(index.files).find((key) => key.toLowerCase().endsWith(lower));
  return hit === undefined ? null : { relPath: hit, ...index.files[hit] };
}

/** Focused file list, or a per-directory rollup when no focus is given. */
export function buildMap(index: MemoIndex, focus: string | null, options: BudgetOptions = {}) {
  const budget = Number.isFinite(options.budgetTokens) ? options.budgetTokens : 1200;
  const tokens = countingMode(index);
  const terms = String(focus ?? "").toLowerCase().split(/[\s,]+/).filter((term) => term.length >= 2);
  const entries = Object.entries(index.files);

  if (terms.length === 0) {
    const dirs = new Map();
    for (const [relPath, file] of entries) {
      const top = relPath.includes("/") ? relPath.split("/")[0] : ".";
      const bucket = dirs.get(top) ?? { dir: top, files: 0, tokens: 0, best: null };
      bucket.files += 1;
      bucket.tokens += file.tokens;
      if (bucket.best === null || file.importance > bucket.best.importance) {
        bucket.best = { relPath, importance: file.importance, description: file.description };
      }
      dirs.set(top, bucket);
    }
    const ranked = [...dirs.values()].sort((a, b) => b.tokens - a.tokens);
    const out = [];
    let spent = 0;
    for (const bucket of ranked) {
      const cost = costUnit(tokens)(`${bucket.dir} ${bucket.best?.relPath ?? ""} ${bucket.best?.description ?? ""}`) + 6;
      if (spent + cost > budget && out.length > 0) break;
      spent += cost;
      out.push(bucket);
    }
    return { mode: "rollup", focus: null, tokens, dirs: out, spent, budget, truncated: out.length < ranked.length, total: ranked.length };
  }

  const scored = [];
  for (const [relPath, file] of entries) {
    const path = relPath.toLowerCase();
    const description = (file.description ?? "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (path.includes(term)) score += 20;
      if (description.includes(term)) score += 8;
      for (const symbol of file.symbols) {
        const name = symbol.name.toLowerCase();
        if (name === term) score += 40;
        else if (name.includes(term)) score += 15;
      }
    }
    if (score === 0) continue;
    // Whether a symbol *is* the term, rather than a file that mentions it.
    // Search relevance and standing are different questions, and without this
    // the second one answers the first: a scene with a fat description and a
    // high import rank used to outrank the script that declares the name.
    const named = file.symbols.some((symbol) => terms.includes(symbol.name.toLowerCase()));
    const exact = file.symbols.some((symbol) => symbol.name.toLowerCase() === terms[0]);
    scored.push({ relPath, score: score + file.importance * 12, named, exact, importance: file.importance, tokens: file.tokens, description: file.description, symbols: file.symbols.length });
  }
  scored.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.named) - Number(a.named) || b.score - a.score || a.relPath.localeCompare(b.relPath));
  const files = [];
  let spent = 0;
  for (const entry of scored) {
    const cost = costUnit(tokens)(`${entry.relPath} ${entry.description ?? ""}`) + 8;
    if (spent + cost > budget && files.length > 0) break;
    spent += cost;
    files.push(entry);
  }
  return { mode: "focused", focus: terms.join(" "), tokens, files, spent, budget, truncated: files.length < scored.length, total: scored.length };
}

/** Index freshness: which indexed files changed or disappeared since the scan. */
export function staleFiles(index: MemoIndex, limit = 10) {
  const changed = [];
  const missing = [];
  for (const [relPath, file] of Object.entries(index.files)) {
    try {
      const stat = statSync(join(index.root, relPath));
      if (stat.mtimeMs !== file.mtimeMs) changed.push(relPath);
    } catch {
      missing.push(relPath);
    }
  }
  return { changed: changed.slice(0, limit), missing: missing.slice(0, limit), changedCount: changed.length, missingCount: missing.length };
}

export function indexMeta(index: MemoIndex) {
  return {
    version: index.version,
    scannedAt: index.scannedAt,
    root: index.root,
    fileCount: index.fileCount,
    totalTokens: index.totalTokens,
    // Whether `totalTokens` is a count or a guess. Every surface that shows a
    // token number reads this before it decides how to word it.
    tokens: countingMode(index) ?? "estimated",
    symbolCount: Object.values(index.files).reduce((sum, file) => sum + file.symbols.length, 0),
  };
}
