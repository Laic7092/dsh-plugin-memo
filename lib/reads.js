/**
 * Repeated-read detection.
 *
 * OpenWolf's interception has two halves. "Condense oversized output, keep the
 * full text on disk, hand back a pointer" is already what a spill/dedup plugin
 * does in this harness, so re-implementing it here would be duplication. The
 * other half — "the agent rereads a file it already saw" — is not covered, and
 * that is what this module is.
 *
 * The policy is deliberately narrow. A read is a duplicate only when the *same
 * window of the same unchanged file* was already read successfully in this
 * session: a different range is always allowed, and so is the same range once
 * the file has been written (mtime or size moved). That keeps the guard out of
 * the way of legitimate work while still catching "cat it again because I
 * forgot".
 *
 * @module dsh-plugin-memo/reads
 */
export const DEFAULT_READ_TOOLS = ["read"];
const PATH_KEYS = ["file_path", "path", "file", "filename"];
/** The file, offset and limit a read-style call is asking for, or null. */
export function readTarget(toolName, args, readTools = DEFAULT_READ_TOOLS) {
    if (!readTools.includes(toolName))
        return null;
    if (!args || typeof args !== "object")
        return null;
    let path = null;
    for (const key of PATH_KEYS) {
        if (typeof args[key] === "string" && args[key].trim().length > 0) {
            path = args[key].trim();
            break;
        }
    }
    if (path === null)
        return null;
    const offset = Number.isFinite(args.offset) ? args.offset : null;
    const limit = Number.isFinite(args.limit) ? args.limit : null;
    return { path, offset, limit };
}
/**
 * The identity of one window: the same path read at a different offset or
 * limit is a different window and gets its own memory. Offsets are kept
 * distinct from "no offset given" (`""`), so a whole-file read never collides
 * with an anchored one.
 */
export function windowKey(target) {
    return `${target.path}\u0000${target.offset ?? ""}:${target.limit ?? ""}`;
}
/** A record of what a successful read actually returned. */
export function readRecord(target, stat, at) {
    return {
        path: target.path,
        offset: target.offset,
        limit: target.limit,
        mtimeMs: stat ? stat.mtimeMs : null,
        size: stat ? stat.size : null,
        at,
    };
}
/**
 * True when this request asks for exactly what an earlier read already
 * returned, from a file that has not changed since.
 */
export function isDuplicate(record, target, stat) {
    if (!record || !target)
        return false;
    if (record.path !== target.path)
        return false;
    if (record.offset !== target.offset || record.limit !== target.limit)
        return false;
    if (stat === null || stat === undefined)
        return false;
    return record.mtimeMs === stat.mtimeMs && record.size === stat.size;
}
/** The model-facing refusal, carrying the escape hatches so it is never a dead end. */
export function duplicateReason(record, target, stat) {
    const window = target.offset === null && target.limit === null
        ? "the whole file"
        : `offset ${target.offset ?? 0}${target.limit === null ? "" : `, limit ${target.limit}`}`;
    return [
        `read blocked: ${target.path} (${window}) was already read in this session and has not changed since`,
        `(same ${stat.size} bytes, same mtime). Use what you already have instead of paying for it twice.`,
        "A different range is always allowed — pass a different offset/limit.",
        "If the content is no longer in your context (for example after a compaction), say so and pass an explicit offset/limit to re-read it.",
    ].join(" ");
}
/**
 * Per-session memory of what was read. Bounded twice over: the oldest sessions
 * are dropped once `maxSessions` are live, and within one session the oldest
 * windows are dropped once `maxWindows` are live — this is a cache, not a
 * record.
 *
 * Windows, not files, are the unit. Keying by path alone means reading a
 * second window of a file erases the first, so the A→B→A pattern this guard
 * exists to catch slips straight through; that was a real bug.
 */
export function createReadTracker(options = {}) {
    const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : 64;
    const maxWindows = Number.isFinite(options.maxWindows) ? options.maxWindows : 256;
    const sessions = new Map();
    function bucket(key) {
        let found = sessions.get(key);
        if (found === undefined) {
            found = new Map();
            sessions.set(key, found);
        }
        sessions.delete(key);
        sessions.set(key, found);
        while (sessions.size > maxSessions) {
            const oldest = sessions.keys().next().value;
            sessions.delete(oldest);
        }
        return found;
    }
    return {
        /** Record a read that actually succeeded. */
        remember(key, target, stat, at) {
            const found = bucket(key);
            const id = windowKey(target);
            // Re-insert so the newest window is the last to be evicted.
            found.delete(id);
            found.set(id, readRecord(target, stat, at));
            while (found.size > maxWindows) {
                found.delete(found.keys().next().value);
            }
        },
        /** The refusal for a duplicate read, or null when the read should proceed. */
        check(key, target, stat) {
            const found = sessions.get(key);
            if (found === undefined)
                return null;
            const record = found.get(windowKey(target));
            return isDuplicate(record, target, stat) ? duplicateReason(record, target, stat) : null;
        },
        /** Forget one session — a compaction can drop the content this guard assumes is still there. */
        clear(key) {
            sessions.delete(key);
        },
        sessionCount() {
            return sessions.size;
        },
        /** Live window count for one session — the bound's observable. */
        windowCount(key) {
            const found = sessions.get(key);
            return found === undefined ? 0 : found.size;
        },
    };
}
