/**
 * The tokenizer is only worth having if it agrees with the reference.
 *
 * `tokenizer-vectors.json` holds `{s, ids}` pairs produced by HuggingFace's
 * `tokenizers` — the same library `AutoTokenizer.from_pretrained` uses in the
 * zip's `deepseek_tokenizer.py` — loaded from the `tokenizer.json` this plugin
 * ships. The assertions below compare id for id, not count for count: two
 * encoders can agree on length while disagreeing on every token.
 *
 * The vectors cover the awkward parts on purpose — CJK, emoji, control bytes,
 * lone special tokens in the middle of a line, adjacent delimiters, runs long
 * enough to exercise merging.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTokenizer, bytesToUnicode, countTokens, loadTokenizer } from "../lib/tokenizer.js";
import { buildIndex, estimateTokens, indexMeta, INDEX_VERSION, refreshIndex } from "../lib/indexer.js";

const VECTORS = JSON.parse(readFileSync(new URL("./tokenizer-vectors.json", import.meta.url), "utf8"));

test("the shipped vocabulary is the DeepSeek V4 one", () => {
  const tokenizer = loadTokenizer();
  assert.equal(tokenizer.vocabSize, 128000);
  assert.equal(tokenizer.merges, 127741);
  assert.equal(tokenizer.addedTokens, 1283);
  // Loading twice must not parse 6MB twice; the module keeps the first one.
  assert.equal(loadTokenizer(), tokenizer);
});

test("encode matches the reference tokenizer id for id", () => {
  const tokenizer = loadTokenizer();
  for (const { s, ids } of VECTORS) {
    const got = tokenizer.encode(s);
    assert.deepEqual(got, ids, `encode(${JSON.stringify(s.slice(0, 40))})`);
  }
});

test("every id round-trips back to the text it came from", () => {
  const tokenizer = loadTokenizer();
  for (const { s, ids } of VECTORS) {
    assert.equal(tokenizer.decode(ids), s, `decode of ${JSON.stringify(s.slice(0, 40))}`);
  }
});

test("the byte table covers all 256 bytes", () => {
  const table = bytesToUnicode();
  assert.equal(table.length, 256);
  assert.equal(new Set(table).size, 256);
  // The three bytes that make the table non-identity, and the space that has to
  // stay printable-looking because the vocabulary spells it Ġ.
  assert.equal(table[0], "\u0100");
  assert.equal(table[32], "\u0120");
  assert.equal(table[65], "A");
});

test("an empty string is zero tokens, and a guess would not say so", () => {
  assert.equal(countTokens(""), 0);
  assert.equal(estimateTokens(""), 0);
});

test("exact counting diverges from the estimate the way the estimate admits", () => {
  const tokenizer = loadTokenizer();
  const code = VECTORS.find((v) => v.s.startsWith("export function")).s;
  const chinese = VECTORS.find((v) => v.s.startsWith("你好")).s;
  // The estimate is documented as roughly 4 characters per token. Code sits
  // near that; Chinese does not, which is the reason the exact counter exists.
  assert.ok(Math.abs(tokenizer.encode(code).length - estimateTokens(code)) <= 4);
  assert.ok(tokenizer.encode(chinese).length > estimateTokens(chinese) * 1.2);
});

test("buildTokenizer refuses a vocabulary it cannot honestly encode", () => {
  assert.throws(() => buildTokenizer({ model: { type: "WordPiece", vocab: {} } }), /BPE/);
  assert.throws(() => buildTokenizer({ model: { type: "BPE" } }), /vocab/);
  // A vocabulary that cannot spell every byte is not a byte-level BPE, and the
  // encoder says so instead of emitting a token list with holes in it.
  assert.throws(
    () => buildTokenizer({
      model: { type: "BPE", vocab: { a: 0, "\u0100": 1 }, merges: [] },
      pre_tokenizer: { type: "ByteLevel" },
    }).encode("A"),
    /no id for/,
  );
  assert.deepEqual(
    buildTokenizer({
      model: { type: "BPE", vocab: { a: 0, "\u0100": 1 }, merges: [] },
      pre_tokenizer: { type: "ByteLevel" },
    }).encode("a"),
    [0],
  );
  // A pretokenizer step this encoder does not implement is refused by name. A
  // step it silently skipped would produce plausible-looking, wrong counts.
  assert.throws(
    () => buildTokenizer({ model: { type: "BPE", vocab: { a: 0 }, merges: [] }, pre_tokenizer: { type: "Whitespace" } }),
    /unsupported pretokenizer step "Whitespace"/,
  );
  assert.throws(
    () => buildTokenizer({
      model: { type: "BPE", vocab: { a: 0 }, merges: [] },
      pre_tokenizer: { type: "Sequence", pretokenizers: [{ type: "Split", pattern: { String: "a" } }] },
    }),
    /unsupported pretokenizer pattern/,
  );
});

test("an index built with the exact counter says so, and counts for real", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-exact-"));
  try {
    const source = "export function alpha() {\n  return 1;\n}\n";
    writeFileSync(join(base, "a.ts"), source, "utf8");
    const index = await buildIndex(base, { tokenizer: "exact" });
    assert.equal(index.tokens, "exact");
    assert.equal(index.version, INDEX_VERSION);
    assert.equal(index.files["a.ts"].tokens, loadTokenizer().encode(source).length);
    assert.equal(index.totalTokens, index.files["a.ts"].tokens);
    assert.equal(indexMeta(index).tokens, "exact");

    // The default is still the guess, and still says so.
    const estimated = await buildIndex(base, {});
    assert.equal(estimated.tokens, "estimated");
    assert.equal(estimated.files["a.ts"].tokens, estimateTokens(source));
    assert.equal(indexMeta(estimated).tokens, "estimated");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("switching the counter rebuilds instead of reusing the other unit's numbers", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-switch-"));
  try {
    writeFileSync(join(base, "a.ts"), "export const alpha = () => 1;\n", "utf8");
    const estimated = await buildIndex(base, {});
    assert.equal(estimated.tokens, "estimated");

    // Nothing on disk moved, so a refresh in the *same* unit must reuse.
    const same = await refreshIndex(estimated, { tokenizer: "estimated" });
    assert.equal(same.rebuilt, false);
    assert.equal(same.changed, 0);
    assert.equal(same.reused, 1);

    const switched = await refreshIndex(estimated, { tokenizer: "exact" });
    assert.equal(switched.rebuilt, true, "an exact refresh over an estimated index re-counts everything");
    assert.equal(switched.index.tokens, "exact");

    // And back again: the stamp decides, not the last thing that was asked for.
    const back = await refreshIndex(switched.index, { tokenizer: "estimated" });
    assert.equal(back.rebuilt, true);
    assert.equal(back.index.tokens, "estimated");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an index built before the counter stamp rebuilds once, then stops", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-legacy-"));
  try {
    writeFileSync(join(base, "a.ts"), "export function alpha() {}\n", "utf8");
    const index = await buildIndex(base, {});
    // Version 3 and earlier never wrote the field; that is what an old index
    // looks like, and it is what makes the counts unreadable in the new format.
    delete index.tokens;
    const once = await refreshIndex(index, {});
    assert.equal(once.rebuilt, true);
    assert.equal(once.index.tokens, "estimated");

    const twice = await refreshIndex(once.index, {});
    assert.equal(twice.rebuilt, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a count can be substituted, and a nonsense mode falls back to the estimate", async () => {
  const base = mkdtempSync(join(tmpdir(), "memo-custom-"));
  try {
    const source = "export const alpha = 1;\n";
    writeFileSync(join(base, "a.ts"), source, "utf8");
    const index = await buildIndex(base, { tokenizer: () => 7 });
    assert.equal(index.files["a.ts"].tokens, 7);

    const said = [];
    const unknown = await buildIndex(base, { tokenizer: "wordpiece", log: (message) => said.push(message) });
    assert.equal(unknown.tokens, "estimated");
    assert.match(said.join("\n"), /unknown tokenizer "wordpiece"/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
