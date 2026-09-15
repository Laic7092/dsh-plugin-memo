import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The browser half, exercised the way the harness loads it.
 *
 * `lib/client.js` is not a bundle with a runtime to import: it is a single
 * `window.__ModuleLoader__.load({ id, factory })` call, and the loader serves
 * it verbatim. So the test reconstructs that contract — a fake `window` with a
 * capturing loader, a fake `document`, and a `require` that answers React — and
 * then drives the factory for real.
 *
 * This is the check that matters most for this file. The module is concatenated
 * with every other client module into one response, so a throw here is not a
 * broken panel, it is a broken batch: whatever else shipped in the same combo
 * would fail to parse too. Everything below is deliberately renderer-free — the
 * cards are pure element factories, so their output can be inspected as data.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/** A React stub good enough to inspect the element tree the module builds. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  });
  return {
    createElement,
    // The section itself is never rendered here; these exist so the factory can
    // capture them without a renderer, and a hook used outside a render would be
    // a real React error the browser would report.
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (callback) => callback,
  };
}

/** Every string in an element tree, in order. */
function textOf(node) {
  if (typeof node === "string") return [node];
  if (typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (node !== null && typeof node === "object" && Array.isArray(node.children)) return node.children.flatMap(textOf);
  return [];
}

/** Every element in a tree, in order. */
function elementsOf(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children || []) elementsOf(child, out);
  return out;
}

/** The first value found for one prop anywhere in the tree. */
function findProp(tree, key) {
  const match = elementsOf(tree).find((node) => node.props && node.props[key] !== undefined);
  return match === undefined ? undefined : match.props[key];
}

