/**
 * The tree-sitter upgrade pass.
 *
 * The line-based extractor in `indexer.ts` is the floor: it always runs, it
 * never fails, and it is what the index is built from when nothing else is
 * available. This module is the ceiling — where a grammar exists, the real
 * syntax tree replaces the guesses, which is the only way to get class methods
 * (`Widget.render`), exact end lines, and nested declarations right.
 *
 * Everything here degrades. `web-tree-sitter` and the grammars are optional
 * dependencies, so a missing package, a missing wasm, a parse failure or a
 * runtime that refuses to initialize all return `null`, and the caller keeps
 * what the regex pass found. A scan never fails because of this file.
 *
 * `tree-sitter-wasm` is optional and carries every grammar this plugin reads,
 * Godot's two included, so there is no shipped wasm to keep in step with the
 * runtime; when the package is missing, the line-based floor is all there is.
 *
 * @module dsh-plugin-memo/ts-symbols
 */
import { existsSync } from "node:fs";
/** Source extension -> grammar name; where its wasm comes from is {@link grammarCandidates}. */
const GRAMMAR = {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    // Godot's two languages, both shipped by `tree-sitter-wasm`.
    ".gd": "gdscript",
    ".tscn": "godot_resource",
    ".tres": "godot_resource",
};
/** Grammar -> the family whose node spec applies. */
const FAMILY = {
    typescript: "js", tsx: "js", javascript: "js",
    python: "python", go: "go", rust: "rust", gdscript: "gd", godot_resource: "gdres",
};
/**
 * Node type -> symbol kind. A `null` kind means "decided by inspection"
 * (`variable_declarator` is a function only when its value is one).
 */
const SPECS = {
    js: {
        symbols: {
            function_declaration: "function",
            generator_function_declaration: "function",
            class_declaration: "class",
            abstract_class_declaration: "class",
            interface_declaration: "interface",
            type_alias_declaration: "type",
            enum_declaration: "enum",
            method_definition: "method",
            method_signature: "method",
            public_field_definition: null,
            field_definition: null,
            variable_declarator: null,
        },
        containers: {
            class_declaration: "name",
            abstract_class_declaration: "name",
            interface_declaration: "name",
        },
        functionValues: new Set(["arrow_function", "function", "function_expression", "generator_function"]),
    },
    python: {
        symbols: { class_definition: "class", function_definition: "function" },
        containers: { class_definition: "name" },
    },
    go: {
        symbols: { function_declaration: "function", method_declaration: "method", type_spec: "type" },
        containers: {},
    },
    rust: {
        symbols: {
            function_item: "function",
            struct_item: "type",
            enum_item: "type",
            trait_item: "trait",
            type_item: "type",
            const_item: "const",
            static_item: "const",
            mod_item: "module",
        },
        containers: { impl_item: "type", trait_item: "name" },
    },
    /**
     * GDScript. The grammar knows a typed `var` from a `func`, so unlike
     * JavaScript nothing here is decided by inspection.
     *
     * `constructor_definition` is `func _init(...)` — Godot's constructor, and
     * the one declaration the grammar gives no `name` field, so the family
     * names it. `qualifyAll` is what makes a nested class readable: without it
     * `Inventory` and the script's own declarations would both be bare names.
     */
    gd: {
        symbols: {
            class_name_statement: "class",
            class_definition: "class",
            function_definition: "function",
            constructor_definition: "function",
            signal_statement: "signal",
            enum_definition: "enum",
            const_statement: "const",
            variable_statement: "var",
            export_variable_statement: "var",
            onready_variable_statement: "var",
        },
        containers: { class_definition: "name" },
        names: { constructor_definition: "_init" },
        qualifyAll: true,
    },
    /**
     * Godot's text resource format (".tscn" scenes, ".tres" resources). A section
     * is not a declaration with a name — `[kind key="value" ...]` declares
     * whatever its attributes say — so this family reads the tree itself instead
     * of a type -> kind table.
     */
    gdres: {
        symbols: {},
        collect: collectResource,
    },
};
function fieldText(node, field) {
    const child = node.childForFieldName(field);
    return child === null || child === undefined ? null : child.text;
}
/**
 * A declaration's name. Most grammars expose it as the `name` field, but the
 * JavaScript grammar's `field_definition` carries a bare `property_identifier`
 * child instead, so fall back to a leading identifier node. A grammar that
 * names nothing itself — GDScript's `func _init` — is covered by the family's
 * `names` table instead.
 */
