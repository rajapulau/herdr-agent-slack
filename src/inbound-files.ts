/**
 * Files arriving FROM the chat, on their way to a pane.
 *
 * The mirror of `tool-files.ts`, and the more dangerous direction: that module
 * decides what may leave the machine, this one writes to it. Everything here
 * treats the sender's filename as hostile — it is chosen remotely, and a name
 * like `../../.ssh/authorized_keys` must land as a harmless string rather than
 * where it asks to.
 */
import * as path from "node:path";
import { existsSync } from "node:fs";

/** Where received files land, relative to the pane's working directory. */
export const INBOX_DIR = ".inbox";

/**
 * Ceiling on one received file. Telegram's Bot API refuses to serve a download
 * larger than this, so the smaller of the two transports sets the limit and
 * both behave the same.
 */
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;

/** Longest stored filename, before the collision suffix. */
const MAX_NAME_LENGTH = 100;

/**
 * A filename safe to write inside the inbox.
 *
 * Only the basename survives, so directory parts in the sender's name are
 * discarded rather than honoured. What remains is reduced to a conservative
 * character set: a name is metadata from a remote party, and the filesystem is
 * not the place to find out which characters this OS treats as special.
 */
export function safeInboxName(raw: string): string {
  const base = path.basename(raw.trim());
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._]+/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  // Truncate the stem, keep the extension: the extension is what tells an
  // agent (and the OS) how to open the thing.
  const ext = path.extname(cleaned).slice(0, 16);
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/** Where a received file will be written. */
export interface InboxTarget {
  /** Absolute path to write to. */
  absolute: string;
  /** Path to hand the agent, relative to its working directory. */
  relative: string;
}

/**
 * Resolve a free path inside `<cwd>/.inbox` for `rawName`.
 *
 * A name already taken gets a numeric suffix rather than overwriting: two
 * screenshots both called `image.png` are two different files, and silently
 * replacing the first would lose work the agent may not have read yet.
 */
export function inboxTarget(
  cwd: string,
  rawName: string,
  exists: (p: string) => boolean = existsSync,
): InboxTarget {
  const dir = path.join(cwd, INBOX_DIR);
  const safe = safeInboxName(rawName);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let n = 0; ; n++) {
    const name = n === 0 ? safe : `${stem}-${n}${ext}`;
    const absolute = path.join(dir, name);
    if (!exists(absolute)) {
      return { absolute, relative: path.join(INBOX_DIR, name) };
    }
  }
}

/**
 * The text handed to the pane for a received file.
 *
 * The caption comes first because it is what the person actually said; the
 * path is a footnote telling the agent where to look. With no caption the
 * path stands alone, which reads as "here is a file, deal with it".
 */
export function describeReceived(relativePaths: string[], caption: string): string {
  const files = relativePaths.map((p) => `[received file: ${p}]`).join("\n");
  const text = caption.trim();
  return text ? `${text}\n\n${files}` : files;
}

/**
 * Whether a received filename is something the agent has to listen to rather
 * than read. Telegram labels a voice note as such; Slack just hands over a
 * file, so the extension is all there is to go on.
 */
export function isAudioName(name: string): boolean {
  return /\.(oga|ogg|opus|m4a|mp3|wav|aac|flac|webm|amr|aiff?)$/i.test(name);
}

/**
 * What the agent is told when a voice message arrives.
 *
 * Deliberately not "here is an instruction". The bridge cannot hear, and the
 * transcriber it would have to use gets exactly the words that matter here
 * wrong — `adopt` came back as `adapt` on a clean synthetic sample, in a
 * sentence that still read perfectly. So the agent is told to transcribe it
 * AND to read the transcript back before acting on it, because a wrong word in
 * a pane running on auto mode is not a typo, it is an action.
 */
export function describeVoice(relativePath: string, seconds: number | undefined): string {
  const length = seconds && seconds > 0 ? ` (${seconds}s)` : "";
  return [
    `[received voice message${length}: ${relativePath}]`,
    "",
    "Transcribe it before doing anything with it, then repeat the transcript back",
    "and wait for confirmation — speech-to-text mangles command words and pane ids.",
    "",
    // Carried with the message rather than left to CLAUDE.md alone: a session
    // read that file when it started, which may have been before this
    // convention existed. `-l id` is the part that must not be missed —
    // without it Whisper reads the English jargon, decides the whole thing is
    // English, and hands back a translation instead of the words spoken.
    "  ffmpeg -y -loglevel error -i <file> -ar 16000 -ac 1 -c:a pcm_s16le /tmp/voice.wav",
    "  whisper-cli -m ~/.cache/whisper-cpp/ggml-large-v3-turbo-q5_0.bin -f /tmp/voice.wav -l id -nt",
  ].join("\n");
}
