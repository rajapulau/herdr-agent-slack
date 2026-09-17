/**
 * PaneWatcher — notice turns the bridge did not start.
 *
 * Until this existed, a pane only reached the chat when the conversation began
 * there: `handleMessage` sent the input and attached the observe loop in the
 * same breath. Type the same question into the terminal instead and the answer
 * stayed in the terminal, so following one agent across both surfaces meant
 * reading both.
 *
 * The watcher closes that gap with the one signal herdr already publishes:
 * `agent_status`. A bound pane that goes from anything else to `working` has
 * started a turn somebody else asked for, and `onExternalTurn` hands it to the
 * PaneAgent, which attaches a loop without sending input. Delivery from there
 * is the ordinary path — the same final event, the same formatting, the same
 * one-answer-per-turn rule.
 *
 * One rule: a bound pane that is working now and was not on the previous
 * tick has a turn the chat is not following. That includes a pane found
 * mid-turn — the daemon has just started, the pane has just appeared, or it
 * has just been bound. An earlier rule skipped those, so that a restart would
 * not replay whatever every pane happened to be doing. It was written when
 * restarts were rare. They happen on every reboot and every rebuild, and the
 * bridge was once down for a day; each time, every bound pane's turn in
 * flight was lost — no indicator, no answer. Replay is prevented where the
 * knowledge is: the communicator seals the screen when a turn is adopted
 * (`beginExternalTurn`), and a turn already closed at that moment is never
 * sent. With that in place, skipping bought nothing.
 *
 * Only bound panes are tracked. An unbound pane's status is not remembered,
 * so binding one mid-turn is a first sight, and its turn is adopted then.
 *
 * A turn shorter than the poll interval is missed entirely: it begins and ends
 * between two ticks and no transition is ever observed. That is the cost of
 * polling, and the reason the interval is seconds rather than the reconcile
 * loop's minutes.
 *
 * The same poll also feeds the chat's liveness indicator through
 * `onBoundStatus`, which is why it lives here rather than in the observe loop:
 * a turn longer than `maxTurnMs` outlives its loop, and an indicator tied to
 * the loop went dark while the agent was plainly still working.
 */
import type { Logger } from "../logger.js";
import type { PaneInfo } from "../types.js";

/**
 * How often to ask herdr what the panes are doing. One `getAgents()` call per
 * tick, which is two short-lived herdr processes — cheap enough for seconds,
 * not cheap enough for sub-second.
 */
export const DEFAULT_WATCH_INTERVAL_MS = 5_000;

export interface PaneWatcherDeps {
  /** Every pane herdr currently reports. Called once per tick. */
  listPanes: () => PaneInfo[];
  /** Whether the bridge has somewhere to deliver this pane's answers. */
  isBound: (paneId: string) => boolean;
  /**
   * Adopt a turn that started in the pane itself. Returns whether it was
   * actually adopted: a pane already being followed — because the turn was
   * started from the chat a second earlier — declines, and that is not worth
   * reporting as a terminal turn.
   */
  onExternalTurn: (paneId: string) => boolean;
  /**
   * What herdr says a bound pane is doing, once per tick. Drives the chat's
   * liveness indicator.
   *
   * Reported here rather than from the observe loop because the two do not
   * have the same lifetime: a turn longer than `maxTurnMs` outlives its loop,
   * and an indicator tied to the loop went dark while the agent was plainly
   * still working. herdr's status is the honest source.
   *
   * This is herdr's reading, unsmoothed. herdr takes a moment to
   * report a pane busy after input reaches it, so a turn just sent from the
   * chat reads as not-working for up to one tick; deciding what to do about
   * that belongs to the consumer, which knows whether a loop is running.
   */
  onBoundStatus?: (paneId: string, working: boolean) => void;
  /** Poll cadence. Defaults to DEFAULT_WATCH_INTERVAL_MS. */
  intervalMs?: number;
  logger?: Logger;
  /** Test seam: install a repeating timer, return its canceller. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  // Node keeps the process alive for a referenced interval. The bridge's own
  // transport already holds the loop open, and a watcher that outlived it
  // would keep a stopped daemon running.
  timer.unref?.();
  return () => clearInterval(timer);
};

export class PaneWatcher {
  /**
   * Bound panes reported `working` on the previous tick. A pane leaves this
   * set when it goes quiet, disappears, or is unbound — so the next time it
   * is seen bound and busy, that is a turn to adopt.
   */
  private readonly busy = new Set<string>();
  private cancel?: () => void;

  constructor(private readonly deps: PaneWatcherDeps) {}

  /**
   * Begin polling. The first tick runs immediately, and adopts whatever bound
   * panes are already working: that is the restart case, and the turn most
   * likely to be lost.
   */
  start(): void {
    if (this.cancel) return;
    this.tick();
    this.cancel = (this.deps.schedule ?? defaultSchedule)(
      () => this.tick(),
      this.deps.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
    );
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  /**
   * One pass. Public so tests can drive it without a timer.
   *
   * herdr being unreachable is not fatal — the next tick tries again — but it
   * must not be mistaken for "every pane went idle", which would turn the
   * following tick's recovery into a burst of spurious transitions. The
   * previous status is therefore left untouched on failure.
   */
  tick(): void {
    let panes: PaneInfo[];
    try {
      panes = this.deps.listPanes();
    } catch (err) {
      this.deps.logger?.warn("pane watcher: could not list panes", {
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const present = new Set<string>();
    for (const pane of panes) {
      present.add(pane.pane_id);
      if (!this.deps.isBound(pane.pane_id)) {
        // Not followed, and not remembered: if it is bound later mid-turn,
        // that tick is its first sight and the turn is adopted then.
        this.busy.delete(pane.pane_id);
        continue;
      }
      const working = pane.status === "working";
      const wasBusy = this.busy.has(pane.pane_id);
      if (working) this.busy.add(pane.pane_id);
      else this.busy.delete(pane.pane_id);
      this.deps.onBoundStatus?.(pane.pane_id, working);
      // Adoption turns on the transition, not on being busy: a pane that
      // stays busy across ticks is one turn, and `noteExternalTurn` would have
      // to decline every repeat.
      if (!working || wasBusy) continue;
      // Log AFTER the decision, not before it. A pane goes busy a second or
      // two after a chat message starts its turn, so logging on the raw
      // transition reported a terminal turn for every question asked from
      // Telegram — which is exactly the signal this line exists to isolate.
      try {
        if (this.deps.onExternalTurn(pane.pane_id)) {
          this.deps.logger?.info("adopted a turn started in the pane", {
            paneId: pane.pane_id,
            label: pane.label,
          });
        }
      } catch (err) {
        this.deps.logger?.error("pane watcher: adopting a turn failed", {
          paneId: pane.pane_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // A pane that has gone comes back as a first sighting.
    for (const paneId of [...this.busy]) {
      if (!present.has(paneId)) this.busy.delete(paneId);
    }
  }
}
