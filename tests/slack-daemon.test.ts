import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backgroundWork, extractHandoffs, formatThreadContext, isAside, loadSlackState, normalizeBotMentions, renderBotMentions } from "../src/slack-daemon.js";

describe("isAside — a message for the thread, not the pane", () => {
  it("recognises `#` followed by a space", () => {
    expect(isAside("# jangan di-merge dulu")).toBe(true);
    expect(isAside("#")).toBe(true);
    expect(isAside("  # leading whitespace is fine")).toBe(true);
    expect(isAside("#\nmulti-line aside")).toBe(true);
  });

  it("keeps an issue or PR number as a prompt", () => {
    expect(isAside("#142 review please")).toBe(false);
    expect(isAside("#hashtag")).toBe(false);
  });

  it("forwards everything else", () => {
    expect(isAside("fix the bug")).toBe(false);
    expect(isAside("// Slack never delivers this; it is not the marker")).toBe(false);
    expect(isAside("")).toBe(false);
  });
});


describe("formatThreadContext — what a mention at the end of a thread carries", () => {
  const m = (author: string, text: string, ts = "1.0") => ({ author, userId: `U_${author.toUpperCase()}`, text, ts });

  it("renders the thread as quoted context with a header and a footer", () => {
    const out = formatThreadContext([m("Budi", "PR #142 review please"), m("Sari", "line 40, why twice?")]);
    expect(out).toBe(
      "[Earlier in this Slack thread — 2 messages]\n" +
        "Budi [U_BUDI]: PR #142 review please\n" +
        "Sari [U_SARI]: line 40, why twice?\n" +
        "[End of thread]",
    );
  });

  it("leaves out bridge traffic: commands and asides", () => {
    const out = formatThreadContext([m("Ganjar", "!panes"), m("Ganjar", "# buat yang lain"), m("Budi", "isi")]);
    expect(out).toContain("Budi [U_BUDI]: isi");
    expect(out).not.toContain("!panes");
    expect(out).not.toContain("buat yang lain");
    expect(out).toContain("1 message]");
  });

  it("is empty when nothing is left, so the prompt goes bare", () => {
    expect(formatThreadContext([])).toBe("");
    expect(formatThreadContext([m("Ganjar", "!bind x"), m("Ganjar", "   ")])).toBe("");
  });

  it("keeps the newest messages when the thread is long, and says what it dropped", () => {
    const many = Array.from({ length: 40 }, (_, i) => m("U", `pesan ${i + 1}`));
    const out = formatThreadContext(many);
    expect(out).toContain("30 of 40 messages, oldest 10 omitted");
    expect(out).not.toContain("pesan 10\n");
    expect(out).toContain("pesan 11");
    expect(out).toContain("pesan 40");
  });

  it("clips a huge message rather than spending the whole budget on it", () => {
    const out = formatThreadContext([m("U", "x".repeat(5_000)), m("V", "terakhir")]);
    expect(out).toContain("U [U_U]: " + "x".repeat(1_000) + "…");
    expect(out).toContain("V [U_V]: terakhir");
  });

  it("stays under the character budget, dropping from the oldest end", () => {
    const many = Array.from({ length: 20 }, (_, i) => m("U", `${i + 1}:` + "y".repeat(900)));
    const out = formatThreadContext(many);
    expect(out.length).toBeLessThan(8_600);
    expect(out).toContain("20:");
    expect(out).not.toContain("\nU [U_U]: 1:");
    expect(out).toMatch(/of 20 messages, oldest \d+ omitted/);
  });
});


const resolve = (name: string): string | undefined =>
  ({ lilith: "lilith", shaka: "shaka" } as Record<string, string>)[name.toLowerCase()];

describe("extractHandoffs — the lines of an answer addressed to another bot", () => {
  it("takes a line that starts with @name, mention removed", () => {
    expect(extractHandoffs("Rencana: A lalu B.\n@lilith kerjakan A dulu", resolve)).toEqual([
      { bot: "lilith", lines: ["kerjakan A dulu"] },
    ]);
  });

  it("groups consecutive lines to the same bot into one brief", () => {
    const text = "@Lilith buat middleware\n@Lilith test-nya di tests/auth\nsisanya nanti.";
    expect(extractHandoffs(text, resolve)).toEqual([
      { bot: "lilith", lines: ["buat middleware", "test-nya di tests/auth"] },
    ]);
  });

  it("keeps a command as its own line, so it runs before the prompt", () => {
    expect(extractHandoffs("@lilith !spawn\n@lilith kerjakan ini", resolve)).toEqual([
      { bot: "lilith", lines: ["!spawn", "kerjakan ini"] },
    ]);
  });

  it("accepts a colon after the name, and any case", () => {
    expect(extractHandoffs("@SHAKA: tolong review", resolve)).toEqual([{ bot: "shaka", lines: ["tolong review"] }]);
  });

  it("ignores a mention that is nobody's, or not at the start of a line", () => {
    expect(extractHandoffs("@budi tolong cek\nlihat @lilith nanti", resolve)).toEqual([]);
  });

  it("starts a new brief when the addressee changes or prose intervenes", () => {
    const text = "@lilith satu\n@shaka dua\n@lilith tiga\nprosa\n@lilith empat";
    expect(extractHandoffs(text, resolve).map((h) => [h.bot, h.lines])).toEqual([
      ["lilith", ["satu"]],
      ["shaka", ["dua"]],
      ["lilith", ["tiga"]],
      ["lilith", ["empat"]],
    ]);
  });
});

