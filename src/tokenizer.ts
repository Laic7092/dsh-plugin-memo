/**
 * Exact token counts for DeepSeek V4, in Node, with no runtime dependency.
 *
 * The index used to say "~4 characters per token" and mean it as an apology.
 * `memo find` spends a *token budget*, though: it stops emitting hits when the
 * shortlist would cost too much to read back. A budget denominated in a unit
 * that is off by 2x on code and 3x on Chinese is a budget you cannot trust.
 *
 * So this module encodes the real thing. `tokenizer/` carries the shipped
 * `tokenizer.json` — a byte-level BPE with a 128,000-entry vocabulary, 1283
 * added tokens and the DeepSeek pretokenizer — and everything below turns that
 * file into `encode(text) -> number[]`:
 *
 *  1. split out added tokens, longest first, keeping them as single ids;
 *  2. apply the three `Isolated` `Split` patterns from the file verbatim;
 *  3. map the surviving bytes through the GPT-2 byte-to-unicode table, the
 *     same one the `ByteLevel` pretokenizer uses;
 *  4. merge each piece with the file's 127,741 ranked merges.
 *
 * The vocabulary is 6MB of JSON, so nothing is parsed until the first count is
 * actually asked for, and the parsed form is kept on the module — one load per
 * process, not one per file. Callers that only need a magnitude should keep
 * using `estimateTokens` in the indexer and never touch this.
 *
 * @module dsh-plugin-memo/tokenizer
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the shipped vocabulary lives: tokenizer/, beside src/ and lib/. */
export const DEFAULT_VOCAB_PATH = join(HERE, "..", "tokenizer", "deepseek_v4.tokenizer.json");

/**
 * The GPT-2 `bytes_to_unicode` table, rebuilt rather than transcribed. Every
 * one of its 256 characters is present in the DeepSeek vocabulary, which is why
 * a byte-level BPE can spell arbitrary UTF-8 with text tokens at all.
 */
export function bytesToUnicode() {
  const bs = [];
  const cs = [];
  for (let b = 33; b <= 126; b += 1) { bs.push(b); cs.push(b); }
  for (let b = 161; b <= 172; b += 1) { bs.push(b); cs.push(b); }
  for (let b = 174; b <= 255; b += 1) { bs.push(b); cs.push(b); }
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (bs.includes(b)) continue;
    bs.push(b);
    cs.push(256 + n);
    n += 1;
  }
  const out = new Array(256);
  for (let i = 0; i < bs.length; i += 1) out[bs[i]] = String.fromCharCode(cs[i]);
  return out;
}

const NUL = String.fromCharCode(0);
const BYTE_CHARS = bytesToUnicode();
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Decode one `pattern` out of a pretokenizer step. The file only ever uses
 * `{"Regex": "..."}`, so anything else is a hard error rather than a silently
 * ignored step: a pretokenizer that quietly drops a rule produces counts that
 * look plausible and are wrong.
 */
function patternOf(step) {
  const pattern = step.pattern;
  if (pattern === undefined || typeof pattern.Regex !== "string") {
    throw new Error("tokenizer: unsupported pretokenizer pattern " + JSON.stringify(pattern));
  }
  return new RegExp(pattern.Regex, "gu");
}

