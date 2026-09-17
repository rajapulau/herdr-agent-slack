import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  INBOX_DIR,
  MAX_INBOUND_BYTES,
  describeReceived,
  describeVoice,
  inboxTarget,
  isAudioName,
  safeInboxName,
} from "../src/inbound-files.js";

describe("safeInboxName", () => {
  it("keeps an ordinary name", () => {
    expect(safeInboxName("diagram.png")).toBe("diagram.png");
  });

  it("discards directory parts instead of honouring them", () => {
    // The sender chooses this string. Traversal must land as a plain name.
    expect(safeInboxName("../../.ssh/authorized_keys")).toBe("authorized_keys");
    expect(safeInboxName("/etc/passwd")).toBe("passwd");
    expect(safeInboxName("a/b/c.txt")).toBe("c.txt");
  });

  it("refuses to produce a dot entry", () => {
    expect(safeInboxName("..")).toBe("file");
    expect(safeInboxName(".")).toBe("file");
    expect(safeInboxName("   ")).toBe("file");
  });

  it("never produces a hidden file", () => {
    // A leading dot would hide the file from the person who sent it.
    expect(safeInboxName(".env")).toBe("env");
  });

  it("reduces anything outside a conservative set", () => {
    expect(safeInboxName("rapat 12 Mei (final).pdf")).toBe("rapat_12_Mei_final_.pdf");
    expect(safeInboxName("a;rm -rf b.txt")).toBe("a_rm_-rf_b.txt");
  });

  it("keeps the extension when truncating a very long name", () => {
    const name = safeInboxName("x".repeat(300) + ".png");
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith(".png")).toBe(true);
  });

  it("caps downloads where Telegram does", () => {
    expect(MAX_INBOUND_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("inboxTarget", () => {
  const cwd = "/work/project";

  it("places a file inside the pane's inbox", () => {
    const target = inboxTarget(cwd, "diagram.png", () => false);
    expect(target.absolute).toBe(join(cwd, INBOX_DIR, "diagram.png"));
    expect(target.relative).toBe(join(INBOX_DIR, "diagram.png"));
  });

  it("suffixes rather than overwriting an existing file", () => {
    // Two screenshots both named image.png are two different files.
    const taken = new Set([join(cwd, INBOX_DIR, "image.png")]);
    const target = inboxTarget(cwd, "image.png", (p) => taken.has(p));
    expect(target.relative).toBe(join(INBOX_DIR, "image-1.png"));
  });

  it("keeps counting past the first collision", () => {
    const taken = new Set([
      join(cwd, INBOX_DIR, "image.png"),
      join(cwd, INBOX_DIR, "image-1.png"),
    ]);
    const target = inboxTarget(cwd, "image.png", (p) => taken.has(p));
    expect(target.relative).toBe(join(INBOX_DIR, "image-2.png"));
  });

  it("puts the suffix before the extension, not after", () => {
    const taken = new Set([join(cwd, INBOX_DIR, "notes.tar.gz")]);
    const target = inboxTarget(cwd, "notes.tar.gz", (p) => taken.has(p));
    expect(target.relative).toBe(join(INBOX_DIR, "notes.tar-1.gz"));
  });

  it("cannot be steered out of the inbox by the sender's name", () => {
    const target = inboxTarget(cwd, "../../escape.txt", () => false);
    expect(target.absolute).toBe(join(cwd, INBOX_DIR, "escape.txt"));
  });
});

describe("describeReceived", () => {
  it("leads with what the person said", () => {
    expect(describeReceived([".inbox/a.png"], "tolong baca ini")).toBe(
      "tolong baca ini\n\n[received file: .inbox/a.png]",
    );
  });

  it("stands alone when there is no caption", () => {
    expect(describeReceived([".inbox/a.png"], "  ")).toBe("[received file: .inbox/a.png]");
  });

  it("lists every file", () => {
    expect(describeReceived([".inbox/a.png", ".inbox/b.pdf"], "")).toBe(
      "[received file: .inbox/a.png]\n[received file: .inbox/b.pdf]",
    );
  });
});

describe("isAudioName", () => {
  it("recognises what a voice note arrives as", () => {
    // Telegram records voice as Opus in Ogg; Slack hands over m4a or webm and
    // says nothing about what it is, so the extension is all there is.
    for (const name of ["voice-1.oga", "note.ogg", "clip.opus", "memo.m4a", "a.mp3", "b.wav", "c.webm"]) {
      expect(isAudioName(name)).toBe(true);
    }
  });

  it("leaves everything else alone", () => {
    for (const name of ["report.pdf", "photo-1.jpg", "notes.md", "data.csv", "audio.txt"]) {
      expect(isAudioName(name)).toBe(false);
    }
  });
});

describe("describeVoice", () => {
  it("names the file and its length", () => {
    const text = describeVoice(".inbox/voice-412.oga", 14);
    expect(text).toContain(".inbox/voice-412.oga");
    expect(text).toContain("(14s)");
  });

  it("omits a length it does not know", () => {
    // Slack does not report one.
    expect(describeVoice(".inbox/clip.m4a", undefined)).not.toContain("(");
  });

  it("carries the transcription command, not just a reference to it", () => {
    // A session read CLAUDE.md when it started, possibly before this
    // convention existed. `-l id` is the part that must not be missed: without
    // it Whisper decides the English jargon means the whole utterance is
    // English and returns a translation.
    const text = describeVoice(".inbox/voice-1.oga", 9);
    expect(text).toContain("whisper-cli");
    expect(text).toContain("-l id");
    expect(text).toContain("ffmpeg");
  });

  it("tells the agent to read the transcript back before acting", () => {
    // The whole point. `adopt` came back as `adapt` on a clean sample, in a
    // sentence that still read perfectly — nothing else would catch that.
    const text = describeVoice(".inbox/voice-1.oga", 9);
    expect(text).toMatch(/transcribe/i);
    expect(text).toMatch(/confirmation/i);
  });
});
