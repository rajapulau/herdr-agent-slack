import { describe, expect, it, vi } from "vitest";
import { AgentCommunicator, type AgentOutputReader } from "../src/agent-sessions.js";

// `sendInput` shells out to herdr; these tests only care that it records the
// prompt used to anchor the turn.
vi.mock("../src/herdr-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/herdr-client.js")>();
  return { ...actual, sendText: vi.fn() };
});

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Reader that always returns `snapshot`, tagged with the given kind. */
function fixedReader(kind: string, snapshot: string): AgentOutputReader {
  return { kind, read: () => snapshot };
}

describe("AgentCommunicator.getTurnResponse", () => {
  const screen = [
    "riwayat lama dari giliran sebelumnya",
    "● jawaban lama yang panjang sekali",
    "❯ halo",
    "● Halo! 👋",
    "Ada yang bisa aku bantu?",
    "✳ Baked for 2s · done 9:12 pm",
  ].join("\n");

  it("returns only the answer to the last submitted prompt", () => {
    const comm = new AgentCommunicator(fixedReader("scrape", screen), noopLogger, "w1:p1");
    comm.sendInput("halo");

    const response = comm.getTurnResponse();
    expect(response).toContain("Halo! 👋");
    expect(response).toContain("Ada yang bisa aku bantu?");
    // Everything above the prompt is earlier scrollback.
    expect(response).not.toContain("riwayat lama");
    expect(response).not.toContain("jawaban lama");
    // The trailing status line refreshes on its own and is not part of the answer.
    expect(response).not.toContain("Baked for 2s");
  });

  it("anchors on the prompt line, not on the agent echoing the same word", () => {
    // "❯ Halo" and "● Halo! 👋" both contain the prompt text; anchoring on the
    // echo would swallow the answer's first line.
    const echoing = ["❯ Halo", "● Halo! 👋", "Ada yang bisa aku bantu?"].join("\n");
    const comm = new AgentCommunicator(fixedReader("scrape", echoing), noopLogger, "w1:p1");
    comm.sendInput("Halo");

    expect(comm.getTurnResponse()).toContain("Halo! 👋");
  });

  it("returns nothing before any prompt has been submitted", () => {
    const comm = new AgentCommunicator(fixedReader("scrape", screen), noopLogger, "w1:p1");
    expect(comm.getTurnResponse()).toBe("");
  });

  it("returns nothing when the prompt is not on screen", () => {
    const comm = new AgentCommunicator(fixedReader("scrape", screen), noopLogger, "w1:p1");
    comm.sendInput("pertanyaan yang sudah tergulung ke atas");
    expect(comm.getTurnResponse()).toBe("");
  });

  it("declines to anchor for structured readers, which diff reliably", () => {
    // A JSONL/SQLite snapshot is cumulative ASSISTANT text — the prompt is not
    // in it, so the caller must stay on its diff-based path.
    for (const kind of ["pi-jsonl", "codex-jsonl", "opencode-db"]) {
      const comm = new AgentCommunicator(fixedReader(kind, screen), noopLogger, "w1:p1");
      comm.sendInput("halo");
      expect(comm.getTurnResponse()).toBe("");
    }
  });

  it("reads the screen's own last prompt for a turn started in the pane", () => {
    const comm = new AgentCommunicator(fixedReader("scrape", screen), noopLogger, "w1:p1");
    comm.beginExternalTurn();

    const response = comm.getTurnResponse();
    expect(response).toContain("Halo! 👋");
    expect(response).not.toContain("jawaban lama");
  });

  it("forgets a stale anchor when the next turn starts in the pane", () => {
    // Without the reset, `extractResponseSince` would find the OLD prompt,
    // bound its answer at the new one, and redeliver a turn already sent.
    const before = ["❯ pertanyaan lama", "● Jawaban lama."].join("\n");
    const after = [before, "❯ pertanyaan baru", "● Jawaban baru."].join("\n");
    let snapshot = before;
    const comm = new AgentCommunicator(
      { kind: "scrape", read: () => snapshot },
      noopLogger,
      "w1:p1",
    );
    comm.sendInput("pertanyaan lama");
    expect(comm.getTurnResponse()).toContain("Jawaban lama.");

    snapshot = after;
    comm.beginExternalTurn();

    expect(comm.getTurnResponse()).toContain("Jawaban baru.");
    expect(comm.getTurnResponse()).not.toContain("Jawaban lama.");
  });

  it("keeps declining to anchor a /follow window, which submits nothing", () => {
    // A follow loop also has no input, but it is not bounded by one turn, so
    // guessing an anchor there would deliver whatever question is last on screen.
    const comm = new AgentCommunicator(fixedReader("scrape", screen), noopLogger, "w1:p1");
    expect(comm.getTurnResponse()).toBe("");
  });

  it("does not consume diff state", () => {
    const comm = new AgentCommunicator(fixedReader("scrape", screen), noopLogger, "w1:p1");
    comm.sendInput("halo");
    comm.getTurnResponse();
    // The first getNewOutput is still the baseline seed — reading the turn
    // response must not have advanced it.
    expect(comm.getNewOutput()).toBe("");
  });
});

describe("AgentCommunicator.getLastAnswer", () => {
  const screen = [
    "❯ pertanyaan lama",
    "● Jawaban lama.",
    "❯ pertanyaan baru",
    "● Jawaban baru.",
    "✳ Baked for 2s · done 9:12 pm",
  ].join("\n");

  it("cuts the answer out of a screen scrape", () => {
    // `/last` used to hand back the trailing 3000 characters of the whole
    // scrollback, which began mid-sentence and mixed several turns.
    const comm = new AgentCommunicator(fixedReader("scrape", screen), noopLogger, "w1:p1");
    const answer = comm.getLastAnswer();
    expect(answer).toContain("Jawaban baru.");
    expect(answer).not.toContain("Jawaban lama.");
    expect(answer).not.toContain("Baked for 2s");
  });

  it("returns a structured reader's snapshot as-is", () => {
    // JSONL and SQLite readers already return assistant text and nothing else.
    const text = "cumulative assistant text with no prompt in it";
    for (const kind of ["pi-jsonl", "codex-jsonl", "opencode-db"]) {
      const comm = new AgentCommunicator(fixedReader(kind, text), noopLogger, "w1:p1");
      expect(comm.getLastAnswer()).toBe(text);
    }
  });

  it("falls back to the raw snapshot when no prompt is on screen", () => {
    const printing = "a pane that has only ever printed\nno prompt anywhere";
    const comm = new AgentCommunicator(fixedReader("scrape", printing), noopLogger, "w1:p1");
    expect(comm.getLastAnswer()).toBe(printing);
  });

  it("does not consume diff state", () => {
    const comm = new AgentCommunicator(fixedReader("scrape", screen), noopLogger, "w1:p1");
    comm.getLastAnswer();
    expect(comm.getNewOutput()).toBe("");
  });
});