describe("renderBotMentions — what the thread sees", () => {
  const mentionFor = (name: string): string | undefined =>
    name.toLowerCase() === "lilith" ? "<@U0BTFJZLSKV>" : undefined;

  it("turns @name at the start of a line into a real Slack mention", () => {
    expect(renderBotMentions("plan\n@lilith do it\n  @Lilith and this", mentionFor)).toBe(
      "plan\n<@U0BTFJZLSKV> do it\n  <@U0BTFJZLSKV> and this",
    );
  });

  it("leaves other names and mid-line mentions alone", () => {
    expect(renderBotMentions("@budi hi\nask @lilith later", mentionFor)).toBe("@budi hi\nask @lilith later");
  });
});

describe("loadSlackState — bindings saved before bots had names", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slack-state-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("assigns them to the first bot and re-keys them", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      threads: { "C1:1.0": { pane_id: "w1:p1", label: "x", agent: "claude", channel: "C1", thread_ts: "1.0" } },
    }));
    const state = loadSlackState(dir, log, "shaka");
    expect(Object.keys(state.threads)).toEqual(["shaka|C1:1.0"]);
    expect(state.threads["shaka|C1:1.0"].bot).toBe("shaka");
    expect(state.threads["shaka|C1:1.0"].context_sent).toBe(true);
    expect(state.asked_from).toEqual({});
    expect(state.marked).toEqual({});
    expect(state.last_answer).toEqual({});
  });

  it("keeps a state that already names its bots", () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      threads: { "lilith|C1:1.0": { bot: "lilith", pane_id: "w1:p1", label: "x", agent: "codex", channel: "C1", thread_ts: "1.0", context_sent: false } },
      last_user: { "C1:1.0": "U1" },
      asked_from: { "w1:p1": "lilith|C1:1.0" },
    }));
    const state = loadSlackState(dir, log, "shaka");
    expect(Object.keys(state.threads)).toEqual(["lilith|C1:1.0"]);
    expect(state.threads["lilith|C1:1.0"].context_sent).toBe(false);
    expect(state.last_user["C1:1.0"]).toBe("U1");
    expect(state.asked_from["w1:p1"]).toBe("lilith|C1:1.0");
  });
});

describe("backgroundWork — what Claude Code's screen says is still running", () => {
  it("reads the closing line, counting shells and not monitors", () => {
    expect(backgroundWork("  chunk pertama selesai.\n\n✻ Crunched for 2m 58s · done 10:04 AM · 1 shell, 1 monitor still running\n\n❯")).toBe("1 shell");
  });

  it("is empty when only monitors run — a watch is not work", () => {
    expect(backgroundWork("✻ Crunched for 2m 32s · done 5:51 PM · 2 monitors still running\n❯\n  ⏵⏵ auto mode on · 2 monitors · ← 2 agents")).toBe("");
  });

  it("reads the mode row when the closing line has scrolled away", () => {
    expect(backgroundWork("❯\n  ⏵⏵ auto mode on · 2 shells · ← 2 agents · ↓ to manage")).toBe("2 shells");
  });

  it("is empty for a quiet pane, and does not mistake herdr's agent count", () => {
    expect(backgroundWork("✻ Worked for 4s · done 9:12 am\n❯\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents")).toBe("");
    expect(backgroundWork("› Ask Codex to do anything")).toBe("");
  });
});

describe("normalizeBotMentions — Slack's own mention syntax at the start of a line", () => {
  const name = (id: string) => (id === "U0BTFJZLSKV" ? "lilith" : undefined);

  it("turns <@id> and <@id|Name> of one of ours into @name", () => {
    expect(normalizeBotMentions("<@U0BTFJZLSKV|Lilith> !bind coder\n<@U0BTFJZLSKV> kerjakan plan 001", name)).toBe(
      "@lilith !bind coder\n@lilith kerjakan plan 001",
    );
  });

  it("leaves other people's mentions and mid-line mentions alone", () => {
    expect(normalizeBotMentions("<@U999> tolong\ncc <@U0BTFJZLSKV> nanti", name)).toBe("<@U999> tolong\ncc <@U0BTFJZLSKV> nanti");
  });
});
