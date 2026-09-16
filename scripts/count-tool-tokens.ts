#!/usr/bin/env node
/**
 * What this plugin's tool surface costs a model, in the tokenizer it ships.
 *
 * A registered tool is paid for by *every* request: its description and its
 * parameter schema are part of the model's standing context whether or not the
 * turn calls it. That is the number this script prints — not the size of the
 * source, and not the size of one answer.
 *
 * It renders the same declaration the harness puts in front of the model: the
 * real `defineTool` definitions from `lib/index.js`, projected through
 * `renderToolsSdk` from `@deepseek-ai/dsh-tools`, counted with `src/tokenizer.ts`
 * (the DeepSeek V4 vocabulary in this package). Point it at another revision to
 * compare — that is how the 8-tools -> 1-tool figure in the README was made:
 *
 *   node scripts/count-tool-tokens.ts
 *   git worktree add /tmp/memo-old HEAD~1 && node scripts/count-tool-tokens.ts /tmp/memo-old/lib/index.js
 *
 * `--json` prints the declaration itself, `--per-tool` breaks the cost down by
 * tool. No writes, and no dependency beyond what the plugin already needs: if
 * the harness packages cannot be resolved it says so and exits non-zero.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { countTokens } from "../src/tokenizer.ts";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const entry = argv.find((arg) => !arg.startsWith("--")) ?? join(import.meta.dirname, "..", "lib", "index.js");

const USAGE = "usage: node scripts/count-tool-tokens.ts [--json] [--per-tool] [path/to/lib/index.js]";
for (const flag of flags) {
  if (!["--json", "--per-tool", "--help"].includes(flag)) {
    process.stderr.write(`unknown option ${flag}` + "\n" + USAGE + "\n");
    process.exit(2);
  }
}
if (flags.has("--help")) {
  process.stdout.write(USAGE + "\n");
  process.exit(0);
}

/**
 * The tool definitions this plugin registers, collected from a throwaway
 * context. The registration path is the real one — `ctx.tools.register` on a
 * stub — so a tool added or renamed in `lib/index.js` shows up here with no
 * change to this script.
 */
async function registeredTools(path) {
  const host = await import(pathToFileURL(path).href);
  const tools = new Map();
  const ctx = {
    logger: { info() {} },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    get() { return undefined; },
    inject() { return { dispose() {} }; },
    on() { return () => {}; },
    effect(callback) { const dispose = callback(); return () => { if (typeof dispose === "function") dispose(); }; },
  };
  host.apply(ctx, {});
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: tool.output,
  }));
}

const require = createRequire(import.meta.url);
let renderToolsSdk;
try {
  ({ renderToolsSdk } = await import("@deepseek-ai/dsh-tools"));
} catch (error) {
  process.stderr.write("cannot resolve @deepseek-ai/dsh-tools (" + error.message + ")\n");
  process.stderr.write("this package needs its harness peer installed to render the model-facing declaration\n");
  process.exit(1);
}

const schemas = await registeredTools(entry);
// The fixed part of the section: instructions, the JsonValue alias, the error
// class. Subtracting it leaves what this plugin actually costs.
const boilerplate = countTokens(renderToolsSdk([]));
const section = countTokens(renderToolsSdk(schemas));

process.stdout.write(`tool surface of ${entry}` + "\n");
process.stdout.write(`${schemas.length} tool(s): ${schemas.map((schema) => schema.name).join(", ")}` + "\n");
process.stdout.write(`this plugin: ${section - boilerplate} tokens in the tools:sdk section` + "\n");
process.stdout.write(`fixed boilerplate around it: ${boilerplate} tokens` + "\n");

if (flags.has("--per-tool")) {
  for (const schema of schemas) {
    const alone = countTokens(renderToolsSdk([schema])) - boilerplate;
    process.stdout.write(`  ${schema.name.padEnd(16)}${String(alone).padStart(6)} tokens` + "\n");
  }
}
if (flags.has("--json")) {
  const text = renderToolsSdk(schemas);
  process.stdout.write("\n" + text.slice(text.indexOf("interface ToolArgsMap")) + "\n");
}
