import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeferredReader } from "../../src/readers/jsonl.js";
import { createAgentOutputReader } from "../../src/readers/registry.js";
import type { AgentSessionRef } from "../../src/agent-sessions.js";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe("DeferredReader — a log that is not there yet", () => {
  it("reads nothing until the pick succeeds, then delegates for good", () => {
    let picks = 0;
    let available = false;
    const reader = new DeferredReader("x-jsonl", true, () => {
      picks += 1;
      return available ? { kind: "x-jsonl", read: () => "said", lastPrompt: () => "asked", lastAnswer: () => "said" } : null;
    }, logger, "w1:p1");
    expect(reader.kind).toBe("x-jsonl");
    expect(reader.verbatim).toBe(true);
    expect(reader.read(10)).toBe("");
    expect(reader.lastPrompt()).toBe("");
    available = true;
    expect(reader.read(10)).toBe("said");
    expect(reader.lastAnswer()).toBe("said");
    const before = picks;
    reader.read(10);
    expect(picks).toBe(before); // picked once, kept
  });
});

describe("Codex pane that has no session yet", () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("waits for the session instead of settling for the screen", () => {
    let session: AgentSessionRef = undefined;
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "codex",
      session,
      resolveSession: () => session,
      readPane: () => "welcome banner",
      logger,
    });
    expect(reader.kind).toBe("codex-jsonl");
    expect(reader.read(100)).toBe("");
    // The first prompt: herdr learns the id, and the rollout appears.
    const id = `late-${Date.now()}`;
    const dir = join(home, ".codex", "sessions", "2026", "09", "14");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-${id}.jsonl`), JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "from rollout" }] },
    }) + "\n");
    session = { kind: "id", id };
    expect(reader.read(100)).toBe("from rollout");
  });

  it("still scrapes when nobody can ask herdr again", () => {
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "codex",
      session: undefined,
      readPane: () => "scraped",
      logger,
    });
    expect(reader.kind).toBe("scrape");
  });
});