/** Load the module through a fake loader and return what it exported. */
function loadClient() {
  const registrations = [];
  const styles = [];
  const react = fakeReact();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  // Real storage, not a stub that swallows writes: what the panel remembers
  // between mounts is a shape that has to survive its own round trip.
  const stored = new Map();
  const fakeWindow = {
    __ModuleLoader__: { load: (entry) => registrations.push(entry) },
    localStorage: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
    },
    fetch: () => Promise.reject(new Error("no network in this test")),
  };
  globalThis.window = fakeWindow;
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: (tag) => styles.push(tag) },
  };

  try {
    // A function body, not a module: the file is a script-style loader call.
    new Function(SOURCE)();
    assert.equal(registrations.length, 1, "the file registers exactly one module");
    const entry = registrations[0];
    assert.equal(entry.id, "dsh-plugin-memo", "the id must be the package name the loader keys on");
    assert.equal(typeof entry.factory, "function");

    const exported = entry.factory((id) => {
      if (id === "react") return react;
      throw new Error(`unexpected require(${JSON.stringify(id)})`);
    });
    return { exported, styles, react, window: fakeWindow };
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

/**
 * Run `body` with the loader's fake window installed again: the module reads
 * `window` at call time, so storage is only reachable while it is back.
 */
function withWindow(fake, body) {
  const previous = globalThis.window;
  globalThis.window = fake;
  try {
    return body();
  } finally {
    globalThis.window = previous;
  }
}

test("the client half loads under the harness module loader and injects its styles", () => {
  const { exported, styles } = loadClient();

  assert.deepEqual(exported.inject, ["slots"], "the slot registry is the one required service");
  assert.equal(typeof exported.apply, "function");
  assert.equal(typeof exported.MemoView, "function");
  assert.equal(typeof exported.configCardFor, "function");
  assert.equal(typeof exported.switchCards.commandsCard, "function");
  assert.equal(typeof exported.cards.indexCard, "function");

  assert.equal(styles.length, 1, "one self-contained style tag");
  assert.equal(styles[0].dataset.plugin, "dsh-plugin-memo");
  assert.equal(styles[0].dataset.pluginCss, "dsh-plugin-memo/panel.css");
  // Only documented theme tokens, so the panel follows light and dark.
  for (const token of ["--dsw-alias-label-primary", "--dsw-alias-bg-layer-1", "--dsw-alias-border-l1", "--dsw-alias-brand-primary"]) {
    assert.ok(styles[0].textContent.includes(token), `CSS must use ${token}`);
  }
});

test("apply contributes one Memo view to the session's view switcher", () => {
  const { exported } = loadClient();
  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject(key, callback) {
        injected.push(key);
        return callback();
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };

  exported.apply(ctx);

  assert.deepEqual(injected, ["conversation.view"], "wait for the slot rather than assume it exists");
  assert.equal(registered.length, 1);
  const { options, component } = registered[0];
  assert.equal(options.name, "conversation.view");
  assert.equal(options.id, "memo", "the view key drives the switcher entry");
  assert.equal(options.order, 30, "after trajectory (10) and context (20), beside the shipped views");
  assert.equal(typeof options.label, "function", "the shell calls label() to render the nav entry");
  assert.equal(options.label(), "Memo");
  assert.equal(component, exported.MemoView);
});

test("the Memo view reads the session directory instead of asking for one", () => {
  const { exported } = loadClient();
  // The standard hook the target hands every view: a selector over the session
  // list. The panel reads only the current session's `cwd` leaf.
  const SESSION_DIR = "/home/laix/projects/open-farm";
  const props = {
    useSessions: (select) => select({ current: "s-1", byId: { "s-1": { cwd: SESSION_DIR } } }),
  };

  const tree = exported.MemoView(props);
  const text = textOf(tree).join(" ");
  // The session's directory reaches the panel as the field's placeholder: the
  // panel opens on it, and typing in the field is how a person overrides it.
  assert.match(findProp(tree, "placeholder"), /open-farm/, "the session's own directory is what the panel opens on");
  assert.equal(findProp(tree, "defaultValue"), undefined, "the override starts empty, so the session wins");
});

test("a session with no directory yet falls back rather than inventing one", () => {
  const { exported } = loadClient();
  const tree = exported.MemoView({ useSessions: (select) => select({ current: undefined, byId: {} }) });
  assert.match(findProp(tree, "placeholder"), /宿主默认/, "no cwd means the host decides");
});

/** The catalogue the host sends, in the grouped shape the card renders. */
const CATALOGUE = [
  { id: "memory", commands: [{ name: "status", on: true }, { name: "handoff", on: true }, { name: "note", on: false }] },
  { id: "index", commands: [{ name: "scan", on: true }, { name: "find", on: true }, { name: "map", on: true }] },
  { id: "bugs", commands: [{ name: "bug-search", on: true }, { name: "bug-log", on: true }] },
];

/** The checkbox of the switch row whose text contains `label`. */
function boxFor(tree, label) {
  const row = elementsOf(tree).find((node) => node.props && node.props.className === "memoToggle" && textOf(node).join(" ").includes(label));
  return row === undefined ? undefined : row.children.find((child) => child.props && child.props.type === "checkbox");
}

/** The button whose own text is exactly `label`. */
function buttonFor(tree, label) {
  return elementsOf(tree).find((node) => node.type === "button" && textOf(node).join("") === label);
}

test("the switch card survives a host that reports no config", () => {
  const { exported } = loadClient();
  // The exact regression: a state payload without `config` used to throw out of
  // the render and take the whole conversation view down with it.
  const missing = exported.configCardFor(undefined, false, () => {});
  assert.equal(missing.length, 1, "a host with nothing to report still renders one card");
  const text = textOf(missing).join(" ");
  assert.match(text, /功能开关/);
  assert.match(text, /没有报告开关状态/);
  assert.equal(textOf(exported.configCardFor(null, false, () => {})).join(" "), text);
});

test("the read switches report the host's live configuration", () => {
  const { exported } = loadClient();
  const seen = [];
  const tree = exported.switchCards.readCard({ readGuard: false, refresh: true, exclude: ["addons"], readTools: ["read"] }, false, (patch) => seen.push(patch));
  const text = textOf(tree).join(" ");

  assert.match(text, /读取与刷新（拦截关 · 复核开 · token 估算）/, "the summary states the switches it holds");
  assert.match(text, /重复读拦截/);
  assert.match(text, /read/, "the intercepted tool names are stated, not editable here");
  assert.equal(findProp(tree, "defaultValue"), "addons", "the exclude field shows the current list");

  // The switches are wired to the host, not to local state.
  const checkboxes = elementsOf(tree).filter((node) => node.props && node.props.type === "checkbox");
  assert.equal(checkboxes.length, 3, "one switch per boolean read setting");
  assert.deepEqual(checkboxes.map((box) => box.props.checked), [false, true, false], "checked reflects the host");
  checkboxes[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(seen, [{ readGuard: true }], "flipping a switch posts exactly that key");

  // The token counter is one of them, and it is a string on the wire, not a
  // boolean: the host refuses a value it does not recognise.
  checkboxes[2].props.onChange({ target: { checked: true } });
  assert.deepEqual(seen[1], { tokenizer: "exact" }, "the exact counter is asked for by name");
});

test("the subcommand switches are grouped by domain and wired to the host", () => {
  const { exported } = loadClient();
  const seen = [];
  const tree = exported.switchCards.commandsCard({ subcommands: CATALOGUE }, false, (patch) => seen.push(patch));
  const text = textOf(tree).join(" ");

  // Every command gets a row a person can read, not just its CLI name.
  for (const label of ["读状态", "写交接", "记一行", "建索引", "找符号", "看地图", "查缺陷", "记缺陷"]) {
    assert.ok(text.includes(label), `the card must carry ${label}`);
  }
  // Grouped the way the host grouped them, each group counting itself.
  for (const group of ["项目记忆", "代码索引", "缺陷记忆"]) assert.ok(text.includes(group), `the card must carry ${group}`);
  assert.match(text, /子命令开关（7\/8 开启）/);

  const boxes = elementsOf(tree).filter((node) => node.props && node.props.type === "checkbox");
  assert.equal(boxes.length, 8, "one switch per command the host reported");

  // One command, one key — and the row reflects the host, not the default.
  const note = boxFor(tree, "记一行");
  assert.equal(note.props.checked, false, "a command the host switched off reads as off");
  note.props.onChange({ target: { checked: true } });
  assert.deepEqual(seen, [{ subcommands: { note: true } }]);
  boxFor(tree, "查缺陷").props.onChange({ target: { checked: false } });
  assert.deepEqual(seen[1], { subcommands: { "bug-search": false } });

  // A group writes its whole set at once, in whichever direction it is not in.
  // The memory group is mixed (2/3), so it offers to finish the job.
  buttonFor(tree, "全开").props.onClick();
  assert.deepEqual(seen[2], { subcommands: { status: true, handoff: true, note: true } });
  buttonFor(tree, "全关").props.onClick();
  assert.deepEqual(seen[3], { subcommands: { scan: false, find: false, map: false } });

  // A host that reports no catalogue at all says so instead of rendering an
  // empty card, and one that reports an unknown command still shows a usable row.
  assert.match(textOf(exported.switchCards.commandsCard({}, false, () => {})).join(" "), /没有报告命令清单/);
  const unknown = textOf(exported.switchCards.commandsCard({ subcommands: [{ id: "future", commands: [{ name: "from_the_future", on: true }] }] }, false, () => {})).join(" ");
  assert.match(unknown, /future/, "an unknown group keeps its own name");
  assert.match(unknown, /from_the_future/, "an unknown command is shown by its name");
});

test("the two switch cards come back together, in order", () => {
  const { exported } = loadClient();
  const cards = exported.configCardFor({ readGuard: true, refresh: true, tokenizer: "exact", exclude: [], readTools: ["read"], subcommands: CATALOGUE }, false, () => {});
  assert.deepEqual(
    cards.map((card) => textOf(card.children[0]).join("")),
    ["子命令开关（7/8 开启）", "读取与刷新（拦截开 · 复核开 · token 精确）"],
    "the subcommands first, then the host's read switches",
  );
});

test("the panel asks the host to revalidate in the counter it has", () => {
  const { exported, window: fake } = loadClient();
  const { ask } = exported.switchConfig;
  const calls = [];
  withWindow(fake, () => {
    fake.fetch = (url) => {
      calls.push(url);
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, config: {} }) });
    };
    ask("/memo/state", { root: "/tmp/p", refresh: true, tokenizer: "exact" });
    assert.match(calls[0], /refresh=1/);
    assert.match(calls[0], /tokenizer=exact/, "the unit has to reach the host, or nothing rebuilds");
    // And a nonsense one is not forwarded: the host refuses what it cannot do,
    // and a panel that sent it anyway would turn a switch into a 400.
    ask("/memo/state", { root: "/tmp/p", refresh: true, tokenizer: "wordpiece" });
    assert.doesNotMatch(calls[1], /tokenizer/);
    // The ordinary read still carries no refresh, so nothing rebuilds by accident.
    ask("/memo/state", { root: "/tmp/p" });
    assert.doesNotMatch(calls[2], /refresh/);
  });
});

