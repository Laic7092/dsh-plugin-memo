/**
 * STATUS.md — the one file a session reads first.
 *
 * It is plain markdown with `##` sections, which makes it both comfortable to
 * read by hand and cheap to patch by hand: `patchStatus` rewrites only the
 * sections it is given, so a note someone typed between two sections survives,
 * and a field the caller left empty is left alone rather than blanked.
 *
 * @module dsh-plugin-memo/status
 */
import { readText, isFile, stamp, writeTextAtomic } from "./store.js";
export const STATUS_SECTIONS = ["现在在哪", "下一步", "未决问题", "不要重犯"];
const UPDATED = /^_最后更新：.*_$/m;
const HEADING = /^##\s+(.*\S)\s*$/;
export function statusTemplate(projectName, at = stamp()) {
    const lines = [
        `# STATUS — ${projectName}`,
        "",
        "> 单一事实来源：接手先读这里，一个阶段结束时用 `memo handoff` 覆写下面四节。",
        "",
        `_最后更新：${at}_`,
    ];
    for (const title of STATUS_SECTIONS)
        lines.push("", `## ${title}`, "");
    return `${lines.join("\n")}\n`;
}
/** Split into the preamble (everything before the first `##`) and the sections. */
export function parseStatus(text) {
    const preamble = [];
    const sections = [];
    let current = null;
    for (const line of String(text ?? "").split("\n")) {
        const heading = HEADING.exec(line);
        if (heading) {
            current = { title: heading[1], body: [] };
            sections.push(current);
            continue;
        }
        if (current === null)
            preamble.push(line);
        else
            current.body.push(line);
    }
    return { preamble: preamble.join("\n"), sections };
}
export function renderStatus(preamble, sections) {
    const parts = [preamble.replace(/\s+$/, "")];
    for (const section of sections) {
        parts.push("", `## ${section.title}`, "", String(section.body ?? "").trim());
    }
    return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")}\n`;
}
function withUpdated(preamble, at) {
    if (UPDATED.test(preamble))
        return preamble.replace(UPDATED, `_最后更新：${at}_`);
    return `${preamble.replace(/\s+$/, "")}\n\n_最后更新：${at}_`;
}
/**
 * Rewrite the sections named in `updates` (title -> body). An empty or missing
 * body leaves that section exactly as it was.
 */
export function patchStatus(text, projectName, updates, at = stamp()) {
    const source = typeof text === "string" && text.trim().length > 0 ? text : statusTemplate(projectName, at);
    const parsed = parseStatus(source);
    const sections = parsed.sections.map((section) => ({ title: section.title, body: section.body.join("\n") }));
    for (const [title, body] of Object.entries(updates)) {
        if (typeof body !== "string" || body.trim().length === 0)
            continue;
        const existing = sections.find((section) => section.title === title);
        if (existing)
            existing.body = body.trim();
        else
            sections.push({ title, body: body.trim() });
    }
    return renderStatus(withUpdated(parsed.preamble, at), sections);
}
export function readStatus(paths) {
    if (!isFile(paths.status))
        return { present: false, text: "", sections: [], updated: null, error: null };
    const file = readText(paths.status);
    if (!file.ok)
        return { present: false, text: "", sections: [], updated: null, error: file.error };
    const parsed = parseStatus(file.text);
    const updated = /^_最后更新：(.*)_$/m.exec(file.text);
    return {
        present: true,
        text: file.text,
        sections: parsed.sections.map((section) => ({ title: section.title, body: section.body.join("\n").trim() })),
        updated: updated ? updated[1].trim() : null,
        error: null,
    };
}
export function writeStatus(paths, text) {
    return writeTextAtomic(paths.status, text);
}
/** `## 现在在哪` -> its body, or null when the section is absent or empty. */
export function sectionBody(status, title) {
    const found = status.sections.find((section) => section.title === title);
    return found && found.body.length > 0 ? found.body : null;
}