function symbolName(node, spec) {
    const forced = spec.names === undefined ? undefined : spec.names[node.type];
    if (typeof forced === "string")
        return forced;
    const named = fieldText(node, "name");
    if (named !== null)
        return named;
    const children = node.namedChildren ?? [];
    const first = children.length > 0 ? children[0] : null;
    if (first !== null && first !== undefined && /identifier$/.test(first.type))
        return first.text;
    return null;
}
/** Nodes that open a new scope: below one, a declaration is no longer a member. */
const FUNCTION_LIKE = new Set([
    "function_declaration", "generator_function_declaration", "function_expression",
    "arrow_function", "generator_function", "method_definition",
    "function_item", "function_definition", "constructor_definition",
]);
/**
 * One tree's symbols. A family may bring its own reader — Godot resources have
 * no declarations with names, only sections whose meaning lives in their
 * attributes — and everything else goes through the walker below.
 */
function collect(root, spec) {
    return typeof spec.collect === "function" ? spec.collect(root) : collectDeclarations(root, spec);
}
/**
 * Walk one tree, emitting qualified symbols in source order.
 *
 * `owner` is the class/interface/impl currently being descended into; it is
 * cleared the moment the walk enters a function body, which is what keeps a
 * closure declared inside a method from being reported as a member of the class.
 */
function collectDeclarations(root, spec) {
    const symbols = [];
    const containers = spec.containers ?? {};
    const visit = (node, owner) => {
        const declared = Object.prototype.hasOwnProperty.call(spec.symbols, node.type) ? spec.symbols[node.type] : undefined;
        let kind = declared;
        if (declared === null) {
            const value = node.childForFieldName("value");
            kind = value !== null && value !== undefined && (spec.functionValues ?? new Set()).has(value.type)
                ? "function"
                : undefined;
        }
        const name = symbolName(node, spec);
        if (kind !== undefined && kind !== null && typeof name === "string" && name.length > 0) {
            // Inside a container a function becomes a method and takes the owner's
            // name; a spec that sets `qualifyAll` prefixes its other members too,
            // and those keep their own kind — a variable stays a variable.
            const isMethod = owner !== null && (kind === "function" || kind === "method");
            const isMember = isMethod || (owner !== null && spec.qualifyAll === true);
            symbols.push({
                name: isMember ? `${owner}.${name}` : name,
                kind: isMethod ? "method" : kind,
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
            });
        }
        const isContainer = Object.prototype.hasOwnProperty.call(containers, node.type);
        let nextOwner = owner;
        if (isContainer) {
            const field = containers[node.type];
            const found = fieldText(node, field) ?? fieldText(node, "name") ?? fieldText(node, "type");
            nextOwner = typeof found === "string" && found.length > 0 ? found : null;
        }
        else if (FUNCTION_LIKE.has(node.type)) {
            nextOwner = null;
        }
        for (const child of node.namedChildren)
            visit(child, nextOwner);
    };
    visit(root, null);
    return symbols;
}
/** A section's kind token: the identifier between the bracket and its attributes. */
function sectionKind(section) {
    for (const child of section.namedChildren)
        if (child.type === "identifier")
            return child.text;
    return null;
}
/** One `key = value` attribute of a section header, with a string's quotes removed. */
function attributeText(section, key) {
    for (const child of section.namedChildren) {
        if (child.type !== "attribute")
            continue;
        const name = child.namedChildren[0];
        const value = child.namedChildren[1];
        if (name === undefined || value === undefined || name.text !== key)
            continue;
        return value.type === "string" ? value.text.slice(1, -1) : value.text;
    }
    return null;
}
/**
 * Symbols for ".tscn"/".tres": a scene's node tree, and the sub-resources it
 * declares. A node is named by its place in the tree (`Player/Sprite`) because
 * bare node names repeat heavily inside one scene. `ext_resource`,
 * `connection` and `editable` rows are dependencies and wiring rather than
 * declarations, and stay out — the edges come from `IMPORT_PATTERNS`, so they
 * are read in one place.
 *
 * Reading the tree rather than the lines is what the ceiling adds here: the
 * order of a header's attributes is free (`[node type="Sprite2D" name="Sprite"]`
 * is the same node), and a section is exactly as long as the parser says.
 */