test("a remembered switch is stored as a patch, and replayed only against a host that knows it", () => {
  const { exported, window: fake } = loadClient();
  const { readStoredConfig, writeStoredConfig, patchFor, sameConfig } = exported.switchConfig;

  withWindow(fake, () => {
    // What the card remembers after a save is the host's answer in the host's
    // own shape — `subcommands` grouped. Storing that and posting it straight
    // back is a 400, so the write flattens it into the patch the route accepts.
    const hostShape = {
      readGuard: true,
      refresh: false,
      exclude: ["addons"],
      readTools: ["read"],
      subcommands: [
        { id: "memory", commands: [{ name: "status", on: false }, { name: "handoff", on: true }, { name: "note", on: true }] },
        { id: "index", commands: [{ name: "scan", on: true }] },
      ],
    };
    writeStoredConfig(hostShape);
    const wanted = readStoredConfig();
    assert.deepEqual(wanted, {
      readGuard: true,
      refresh: false,
      exclude: ["addons"],
      subcommands: { status: false, handoff: true, note: true, scan: true },
    });

    // A host that already agrees is left alone: no request, so opening the view
    // does not flip anything.
    assert.equal(sameConfig(patchFor(wanted, hostShape), hostShape), true, "nothing to re-apply");
    assert.deepEqual(patchFor(wanted, hostShape).subcommands, { status: false, handoff: true, note: true, scan: true });

    // One that disagrees gets the disagreement, and a command it does not report
    // is left out rather than sent — one unknown key fails the whole request and
    // would silently cost every switch the person had set.
    const stale = {
      readGuard: false,
      refresh: false,
      exclude: ["addons"],
      readTools: ["read"],
      subcommands: [{ id: "memory", commands: [{ name: "status", on: true }, { name: "handoff", on: true }, { name: "note", on: true }] }],
    };
    const patch = patchFor(wanted, stale);
    assert.deepEqual(Object.keys(patch.subcommands), ["status", "handoff", "note"], "scan is not on this host, so it is not replayed");
    assert.equal(patch.readGuard, true);
    assert.equal(sameConfig(patch, stale), false, "a host that disagrees re-applies");
    assert.equal(sameConfig(patch, hostShape), true, "…and one that agrees does not");

    // Nothing recognisable is nothing to send, not a body full of guesses.
    writeStoredConfig({ subcommands: [{ id: "future", commands: [{ name: "from_the_future", on: false }] }] });
    assert.deepEqual(patchFor(readStoredConfig(), hostShape), {});
    // A host that cannot be understood is never "already in agreement".
    assert.equal(sameConfig({ readGuard: true }, {}), false);
    assert.deepEqual(patchFor({ readGuard: true }, null), {}, "no report, no patch");

    // Junk in storage is forgotten rather than repaired into something wrong.
    fake.localStorage.setItem("dsh-plugin-memo:config", "not json");
    assert.deepEqual(readStoredConfig(), {});
    fake.localStorage.setItem("dsh-plugin-memo:config", "[1,2]");
    assert.deepEqual(readStoredConfig(), {});
    fake.localStorage.setItem("dsh-plugin-memo:config", '{"readGuard":"yes","refresh":null,"exclude":"a","subcommands":3}');
    assert.deepEqual(readStoredConfig(), {}, "only the keys with the right type survive");
  });
});

