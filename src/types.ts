/**
 * Shared shapes.
 *
 * The indexer, the tree-sitter analyzer, the CLI and the panel all talk about
 * the same few things — a symbol, a file's entry, a whole index, the live plugin
 * state. They live here once so those modules cannot drift into three private
 * ideas of what an index is.
 *
 * @module dsh-plugin-memo/types
 */

/** The unit an index's `tokens` are counted in. */
export type TokenMode = "estimated" | "exact";

/** One declaration the indexer — or a grammar — found in a file. */
export interface IndexSymbol {
  name: string;
  kind: string;
  line: number;
  endLine: number;
}

/**
 * One call site the indexer found in a file.
 *
 * What the file *calls*, not what the call means: the name as written, the
 * receiver it was written on, that receiver's type when the same file declares
 * one, and the declaration the call sits inside. Which file answers the name is
 * a fact about the whole project and is decided when somebody asks -- see
 * calls.ts.
 */
export interface IndexCall {
  name: string;
  receiver: string | null;
  receiverType: string | null;
  line: number;
  caller: string | null;
}

/** One file's entry in the code index. */
export interface IndexEntry {
  bytes: number;
  lines: number;
  tokens: number;
  mtimeMs: number;
  language: string;
  description: string | null;
  symbols: IndexSymbol[];
  /** `"ts"` when a grammar read the file, `"regex"` when the line pass did. */
  symbolSource: string;
  importance: number;
  imports: string[];
  /** The calls this file makes, as written. */
  calls: IndexCall[];
  /** GDScript's `class_name`, or null for every other language. */
  className: string | null;
}

/**
 * What a sweep saw and did not index.
 *
 * The extension table is the whole of what this index can see, so what it left
 * out is part of what a query means. Without it a miss reads as absence -- the
 * one thing a search surface must never say -- and the suffixes are the part a
 * reader can act on: a `.md`, a `.cfg`, a `.csv` is a place to look next.
 */
export interface IndexCoverage {
  /** Files the sweep visited, after excludes and the project's own ignore names. */
  seen: number;
  /** How many of those the extension table accepted as candidates. */
  candidates: number;
  /** Candidates that could not be indexed at all: binary, over the cap, unreadable. */
  failed: number;
  /** Every file outside the table, including the ones the suffix list leaves out. */
  skipped: number;
  /** Outside the table, by suffix, biggest first, capped at COVERAGE_SUFFIXES. */
  suffixes: Array<[string, number]>;
}

/** The whole on-disk index. */
export interface MemoIndex {
  version: number;
  analyzerAvailable: boolean;
  analyzerGrammars: string | null;
  scannedAt: string;
  root: string;
  /** The counter the entries were counted in; `"custom"` for a substituted one. */
  tokens: string;
  excludes: string[];
  fileCount: number;
  totalTokens: number;
  symbolSource: string;
  /**
   * What the sweep left out. Optional because an index written before this had
   * no way to know, and a missing answer is not the same as "nothing was left out".
   */
  coverage?: IndexCoverage | null;
  files: Record<string, IndexEntry>;
}

/** What {@link createTsAnalyzer} resolves to, or null when tree-sitter cannot run. */
export interface TsAnalyzer {
  available?: true;
  grammars: string[];
  analyze(text: string, ext: string): Promise<IndexSymbol[] | null>;
}

/** The live plugin state, built once in `index.ts` and read everywhere else. */
export interface MemoState {
  dirName: string;
  defaultRoot?: string;
  readGuard: boolean;
  readTools: string[];
  exclude: string[];
  refresh: boolean;
  tokenizer: TokenMode;
  subcommands: Record<string, boolean>;
}

/** The subset of {@link MemoState} a composition may pin. */
export type MemoConfig = Partial<MemoState> & { tools?: unknown };
