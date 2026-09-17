import { describe, expect, it } from "vitest";
import { isDirectMessage, mentionsAny, stripMention } from "../src/slack-client.js";

const BOT = "U07RMCZM599";

describe("stripMention — what a channel mention leaves behind", () => {
  it("drops the mention at the front, so `@bot !bind x` is the command `!bind x`", () => {
    expect(stripMention(`<@${BOT}> !bind harness`, BOT)).toBe("!bind harness");
  });

  it("drops a mention that carries a display name", () => {
    expect(stripMention(`<@${BOT}|shaka> !panes`, BOT)).toBe("!panes");
  });

  it("closes the gap a mid-sentence mention leaves", () => {
    expect(stripMention(`fix this <@${BOT}> please`, BOT)).toBe("fix this please");
    expect(stripMention(`hello <@${BOT}>`, BOT)).toBe("hello");
  });

  it("keeps line breaks — a prompt is often more than one line", () => {
    expect(stripMention(`<@${BOT}>\nline one\nline two`, BOT)).toBe("line one\nline two");
  });

  it("leaves other people's mentions alone", () => {
    expect(stripMention(`<@${BOT}> ask <@UOTHER> about it`, BOT)).toBe("ask <@UOTHER> about it");
  });

  it("is empty for a bare mention, so the caller can answer with help", () => {
    expect(stripMention(`<@${BOT}>`, BOT)).toBe("");
    expect(stripMention(`  <@${BOT}>  `, BOT)).toBe("");
  });

  it("only trims when the bot id is unknown", () => {
    expect(stripMention(`  <@${BOT}> hi `, undefined)).toBe(`<@${BOT}> hi`);
  });
});

describe("isDirectMessage", () => {
  it("reads the channel id prefix", () => {
    expect(isDirectMessage("D07RESWBHEJ")).toBe(true);
    expect(isDirectMessage("C0123456789")).toBe(false);
    expect(isDirectMessage("G0123456789")).toBe(false);
  });
});


describe("mentionsAny", () => {
  const ours = (id: string) => id === "U1" || id === "U2";
  it("finds a mention of one of ours, with or without a display name", () => {
    expect(mentionsAny("hey <@U1> do it", ours)).toBe(true);
    expect(mentionsAny("<@U2|lilith> go", ours)).toBe(true);
  });
  it("ignores other people's mentions and plain text", () => {
    expect(mentionsAny("hey <@U9> do it", ours)).toBe(false);
    expect(mentionsAny("no mention here", ours)).toBe(false);
  });
});