function collectResource(root) {
    const symbols = [];
    const visit = (node) => {
        if (node.type === "section") {
            const kind = sectionKind(node);
            const line = node.startPosition.row + 1;
            const endLine = node.endPosition.row + 1;
            if (kind === "node") {
                const name = attributeText(node, "name");
                const parent = attributeText(node, "parent");
                if (name !== null) {
                    const path = parent === null || parent === "" || parent === "." ? name : `${parent}/${name}`;
                    symbols.push({ name: path, kind: "node", line, endLine });
                }
            }
            else if (kind === "sub_resource") {
                const name = attributeText(node, "id") ?? attributeText(node, "type");
                if (name !== null)
                    symbols.push({ name, kind: "sub_resource", line, endLine });
            }
            else if (kind === "gd_resource") {
                const name = attributeText(node, "type");
                if (name !== null)
                    symbols.push({ name, kind: "resource", line, endLine });
            }
        }
        for (const child of node.namedChildren)
            visit(child);
    };
    visit(root);
    return symbols;
}
/**
 * Every wasm this grammar could load, or none when the package is absent.
 *
 * `tree-sitter-wasm` keeps each parser under `out/<grammar>/`, and the package's
 * own `getWasmPath` is the authority on where that is. It is captured when the
 * analyzer starts because the import is optional: before that there is nothing
 * to look for, and a missing package means the line-based floor stays in charge.
 */
let locateWasm = null;
function grammarCandidates(grammar) {
    if (locateWasm === null)
        return [];
    try {
        const wasm = locateWasm(grammar);
        return typeof wasm === "string" && existsSync(wasm) ? [wasm] : [];
    }
    catch {
        // A grammar the package does not carry simply has no candidate.
        return [];
    }
}
let analyzerPromise = null;
/**
 * Build the analyzer at most once per process. Resolves to `null` — never
 * rejects — when tree-sitter or the grammars cannot be used here.
 */
export function createTsAnalyzer() {
    if (analyzerPromise !== null)
        return analyzerPromise;
    analyzerPromise = (async () => {
        let mod;
        try {
            mod = await import("web-tree-sitter");
        }
        catch {
            return null;
        }
        // Godot included: the package carries every grammar this plugin reads, so
        // there is no bundled wasm to fall back to. Its absence is not a failure,
        // only an empty grammar list that leaves the line-based pass in charge.
        try {
            const wasm = await import("tree-sitter-wasm");
            if (typeof wasm.getWasmPath === "function")
                locateWasm = (grammar) => wasm.getWasmPath(grammar);
        }
        catch {
            // Optional dependency.
        }
        const Parser = mod.Parser ?? mod.default;
        if (typeof Parser !== "function" || typeof Parser.init !== "function")
            return null;
        // Order matters: `init()` is what attaches `Language` to the constructor,
        // so it cannot be looked up before initialization.
        try {
            await Parser.init();
        }
        catch {
            return null;
        }
        const Language = mod.Language ?? Parser.Language;
        if (typeof Language?.load !== "function")
            return null;
        const parsers = new Map();
        const loadParser = async (grammar) => {
            if (parsers.has(grammar))
                return parsers.get(grammar);
            let parser = null;
            for (const wasm of grammarCandidates(grammar)) {
                if (!existsSync(wasm))
                    continue;
                try {
                    const language = await Language.load(wasm);
                    parser = new Parser();
                    parser.setLanguage(language);
                    break;
                }
                catch {
                    // A build the runtime refuses is not the end of the road: the package
                    // may still hold a compatible one for this grammar.
                    parser = null;
                }
            }
            parsers.set(grammar, parser);
            return parser;
        };
        return {
            available: true,
            // What is actually on disk, because this list is what the log line
            // promises the upgrade covers — a grammar whose wasm is absent covers
            // nothing.
            grammars: [...new Set(Object.values(GRAMMAR))].filter((grammar) => grammarCandidates(grammar).some((wasm) => existsSync(wasm))),
            /** Symbols from a real syntax tree, or null to keep the regex ones. */
            async analyze(text, ext) {
                const grammar = GRAMMAR[String(ext).toLowerCase()];
                if (grammar === undefined)
                    return null;
                const spec = SPECS[FAMILY[grammar]];
                if (spec === undefined)
                    return null;
                const parser = await loadParser(grammar);
                if (parser === null)
                    return null;
                let tree = null;
                try {
                    tree = parser.parse(text);
                    if (!tree)
                        return null;
                    // A tree that contains errors is not an upgrade: replacing the
                    // line-based symbols with the handful the grammar salvaged would lose
                    // declarations and say nothing about it. The floor is what the file
                    // deserves until the grammar can read it.
                    if (tree.rootNode.hasError === true)
                        return null;
                    const symbols = collect(tree.rootNode, spec);
                    return symbols.length > 0 ? symbols : null;
                }
                catch {
                    return null;
                }
                finally {
                    try {
                        if (tree && typeof tree.delete === "function")
                            tree.delete();
                    }
                    catch {
                        // Releasing the tree is best-effort.
                    }
                }
            },
        };
    })();
    return analyzerPromise;
}
/** Which extensions this module could upgrade, for reporting. */
export const TS_EXTENSIONS = Object.keys(GRAMMAR);