test("the stylesheet is well formed, themed, and built to wrap", () => {
  const { styles } = loadClient();
  const css = styles[0].textContent;

  // A hand-written stylesheet is still a program. One unclosed brace silently
  // swallows every rule after it, which is a layout bug nobody can see in a diff.
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, "braces are balanced");
  assert.doesNotMatch(css, /;;/, "no empty declaration");

  // Every colour comes from a token. A literal one would freeze the panel in
  // whichever theme it was written in. (`white-space` is not a colour.)
  const literals = css
    .replace(/var\(--[a-z0-9-]+\)/g, "")
    .match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black|silver|gray|grey)\b(?!-)/gi);
  assert.equal(literals, null, `literal colour(s) in the stylesheet: ${literals}`);

  // The two properties that make this view survive a narrow pane: the reading
  // column caps its own measure, and rows wrap instead of squeezing.
  assert.match(css, /\.memoPane\{[^}]*max-width:\d/, "the pane caps its measure");
  assert.match(css, /\.memoBar\{[^}]*flex-wrap:wrap/, "the toolbar wraps");
  assert.match(css, /\.memoList li\{[^}]*flex-wrap:wrap/, "list rows wrap");
  assert.match(css, /\.memoGrid\{[^}]*minmax\(0,1fr\)/, "the key/value grid lets its value column shrink");
});

