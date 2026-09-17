import { existsSync, readFileSync, statSync } from "node:fs";
import type { AgentOutputReader } from "./types.js";
import type { Logger } from "../logger.js";

function extractTextFromContent(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      if ((c?.type === "text" || c?.type === "output_text" || c?.type === "input_text") && typeof c.text === "string") {
        return c.text;
      }
      return "";
    })
    .filter((s: string) => s.length > 0)
    .join("\n\n");
}

export function readPiCumulativeSnapshot(path: string): string {
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8");
  const chunks: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type !== "message") continue;
    const msg = ev.message;
    if (!msg || msg.role !== "assistant") continue;
    const text = extractTextFromContent(msg.content);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

export class PiJsonlReader implements AgentOutputReader {
  readonly kind = "pi-jsonl";
  constructor(
    private readonly path: string,
    private readonly logger: Logger,
    private readonly paneId: string,
    private readonly agentName: string,
  ) {}

  read(_maxLines: number): string {
    try {
      return readPiCumulativeSnapshot(this.path);
    } catch (err) {
      this.logger.warn("pi jsonl read failed", {
        paneId: this.paneId,
        agent: this.agentName,
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }
}

/** The pieces of a rollout the bridge cares about, in order. See `ClaudeTurns`. */
interface CodexTurns {
  answers: string[];
  latestAnswerStart: number;
  latestPrompt: string;
}

/**
 * What the person (or the bridge) typed, or "" for a `user` line Codex wrote
 * itself: `<environment_context>`, the `# AGENTS.md instructions for …`
 * preamble. A bridge prompt starts with `[` and counts.
 */
function codexPromptText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || /^# AGENTS\.md instructions/.test(trimmed)) return "";
  return trimmed;
}

function readCodexTurns(path: string): CodexTurns {
  const turns: CodexTurns = { answers: [], latestAnswerStart: 0, latestPrompt: "" };
  if (!existsSync(path)) return turns;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type !== "response_item" || ev?.payload?.type !== "message") continue;
    if (ev.payload.role === "user") {
      const prompt = codexPromptText(extractTextFromContent(ev.payload.content));
      if (!prompt) continue;
      turns.latestPrompt = prompt;
      turns.latestAnswerStart = turns.answers.length;
      continue;
    }
    if (ev.payload.role !== "assistant") continue;
    const text = extractTextFromContent(ev.payload.content);
    if (text) turns.answers.push(text);
  }
  return turns;
}

export function readCodexCumulativeSnapshot(path: string): string {
  return readCodexTurns(path).answers.join("\n\n").trim();
}

export class CodexJsonlReader implements AgentOutputReader {
  readonly kind = "codex-jsonl";
  constructor(
    private readonly path: string,
    private readonly logger: Logger,
    private readonly paneId: string,
  ) {}

  read(_maxLines: number): string {
    return this.turns().answers.join("\n\n").trim();
  }

  lastPrompt(): string {
    return this.turns().latestPrompt;
  }

  lastAnswer(): string {
    const turns = this.turns();
    return turns.answers.slice(turns.latestAnswerStart).join("\n\n").trim();
  }

  private turns(): CodexTurns {
    try {
      return readCodexTurns(this.path);
    } catch (err) {
      this.logger.warn("codex jsonl read failed", {
        paneId: this.paneId,
        agent: "codex",
        message: err instanceof Error ? err.message : String(err),
      });
      return { answers: [], latestAnswerStart: 0, latestPrompt: "" };
    }
  }
}

