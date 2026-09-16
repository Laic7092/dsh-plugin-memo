import test from "node:test";
import assert from "node:assert/strict";

import { createReadTracker, isDuplicate, readRecord, readTarget, windowKey } from "../src/reads.ts";

const stat = (mtimeMs, size) => ({ mtimeMs, size, isFile: true });

test("readTarget recognizes a read call and its window", () => {
  assert.deepEqual(readTarget("read", { file_path: "/a/b.ts" }), { path: "/a/b.ts", offset: null, limit: null });
  assert.deepEqual(readTarget("read", { path: "src/a.ts", offset: 10, limit: 20 }), { path: "src/a.ts", offset: 10, limit: 20 });
  assert.deepEqual(readTarget("read", { file: "a.ts" }), { path: "a.ts", offset: null, limit: null });

  // Anything that is not a read, or carries no path, is not our business.
  assert.equal(readTarget("bash", { command: "cat a.ts" }), null);
  assert.equal(readTarget("read", { offset: 1 }), null);
  assert.equal(readTarget("read", {}), null);
  assert.equal(readTarget("read", { file_path: "   " }), null);
  assert.equal(readTarget("read", null), null);
  // A configured tool set is honoured.
  assert.equal(readTarget("read", { file_path: "a.ts" }, ["view"]), null);
  assert.equal(readTarget("view", { file_path: "a.ts" }, ["view"]).path, "a.ts");
});

test("only the same window of the same unchanged file is a duplicate", () => {
  const target = { path: "/a/b.ts", offset: null, limit: null };
  const record = readRecord(target, stat(1000, 500), "t0");

  assert.equal(isDuplicate(record, target, stat(1000, 500)), true);
  // The file was edited since: re-reading is legitimate.
  assert.equal(isDuplicate(record, target, stat(2000, 500)), false);
  assert.equal(isDuplicate(record, target, stat(1000, 501)), false);
  // A different window is always allowed.
  assert.equal(isDuplicate(record, { path: "/a/b.ts", offset: 40, limit: 10 }, stat(1000, 500)), false);
  assert.equal(isDuplicate(readRecord({ path: "/a/b.ts", offset: 0, limit: 50 }, stat(1, 2), "t"), { path: "/a/b.ts", offset: 0, limit: 50 }, stat(1, 2)), true);
  // Nothing known about the file: do not block.
  assert.equal(isDuplicate(record, target, null), false);
  assert.equal(isDuplicate(undefined, target, stat(1000, 500)), false);
  assert.equal(isDuplicate(record, null, stat(1000, 500)), false);
});

test("the tracker is per session, bounded, and cleared on demand", () => {
  const tracker = createReadTracker({ maxSessions: 2 });
  const target = { path: "/a/b.ts", offset: null, limit: null };
  const unchanged = stat(1000, 500);

  assert.equal(tracker.check("s1", target, unchanged), null, "nothing recorded yet");
  tracker.remember("s1", target, unchanged, "t0");
  const reason = tracker.check("s1", target, unchanged);
  assert.match(reason, /already read in this session/);
  assert.match(reason, /different offset\/limit/, "the refusal carries the escape hatch");

  // Another session has its own memory.
  assert.equal(tracker.check("s2", target, unchanged), null);

  tracker.clear("s1");
  assert.equal(tracker.check("s1", target, unchanged), null);

  // The bound drops the oldest session rather than growing forever.
  tracker.remember("a", target, unchanged, "t");
  tracker.remember("b", target, unchanged, "t");
  tracker.remember("c", target, unchanged, "t");
  assert.equal(tracker.sessionCount(), 2);
  assert.equal(tracker.check("a", target, unchanged), null);
  assert.notEqual(tracker.check("c", target, unchanged), null);
});

test("a window key distinguishes ranges, and 'no offset' from offset 0", () => {
  assert.notEqual(windowKey({ path: "a.ts", offset: null, limit: null }), windowKey({ path: "a.ts", offset: 0, limit: null }));
  assert.notEqual(windowKey({ path: "a.ts", offset: 10, limit: 20 }), windowKey({ path: "a.ts", offset: 10, limit: 30 }));
  assert.notEqual(windowKey({ path: "a.ts", offset: 10, limit: 20 }), windowKey({ path: "b.ts", offset: 10, limit: 20 }));
  // The null byte keeps a path that ends in the separator from aliasing.
  assert.notEqual(windowKey({ path: "a", offset: 1, limit: 2 }), windowKey({ path: "a\u00001:2", offset: null, limit: null }));
});

test("a second window of the same file does not erase the first", () => {
  const tracker = createReadTracker();
  const unchanged = stat(1000, 500);
  const first = { path: "/a/b.ts", offset: 0, limit: 50 };
  const second = { path: "/a/b.ts", offset: 200, limit: 50 };

  tracker.remember("s1", first, unchanged, "t0");
  // Reading a different window of the same file must not drop the first record:
  // A -> B -> A is exactly the pattern this guard exists to catch.
  tracker.remember("s1", second, unchanged, "t1");
  assert.match(tracker.check("s1", first, unchanged), /already read in this session/);
  assert.match(tracker.check("s1", second, unchanged), /already read in this session/);
  assert.equal(tracker.windowCount("s1"), 2);

  // A whole-file read is its own window and does not shadow the anchored ones.
  const whole = { path: "/a/b.ts", offset: null, limit: null };
  tracker.remember("s1", whole, unchanged, "t2");
  assert.notEqual(tracker.check("s1", whole, unchanged), null);
  assert.notEqual(tracker.check("s1", first, unchanged), null, "the anchored window is still remembered");

  // An edit still lets the same window through.
  assert.equal(tracker.check("s1", first, stat(2000, 500)), null);
});

test("windows are bounded within one session, oldest evicted first", () => {
  const tracker = createReadTracker({ maxWindows: 3 });
  const unchanged = stat(1, 1);
  const window = (offset) => ({ path: "/a.ts", offset, limit: 10 });

  tracker.remember("s", window(0), unchanged, "t");
  tracker.remember("s", window(10), unchanged, "t");
  tracker.remember("s", window(20), unchanged, "t");
  tracker.remember("s", window(30), unchanged, "t");

  assert.equal(tracker.windowCount("s"), 3);
  assert.equal(tracker.check("s", window(0), unchanged), null, "the oldest window was evicted");
  assert.notEqual(tracker.check("s", window(30), unchanged), null);

  // Re-remembering a live window refreshes it instead of growing the map.
  tracker.remember("s", window(30), unchanged, "t");
  assert.equal(tracker.windowCount("s"), 3);
});
