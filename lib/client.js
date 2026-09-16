"use strict";
/**
 * dsh-plugin-memo — browser half.
 *
 * Plain JavaScript in the harness's own module format, not a bundler output:
 * `dsh-client-modules` serves this file verbatim (it only concatenates module
 * sources and emits a source map), so there is nothing to build and no build
 * tool in this package. Everything it needs — React, and the `slots` service
 * off the plugin context — arrives through `require` and Cordis.
 *
 * What it contributes is one `conversation.view`: the session's own view
 * switcher gains a "Memo" entry beside Chat and Trajectory, so the memory on
 * screen belongs to the session being looked at. The project directory comes
 * from that session's summary — the shell already knows where it started, so
 * the panel does not have to ask. All data comes from the host half's own JSON
 * routes over `fetch` — no remote namespace, and no live Cordis object crossing
 * the wire.
 *
 * The view is read-mostly by design. Its writes are the switches — the read
 * guard and refresh policy, the index's exclude list, and one on/off per CLI
 * subcommand — plus "rebuild index", which the host refuses for a directory
 * that has no `.memo/` yet.
 */
// The harness's client loader concatenates module sources and calls each factory
// with a CommonJS-like `require`; nothing here is a bundler output, so there is no
// module id to import and the loader itself is reached off `window`.
window.__ModuleLoader__.load({
    id: "dsh-plugin-memo",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        let react = require("react");
        //#region styles
        /**
         * The pane's whole appearance.
         *
         * Three rules decide most of it. **One measure**: the column is capped and
         * centred (≈55 汉字 per line at 13px), so a wide window does not turn a
         * paragraph into a 200-character line, and a narrow one simply fills what
         * it is given. **Intrinsic wrapping**: rows use `flex-wrap` and
         * `minmax(0,1fr)` rather than media queries on the *viewport*, because
         * this view lives inside a shell that can be narrow while the window is
         * wide — a viewport query would guess wrong. **Tokens only**: every colour
         * comes from a documented theme token, so the panel follows light and dark
         * without knowing either exists.
         */
        const CSS = [
            ".memoPane{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;max-width:940px;margin:0 auto;padding:20px 0;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary)}",
            ".memoPane *{box-sizing:border-box}",
            // Toolbar
            ".memoBar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
            ".memoInput{flex:1 1 220px;min-width:0;height:30px;padding:0 9px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-family:var(--dsw-font-mono);font-size:12px}",
            ".memoInput:focus-visible,.memoBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
            ".memoBtn{height:30px;padding:0 11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer;font-size:12px;white-space:nowrap;transition:border-color .12s ease,background-color .12s ease}",
            ".memoBtn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}",
            ".memoBtn:disabled{color:var(--dsw-alias-label-secondary);cursor:default;opacity:.6}",
            ".memoBtnPrimary{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
            ".memoBtnTiny{height:22px;padding:0 8px;font-size:11px}",
            // Path, notice, error: quoted back to the person, so they wrap rather than push the layout.
            ".memoNote{margin:0;padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l2);border-radius:0 8px 8px 0;background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere}",
            ".memoNoteError{border-left-color:var(--dsw-alias-state-error-primary)}",
            ".memoErr{color:var(--dsw-alias-state-error-primary)}",
            ".memoWarn{color:var(--dsw-alias-state-warn-primary)}",
            // Cards
            ".memoCard{padding:12px 14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}",
            ".memoCard h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
            ".memoCard h4:not(:first-child){margin-top:14px}",
            ".memoBody{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}",
            ".memoMuted{color:var(--dsw-alias-label-secondary)}",
            // A folding card: its summary is the card title, and it carries the
            // current state, so the collapsed view is still a reading of the state
            // rather than a closed drawer.
            ".memoDetails{display:block}",
            ".memoSummary{display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;list-style:none;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
            ".memoSummary::-webkit-details-marker{display:none}",
            ".memoSummary::after{content:\"▸\";flex:none;margin-left:auto;font-size:10px;transition:transform .12s ease}",
            ".memoSummary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}",
            ".memoDetails[open] > .memoSummary{margin-bottom:9px}",
            ".memoDetails[open] > .memoSummary::after{content:\"▾\"}",
            // One STATUS section: its label belongs to its body, so they travel together.
            ".memoSection{margin-top:15px}",
            ".memoSection:first-of-type{margin-top:0}",
            ".memoSection h4{margin-bottom:3px}",
            // Lists: the tag column keeps its width, the text column wraps under it.
            ".memoList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px}",
            ".memoList li{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;min-width:0}",
            ".memoTag{flex:none;padding:0 6px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;font-size:11px;line-height:17px}",
            ".memoWhen{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}",
            ".memoText{flex:1 1 200px;min-width:0;overflow-wrap:anywhere}",
            // Key/value grid: labels hug their content, values take what is left.
            ".memoGrid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;align-items:baseline;margin:0}",
            ".memoGrid dt{color:var(--dsw-alias-label-secondary);font-size:12px}",
            ".memoGrid dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}",
            // Switches: a group is a heading with its own actions, a row is one tool.
            ".memoGroup{display:flex;align-items:center;gap:10px;margin:14px 0 2px;padding-bottom:5px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
            ".memoGroup:first-of-type{margin-top:2px}",
            ".memoGroupName{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}",
            ".memoGroupCount{font-weight:400;font-variant-numeric:tabular-nums}",
            ".memoToggle{display:flex;gap:9px;align-items:flex-start;padding:5px 6px;margin:0 -6px;border-radius:8px;cursor:pointer}",
            ".memoToggle:hover{background:var(--dsw-alias-bg-layer-2)}",
            ".memoToggle input{flex:none;width:14px;height:14px;margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}",
            ".memoToggleText{display:flex;flex-wrap:wrap;gap:0 8px;min-width:0}",
            ".memoToggleLabel{font-weight:500}",
            ".memoToggleHint{color:var(--dsw-alias-label-secondary);font-size:12px}",
            // Last resort for a genuinely narrow pane: stack the key/value pairs.
            // The threshold is low on purpose — the paired layout already survives a
            // long value by wrapping it, and stacking costs five extra lines.
            "@media (max-width:400px){.memoGrid{grid-template-columns:minmax(0,1fr)}.memoGrid dt{margin-top:6px}.memoGrid dt:first-of-type{margin-top:0}}",
            "@media (prefers-reduced-motion:reduce){.memoBtn{transition:none}}",
        ].join("");
        const CSS_ID = "dsh-plugin-memo/panel.css";
        // A self-contained style tag that names its owner, so the panel survives
        // every theme without a build step. Only documented theme tokens are used.
        if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
            const tag = document.createElement("style");
            tag.dataset.plugin = "dsh-plugin-memo";
            tag.dataset.pluginCss = CSS_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }
        //#endregion
        //#region helpers
        const h = react.createElement;
        const STORAGE_KEY = "dsh-plugin-memo:root";
        const CONFIG_KEY = "dsh-plugin-memo:config";
        const numberFormat = new Intl.NumberFormat("en-US");
        const num = (value) => (typeof value === "number" && Number.isFinite(value) ? numberFormat.format(value) : "-");
        const clamp = (text, max) => (typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text || "");
        /** Local storage can throw (private mode, disabled cookies) — never fatal. */
        function readStored(key) {
            try {
                return window.localStorage.getItem(key) || "";
            }
            catch {
                return "";
            }
        }
        function writeStored(key, value) {
            try {
                if (value.length > 0)
                    window.localStorage.setItem(key, value);
                else
                    window.localStorage.removeItem(key);
            }
            catch {
                // Remembering a preference is a convenience, not a requirement.
            }
        }
        const readStoredRoot = () => readStored(STORAGE_KEY);
        const writeStoredRoot = (value) => writeStored(STORAGE_KEY, value);
        /**
         * The switches this panel owns. Not the whole plugin config: see
         * panelConfig.
         *
         * What is remembered is a *patch* — `subcommands` as a name -> boolean map
         * — while the host reports `subcommands` as the grouped catalogue the card
         * renders. The two shapes are reconciled by `commandMap`/`patchFor` below
         * rather than by storing whatever the host last said.
         */
        function readStoredConfig() {
            const raw = readStored(CONFIG_KEY);
            if (raw.length === 0)
                return {};
            try {
                const parsed = JSON.parse(raw);
                if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
                    return {};
                const kept = {};
                if (typeof parsed.readGuard === "boolean")
                    kept.readGuard = parsed.readGuard;
                if (typeof parsed.refresh === "boolean")
                    kept.refresh = parsed.refresh;
                if (parsed.tokenizer === "exact" || parsed.tokenizer === "estimated")
                    kept.tokenizer = parsed.tokenizer;
                if (Array.isArray(parsed.exclude))
                    kept.exclude = parsed.exclude.filter((name) => typeof name === "string");
                if (parsed.subcommands !== null && typeof parsed.subcommands === "object" && !Array.isArray(parsed.subcommands)) {
                    const subcommands = {};
                    for (const [name, on] of Object.entries(parsed.subcommands))
                        if (typeof on === "boolean")
                            subcommands[name] = on;
                    if (Object.keys(subcommands).length > 0)
                        kept.subcommands = subcommands;
                }
                return kept;
            }
            catch {
                return {};
            }
        }
        function writeStoredConfig(config) {
            const kept = {};
            if (typeof config.readGuard === "boolean")
                kept.readGuard = config.readGuard;
            if (typeof config.refresh === "boolean")
                kept.refresh = config.refresh;
            if (config.tokenizer === "exact" || config.tokenizer === "estimated")
                kept.tokenizer = config.tokenizer;
            if (Array.isArray(config.exclude))
                kept.exclude = config.exclude.slice();
            const subcommands = commandMap(config);
            if (Object.keys(subcommands).length > 0)
                kept.subcommands = subcommands;
            writeStored(CONFIG_KEY, JSON.stringify(kept));
        }
        /** The host's grouped subcommand switches, flattened to `{ name: on }`. */
        function commandMap(config) {
            const map = {};
            if (config === null || typeof config !== "object" || !Array.isArray(config.subcommands))
                return map;
            for (const group of config.subcommands) {
                if (group === null || typeof group !== "object" || !Array.isArray(group.commands))
                    continue;
                for (const entry of group.commands)
                    if (entry && typeof entry.name === "string")
                        map[entry.name] = entry.on === true;
            }
            return map;
        }
        /**
         * What to actually send: the remembered patch minus anything this host
         * did not report. One key an older (or newer) host does not know would
         * otherwise fail the whole request, quietly costing the person every
         * switch they had set.
         */
        function patchFor(wanted, live) {
            if (live === null || typeof live !== "object")
                return {};
            const patch = {};
            if (typeof live.readGuard === "boolean" && typeof wanted.readGuard === "boolean")
                patch.readGuard = wanted.readGuard;
            if (typeof live.refresh === "boolean" && typeof wanted.refresh === "boolean")
                patch.refresh = wanted.refresh;
            if (typeof live.tokenizer === "string" && typeof wanted.tokenizer === "string")
                patch.tokenizer = wanted.tokenizer;
            if (Array.isArray(live.exclude) && Array.isArray(wanted.exclude))
                patch.exclude = wanted.exclude;
            if (Array.isArray(live.subcommands) && wanted.subcommands !== null && typeof wanted.subcommands === "object") {
                const known = commandMap(live);
                const subcommands = {};
                for (const [name, on] of Object.entries(wanted.subcommands))
                    if (name in known && typeof on === "boolean")
                        subcommands[name] = on;
                if (Object.keys(subcommands).length > 0)
                    patch.subcommands = subcommands;
            }
            return patch;
        }
        /** Whether the host is already doing what this (already filtered) patch asks. */
        function sameConfig(patch, live) {
            if ("readGuard" in patch && patch.readGuard !== live.readGuard)
                return false;
            if ("refresh" in patch && patch.refresh !== live.refresh)
                return false;
            if ("tokenizer" in patch && patch.tokenizer !== live.tokenizer)
                return false;
            if ("exclude" in patch && (patch.exclude || []).join("\u0000") !== (live.exclude || []).join("\u0000"))
                return false;
            if ("subcommands" in patch) {
                const liveCommands = commandMap(live);
                for (const [name, on] of Object.entries(patch.subcommands))
                    if (liveCommands[name] !== on)
                        return false;
            }
            return true;
        }
        /**
         * One request against the host half's JSON routes.
         *
         * The query is assembled here rather than baked into `path`, because the
         * host reads `root` and `refresh` off the same query string.
         */
        function ask(path, options = {}) {
            const settings = options || {};
            const query = new URLSearchParams();
            if (settings.root)
                query.set("root", settings.root);
            if (settings.refresh === true)
                query.set("refresh", "1");
            if (settings.tokenizer === "exact" || settings.tokenizer === "estimated")
                query.set("tokenizer", settings.tokenizer);
            const suffix = query.toString();
            return window
                .fetch(`${path}${suffix.length > 0 ? `?${suffix}` : ""}`, {
                method: settings.method || "GET",
                credentials: "same-origin",
                headers: settings.body === undefined
                    ? { accept: "application/json" }
                    : { accept: "application/json", "content-type": "application/json" },
                body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
            })
                .then((response) => response.json().then((body) => {
                if (!body || body.ok !== true)
                    throw new Error((body && body.error) || `HTTP ${response.status}`);
                return body;
            }, () => {
                throw new Error(`HTTP ${response.status}`);
            }));
        }
        function field(label, value) {
            return [h("dt", { key: `${label}-k` }, label), h("dd", { key: `${label}-v` }, value)];
        }
        function card(title, children) {
            return h("div", { className: "memoCard" }, h("h4", null, title), children);
        }
        /**
         * A card that folds away, for the parts that are configuration rather than
         * memory. The title doubles as the summary line, so a closed card still
         * states what is set ("工具开关（6/8 开启）") instead of hiding it.
         */
        function foldCard(title, children) {
            return h("details", { className: "memoCard memoDetails" }, h("summary", { className: "memoSummary" }, title), children);
        }
        function prose(text, kind) {
            return h("p", { className: `memoBody ${kind || ""}`.trim() }, text);
        }
        /**
         * One switch. Disabled while a save is in flight so the row cannot race
         * itself. The label and its hint are separate spans that wrap as a pair,
         * so a narrow pane puts the hint on its own line instead of squeezing it.
         */
        function toggle(label, hint, checked, disabled, onChange) {
            return h("label", { className: "memoToggle", key: label }, h("input", { type: "checkbox", checked: checked, disabled: disabled, onChange: (event) => onChange(event.target.checked) }), h("span", { className: "memoToggleText" }, h("span", { className: "memoToggleLabel" }, label), hint ? h("span", { className: "memoToggleHint" }, hint) : null));
        }
        //#endregion
        //#region cards
        /** The index block: counts, origin, and whether disk has moved past it. */
        function indexCard(index) {
            if (index.present !== true)
                return card("代码索引", prose("还没有索引。在项目里跑一次 memo scan 就会建起来。", "memoMuted"));
            if (index.readable !== true)
                return card("代码索引", prose(index.error || "index.json 读不出来。", "memoErr"));
            const stale = index.staleChanged > 0 || index.staleMissing > 0;
            return card("代码索引", [
                h("dl", { className: "memoGrid", key: "grid" }, field("文件", num(index.fileCount)), field("符号", num(index.symbolCount)), field(index.tokens === "exact" ? "精确 tokens" : "估算 tokens", num(index.totalTokens)), field("符号来源", index.symbolSource), field("建立于", index.scannedAt || "-")),
                stale
                    ? h("p", { className: "memoBody memoWarn", key: "stale" }, `索引落后于磁盘：${index.staleChanged} 个文件改过、${index.staleMissing} 个已消失。` +
                        (index.staleChangedFiles.length > 0 ? ` 改过：${index.staleChangedFiles.join("、")}` : "") +
                        (index.staleMissingFiles.length > 0 ? ` 没了：${index.staleMissingFiles.join("、")}` : ""))
                    : h("p", { className: "memoBody memoMuted", key: "fresh" }, "索引与磁盘一致。"),
            ]);
        }
        /** The STATUS.md block: the four sections the format fixes, then any extra. */
        function statusCard(status) {
            if (status.present !== true)
                return card("STATUS.md", prose("还没有 STATUS.md。让模型跑一次 memo handoff 就有第一份。", "memoMuted"));
            // Each label is wrapped with its body: a section that is long enough to
            // wrap should never look like it belongs to the next heading.
            const blocks = [];
            for (const section of status.sections.concat(status.extra)) {
                blocks.push(h("section", { key: `s-${section.title}`, className: "memoSection" }, h("h4", null, section.title), h("p", { className: section.body ? "memoBody" : "memoBody memoMuted" }, section.body || "（空）")));
            }
            return card(`STATUS.md · 最后更新 ${status.updated || "未知"}`, blocks);
        }
        function journalCard(journal) {
            if (journal.present !== true || journal.notes.length === 0)
                return card("最近动作", prose("journal 还是空的。", "memoMuted"));
            return card(`最近动作（${journal.notes.length} / ${num(journal.total)}）`, h("ul", { className: "memoList" }, journal.notes.map((note, index) => h("li", { key: `${note.at}-${index}` }, h("span", { className: "memoWhen" }, String(note.at || "").replace("T", " ").slice(0, 16)), h("span", { className: "memoTag" }, note.kind || "note"), h("span", { className: "memoText" }, note.text)))));
        }
        function bugsCard(bugs) {
            return card(`bug 记忆（${num(bugs.total)} 条）`, bugs.recent.length === 0
                ? prose("还没记过。", "memoMuted")
                : h("ul", { className: "memoList" }, bugs.recent.map((bug) => h("li", { key: bug.id }, h("span", { className: "memoTag" }, `${bug.id} ×${bug.occurrences}`), h("span", { className: "memoText" }, bug.errorMessage, bug.fix ? h("span", { className: "memoMuted" }, ` — ${clamp(bug.fix, 160)}`) : null)))));
        }
        //#endregion
        //#region section
        /**
         * The Memo view. It is a Conversation View, not a settings page, so it
         * takes the target's standard props and holds no service handle of its own:
         * every fact on screen comes from the host's JSON routes, so there is
         * nothing here that can drift behind the files.
         *
         * `useSessions` is the standard hook the target hands every view; the
         * session summary already carries the working directory the shell launched
         * this session in, so the panel starts on the right project without
         * asking, and only a deliberate override is remembered.
         */
        function MemoView(props) {
            const sessions = props.useSessions;
            const [overrideRoot, setOverrideRoot] = react.useState(readStoredRoot);
            const [draft, setDraft] = react.useState(readStoredRoot);
            const [data, setData] = react.useState(null);
            const [error, setError] = react.useState(null);
            const [busy, setBusy] = react.useState("load");
            const [notice, setNotice] = react.useState(null);
            const [config, setConfig] = react.useState(null);
            const [saving, setSaving] = react.useState(false);
            const [reloadKey, setReloadKey] = react.useState(0);
            // The session's own directory, or undefined when this session has no
            // workspace yet. Read as a leaf field: the snapshot itself is live data.
            const cwd = typeof sessions === "function" ? sessions((state) => {
                const current = state && state.current;
                const summary = current === undefined || state.byId === undefined ? undefined : state.byId[current];
                return summary && typeof summary.cwd === "string" ? summary.cwd : undefined;
            }) : undefined;
            const root = overrideRoot.length > 0 ? overrideRoot : cwd !== undefined ? cwd : "";
            // One load path for mount, refresh, and project change. `refresh=1` makes
            // the host revalidate the index the way `memo find` does, so the staleness
            // figure on screen is never one the panel invented.
            // The counter is part of the load: switching it changes what every
            // number in the index means, and the host has to rebuild before the
            // panel can report new ones. It arrives with the config, and until it
            // has, the host uses whatever its composition says.
            react.useEffect(() => {
                let cancelled = false;
                setBusy("load");
                setError(null);
                setNotice(null);
                ask("/memo/state", { root: root, refresh: true, tokenizer: config === null ? undefined : config.tokenizer })
                    .then((body) => {
                    if (!cancelled) {
                        setData(body);
                        setConfig(body.config);
                    }
                })
                    .catch((failure) => {
                    if (!cancelled)
                        setError(failure.message);
                })
                    .then(() => {
                    if (!cancelled)
                        setBusy(null);
                });
                return () => {
                    cancelled = true;
                };
            }, [root, cwd, reloadKey]);
            // Re-apply the remembered switches once per mount, and only when the host
            // disagrees: the host keeps its own state in memory, so after a profile
            // restart it is back on the composition's defaults while the panel still
            // remembers what was chosen. `GET` tells us which of the two is true, and
            // it also says which subcommands exist here — the patch is filtered against
            // that report before it is sent.
            react.useEffect(() => {
                const wanted = readStoredConfig();
                if (Object.keys(wanted).length === 0)
                    return;
                let cancelled = false;
                ask("/memo/config")
                    .then((body) => {
                    if (cancelled)
                        return null;
                    const patch = patchFor(wanted, body.config);
                    if (Object.keys(patch).length === 0 || sameConfig(patch, body.config))
                        return null;
                    return ask("/memo/config", { method: "POST", body: patch }).then((saved) => {
                        if (!cancelled)
                            setConfig(saved.config);
                    });
                })
                    .catch(() => {
                    // No switches reachable: the panel still reads.
                });
                return () => {
                    cancelled = true;
                };
            }, []);
            const save = (patch) => {
                setSaving(true);
                setError(null);
                ask("/memo/config", { method: "POST", body: patch })
                    .then((body) => {
                    setConfig(body.config);
                    writeStoredConfig(body.config);
                    setNotice("配置已生效。");
                    return ask("/memo/state", { root: root }).then((state) => setData(state));
                })
                    .catch((failure) => setError(failure.message))
                    .then(() => setSaving(false));
            };
            const scan = () => {
                setBusy("scan");
                setError(null);
                setNotice(null);
                ask("/memo/scan", { root: root, method: "POST" })
                    .then((body) => {
                    setNotice(`索引已重建：${num(body.index.fileCount)} 个文件 · ${num(body.index.symbolCount)} 个符号 · ${body.durationMs} ms`);
                    return ask("/memo/state", { root: root }).then((state) => setData(state));
                })
                    .catch((failure) => setError(failure.message))
                    .then(() => setBusy(null));
            };
            const open = (event) => {
                event.preventDefault();
                const next = draft.trim();
                writeStoredRoot(next);
                setOverrideRoot(next);
                setReloadKey((key) => key + 1);
            };
            const useSessionRoot = () => {
                writeStoredRoot("");
                setDraft("");
                setOverrideRoot("");
                setReloadKey((key) => key + 1);
            };
            const bar = h("form", { className: "memoBar", onSubmit: open }, h("input", {
                className: "memoInput",
                type: "text",
                value: draft,
                placeholder: cwd ? `留空 = 本会话目录 ${cwd}` : "项目绝对路径（留空 = 宿主默认）",
                "aria-label": "项目绝对路径",
                onChange: (event) => setDraft(event.target.value),
                spellCheck: false,
            }), h("button", { className: "memoBtn", type: "submit", disabled: busy !== null }, "打开"), h("button", { className: "memoBtn", type: "button", disabled: busy !== null, onClick: () => setReloadKey((key) => key + 1) }, busy === "load" ? "读取中…" : "刷新"), h("button", { className: "memoBtn memoBtnPrimary", type: "button", disabled: busy !== null || data === null || data.initialized !== true, onClick: scan }, busy === "scan" ? "重建中…" : "重建索引"), overrideRoot.length > 0 && cwd !== undefined
                ? h("button", { className: "memoBtn", type: "button", disabled: busy !== null, onClick: useSessionRoot }, "回到本会话目录")
                : null);
            const head = [
                overrideRoot.length > 0 && cwd !== undefined
                    ? h("p", { className: "memoBody memoMuted", key: "override" }, `正在看手动指定的项目；本会话目录是 ${cwd}。`)
                    : null,
                notice !== null ? h("p", { className: "memoNote memoBody", key: "notice" }, notice) : null,
                error !== null ? h("p", { className: "memoNote memoNoteError memoBody memoErr", key: "error" }, error) : null,
            ];
            // The switch cards, or an empty list when the host has not answered yet.
            const configCards = config === null ? [] : configCardFor(config, saving, save);
            if (data === null) {
                return h("div", { className: "memoPane" }, bar, ...head, ...configCards, prose(busy !== null ? "读取中…" : "没有数据。", "memoMuted"));
            }
            const body = data.initialized !== true
                ? [prose("这个目录里还没有 .memo/。在项目里跑一次 memo scan（或 /memo scan），面板才能接管。", "memoMuted")]
                : [statusCard(data.status), journalCard(data.journal), bugsCard(data.bugs), indexCard(data.index)];
            return h("div", { className: "memoPane" }, bar, ...head, ...configCards, ...body);
        }
        /**
         * What each subcommand is called on screen, and what a person is trading
         * away by leaving it on. The host names the commands and reports their
         * state; the words live here, beside the rest of this file's copy, and a
         * name this map has never heard of falls back to showing the name itself.
         */
        const COMMAND_TEXT = {
            status: ["读状态", "先看 STATUS、日志和 bug 数，再动代码"],
            handoff: ["写交接", "更新 STATUS.md 里你指定的那几节"],
            note: ["记一行", "往 journal.jsonl 追加一条"],
            "bug-search": ["查缺陷", "按症状找以前记下的根因和修法"],
            "bug-log": ["记缺陷", "把根因和修法写进 bugs.json"],
            scan: ["建索引", "全量扫描并写 index.json"],
            find: ["找符号", "按符号或路径定位到行号"],
            map: ["看地图", "目录分布，或聚焦某个主题的文件清单"],
        };
        const GROUP_TEXT = { memory: "项目记忆", index: "代码索引", bugs: "缺陷记忆" };
        /**
         * The subcommand switches, grouped the way the host groups them.
         *
         * There is one `memo` tool now, so a switch no longer adds or removes
         * anything from the tool table: it makes the CLI refuse that one command,
         * for the model and for `/memo` alike — which is what the card says, and
         * the reason the host is the one enforcing it. The group button is the
         * same write over the group's whole set, so it can send several keys.
         */
        function commandsCard(config, saving, save) {
            const groups = Array.isArray(config.subcommands) ? config.subcommands : [];
            if (groups.length === 0) {
                return card("子命令开关", prose("这个宿主半没有报告命令清单（版本较旧，或者路由没注册）。", "memoMuted"));
            }
            const blocks = [];
            let on = 0;
            let total = 0;
            for (const group of groups) {
                const entries = Array.isArray(group.commands) ? group.commands : [];
                const title = GROUP_TEXT[group.id] || String(group.id);
                const onCount = entries.filter((entry) => entry.on === true).length;
                const allOn = entries.length > 0 && onCount === entries.length;
                on += onCount;
                total += entries.length;
                blocks.push(h("div", { key: `group-${group.id}`, className: "memoGroup" }, h("span", { className: "memoGroupName" }, title, h("span", { className: "memoGroupCount" }, `　${onCount}/${entries.length}`)), entries.length === 0
                    ? null
                    : h("button", {
                        className: "memoBtn memoBtnTiny",
                        type: "button",
                        disabled: saving,
                        onClick: () => {
                            const patch = {};
                            for (const entry of entries)
                                patch[entry.name] = !allOn;
                            save({ subcommands: patch });
                        },
                    }, allOn ? "全关" : "全开")));
                for (const entry of entries) {
                    const text = COMMAND_TEXT[entry.name] || [];
                    blocks.push(toggle(text[0] || entry.name, text[1], entry.on === true, saving, (value) => save({ subcommands: { [entry.name]: value } })));
                }
            }
            blocks.push(h("p", { key: "note", className: "memoBody memoMuted" }, "关掉的子命令会被 CLI 拒绝：模型调 memo 时拿到一句拒绝的理由，/memo 也一样。重启 profile 后回到 composition 里的值，这个页面会在下次打开时重新应用你选过的。"));
            return foldCard(`子命令开关（${on}/${total} 开启）`, blocks);
        }
        /**
         * The host's own read switches.
         *
         * Tolerant about the shape it is handed: a build of the host half that
         * predates these switches answers without them, and a panel that throws
         * on that takes the whole conversation view down with it — which is
         * exactly what happened once. Absent values render as off and say so.
         */
        function readCard(config, saving, save) {
            const excluded = Array.isArray(config.exclude) ? config.exclude : [];
            const readTools = Array.isArray(config.readTools) ? config.readTools : [];
            // The summary states the switches, the way the command card's summary
            // states its count: folded, it still answers "is the guard on?".
            const state = `（拦截${config.readGuard === true ? "开" : "关"} · 复核${config.refresh === true ? "开" : "关"} · token ${config.tokenizer === "exact" ? "精确" : "估算"}）`;
            return foldCard(`读取与刷新${state}`, [
                toggle("重复读拦截", "同一窗口第二次读会被拒", config.readGuard === true, saving, (value) => save({ readGuard: value })),
                toggle("查询前自动复核索引", "关掉后索引只在重建时更新", config.refresh === true, saving, (value) => save({ refresh: value })),
                toggle("用 DeepSeek V4 分词器精确计数", "开：每个 token 数都是真分词器的输出（首次计数要读 6MB 词表）。关：仍是 ~4 字符一个 token 的估算。两种都会写进索引，切换后下次扫描/复核会重建", config.tokenizer === "exact", saving, (value) => save({ tokenizer: value ? "exact" : "estimated" })),
                h("div", { key: "exclude", className: "memoBar" }, h("input", {
                    className: "memoInput",
                    type: "text",
                    defaultValue: excluded.join(", "),
                    placeholder: "额外排除的目录名，逗号分隔（例如 addons, generated）",
                    "aria-label": "额外排除的目录名",
                    spellCheck: false,
                    onKeyDown: (event) => {
                        if (event.key !== "Enter")
                            return;
                        event.preventDefault();
                        save({ exclude: splitNames(event.target.value) });
                    },
                }), h("button", {
                    className: "memoBtn",
                    type: "button",
                    disabled: saving,
                    onClick: (event) => {
                        const input = event.currentTarget.previousSibling;
                        save({ exclude: splitNames(input && input.value) });
                    },
                }, "保存排除")),
                readTools.length > 0
                    ? h("p", { key: "tools", className: "memoBody memoMuted" }, `被拦截的读工具：${readTools.join("、")}（改它要动 composition）`)
                    : null,
                h("p", { key: "note", className: "memoBody memoMuted" }, "这两个开关改的是宿主进程里的运行时配置，重启 profile 后会恢复 composition 里的值。"),
            ]);
        }
        /**
         * Every card this panel puts behind a switch, in order.
         *
         * Returns an array so the view can splat it: one card per concern, and a
         * host that reports nothing at all still renders as a line of prose
         * rather than throwing out of the render.
         */
        function configCardFor(rawConfig, saving, save) {
            const config = rawConfig !== null && typeof rawConfig === "object" ? rawConfig : null;
            if (config === null) {
                return [card("功能开关", prose("这个宿主半没有报告开关状态（版本较旧或路由未注册）。", "memoMuted"))];
            }
            return [commandsCard(config, saving, save), readCard(config, saving, save)];
        }
        /** One directory-name list, however the person separated it. */
        function splitNames(text) {
            return String(text || "")
                .split(/[\s,，]+/)
                .map((name) => name.trim())
                .filter((name) => name.length > 0);
        }
        //#endregion
        //#region plugin
        /** Required client services: the slot registry is how a page gets added. */
        const inject = ["slots"];
        /**
         * Add one Conversation View. It sits beside the shipped `chat` and
         * `trajectory` views in the session's own view switcher, so the memory it
         * shows belongs to the session the person is looking at.
         *
         * `slots.inject` waits for the slot to exist rather than registering
         * against a ledger that has not declared it yet, and the `label` is a plain
         * function because this package has no locale face.
         * @param ctx - client root context.
         */
        function apply(ctx) {
            ctx.slots.inject("conversation.view", () => ctx.slots.register({
                name: "conversation.view",
                id: "memo",
                order: 30,
                label: () => "Memo",
            }, MemoView));
        }
        //#endregion
        exports.apply = apply;
        exports.inject = inject;
        exports.MemoView = MemoView;
        exports.configCardFor = configCardFor;
        exports.cards = { indexCard: indexCard, statusCard: statusCard, journalCard: journalCard, bugsCard: bugsCard };
        exports.switchCards = { commandsCard: commandsCard, readCard: readCard };
        // The remembered-config round trip, exposed because it is the one part of
        // this file with a shape on both sides of it: what is stored is a patch,
        // what the host reports is a catalogue, and a mix-up between the two is a
        // 400 on every mount.
        exports.switchConfig = { readStoredConfig: readStoredConfig, writeStoredConfig: writeStoredConfig, patchFor: patchFor, sameConfig: sameConfig, commandMap: commandMap, ask: ask };
        return module.exports;
    },
});
