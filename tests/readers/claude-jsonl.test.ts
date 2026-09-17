import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeJsonlReader } from "../../src/readers/jsonl.js";
import { createAgentOutputReader } from "../../src/readers/registry.js";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** One transcript line the way Claude Code writes it. */
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks }, ...extra });
const text = (t: string) => ({ type: "text", text: t });

describe("ClaudeJsonlReader", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claude-reader-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (lines: string[]): ClaudeJsonlReader => {
    const path = join(dir, "session.jsonl");
    writeFileSync(path, lines.join("\n") + "\n", "utf8");
    return new ClaudeJsonlReader(() => path, logger, "w1:p1");
  };

  it("is the model's own Markdown, so it is delivered verbatim", () => {
    const reader = write([assistant([text("**tebal** dan `kode`\n\n```ts\nconst x = 1;\n```")])]);
    expect(reader.verbatim).toBe(true);
    expect(reader.read(100)).toBe("**tebal** dan `kode`\n\n```ts\nconst x = 1;\n```");
  });

  it("keeps only text blocks: thinking and tool calls share the message", () => {
    const reader = write([
      user("halo"),
      assistant([{ type: "thinking", thinking: "hmm" }]),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }]),
      assistant([text("Ada satu file.")]),
    ]);
    expect(reader.read(100)).toBe("Ada satu file.");
  });

  it("leaves a subagent's traffic out", () => {
    const reader = write([
      assistant([text("dari subagent")], { isSidechain: true }),
      assistant([text("jawaban utama")]),
    ]);
    expect(reader.read(100)).toBe("jawaban utama");
  });

  it("cuts the last answer at the last thing the user typed", () => {
    const reader = write([
      user("pertama"),
      assistant([text("jawaban pertama")]),
      user("kedua"),
      assistant([text("bagian satu")]),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "…" }]),
      assistant([text("bagian dua")]),
    ]);
    expect(reader.lastPrompt()).toBe("kedua");
    expect(reader.lastAnswer()).toBe("bagian satu\n\nbagian dua");
    expect(reader.read(100)).toBe("jawaban pertama\n\nbagian satu\n\nbagian dua");
  });

  it("does not mistake what Claude Code logs as the user for a question", () => {
    const reader = write([
      user("pertanyaan asli"),
      assistant([text("jawaban")]),
      // Slash-command expansion, shell passthrough, an interruption, a task
      // notification and a skill's injected prompt all arrive as `user`.
      user("<command-name>/compact</command-name>"),
      user("<local-command-stdout>Compacted</local-command-stdout>"),
      user("<bash-input>git status</bash-input>"),
      user("[Request interrupted by user for tool use]"),
      user("<task-notification>done</task-notification>"),
      user("# /skill — instructions", { isMeta: true }),
      user([{ type: "tool_result", tool_use_id: "t1", content: "x" }]),
    ]);
    expect(reader.lastPrompt()).toBe("pertanyaan asli");
    expect(reader.lastAnswer()).toBe("jawaban");
  });

  it("counts a bridge prompt, which starts with a bracket, as a prompt", () => {
    const reader = write([
      user("pertama"),
      assistant([text("jawaban pertama")]),
      user("[Slack bridge: you are shaka…]\n\nkedua"),
      assistant([text("jawaban kedua")]),
      user("[Request interrupted by user]"),
    ]);
    expect(reader.lastPrompt()).toBe("[Slack bridge: you are shaka…]\n\nkedua");
    expect(reader.lastAnswer()).toBe("jawaban kedua");
  });

  it("reads a prompt sent as a text block", () => {
    const reader = write([user([text("dari blok")]), assistant([text("ok")])]);
    expect(reader.lastPrompt()).toBe("dari blok");
  });

  it("tolerates malformed lines and an empty log", () => {
    const reader = write(["{not json", assistant([text("tetap terbaca")]), ""]);
    expect(reader.read(100)).toBe("tetap terbaca");
    const empty = new ClaudeJsonlReader(() => join(dir, "missing.jsonl"), logger, "w1:p1");
    expect(empty.read(100)).toBe("");
    expect(empty.lastPrompt()).toBe("");
    expect(empty.lastAnswer()).toBe("");
  });

  it("keeps looking for a transcript that does not exist yet", () => {
    // A fresh session writes its file with the first prompt, after the
    // reader was chosen.
    const path = join(dir, "later.jsonl");
    let exists = false;
    const reader = new ClaudeJsonlReader(() => (exists ? path : null), logger, "w1:p1");
    expect(reader.read(100)).toBe("");
    writeFileSync(path, user("halo") + "\n" + assistant([text("Halo!")]) + "\n", "utf8");
    exists = true;
    expect(reader.read(100)).toBe("Halo!");
    expect(reader.lastPrompt()).toBe("halo");
  });
});

describe("Claude reader selection", () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "claude-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("selects claude-jsonl for an id session whose transcript is under ~/.claude/projects", () => {
    const sessionId = `sel-${Date.now()}`;
    const project = join(home, ".claude", "projects", "-home-someone-repo");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${sessionId}.jsonl`), assistant([text("from transcript")]) + "\n", "utf8");

    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "claude",
      session: { kind: "id", id: sessionId },
      readPane: () => "SHOULD NOT BE CALLED",
      logger,
    });
    expect(reader.kind).toBe("claude-jsonl");
    expect(reader.read(100)).toBe("from transcript");
  });

  it("selects claude-jsonl before the transcript exists, and reads it once it does", () => {
    const sessionId = `late-${Date.now()}`;
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "claude",
      session: { kind: "id", id: sessionId },
      readPane: () => "SHOULD NOT BE CALLED",
      logger,
    });
    expect(reader.kind).toBe("claude-jsonl");
    expect(reader.read(100)).toBe("");
    const project = join(home, ".claude", "projects", "-home-someone-repo");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${sessionId}.jsonl`), assistant([text("now it is")]) + "\n", "utf8");
    expect(reader.read(100)).toBe("now it is");
  });
});
