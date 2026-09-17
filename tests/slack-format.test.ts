import { describe, expect, it } from "vitest";
import {
  SLACK_MAX_MESSAGE,
  escapeMrkdwn,
  formatForSlack,
  toMrkdwn,
} from "../src/slack-format.js";
import { DEFAULT_CHUNK_CHARS } from "../src/markdown-chunk.js";

describe("toMrkdwn — the dialect trap", () => {
  it("maps Markdown bold to mrkdwn bold, not italic", () => {
    // The whole reason this module exists: `**x**` passed through unchanged
    // renders as *x* — which Slack shows as italic, on the wrong words.
    expect(toMrkdwn("**tebal**")).toBe("*tebal*");
    expect(toMrkdwn("__tebal__")).toBe("*tebal*");
  });

  it("maps Markdown italic to mrkdwn italic", () => {
    expect(toMrkdwn("*miring*")).toBe("_miring_");
  });

  it("does not re-read its own bold output as italic", () => {
    // `**x**` → `*x*` must not then match the single-asterisk italic rule.
    expect(toMrkdwn("**tebal** dan *miring*")).toBe("*tebal* dan _miring_");
  });

  it("maps strikethrough to the single-tilde form", () => {
    expect(toMrkdwn("~~coret~~")).toBe("~coret~");
  });
});

describe("toMrkdwn — links and escaping", () => {
  it("uses Slack's angle-bracket link form", () => {
    expect(toMrkdwn("lihat [docs](https://example.com/a)")).toBe(
      "lihat <https://example.com/a|docs>",
    );
  });

  it("emits a bare link when there is no label", () => {
    expect(toMrkdwn("[](https://example.com)")).toBe("<https://example.com>");
  });

  it("replaces a pipe in the label, which would split the link", () => {
    expect(toMrkdwn("[a|b](https://example.com)")).toBe("<https://example.com|a/b>");
  });

  it("escapes only the three characters Slack reserves", () => {
    expect(escapeMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    // Quotes and apostrophes are ordinary text in mrkdwn.
    expect(escapeMrkdwn(`"kata" 'lain'`)).toBe(`"kata" 'lain'`);
  });
});

describe("toMrkdwn — blocks", () => {
  it("turns headings into bold, since Slack has none", () => {
    expect(toMrkdwn("## Jawaban")).toBe("*Jawaban*");
  });

  it("drops the language tag from a fence, which Slack would render literally", () => {
    expect(toMrkdwn("```ts\nconst a = 1;\n```")).toBe("```\nconst a = 1;\n```");
  });

  it("never applies inline markup inside a fence", () => {
    expect(toMrkdwn("```\n**not bold** and *not italic*\n```")).toBe(
      "```\n**not bold** and *not italic*\n```",
    );
  });

  it("renders a bullet list", () => {
    expect(toMrkdwn("- satu\n- dua")).toBe("• satu\n• dua");
  });

  it("keeps inline code untouched", () => {
    expect(toMrkdwn("jalankan `npm test` dulu")).toBe("jalankan `npm test` dulu");
  });

  it("recognises a two-column table, which carries one separator per row", () => {
    // Verbatim shape that reached Slack as ragged prose: an ASCII-shaped rule
    // of "two or more separators" never matched a two-column table.
    const table = [
      "src/config.ts        │ Opsi baru [slack] suggested_panes",
      "src/slack-daemon.ts  │ Fungsi selectSuggestedPanes()",
      "dist/                │ Sudah di-build ulang",
    ].join("\n");
    const out = toMrkdwn(table);
    expect(out.startsWith("```\n")).toBe(true);
    expect(out).toContain("src/config.ts        │ Opsi baru");
  });

  it("still requires two pipes for the ASCII separator, which is ordinary prose", () => {
    expect(toMrkdwn("jalankan a | b dulu")).toBe("jalankan a | b dulu");
  });

  it("puts a terminal table in a code block so the columns line up", () => {
    const table = ["Waktu | Dari | Isi", "13:11 | Slack | Notifikasi"].join("\n");
    const out = toMrkdwn(table);
    expect(out.startsWith("```\n")).toBe(true);
    expect(out).toContain("Waktu | Dari | Isi");
  });
});

describe("formatForSlack", () => {
  it("keeps every body inside the block limit", () => {
    const messages = formatForSlack("&".repeat(DEFAULT_CHUNK_CHARS));
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.text.length).toBeLessThanOrEqual(SLACK_MAX_MESSAGE);
    }
  });

  it("returns nothing for output that filtered down to nothing", () => {
    expect(formatForSlack("")).toEqual([]);
  });

  it("renders a whole answer end to end", () => {
    const answer = [
      "## Jawaban",
      "",
      "**Ya**, bisa `dibaca`.",
      "",
      "- satu",
      "- dua",
    ].join("\n");
    expect(formatForSlack(answer)[0].text).toBe(
      "*Jawaban*\n\n*Ya*, bisa `dibaca`.\n\n• satu\n• dua",
    );
  });
});

describe("toMrkdwn — a Markdown table becomes a list", () => {
  it("names each row by its first column and follows with header: value", () => {
    const table = [
      "| Origin | Endpoint | Model | Baris |",
      "|---|---|---|---|",
      "| prodfeat/worker | qiscus-dev | gpt4o-mini | 4372 |",
      "| production/sun | sun-team | gpt-4.1-nano | 233 |",
    ].join("\n");
    expect(toMrkdwn(table)).toBe(
      "• *prodfeat/worker* — Endpoint: qiscus-dev · Model: gpt4o-mini · Baris: 4372\n" +
        "• *production/sun* — Endpoint: sun-team · Model: gpt-4.1-nano · Baris: 233",
    );
  });

  it("renders a two-column table as key — value", () => {
    expect(toMrkdwn("| Setting | Value |\n|---|---|\n| ttl | 30s |\n| retries | **3** |")).toBe(
      "• *ttl* — 30s\n• *retries* — *3*",
    );
  });

  it("puts a wide row's columns on their own lines", () => {
    const table = [
      "| App | Endpoint | Model | Note |",
      "|---|---|---|---|",
      "| prodfeat/agentlabs-llm-latest-2-worker | agentlabs-production | gpt4o-mini | semua 404 Not Found, perlu dicek konfigurasinya |",
    ].join("\n");
    expect(toMrkdwn(table)).toBe(
      "• *prodfeat/agentlabs-llm-latest-2-worker*\n" +
        "    Endpoint: agentlabs-production\n" +
        "    Model: gpt4o-mini\n" +
        "    Note: semua 404 Not Found, perlu dicek konfigurasinya",
    );
  });

  it("still fences a terminal table that has no separator row", () => {
    const boxed = "src/config.ts │ new option\nsrc/daemon.ts │ wiring";
    expect(toMrkdwn(boxed)).toBe("```\n" + boxed + "\n```");
  });
});

describe("inline — Slack's own mentions survive", () => {
  it("keeps user, channel and special mentions unescaped", () => {
    expect(toMrkdwn("Bukan karena lokal, mba <@UM98MR75K> — cek <#C0BJLRE4GP4|dev> ya <!here>")).toBe(
      "Bukan karena lokal, mba <@UM98MR75K> — cek <#C0BJLRE4GP4|dev> ya <!here>",
    );
  });

  it("still escapes an angle bracket that is not a mention", () => {
    expect(toMrkdwn("a <b> c <@not-an-id>")).toBe("a &lt;b&gt; c &lt;@not-an-id&gt;");
  });
});