export function validatePathSession(path: string): string | null {
  if (!existsSync(path)) return `session path does not exist: ${path}`;
  try {
    const st = statSync(path);
    if (!st.isFile()) return `session path is not a regular file: ${path}`;
  } catch (err) {
    return `cannot stat session path: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

// --- Claude Code ------------------------------------------------------------

/**
 * One line of a Claude Code transcript, as far as the bridge reads it. The
 * file under `~/.claude/projects/<cwd>/<session>.jsonl` logs both sides of
 * the conversation, one content block per line for the assistant.
 */
interface ClaudeTranscriptLine {
  type?: string;
  /** A subagent's traffic, logged into the same file. Never the answer. */
  isSidechain?: boolean;
  /** Bridge/skill scaffolding injected as the user, not something they typed. */
  isMeta?: boolean;
  message?: { role?: string; content?: unknown };
}

/** The pieces of a Claude Code transcript the bridge cares about, in order. */
interface ClaudeTurns {
  /** Assistant text blocks, in the order they were written. */
  answers: string[];
  /** Index into `answers` at which the text for the latest prompt begins. */
  latestAnswerStart: number;
  /** The last thing the user actually typed; "" when the log has none. */
  latestPrompt: string;
}

/**
 * The user's own words, or "" for a line the user did not write. Claude Code
 * logs a lot as `user` that nobody typed: tool results, task notifications,
 * slash-command expansions (`<command-name>`), shell passthrough
 * (`<bash-input>`), interruptions (`[Request interrupted…]`), attachments.
 * Every one of those is wrapped in `<…>` or `[…]`; a typed prompt is not.
 */
function claudePromptText(line: ClaudeTranscriptLine): string {
  if (line.isMeta || line.isSidechain) return "";
  const content = line.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? extractTextFromContent(content) : "";
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) return "";
  // Claude Code's own bracketed notes; a bridge prompt also starts with `[`
  // and is a prompt.
  if (/^\[(?:Request interrupted|Attached:|System:|Image|Pasted)/.test(trimmed)) return "";
  return trimmed;
}

function readClaudeTurns(path: string): ClaudeTurns {
  const turns: ClaudeTurns = { answers: [], latestAnswerStart: 0, latestPrompt: "" };
  if (!existsSync(path)) return turns;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: ClaudeTranscriptLine;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type === "user") {
      const prompt = claudePromptText(ev);
      if (!prompt) continue;
      turns.latestPrompt = prompt;
      turns.latestAnswerStart = turns.answers.length;
      continue;
    }
    if (ev?.type !== "assistant" || ev.isSidechain) continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    // Only `text` blocks are the answer. `thinking` and `tool_use` share the
    // message, and `extractTextFromContent` already leaves them out.
    const text = extractTextFromContent(content);
    if (text) turns.answers.push(text);
  }
  return turns;
}

/** Every assistant message so far, oldest first — the cumulative snapshot the diff path expects. */
export function readClaudeCumulativeSnapshot(path: string): string {
  return readClaudeTurns(path).answers.join("\n\n").trim();
}

/**
 * Reads the transcript Claude Code writes as it goes. Unlike the screen it
 * is the model's own Markdown — fences, emphasis, tables intact — with none
 * of the TUI drawn around it, and it logs the prompts too, so a question
 * typed into the terminal can be quoted with its answer.
 *
 * The file appears with the session's first prompt, and a pane bound fresh
 * has not had one yet — so the path is looked up on each read until found,
 * rather than once when the reader is chosen.
 */
export class ClaudeJsonlReader implements AgentOutputReader {
  readonly kind = "claude-jsonl";
  readonly verbatim = true;
  private path: string | null;
  constructor(
    private readonly locate: () => string | null,
    private readonly logger: Logger,
    private readonly paneId: string,
  ) {
    this.path = locate();
  }

  read(_maxLines: number): string {
    return this.turns().answers.join("\n\n").trim();
  }

  lastPrompt(): string {
    return this.turns().latestPrompt;
  }

  lastAnswer(): string {
    const turns = this.turns();
    return turns.answers.slice(turns.latestAnswerStart).join("\n\n").trim();
  }

  private turns(): ClaudeTurns {
    try {
      this.path ??= this.locate();
      if (!this.path) return { answers: [], latestAnswerStart: 0, latestPrompt: "" };
      return readClaudeTurns(this.path);
    } catch (err) {
      this.logger.warn("claude jsonl read failed", {
        paneId: this.paneId,
        agent: "claude",
        message: err instanceof Error ? err.message : String(err),
      });
      return { answers: [], latestAnswerStart: 0, latestPrompt: "" };
    }
  }
}

// --- Not yet ------------------------------------------------------------------

/**
 * A structured reader for a pane whose log cannot be found yet — the agent
 * has just started and herdr has no session for it, or the file is not
 * written until the first prompt. `pick` is tried on every read until it
 * returns one; until then there is nothing, which is the truth: the agent
 * has not said anything. Chosen instead of the screen, because the screen
 * of a pane that has said nothing is its welcome banner, and that has been
 * delivered as an answer.
 */
export class DeferredReader implements AgentOutputReader {
  private inner: AgentOutputReader | null = null;
  constructor(
    readonly kind: string,
    readonly verbatim: boolean,
    private readonly pick: () => AgentOutputReader | null,
    private readonly logger: Logger,
    private readonly paneId: string,
  ) {}

  private resolved(): AgentOutputReader | null {
    if (!this.inner) {
      this.inner = this.pick();
      if (this.inner) this.logger.info("structured source found", { paneId: this.paneId, kind: this.inner.kind });
    }
    return this.inner;
  }

  read(maxLines: number): string {
    return this.resolved()?.read(maxLines) ?? "";
  }

  lastPrompt(): string {
    return this.resolved()?.lastPrompt?.() ?? "";
  }

  lastAnswer(): string {
    return this.resolved()?.lastAnswer?.() ?? "";
  }
}