test("no element styles itself inline", () => {
  const { exported } = loadClient();
  const props = { useSessions: (select) => select({ current: "s-1", byId: { "s-1": { cwd: "/tmp" } } }) };
  const inline = (tree) => elementsOf(tree).filter((node) => node.props && node.props.style !== undefined);
  const cards = exported.configCardFor({ readGuard: true, refresh: true, exclude: [], readTools: ["read"], subcommands: CATALOGUE }, false, () => {});

  // An inline style cannot follow the theme, and cannot answer to the width the
  // view is given — so the layout has to live in the stylesheet, every time.
  assert.deepEqual(inline(exported.MemoView(props)), []);
  assert.deepEqual(inline(cards), []);
});

test("the index card reports counts, origin, and freshness", () => {
  const { exported } = loadClient();
  const fresh = textOf(exported.cards.indexCard({
    present: true,
    readable: true,
    fileCount: 28,
    symbolCount: 247,
    totalTokens: 60291,
    symbolSource: "ts (24 files)",
    scannedAt: "2026-09-15T16:40:27.792Z",
    staleChanged: 0,
    staleMissing: 0,
    staleChangedFiles: [],
    staleMissingFiles: [],
  }));
  const freshText = fresh.join(" ");
  assert.match(freshText, /代码索引/);
  assert.match(freshText, /28/);
  assert.match(freshText, /247/);
  assert.match(freshText, /60,291/, "the count is on screen, grouped like every other number");
  assert.match(freshText, /ts \(24 files\)/);
  assert.match(freshText, /索引与磁盘一致/);
  // No unit reported: the hedged label, because the panel cannot know better.
  assert.match(freshText, /估算 tokens/);
  assert.doesNotMatch(freshText, /精确 tokens/);

  // An index counted by the tokenizer says so — the count is the same field,
  // and a panel that kept calling it an estimate would be lying about a number
  // the host went to the trouble of measuring.
  const exactText = textOf(exported.cards.indexCard({
    present: true,
    readable: true,
    fileCount: 28,
    symbolCount: 247,
    totalTokens: 60291,
    tokens: "exact",
    symbolSource: "ts (24 files)",
    scannedAt: "2026-09-15T16:40:27.792Z",
    staleChanged: 0,
    staleMissing: 0,
    staleChangedFiles: [],
    staleMissingFiles: [],
  })).join(" ");
  assert.match(exactText, /精确 tokens/);
  assert.doesNotMatch(exactText, /估算 tokens/);

  const staleText = textOf(exported.cards.indexCard({
    present: true,
    readable: true,
    fileCount: 2,
    symbolCount: 3,
    totalTokens: 10,
    symbolSource: "regex",
    scannedAt: "t",
    staleChanged: 1,
    staleMissing: 1,
    staleChangedFiles: ["src/a.ts"],
    staleMissingFiles: ["src/gone.ts"],
  })).join(" ");
  assert.match(staleText, /索引落后于磁盘/);
  assert.match(staleText, /src\/a\.ts/);
  assert.match(staleText, /src\/gone\.ts/);

  // A project with no index yet, and one whose index cannot be read, say so.
  assert.match(textOf(exported.cards.indexCard({ present: false })).join(" "), /还没有索引/);
  assert.match(textOf(exported.cards.indexCard({ present: true, readable: false, error: "boom" })).join(" "), /boom/);
});

