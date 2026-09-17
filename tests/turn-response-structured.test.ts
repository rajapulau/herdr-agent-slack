import { describe, expect, it, vi } from "vitest";
import { AgentCommunicator, type AgentOutputReader } from "../src/agent-sessions.js";

vi.mock("../src/herdr-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/herdr-client.js")>();
  return { ...actual, sendText: vi.fn() };
});

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A transcript-backed reader, as `ClaudeJsonlReader` presents itself. */
function transcript(state: { prompt: string; answer: string; all: string }): AgentOutputReader {
  return {
    kind: "claude-jsonl",
    verbatim: true,
    read: () => state.all,
    lastPrompt: () => state.prompt,
    lastAnswer: () => state.answer,
  };
}

describe("AgentCommunicator with a reader that logs the prompts", () => {
  it("answers a question the bridge typed with everything logged after it", () => {
    const state = { prompt: "halo", answer: "Halo! 👋", all: "jawaban lama\n\nHalo! 👋" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    comm.sendInput("halo");
    expect(comm.getTurnResponse()).toBe("Halo! 👋");
  });

  it("quotes a question typed in the terminal, and answers it from the log", () => {
    const state = { prompt: "lama", answer: "jawaban lama", all: "jawaban lama" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    comm.sealAnsweredPrompt();
    // Somebody types into the pane.
    state.prompt = "baru";
    state.answer = "jawaban baru";
    state.all = "jawaban lama\n\njawaban baru";
    comm.beginExternalTurn();
    expect(comm.getPendingPrompt()).toBe("baru");
    expect(comm.getTurnPrompt()).toBe("baru");
    expect(comm.getTurnResponse()).toBe("jawaban baru");
  });

  it("does not announce the sealed question when the agent wakes on its own", () => {
    const state = { prompt: "lama", answer: "jawaban lama", all: "jawaban lama" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    comm.sealAnsweredPrompt();
    // A task notification: the agent continues under the same question.
    state.answer = "jawaban lama\n\nlanjutan";
    state.all = state.answer;
    comm.beginExternalTurn();
    expect(comm.getPendingPrompt()).toBe("");
    // Nothing anchors the turn, so the caller stays on the diff path rather
    // than resending the old answer.
    expect(comm.getTurnResponse()).toBe("");
  });

  it("does not announce the bridge's own question as typed in the terminal", () => {
    const state = { prompt: "", answer: "", all: "" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    comm.sendInput("dari slack");
    state.prompt = "dari slack";
    state.answer = "ok";
    state.all = "ok";
    comm.markDelivered("");
    comm.beginExternalTurn();
    expect(comm.getPendingPrompt()).toBe("");
  });

  it("does not quote the bridge's question again when the agent continues under it", () => {
    const state = { prompt: "", answer: "", all: "" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    comm.sendInput("sudah selesai?");
    state.prompt = "sudah selesai?";
    state.answer = "belum";
    state.all = "belum";
    comm.markDelivered("");
    // A poller wakes the agent; nobody typed anything new.
    state.answer = "belum\n\nsekarang sudah";
    state.all = state.answer;
    comm.beginExternalTurn();
    expect(comm.getTurnPrompt()).toBe("");
    comm.markDelivered("");
    // And not on the wake-up after that either: the memory survives a turn
    // that had no question of its own.
    comm.beginExternalTurn();
    expect(comm.getTurnPrompt()).toBe("");
    // A genuinely new question is quoted.
    state.prompt = "commit sekarang";
    expect(comm.getTurnPrompt()).toBe("commit sekarang");
  });

  it("does not announce a question it sent that the log never logged as a prompt", () => {
    // Sent while the pane was busy: Claude Code absorbs it into the running
    // turn, so the log's last prompt stays the one before it.
    const state = { prompt: "", answer: "", all: "" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    comm.sendInput("salah mention");
    state.prompt = "salah mention";
    state.answer = "diperbaiki";
    state.all = state.answer;
    comm.markDelivered("");
    comm.sendInput("ulangi handoff ke lilith"); // absorbed: state.prompt stays
    state.answer = "diperbaiki\n\nhandoff dikirim";
    state.all = state.answer;
    comm.markDelivered("");
    // A monitor wakes the pane. The log's last prompt is "salah mention".
    comm.beginExternalTurn();
    expect(comm.getPendingPrompt()).toBe("");
    expect(comm.getTurnPrompt()).toBe("");
  });

  it("knows an answered question is old, even on a pane found working", () => {
    // A restart while a monitor has the pane working again: the log's last
    // question already has its answer, so it is nobody's new question.
    const state = { prompt: "salah mention", answer: "diperbaiki", all: "diperbaiki" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    expect(comm.lastPromptAnswered()).toBe(true);
    comm.sealAnsweredPrompt();
    comm.beginExternalTurn();
    expect(comm.getPendingPrompt()).toBe("");
    // Whereas a question with no answer yet is genuinely pending.
    const pending = new AgentCommunicator(transcript({ prompt: "baru", answer: "", all: "" }), noopLogger, "w1:p2");
    expect(pending.lastPromptAnswered()).toBe(false);
  });

  it("reads the last answer from the log, not the whole log", () => {
    const state = { prompt: "kedua", answer: "jawaban kedua", all: "jawaban pertama\n\njawaban kedua" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    expect(comm.getLastAnswer()).toBe("jawaban kedua");
    expect(comm.verbatim).toBe(true);
  });

  it("treats everything after an empty baseline as new", () => {
    // A session so new its log did not exist when the communicator was
    // seeded. The diff path used to stay dead for the whole session.
    const state = { prompt: "", answer: "", all: "" };
    const comm = new AgentCommunicator(transcript(state), noopLogger, "w1:p1");
    expect(comm.getNewOutput()).toBe(""); // seed on nothing
    state.all = "jawaban pertama";
    expect(comm.getNewOutput()).toBe("jawaban pertama");
    state.all = "jawaban pertama\n\njawaban kedua";
    expect(comm.getNewOutput()).toBe("jawaban kedua");
    expect(comm.getNewOutput()).toBe("");
  });

  it("leaves a reader without prompts on the diff path", () => {
    const plain: AgentOutputReader = { kind: "pi-jsonl", read: () => "semua teks" };
    const comm = new AgentCommunicator(plain, noopLogger, "w1:p1");
    comm.sendInput("x");
    expect(comm.getTurnResponse()).toBe("");
    expect(comm.getTurnPrompt()).toBe("x");
    expect(comm.getLastAnswer()).toBe("semua teks");
    expect(comm.verbatim).toBe(false);
  });
});
