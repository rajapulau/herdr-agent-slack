/**
 * PaneWatcher — turns the bridge did not start.
 *
 * The whole feature rests on one rule: a bound pane that is `working` and was
 * not on the previous tick has a turn under way that the chat is not
 * following. These tests pin the edges of that rule, because each of them,
 * got wrong, produces a visible failure in the chat: a missed answer, a
 * duplicate answer, or a burst of stale answers after a restart.
 *
 * Replay after a restart is not the watcher's problem any more. The
 * communicator seals the screen when a turn is adopted (see
 * `beginExternalTurn`), so a turn that was already closed cannot be sent
 * again; that is what lets the watcher adopt a pane found mid-turn.
 */
import { describe, expect, it, vi } from "vitest";
import { PaneWatcher } from "../../src/turn/pane-watcher.js";
import type { PaneInfo } from "../../src/types.js";

const pane = (paneId: string, status: PaneInfo["status"]): PaneInfo => ({
  pane_id: paneId,
  label: paneId,
  agent: "claude",
  tab_id: paneId,
  workspace_id: "w1",
  status,
});

/** A watcher whose pane list and bound set the test drives directly. */
function makeWatcher(opts: { bound?: string[]; accept?: boolean } = {}) {
  let panes: PaneInfo[] = [];
  let thrown: Error | null = null;
  const bound = new Set(opts.bound ?? []);
  const adopted: string[] = [];
  const logged: string[] = [];
  const live: Array<[string, boolean]> = [];
  const watcher = new PaneWatcher({
    listPanes: () => {
      if (thrown) throw thrown;
      return panes;
    },
    isBound: (paneId) => bound.has(paneId),
    onExternalTurn: (paneId) => {
      adopted.push(paneId);
      return opts.accept ?? true;
    },
    onBoundStatus: (paneId, working) => live.push([paneId, working]),
    logger: {
      info: (message) => logged.push(message),
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    // Never install a real timer: every tick in these tests is explicit.
    schedule: () => () => {},
  });
  return {
    watcher,
    adopted,
    logged,
    live,
    bound,
    see(next: PaneInfo[]) {
      panes = next;
      watcher.tick();
    },
    fail(err: Error) {
      thrown = err;
      watcher.tick();
      thrown = null;
    },
  };
}

describe("PaneWatcher", () => {
  it("adopts a bound pane that goes from idle to working", () => {
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    expect(env.adopted).toEqual([]);

    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1"]);
  });

  it("adopts a pane that was already working when first seen, once", () => {
    // A daemon restart finds panes mid-turn. Skipping them was the old rule,
    // written when restarts were rare; they happen on every reboot and every
    // rebuild, and each one lost whatever every bound pane was doing, with
    // no typing and no answer. The turn is adopted; the communicator's seal
    // keeps an already-closed turn from being sent again.
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "working")]);
    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1"]);
  });

  it("adopts once per turn, and again on the next one", () => {
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);
    env.see([pane("w1:p1", "working")]);
    env.see([pane("w1:p1", "working")]);
    expect(env.adopted).toEqual(["w1:p1"]);

    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1", "w1:p1"]);
  });

  it("ignores panes the bridge has nowhere to deliver to", () => {
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    env.see([pane("w1:p1", "working"), pane("w2:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1"]);
  });

  it("adopts a busy pane the moment it is bound", () => {
    // `/pair` on a pane mid-turn: the person pairing it wants that turn's
    // answer, not the next one's. The tick after binding is the pane's first
    // sight as a bound pane, and its turn is adopted then — once.
    const env = makeWatcher();
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);
    env.bound.add("w1:p1");
    env.see([pane("w1:p1", "working")]);
    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1"]);
  });

  it("forgets a pane's busy state while it is unbound", () => {
    // Unbind mid-turn, rebind mid-turn: the second binding is a first sight
    // again. The alternative — remembering it was busy — would make the
    // rebound pane's turn the one case that is never adopted.
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);
    env.bound.delete("w1:p1");
    env.see([pane("w1:p1", "working")]);
    env.bound.add("w1:p1");
    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1", "w1:p1"]);
  });

  it("keeps the last known status when herdr cannot be reached", () => {
    // Reading a failed call as "everything went idle" would make the next
    // successful tick report a transition for every busy pane at once.
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);
    expect(env.adopted).toEqual(["w1:p1"]);

    env.fail(new Error("herdr agent list exited 1"));
    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1"]);
  });

  it("treats a pane that left and came back busy as a turn to adopt", () => {
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    env.see([]);
    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1"]);
  });

  it("reports a terminal turn only when one was actually adopted", () => {
    // A pane goes busy a second or two after a chat message starts its turn.
    // The PaneAgent declines that one, and the log must not claim otherwise —
    // isolating terminal turns is the whole point of the line.
    const env = makeWatcher({ bound: ["w1:p1"], accept: false });
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1"]);
    expect(env.logged).toEqual([]);
  });

  it("reports the turns it did adopt", () => {
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);

    expect(env.logged).toEqual(["adopted a turn started in the pane"]);
  });

  it("treats herdr's sticky `done` as not working", () => {
    // `done` is a settled state — a finished turn nobody has looked at — and
    // panes hold it for minutes. Entering it must not read as a new turn, and
    // leaving it for `working` must.
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "done")]);
    env.see([pane("w1:p1", "done")]);
    expect(env.adopted).toEqual([]);

    env.see([pane("w1:p1", "working")]);

    expect(env.adopted).toEqual(["w1:p1"]);
  });

  it("reports a bound pane as live for as long as herdr says it is working", () => {
    // The whole point: this outlives the observe loop, so a turn past
    // `maxTurnMs` still shows an indicator.
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);
    env.see([pane("w1:p1", "working")]);

    expect(env.live).toEqual([
      ["w1:p1", false],
      ["w1:p1", true],
      ["w1:p1", true],
    ]);
  });

  it("reports herdr's reading unsmoothed", () => {
    // Deciding what a single not-working reading means belongs to the
    // consumer, which knows whether a loop is running; the watcher does not.
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle")]);
    env.see([pane("w1:p1", "working")]);
    env.see([pane("w1:p1", "done")]);

    expect(env.live).toEqual([
      ["w1:p1", false],
      ["w1:p1", true],
      ["w1:p1", false],
    ]);
  });

  it("reports a pane already busy when watching began as live", () => {
    // Its turn is adopted now, so the answer IS coming, and the indicator is
    // herdr's reading with nothing held back.
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "working")]);
    env.see([pane("w1:p1", "working")]);

    expect(env.live).toEqual([
      ["w1:p1", true],
      ["w1:p1", true],
    ]);
  });

  it("says nothing about panes the bridge is not bound to", () => {
    const env = makeWatcher({ bound: ["w1:p1"] });
    env.see([pane("w1:p1", "idle"), pane("w2:p1", "working")]);

    expect(env.live.map(([paneId]) => paneId)).toEqual(["w1:p1"]);
  });

  it("survives an adoption that throws and keeps watching", () => {
    const failing = vi.fn(() => {
      throw new Error("agent gone");
    });
    let panes: PaneInfo[] = [pane("w1:p1", "idle"), pane("w2:p1", "idle")];
    const watcher = new PaneWatcher({
      listPanes: () => panes,
      isBound: () => true,
      onExternalTurn: failing as unknown as (paneId: string) => boolean,
      schedule: () => () => {},
    });
    watcher.tick();
    panes = [pane("w1:p1", "working"), pane("w2:p1", "working")];
    watcher.tick();

    // The second pane is still offered even though the first one threw.
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("adopts on start() what is already under way, then keeps polling", () => {
    // The first tick is the restart case itself: whatever a bound pane is
    // doing when the daemon comes up is the turn most likely to be missed.
    const schedule = vi.fn(() => () => {});
    const adopted: string[] = [];
    const watcher = new PaneWatcher({
      listPanes: () => [pane("w1:p1", "working"), pane("w2:p1", "idle")],
      isBound: () => true,
      onExternalTurn: (paneId) => {
        adopted.push(paneId);
        return true;
      },
      schedule,
    });

    watcher.start();

    expect(adopted).toEqual(["w1:p1"]);
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