test("the STATUS card labels every section and marks the empty ones", () => {
  const { exported } = loadClient();
  const text = textOf(exported.cards.statusCard({
    present: true,
    updated: "2026-09-15T16:51:00.432Z",
    sections: [
      { title: "现在在哪", body: "索引保鲜做完了" },
      { title: "下一步", body: "重启 profile" },
      { title: "未决问题", body: null },
      { title: "不要重犯", body: "别用 fs/write-intent" },
    ],
    extra: [{ title: "额外一节", body: "自定义内容" }],
  })).join(" ");
  assert.match(text, /最后更新 2026-09-15T16:51:00\.432Z/);
  for (const expected of ["现在在哪", "索引保鲜做完了", "下一步", "重启 profile", "未决问题", "不要重犯", "额外一节", "自定义内容"]) {
    assert.ok(text.includes(expected), `the card must carry ${expected}`);
  }
  assert.match(text, /（空）/, "a section that was never written reads as empty, not as absent");

  assert.match(textOf(exported.cards.statusCard({ present: false, sections: [], extra: [] })).join(" "), /还没有 STATUS\.md/);
});

test("the journal and bug cards carry their entries", () => {
  const { exported } = loadClient();
  const journal = textOf(exported.cards.journalCard({
    present: true,
    total: 9,
    notes: [{ at: "2026-09-15T16:51:05.365Z", kind: "decision", text: "不用文件监听" }],
  })).join(" ");
  assert.match(journal, /1 \/ 9/, "the card shows how much of the journal it is showing");
  assert.match(journal, /decision/);
  assert.match(journal, /不用文件监听/);
  assert.match(journal, /2026-09-15 16:51/, "the timestamp is made readable");
  assert.match(textOf(exported.cards.journalCard({ present: true, total: 0, notes: [] })).join(" "), /还是空的/);

  const bugs = textOf(exported.cards.bugsCard({
    present: true,
    total: 2,
    recent: [{ id: "bug-001", occurrences: 3, errorMessage: "A→B→A 漏判", fix: "按窗口记" }],
  })).join(" ");
  assert.match(bugs, /bug 记忆（2 条）/);
  assert.match(bugs, /bug-001 ×3/);
  assert.match(bugs, /A→B→A 漏判/);
  assert.match(bugs, /按窗口记/);
  assert.match(textOf(exported.cards.bugsCard({ present: false, total: 0, recent: [] })).join(" "), /还没记过/);
});
