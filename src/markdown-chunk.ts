/**
 * Splitting Markdown into transport-sized pieces.
 *
 * Every chat transport caps a message, and every one of them needs the same
 * thing: cut on line boundaries, never mid-word, and keep a fenced code block
 * self-contained so each piece converts to well-formed markup on its own.
 * Only the limit and the markup dialect differ, so this lives apart from both
 * `telegram-format` and `slack-format`.
 */

/**
 * Default source-text budget per chunk. Deliberately well below any
 * transport's hard limit: escaping and tag insertion both grow the payload.
 */
export const DEFAULT_CHUNK_CHARS = 3_000;

const FENCE_OPEN = /^\s*```+\s*([A-Za-z0-9_+#-]*)\s*$/;
const FENCE_CLOSE = /^\s*```+\s*$/;


/**
 * Break lines that exceed the per-chunk budget on their own. Telegram's
 * limit is absolute, and a single 6000-character line has no safe break
 * point, so it is cut at fixed width.
 */
function* splitLongLines(lines: string[], limit: number): Generator<string> {
  const max = Math.max(1, limit - 16); // headroom for a reopened fence line
  for (const line of lines) {
    if (line.length <= max) {
      yield line;
      continue;
    }
    for (let i = 0; i < line.length; i += max) yield line.slice(i, i + max);
  }
}

/**
 * Split Markdown into chunks of at most `limit` source characters, cutting
 * on line boundaries. A chunk that ends inside a fenced code block closes
 * the fence, and the next chunk reopens it with the same info string.
 */
export function splitMarkdown(text: string, limit = DEFAULT_CHUNK_CHARS): string[] {
  const source = text.trim();
  if (!source) return [];
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  /** Info string of the fenced block we are inside, or null outside one. */
  let fence: string | null = null;

  const push = (line: string): void => {
    current.push(line);
    size += line.length + 1;
  };
  const flush = (): void => {
    if (!current.length) return;
    chunks.push((fence !== null ? [...current, "```"] : current).join("\n"));
    current = [];
    size = 0;
    if (fence !== null) push("```" + fence);
  };

  for (const line of splitLongLines(source.split("\n"), limit)) {
    // Annotated: `fence` is assigned from `open`, which TS reads as circular.
    const open: RegExpMatchArray | null = fence === null ? line.match(FENCE_OPEN) : null;
    const close = fence !== null && FENCE_CLOSE.test(line);
    if (size + line.length + 1 > limit && current.length) flush();
    push(line);
    if (open) fence = open[1];
    else if (close) fence = null;
  }
  // A trailing flush may re-push a reopening fence into `current`; that
  // leftover is discarded with the function scope.
  flush();
  return chunks;
}

