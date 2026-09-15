/**
 * The project index behind `memo_find` and `memo_map`.
 *
 * The point is not to know everything about the code — it is to answer "where
 * is X" without paying for a directory walk, and "what matters here" without
 * reading twenty files. So the index keeps, per file: size, estimated tokens,
 * a one-line description, the symbols with their line ranges, and an importance
 * score derived from the import graph (PageRank, the same shape OpenWolf uses).
 *
 * There is no parser here and no tree-sitter: extraction is line-based and
 * deliberately conservative. A heuristic that misses an exotic declaration is
 * acceptable; one that invents a symbol is not.
 *
 * @module dsh-plugin-memo/indexer
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { countTokens } from "./tokenizer.js";

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
 */
export const INDEX_VERSION = 4;
export const DEFAULT_EXCLUDES = [
  "node_modules", ".git", ".memo", "dist", "build", "out", "target", "vendor",
  ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".idea", ".vscode",
];
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_FILES = 20_000;
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

const IMPORT_PATTERNS = {
  js: [/from\s+["']([^"']+)["']/g, /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s+["']([^"']+)["']/gm],
  py: [/^\s*from\s+([.\w]+)\s+import/gm, /^\s*import\s+([.\w]+)/gm],
  go: [],
  rs: [],
};

IMPORT_PATTERNS.go = [];
IMPORT_PATTERNS.rs = [];
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
export function estimateTokens(text) {
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
function resolveTokenCounter(options, log) {
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
function countingMode(index) {
  return index?.tokens === "exact" || index?.tokens === "estimated" ? index.tokens : null;
}

/**
 * The cost of one shortlist hit, in the same unit the index was built in. A
 * hit's cost is a string this module makes up (`path Name`), so it is measured
 * with whichever counter produced the counts being spent against — spending a
 * budget of exact tokens with a rough estimate of the hits would drift.
 */
function costUnit(tokens) {
  return tokens === "exact" ? exactTokens : estimateTokens;
}

/** Exact counts, loaded on first use: no project pays for the vocabulary twice. */
function exactTokens(text) {
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
 * A file's lines joined with its own comment style removed, for import
 * scanning. Without this a commented-out line is a dependency: `# preload(...)`
 * and `# import os` both used to become edges that no code ever had.
 */
function commentFree(lines, language) {
  const body = HASH_COMMENT.has(language) ? lines.map(stripHashComment) : lines;
  return body.join("\n");
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

function extractSymbols(lines, language) {
  if (language === "gdres") return extractGdResourceSymbols(lines);
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
    const isComment = /^(\/\/|\/\*|\*|#|"""|--)/.test(trimmed);
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

function walk(root, excludes, files, depth = 0) {
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
      walk(full, excludes, files, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const language = LANGUAGE[extname(entry.name)];
    if (language === undefined) continue;
    files.push({ full, language, ext: extname(entry.name).toLowerCase() });
  }
}

/**
 * Build the index for one project. Never throws: an unreadable file is skipped,
 * because a partial index still answers most questions.
 *
 * `options.analyzer` is the optional tree-sitter upgrade (see `ts-symbols.js`).
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
async function indexOneFile(root, full, language, ext, maxBytes, analyzer, counter) {
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
  let symbols = extractSymbols(lines, language);
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
      // Only GDScript has one; the field is always present so the entry shape
      // does not depend on the language.
      className: globalNameOf(text, language),
    },
  };
}

/** `ts (N files)` or `regex`, derived from the entries rather than tracked. */
function symbolSourceOf(files) {
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

export async function buildIndex(root, options = {}) {
  const resolved = resolve(root);
  const requested = Array.isArray(options.exclude) ? options.exclude : [];
  const excludes = new Set([...DEFAULT_EXCLUDES, ...requested]);
  const maxBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : MAX_FILE_BYTES;
  const analyzer = options.analyzer ?? null;
  const counter = resolveTokenCounter(options, options.log);
  const found = [];
  walk(resolved, excludes, found);

  const files = {};
  for (const { full, language, ext } of found) {
    const one = await indexOneFile(resolved, full, language, ext, maxBytes, analyzer, counter);
    if (one !== null) files[one.rel] = one.entry;
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
export async function refreshIndex(index, options = {}) {
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
  const found = [];
  walk(root, excludes, found);

  const previous = index.files ?? {};
  const files = {};
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
    if (one === null) continue; // over the cap, binary, or unreadable
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
  const specs = new Set();
  for (const pattern of IMPORT_PATTERNS[language] ?? []) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) specs.add(match[1]);
  }
  return [...specs];
}

/**
 * Resolve one specifier against the index.
 *
 * Three shapes reach here: a `res://` project path (Godot, always carrying its
 * extension), a relative path (JS/TS/Python/Go/Rust), and a bare identifier —
 * which is only ever a GDScript global class name, because no other indexed
 * language refers to a sibling file by a name the file itself declares.
 */
function resolveSpecifier(fromRel, spec, files, byClassName) {
  if (spec.startsWith("res://")) {
    const target = posix.normalize(spec.slice("res://".length));
    if (files[target] !== undefined) return target;
    return null;
  }
  if (spec.startsWith(".")) {
    const base = posix.dirname(fromRel);
    const target = posix.normalize(posix.join(base === "." ? "" : base, spec));
    const candidates = [
      target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.jsx`, `${target}.mjs`, `${target}.cjs`,
      `${target}.py`, `${target}.go`, `${target}.rs`, `${target}.gd`, `${target}.tscn`, `${target}.tres`,
      `${target}/index.ts`, `${target}/index.js`,
    ];
    for (const candidate of candidates) if (files[candidate] !== undefined) return candidate;
    return null;
  }
  return byClassName !== undefined && byClassName.has(spec) ? byClassName.get(spec) : null;
}

/** Personalized PageRank over the import graph, normalized to 0..1. */
function rankByImportance(files) {
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
    for (const spec of files[name].imports ?? []) {
      const target = resolveSpecifier(name, spec, files, byClassName);
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
  const max = Math.max(...rank.values());
  for (const name of names) {
    files[name].importance = max > 0 ? Number((rank.get(name) / max).toFixed(4)) : 0;
  }
}

const DEFAULT_BUDGET = 1000;

/** Cost of one hit in the emitted shortlist, in estimated tokens. */
function hitCost(relPath, name) {
  return estimateTokens(`${relPath} ${name ?? ""}`) + 6;
}

/**
 * Rank files and symbols against a query, stopping at the token budget.
 * Exact symbol names beat prefixes, which beat substrings, which beat paths.
 */
export function findInIndex(index, query, options = {}) {
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
export function fileDetail(index, relPath) {
  const wanted = String(relPath ?? "").replace(/^\.\//, "");
  const exact = index.files[wanted];
  if (exact !== undefined) return { relPath: wanted, ...exact };
  const lower = wanted.toLowerCase();
  const hit = Object.keys(index.files).find((key) => key.toLowerCase().endsWith(lower));
  return hit === undefined ? null : { relPath: hit, ...index.files[hit] };
}

/** Focused file list, or a per-directory rollup when no focus is given. */
export function buildMap(index, focus, options = {}) {
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
    scored.push({ relPath, score: score + file.importance * 12, importance: file.importance, tokens: file.tokens, description: file.description, symbols: file.symbols.length });
  }
  scored.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
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
export function staleFiles(index, limit = 10) {
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

export function indexMeta(index) {
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
