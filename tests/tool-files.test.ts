import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { extractSendRequests, listRecentFiles, resolveInsideCwd } from "../src/tool-files.js";

describe("listRecentFiles", () => {
  let root: string;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "recent-files-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write `name` with an mtime `agoMs` before NOW. */
  function write(name: string, agoMs: number, body = "x"): void {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    const when = new Date(NOW - agoMs);
    utimesSync(target, when, when);
  }

  it("lists files inside the window, newest first", () => {
    write("old.md", 60_000);
    write("new.md", 1_000);
    write("middle.md", 30_000);
    expect(listRecentFiles(root, 120_000, NOW).map((f) => f.relative)).toEqual([
      "new.md",
      "middle.md",
      "old.md",
    ]);
  });

  it("excludes anything older than the window", () => {
    write("stale.md", 10 * 60_000);
    write("fresh.md", 1_000);
    expect(listRecentFiles(root, 60_000, NOW).map((f) => f.relative)).toEqual(["fresh.md"]);
  });

  it("finds files in subdirectories, reported relative to the root", () => {
    write(join("docs", "laporan.md"), 1_000);
    expect(listRecentFiles(root, 60_000, NOW).map((f) => f.relative)).toEqual([
      join("docs", "laporan.md"),
    ]);
  });

  it("skips dependency and build directories", () => {
    // A fresh npm install would otherwise bury the file the user wants.
    write(join("node_modules", "pkg", "index.js"), 1_000);
    write(join("dist", "bundle.js"), 1_000);
    write(join(".git", "COMMIT_EDITMSG"), 1_000);
    write("real.md", 2_000);
    expect(listRecentFiles(root, 60_000, NOW).map((f) => f.relative)).toEqual(["real.md"]);
  });

  it("skips dotfiles and dot-directories", () => {
    write(".env", 1_000);
    write("kept.md", 2_000);
    expect(listRecentFiles(root, 60_000, NOW).map((f) => f.relative)).toEqual(["kept.md"]);
  });

  it("reports each file's size", () => {
    write("a.md", 1_000, "hello");
    expect(listRecentFiles(root, 60_000, NOW)[0]).toMatchObject({ relative: "a.md", size: 5 });
  });

  it("returns nothing for a directory it cannot read", () => {
    expect(listRecentFiles(join(root, "tidak-ada"), 60_000, NOW)).toEqual([]);
  });

  it("caps the listing", () => {
    for (let i = 0; i < 40; i++) write(`f${i}.md`, i * 100);
    expect(listRecentFiles(root, 60_000, NOW).length).toBeLessThanOrEqual(15);
  });
});

describe("extractSendRequests", () => {
  it("pulls the marker out and leaves the prose", () => {
    const answer = ["Sudah aku kirim ya.", "@@send: docs/laporan.md"].join("\n");
    expect(extractSendRequests(answer)).toEqual({
      paths: ["docs/laporan.md"],
      text: "Sudah aku kirim ya.",
    });
  });

  it("accepts the neutral @@send: spelling", () => {
    expect(extractSendRequests("@@send: docs/a.md").paths).toEqual(["docs/a.md"]);
  });

  it("keeps the agent's order for several files", () => {
    const answer = [
      "@@send: a.md",
      "Dua-duanya ya.",
      "@@send: b.md",
    ].join("\n");
    const result = extractSendRequests(answer);
    expect(result.paths).toEqual(["a.md", "b.md"]);
    expect(result.text).toBe("Dua-duanya ya.");
  });

  it("strips quotes an agent may wrap the path in", () => {
    expect(extractSendRequests('@@send: "docs/a b.md"').paths).toEqual(["docs/a b.md"]);
  });

  it("ignores a marker followed by prose rather than a path", () => {
    // An agent explaining the convention writes exactly this, and it used to
    // come back to the user as "⚠️ <the whole sentence> — not found".
    const answer =
      "@@send: bukan konvensi yang ada di instruksi saya, tapi ini bukan permintaan.";
    expect(extractSendRequests(answer)).toEqual({ paths: [], text: answer });
  });

  it("still accepts a quoted path that contains spaces", () => {
    expect(extractSendRequests('@@send: "Untuk Pelanggan/a b.pdf"').paths).toEqual([
      "Untuk Pelanggan/a b.pdf",
    ]);
  });

  it("ignores an absurdly long argument", () => {
    expect(extractSendRequests("@@send: " + "x".repeat(600)).paths).toEqual([]);
  });

  it("ignores a marker that is not at the start of a line", () => {
    // Prose about the convention, or a quoted example, is not a request.
    const answer = "Tulis @@send: path untuk mengirim file.";
    expect(extractSendRequests(answer)).toEqual({ paths: [], text: answer });
  });

  it("leaves an answer with no markers untouched", () => {
    const answer = "Halo!\n\nAda yang bisa aku bantu?";
    expect(extractSendRequests(answer)).toEqual({ paths: [], text: answer });
  });

  it("collapses the gap a removed marker leaves behind", () => {
    const answer = ["Selesai.", "", "@@send: a.md", "", "Ada lagi?"].join("\n");
    expect(extractSendRequests(answer).text).toBe("Selesai.\n\nAda lagi?");
  });

  it("ignores a marker with no path", () => {
    expect(extractSendRequests("@@send:   ").paths).toEqual([]);
  });
});

describe("resolveInsideCwd", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tool-files-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.md"), "hi");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a path inside the working directory", () => {
    const verdict = resolveInsideCwd(root, "docs/a.md");
    expect(verdict).toEqual({ ok: true, absolute: join(root, "docs", "a.md") });
  });

  it("accepts a path that does not exist yet, leaving the report to the caller", () => {
    expect(resolveInsideCwd(root, "docs/belum-ada.md").ok).toBe(true);
  });

  it("refuses traversal out of the working directory", () => {
    for (const escape of ["../../.ssh/id_rsa", "..", "docs/../../etc/passwd"]) {
      const verdict = resolveInsideCwd(root, escape);
      expect(verdict.ok, escape).toBe(false);
    }
  });

  it("refuses an absolute path elsewhere on the machine", () => {
    expect(resolveInsideCwd(root, "/etc/passwd").ok).toBe(false);
  });

  it("refuses a symlink that points out of the working directory", () => {
    // The lexical check passes here — only comparing REAL paths catches it.
    const outside = mkdtempSync(join(tmpdir(), "tool-files-outside-"));
    writeFileSync(join(outside, "id_rsa"), "secret");
    symlinkSync(outside, join(root, "keys"));
    try {
      const verdict = resolveInsideCwd(root, "keys/id_rsa");
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toContain("symlink");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses when the pane has no working directory", () => {
    expect(resolveInsideCwd("", "a.md").ok).toBe(false);
  });

  it("refuses an empty path", () => {
    expect(resolveInsideCwd(root, "   ").ok).toBe(false);
  });
});