/** The literal-text alternation for every added token, longest first. */
function alternationOf(texts) {
  return new RegExp(
    texts
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((text) => text.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
      .join("|"),
    "gu",
  );
}

/**
 * Turn one `tokenizer.json` into an encoder.
 *
 * @param {object} spec parsed tokenizer.json
 * @returns {{ encode(text: string): number[], decode(ids: number[]): string,
 *            vocabSize: number, merges: number, addedTokens: number }}
 */
export function buildTokenizer(spec) {
  const model = spec?.model;
  if (model?.type !== "BPE") {
    throw new Error("tokenizer: expected a BPE model, got " + JSON.stringify(model?.type));
  }
  if (!model.vocab || typeof model.vocab !== "object") {
    throw new Error("tokenizer: model.vocab is missing");
  }

  const vocab = new Map(Object.entries(model.vocab));

  // Merges arrive as "left right" pairs in rank order; the rank *is* the
  // priority, so a Map from "left NUL right" to index is the whole structure.
  const ranks = new Map();
  const merges = Array.isArray(model.merges) ? model.merges : [];
  for (let i = 0; i < merges.length; i += 1) {
    const merge = merges[i];
    if (Array.isArray(merge)) {
      ranks.set(merge[0] + NUL + merge[1], i);
      continue;
    }
    const at = merge.indexOf(" ");
    if (at < 0) throw new Error("tokenizer: malformed merge " + JSON.stringify(merge));
    ranks.set(merge.slice(0, at) + NUL + merge.slice(at + 1), i);
  }

  // Added tokens are matched as literal text, so the longest wins at any
  // position. They are lifted out before the BPE and put back as single ids.
  const added = Array.isArray(spec.added_tokens) ? spec.added_tokens : [];
  const addedText = new Map();
  for (const token of added) {
    if (typeof token?.content === "string" && Number.isInteger(token.id)) {
      addedText.set(token.content, token.id);
    }
  }
  const addedPattern = addedText.size === 0 ? null : alternationOf([...addedText.keys()]);

  const steps = spec.pre_tokenizer?.type === "Sequence"
    ? (spec.pre_tokenizer.pretokenizers ?? [])
    : (spec.pre_tokenizer ? [spec.pre_tokenizer] : []);
  const splits = [];
  let byteLevel = false;
  for (const at of steps) {
    if (at.type === "Split") splits.push(patternOf(at));
    else if (at.type === "ByteLevel") byteLevel = true;
    else throw new Error("tokenizer: unsupported pretokenizer step " + JSON.stringify(at.type));
  }
  if (!byteLevel) throw new Error("tokenizer: no ByteLevel step, this is not a byte-level BPE");

  /**
   * One BPE piece. The highest-priority merge anywhere in the piece wins, then
   * the scan repeats: a single left-to-right pass is a different algorithm, and
   * a different count.
   *
   * Pieces are single pretokenizer segments — a handful of characters — so the
   * O(n^2) scan is over a short list, not over a file.
   */
  function mergePiece(piece) {
    let symbols = [];
    for (const char of piece) {
      const id = vocab.get(char);
      if (id === undefined) {
        // A byte-level vocabulary covers every byte; anything missing is a
        // vocabulary this encoder does not understand. Fail loudly.
        throw new Error("tokenizer: no id for " + JSON.stringify(char));
      }
      symbols.push({ text: char, id });
    }
    while (symbols.length > 1) {
      let bestRank = Infinity;
      let bestAt = -1;
      for (let i = 0; i < symbols.length - 1; i += 1) {
        const rank = ranks.get(symbols[i].text + NUL + symbols[i + 1].text);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestAt = i;
        }
      }
      if (bestAt < 0) break;
      const merged = symbols[bestAt].text + symbols[bestAt + 1].text;
      const id = vocab.get(merged);
      if (id === undefined) throw new Error("tokenizer: merged " + JSON.stringify(merged) + " has no id");
      symbols = symbols.slice(0, bestAt).concat([{ text: merged, id }], symbols.slice(bestAt + 2));
    }
    return symbols;
  }

  /**
   * One `Split` step. The behaviors in `tokenizer.json` are all `Isolated`,
   * which keeps the text *between* the matches as pieces of its own — the
   * separator is isolated, not removed. Treating the step as a filter (keeping
   * only the matches) silently drops every letter that is not a digit, which
   * tokenizes `Hello!` as the empty string.
   */
  function splitPiece(piece, pattern) {
    const out = [];
    let last = 0;
    piece.replace(pattern, (hit, offset) => {
      if (offset > last) out.push(piece.slice(last, offset));
      if (hit.length > 0) out.push(hit);
      last = offset + hit.length;
      return hit;
    });
    if (last < piece.length) out.push(piece.slice(last));
    return out;
  }

  /** Text that carries no added tokens: pretokenize, byte-map, merge. */
  function encodePlain(text) {
    const ids = [];
    let pieces = [text];
    for (const pattern of splits) {
      const next = [];
      for (const piece of pieces) next.push(...splitPiece(piece, pattern));
      pieces = next;
    }
    for (const piece of pieces) {
      if (piece.length === 0) continue;
      let mapped = "";
      for (const byte of ENCODER.encode(piece)) mapped += BYTE_CHARS[byte];
      for (const symbol of mergePiece(mapped)) ids.push(symbol.id);
    }
    return ids;
  }

  // Ids come from two places: the vocabulary, and the added tokens that never
  // reach it. Both are needed to read a shortlist back.
  const reverse = new Map();
  for (const [text, id] of vocab) if (!reverse.has(id)) reverse.set(id, text);
  for (const [text, id] of addedText) if (!reverse.has(id)) reverse.set(id, text);

  return {
    vocabSize: vocab.size,
    merges: ranks.size,
    addedTokens: addedText.size,

    encode(text) {
      const source = String(text);
      if (source.length === 0) return [];
      if (addedPattern === null) return encodePlain(source);
      const ids = [];
      let last = 0;
      addedPattern.lastIndex = 0;
      for (let hit = addedPattern.exec(source); hit !== null; hit = addedPattern.exec(source)) {
        // A zero-length match would spin forever; the alternation is literal
        // tokens so it cannot happen, but a stuck regex must not hang a scan.
        if (hit[0].length === 0) { addedPattern.lastIndex += 1; continue; }
        if (hit.index > last) ids.push(...encodePlain(source.slice(last, hit.index)));
        ids.push(addedText.get(hit[0]));
        last = hit.index + hit[0].length;
      }
      if (last < source.length) ids.push(...encodePlain(source.slice(last)));
      return ids;
    },

    /** Inverse of `encode`, for tests and for reading a shortlist back. */
    decode(ids) {
      let text = "";
      for (const id of ids) {
        const piece = reverse.get(id);
        if (piece === undefined) throw new Error("tokenizer: no token for id " + id);
        text += piece;
      }
      const bytes = [];
      for (const char of text) {
        const byte = BYTE_CHARS.indexOf(char);
        if (byte < 0) { bytes.push(...ENCODER.encode(char)); continue; }
        bytes.push(byte);
      }
      return DECODER.decode(Uint8Array.from(bytes));
    },
  };
}

