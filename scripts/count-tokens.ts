#!/usr/bin/env node
/**
 * Count tokens with the tokenizer this plugin ships.
 *
 * The plugin's own use of the vocabulary is invisible from the outside: it
 * happens inside `memo_scan`. This is the same counter as a command, for the
 * times a person wants a number without building an index — trimming a prompt,
 * checking whether a file is under the tree-sitter size threshold, or seeing
 * how far the rough estimate is from the truth.
 *
 *   node scripts/count-tokens.ts "Hello!"
 *   node scripts/count-tokens.ts --estimate src/indexer.ts
 *   cat src/tokenizer.ts | node scripts/count-tokens.ts
 *   node scripts/count-tokens.ts --ids "Hello!"      # the ids, for a fixture
 *
 * No dependencies, and no writes: it reads the vocabulary, prints a number and
 * its inputs, and exits non-zero on a usage error or an unreadable file.
 */
import { readFileSync } from "node:fs";
import { countTokens, loadTokenizer } from "../src/tokenizer.ts";

const USAGE = [
  "usage: node scripts/count-tokens.ts [--ids] [--estimate] [--total] [--vocab] [text-or-file ...]",
  "",
  "  --ids       print the token ids, one per line, instead of the count",
  "  --estimate  print the 4-characters-per-token estimate too, for comparison",
  "  --total     print only the summed count across every input",
  "  --vocab     print what vocabulary was loaded, then exit",
  "  no input    read standard input",
].join("\n");

const argv = process.argv.slice(2);
const flags = new Set();
const inputs = [];
for (const arg of argv) {
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    if (!["ids", "estimate", "total", "vocab", "help"].includes(name)) {
      process.stderr.write(`unknown option ${arg}\n${USAGE}\n`);
      process.exit(2);
    }
    flags.add(name);
  } else {
    inputs.push(arg);
  }
}
if (flags.has("help")) {
  process.stdout.write(USAGE + "\n");
  process.exit(0);
}

const tokenizer = loadTokenizer();
if (flags.has("vocab")) {
  process.stdout.write(`vocabulary: ${tokenizer.vocabSize} tokens, ${tokenizer.merges} merges, ${tokenizer.addedTokens} added tokens\n`);
  process.exit(0);
}

/**
 * One input, read as a file when it names an existing one and as literal text
 * otherwise — the same rule every CLI with this shape uses, and the reason a
 * path typo shows up as a token count instead of an error. A missing file is
 * still worth a warning when the name plainly looks like a path.
 */
function readInput(input) {
  try {
    return { label: input, text: readFileSync(input, "utf8"), file: true };
  } catch (error) {
    if (error && error.code === "ENOENT" && !input.includes(" ") && /[./]/.test(input)) {
      process.stderr.write(`no such file: ${input} (counting it as literal text)\n`);
    }
    return { label: null, text: input, file: false };
  }
}

let sources = inputs.map(readInput);
if (sources.length === 0) {
  sources = [{ label: "<stdin>", text: readFileSync(0, "utf8"), file: false }];
}

let total = 0;
for (const source of sources) {
  const ids = tokenizer.encode(source.text);
  total += ids.length;
  if (flags.has("ids")) {
    for (const id of ids) process.stdout.write(String(id) + "\n");
    continue;
  }
  const name = source.label === null ? JSON.stringify(source.text.slice(0, 40)) : source.label;
  if (flags.has("total")) continue;
  if (flags.has("estimate")) {
    const estimate = Math.ceil(source.text.length / 4);
    const drift = estimate === 0 ? "0%" : `${Math.round(((estimate - ids.length) / ids.length) * 100)}%`;
    process.stdout.write(`${name}: ${ids.length} tokens (${estimate} estimated, ${drift} off)\n`);
    continue;
  }
  process.stdout.write(`${name}: ${ids.length} tokens\n`);
}
if (flags.has("total") || sources.length > 1) process.stdout.write(`total: ${total} tokens\n`);
