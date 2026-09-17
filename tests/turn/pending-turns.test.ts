/**
 * PendingTurnLog — the record of questions asked and not yet answered.
 *
 * It exists for one moment: the daemon dies mid-turn and comes back. Its
 * observe loop is gone, and the watcher's first-sight rule refuses to adopt a
 * pane that is already working — deliberately, so a restart does not replay
 * every pane. This log is what distinguishes the pane somebody is waiting on,
 * so the tests that matter are the ones about surviving a restart.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingTurnLog } from "../../src/turn/pending-turns.js";

function tempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pending-turns-"));
  return { path: join(dir, "pending-turns.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const HOUR = 60 * 60_000;

describe("PendingTurnLog", () => {
  it("survives the process that opened it", () => {
    const file = tempFile();
    const now = Date.now();
    new PendingTurnLog(file.path).open("w1:p1", new Date(now));

    // The restart: a brand-new log reading the same file.
    const reopened = new PendingTurnLog(file.path);

    expect(reopened.resumable(HOUR, now + 60_000)).toEqual(["w1:p1"]);
    file.cleanup();
  });

  it("forgets a pane once its answer has gone out", () => {
    const file = tempFile();
    const log = new PendingTurnLog(file.path);
    log.open("w1:p1");
    log.close("w1:p1");

    expect(new PendingTurnLog(file.path).resumable(HOUR)).toEqual([]);
    file.cleanup();
  });

  it("keeps the start of the turn the user is waiting on", () => {
    // A follow-up message during the same turn does not restart the clock:
    // the wait began with the first question.
    const file = tempFile();
    const log = new PendingTurnLog(file.path);
    const first = Date.now() - 30 * 60_000;
    log.open("w1:p1", new Date(first));
    log.open("w1:p1", new Date());

    const stored = JSON.parse(readFileSync(file.path, "utf8"));
    expect(stored).toHaveLength(1);
    expect(Date.parse(stored[0].started_at)).toBe(first);
    file.cleanup();
  });

  it("drops a question too old to be worth answering", () => {
    const file = tempFile();
    const now = Date.now();
    const log = new PendingTurnLog(file.path);
    log.open("fresh", new Date(now - 60_000));
    log.open("ancient", new Date(now - 5 * HOUR));

    expect(log.resumable(HOUR, now)).toEqual(["fresh"]);
    // And the drop is persisted, so it is not reconsidered on the next start.
    expect(new PendingTurnLog(file.path).resumable(10 * HOUR, now)).toEqual(["fresh"]);
    file.cleanup();
  });

  it("returns the longest wait first", () => {
    const file = tempFile();
    const now = Date.now();
    const log = new PendingTurnLog(file.path);
    log.open("recent", new Date(now - 60_000));
    log.open("older", new Date(now - 10 * 60_000));

    expect(log.resumable(HOUR, now)).toEqual(["older", "recent"]);
    file.cleanup();
  });

  it("treats an unusable timestamp as stale rather than resuming on it", () => {
    const file = tempFile();
    writeFileSync(
      file.path,
      JSON.stringify([
        { pane_id: "broken", started_at: "not a date" },
        { pane_id: "future", started_at: new Date(Date.now() + HOUR).toISOString() },
      ]),
      "utf8",
    );

    expect(new PendingTurnLog(file.path).resumable(HOUR)).toEqual([]);
    file.cleanup();
  });

  it("starts empty when there is no file, or an unreadable one", () => {
    const file = tempFile();
    expect(new PendingTurnLog(file.path).resumable(HOUR)).toEqual([]);
    writeFileSync(file.path, "{ not json", "utf8");
    expect(new PendingTurnLog(file.path).resumable(HOUR)).toEqual([]);
    file.cleanup();
  });
});