/** Parsed tokenizers, keyed by vocabulary path: one 6MB parse per process. */
const CACHE = new Map();

/** Load (and memoize) the shipped vocabulary. */
export function loadTokenizer(path = DEFAULT_VOCAB_PATH) {
  const cached = CACHE.get(path);
  if (cached !== undefined) return cached;
  const spec = JSON.parse(readFileSync(path, "utf8"));
  const tokenizer = buildTokenizer(spec);
  CACHE.set(path, tokenizer);
  return tokenizer;
}

/**
 * Counts of previously seen strings, so a refresh that re-reads an unchanged
 * file does not re-encode it. The index is the durable cache; this is the one
 * that saves work inside a single process.
 */
const COUNTS = new Map();
const COUNT_CACHE_LIMIT = 4096;

/**
 * Exact token count for `text`.
 *
 * @param {string} text
 * @param {{ path?: string }} [options] vocabulary to use
 * @returns {number}
 */
export function countTokens(text: string, options: { path?: string } = {}) {
  const source = String(text);
  // Small enough to memoize cheaply, large enough that a repeated file body is
  // the common case rather than a pathological one.
  const key = source.length <= 4096 ? source : null;
  if (key !== null) {
    const hit = COUNTS.get(key);
    if (hit !== undefined) return hit;
  }
  const count = loadTokenizer(options.path).encode(source).length;
  if (key !== null) {
    if (COUNTS.size >= COUNT_CACHE_LIMIT) COUNTS.delete(COUNTS.keys().next().value);
    COUNTS.set(key, count);
  }
  return count;
}

/**
 * How far the CJK runs an FTS5 tokenizer cannot search reach.
 *
 * The escapes are spelled out rather than written as literal characters: this
 * file is read by people, and a range like \u3040-\u30ff is a fact about
 * Unicode, not a keystroke. They are the ranges source code actually carries --
 * ideographs (and the extensions newer emoji-era text uses), the two kana
 * scripts, compatibility ideographs, and Hangul.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_RUN = new RegExp("[" + CJK.source.slice(1, -1) + "]+", "g");

/**
 * Text with every CJK character spaced out, for the full-text index.
 *
 * The FTS5 tokenizer this index uses (`unicode61`) does not segment CJK: a run
 * like 日结处理 is *one* token, so a search for a two-character phrase out of
 * the middle of it finds nothing, and the answer reads as "the project does not
 * mention this" rather than "the index cannot say". That is the one failure a
 * search surface must not have, and it was measured on a real GDScript project:
 * 日结 lived in 26 files, was indexed in all of them, and matched none.
 *
 * So the CJK runs are pre-tokenized on both sides of the index -- this function
 * runs over the body, the path and the description when a scan writes them, and
 * over the query when one is searched. A phrase becomes the consecutive run of
 * one-character tokens that a phrase query already means, which is what makes
 * 日结 a phrase *inside* 日结处理; a single character is a token and an answer.
 *
 * ASCII is deliberately left exactly as it was: `migrate_save` still tokenizes
 * into the parts the identifier rule expects, `ZEBRA-CROSSING` still keeps its
 * hyphens, and nothing about an English query moves. It costs index size where
 * there is CJK to pay for -- that is the trade, and it buys the hits.
 *
 * @param text - a body, a path, or one query.
 * @returns the same text with spaces between CJK characters; no other change.
 */
export function padCjk(text: string): string {
  const source = String(text ?? "");
  if (source.length === 0) return source;
  // One space around every CJK run, so the run becomes one token per
  // character; the collapse and the trim take back the spaces that fall
  // next to whitespace the file already had.
  const spaced = source.replace(CJK_RUN, (run) => " " + [...run].join(" ") + " ");
  return spaced.replace(/\s+/g, " ").trim();
}
