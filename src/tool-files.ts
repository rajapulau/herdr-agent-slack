/**
 * Finding and vetting files an agent wrote, for `/files` and `/file`.
 *
 * Both halves are pure so the security-critical part — deciding whether a
 * path may leave the machine — is testable without a pane, a bot, or a disk.
 */
import * as path from "node:path";
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";

/** Most a single `/files` listing will offer. Older entries are dropped. */
const MAX_LISTED = 15;

/** Directories never worth walking: build output, caches, dependency trees. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", ".git", ".next", ".venv", "venv", "coverage",
]);

/** Bounds on the walk, so `/files` in a large tree still answers promptly. */
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20_000;
const TIME_BUDGET_MS = 1_500;

/** One recently changed file, relative to the directory that was scanned. */
export interface RecentFile {
  /** Path relative to the scanned root — what the user types back at `/file`. */
  relative: string;
  size: number;
  modifiedMs: number;
}

/**
 * Files under `root` modified within `windowMs`, newest first.
 *
 * Reading the filesystem rather than the pane is deliberate. Scraping tool
 * blocks only sees `Write(path)`-shaped calls on the part of the scrollback
 * still on screen — it misses `Bash(cat > file)`, `sed -i`, a compiler's
 * output, and anything that scrolled away. The disk knows what changed
 * regardless of how it was written.
 *
 * The walk is bounded on three axes (depth, entries, wall clock) because a
 * pane's working directory can be an entire home folder.
 */
export function listRecentFiles(
  root: string,
  windowMs: number,
  now: number = Date.now(),
): RecentFile[] {
  const found: RecentFile[] = [];
  // Wall clock, not `now`: that parameter dates the FILES, and a test passing a
  // fixed timestamp would otherwise set a deadline already in the past and
  // abandon the walk before it read anything.
  const deadline = Date.now() + TIME_BUDGET_MS;
  let entriesSeen = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || entriesSeen >= MAX_ENTRIES || Date.now() > deadline) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — not worth failing the whole listing
    }
    for (const entry of entries) {
      if (entriesSeen++ >= MAX_ENTRIES) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, symlinks, devices
      try {
        const stat = statSync(absolute);
        if (now - stat.mtimeMs > windowMs) continue;
        found.push({
          relative: path.relative(root, absolute),
          size: stat.size,
          modifiedMs: stat.mtimeMs,
        });
      } catch {
        // Vanished between readdir and stat; nothing to report.
      }
    }
  };

  walk(root, 0);
  found.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return found.slice(0, MAX_LISTED);
}

/**
 * The line an agent prints to ask for a file to be delivered to the thread.
 * Anchored to the start of a line so a path mentioned mid-sentence — or a
 * marker quoted inside a code block — is not mistaken for a request.
 */
const SEND_MARKER = /^\s*@@send:\s*(.+?)\s*$/;

/** An answer split into the files it asked to send and the prose to show. */
export interface SendRequests {
  /** Paths the agent asked for, in the order it named them. */
  paths: string[];
  /** The answer with the marker lines removed. */
  text: string;
}

/**
 * Pull `@@send:` requests out of a finished answer.
 *
 * The agent resolves what "that file" means — it is the one that just wrote it
 * — and names a path; the caller owns the decision to honour it. Nothing here
 * touches the disk, and a named path is still subject to `resolveInsideCwd`.
 */
export function extractSendRequests(answer: string): SendRequests {
  const paths: string[] = [];
  const kept: string[] = [];
  for (const line of answer.split("\n")) {
    const requested = parseSendRequest(line);
    if (requested === null) {
      kept.push(line);
      continue;
    }
    paths.push(requested);
  }
  return { paths, text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/**
 * The path a marker line asks for, or null when the line is not a request.
 *
 * The argument has to look like a path, not a sentence. An agent asked about
 * the convention answers by writing it — "@@send: is not a convention I know
 * of, the documented one is …" — and a rule that only checked "starts with the
 * marker" turned that whole explanation into a filename, which then came back
 * to the user as `⚠️ <the sentence> — not found`.
 */
function parseSendRequest(line: string): string | null {
  const match = line.match(SEND_MARKER);
  if (!match) return null;
  const raw = match[1].trim();
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(raw);
  const candidate = (quoted ? quoted[2] : raw).trim();
  if (!candidate || candidate.length > 512) return null;
  // Unquoted paths carry no whitespace; quoting is how you ask for one that
  // does. Everything else on that line is prose about the convention.
  if (!quoted && /\s/.test(candidate)) return null;
  return candidate;
}

/** Why a path was refused, or the absolute path when it was accepted. */
export type PathVerdict =
  | { ok: true; absolute: string }
  | { ok: false; reason: string };

/**
 * Resolve `candidate` against the pane's working directory, refusing anything
 * that lands outside it.
 *
 * Two escapes are checked, not one:
 *   - `../` traversal, caught by comparing the resolved path against the root;
 *   - a symlink inside the directory pointing out of it, caught by comparing
 *     REAL paths. Without that second check, `ln -s ~/.ssh keys` inside the
 *     project would hand over private keys through a path that looks local.
 *
 * A path that does not exist yet still has its existing ancestors resolved, so
 * a not-yet-written file under a symlinked directory (every project under
 * macOS's `/var` → `/private/var`, for one) is judged against the same real
 * root as an existing one. The caller reports the missing file afterwards.
 */
export function resolveInsideCwd(cwd: string, candidate: string): PathVerdict {
  if (!cwd) return { ok: false, reason: "this pane has no working directory" };
  if (candidate.trim() === "") return { ok: false, reason: "no path given" };

  const root = path.resolve(cwd);
  const absolute = path.resolve(root, candidate);
  if (!isInside(root, absolute)) {
    return { ok: false, reason: `outside the pane's working directory (${root})` };
  }

  const realRoot = realpathBestEffort(root);
  const realTarget = realpathBestEffort(absolute);
  if (!isInside(realRoot, realTarget)) {
    return { ok: false, reason: "resolves outside the pane's working directory via a symlink" };
  }
  return { ok: true, absolute };
}

/** Whether `target` is `root` itself or sits beneath it. */
function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Real path of `candidate`; for one that does not exist, the real path of its
 * nearest existing ancestor with the remaining segments appended. Comparing a
 * resolved root against an unresolved target would refuse every new file under
 * a symlinked directory.
 */
function realpathBestEffort(candidate: string): string {
  let head = candidate;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return candidate; // nothing along the path resolves
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}
