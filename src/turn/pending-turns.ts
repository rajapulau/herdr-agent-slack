/**
 * Turns started from the chat that have not been answered yet.
 *
 * A daemon that dies mid-turn takes its observe loop with it, and the answer
 * the user is waiting for is lost twice over: the loop that would have
 * delivered it is gone, and the replacement daemon deliberately ignores a pane
 * that is already working — the first-sight rule, which exists so a restart
 * does not replay whatever every pane happened to be doing.
 *
 * That rule cannot tell "a turn nobody in the chat is waiting for" from "the
 * turn the user asked for a minute ago". This log is what tells them apart:
 * one line per pane with a question outstanding, written when the turn starts
 * and removed when its answer goes out. Whatever survives a restart is a debt.
 *
 * It lives in its own file rather than in `state.json` because the PaneManager
 * owns that one and writes it from a snapshot it loaded earlier; a marker
 * written between its load and its save would be silently dropped. Nothing but
 * this log writes this file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logger.js";

/** One outstanding question, keyed by the pane that was asked. */
export interface PendingTurn {
  pane_id: string;
  /** ISO timestamp, so a turn can be judged too old to be worth resuming. */
  started_at: string;
}

export class PendingTurnLog {
  private readonly turns = new Map<string, string>();

  constructor(
    private readonly filePath: string,
    private readonly logger?: Logger,
  ) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PendingTurn[];
      for (const turn of parsed) {
        if (turn?.pane_id && turn.started_at) this.turns.set(turn.pane_id, turn.started_at);
      }
    } catch {
      // No file, or one written by a version that did not have this. Either
      // way there is nothing owed.
    }
  }

  /**
   * Record that a pane has been asked something. Idempotent per pane: a second
   * message during the same turn does not reset the clock, because the turn
   * the user is waiting on started with the first one.
   */
  open(paneId: string, startedAt = new Date()): void {
    if (this.turns.has(paneId)) return;
    this.turns.set(paneId, startedAt.toISOString());
    this.persist();
  }

  /** Whether a pane is owed an answer to a question asked through the chat. */
  isOpen(paneId: string): boolean {
    return this.turns.has(paneId);
  }

  /** The answer went out. Nothing is owed for this pane any more. */
  close(paneId: string): void {
    if (!this.turns.delete(paneId)) return;
    this.persist();
  }

  /**
   * Panes still owed an answer, oldest first, dropping anything older than
   * `maxAgeMs`. A question from yesterday is not worth answering into a chat
   * that has moved on, and the pane it names has almost certainly done several
   * other things since.
   */
  resumable(maxAgeMs: number, now = Date.now()): string[] {
    const fresh: Array<[string, number]> = [];
    let dropped = 0;
    for (const [paneId, startedAt] of this.turns) {
      const age = now - Date.parse(startedAt);
      // An unparseable or future timestamp is not evidence of anything; treat
      // it as stale rather than resuming on it.
      if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
        this.turns.delete(paneId);
        dropped += 1;
        continue;
      }
      fresh.push([paneId, age]);
    }
    if (dropped > 0) {
      this.persist();
      this.logger?.info("dropped stale pending turns", { count: dropped });
    }
    return fresh.sort((a, b) => b[1] - a[1]).map(([paneId]) => paneId);
  }

  private persist(): void {
    const entries: PendingTurn[] = [...this.turns].map(([pane_id, started_at]) => ({
      pane_id,
      started_at,
    }));
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(entries, null, 2), "utf8");
    } catch (err) {
      // Losing the log costs a late answer after a crash, which is strictly
      // better than failing the turn that is happening right now.
      this.logger?.warn("could not write the pending-turn log", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
