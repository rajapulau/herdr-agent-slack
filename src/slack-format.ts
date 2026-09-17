/**
 * Markdown → Slack mrkdwn conversion.
 *
 * mrkdwn looks like Markdown and is not: Slack's `*bold*` is Markdown's
 * *italic*, and Slack has no heading, no `[text](url)`, and no language tag on
 * a code fence. Passing an agent's Markdown through unchanged therefore
 * renders WRONG rather than merely plain — emphasis lands on the wrong words.
 *
 * Escaping is narrower than HTML's: Slack only reserves `&`, `<` and `>`,
 * because `<…>` delimits its link syntax.
 *
 * Chunking is shared with the Telegram formatter (`markdown-chunk.ts`); only
 * the dialect differs.
 */
import { DEFAULT_CHUNK_CHARS, splitMarkdown } from "./markdown-chunk.js";

/**
 * Slack renders a message body beyond this, but a Block Kit section caps here
 * — staying under it keeps the door open to switching to blocks later.
 */
export const SLACK_MAX_MESSAGE = 3_000;

/** Escape the three characters Slack reserves. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const FENCE_OPEN = /^\s*```+\s*([A-Za-z0-9_+#-]*)\s*$/;
const FENCE_CLOSE = /^\s*```+\s*$/;

/**
 * Convert the inline markup of one line.
 *
 * Order matters and is load-bearing. Bold must be converted before italic, and
 * its result parked in a placeholder — otherwise the single-asterisk italic
 * rule would immediately re-match the `*bold*` this function just produced and
 * turn it into `_bold_`.
 */
function inlineMrkdwn(raw: string): string {
  const parked: string[] = [];
  const park = (rendered: string): string => {
    parked.push(rendered);
    return `\u0000${parked.length - 1}\u0000`;
  };

  // Code spans first: nothing inside them is markup.
  let text = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => park(`\`${escapeMrkdwn(code)}\``));
  // Slack's own mentions — <@U…>, <#C…>, <!here> — are markup Slack wants
  // kept, not angle brackets to escape: an agent that names a person writes
  // one, and escaped it is a dead string.
  text = text.replace(/<(@[A-Z0-9]+(?:\|[^>\n]*)?|#[A-Z0-9]+(?:\|[^>\n]*)?|!(?:here|channel|everyone))>/g, (m) => park(m));
  text = escapeMrkdwn(text);
  // Links before emphasis — a label may itself be bold. Slack's form is
  // <url|label>, and a literal `|` inside the label would split it.
  text = text.replace(
    /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, href: string) =>
      park(label ? `<${href}|${label.replace(/\|/g, "/")}>` : `<${href}>`),
  );
  text = text.replace(/\*\*([^\n]+?)\*\*/g, (_m, body: string) => park(`*${body}*`));
  text = text.replace(/__([^\n]+?)__/g, (_m, body: string) => park(`*${body}*`));
  text = text.replace(/~~([^\n]+?)~~/g, (_m, body: string) => park(`~${body}~`));
  // Single-asterisk italics only when both delimiters hug non-space text, so
  // `* bullet` and a stray `*` never open an emphasis run.
  text = text.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, "_$1_");
  return text.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => parked[Number(index)]);
}

/** Convert one non-fenced line, mapping block markup onto what Slack has. */
function blockMrkdwn(line: string): string {
  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
  if (heading) {
    // Slack has no headings; bold is the closest available weight.
    const body = inlineMrkdwn(heading[2].replace(/\s+#+\s*$/, "").trim());
    return body ? `*${body}*` : "";
  }
  if (/^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) return "──────────";
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}• ${inlineMrkdwn(bullet[2])}`;
  return inlineMrkdwn(line);
}

/**
 * A row of a terminal table.
 *
 * Two separators are required for the ASCII pipe, because `|` is ordinary
 * prose and code. The box-drawing `│` needs only one: nothing writes it by
 * accident, and a two-column table — `src/config.ts │ new option` — carries
 * exactly one per row, which an ASCII-shaped rule of "two or more" silently
 * failed to recognise.
 */
function isTableRow(line: string): boolean {
  if (line.includes("│")) return true;
  return (line.match(/\|/g) ?? []).length >= 2;
}

/** The row under a Markdown table's header: `|---|:---:|---|`. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** The cells of one `| a | b |` row, outer pipes dropped, inner markup converted. */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => inlineMrkdwn(cell.trim()));
}

/**
 * A table as a list. The first column names the item and goes bold; the
 * rest follow as `Header: value`, on one line when they fit and one per
 * line when they do not, so a wide row stays legible on a narrow screen.
 * A two-column table is simply `• *key* — value`.
 */
function tableAsList(header: string[], rows: string[][]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const [first, ...rest] = row;
    if (rest.length === 0) {
      lines.push(`• ${first}`);
      continue;
    }
    if (rest.length === 1) {
      lines.push(`• *${first}* — ${rest[0]}`);
      continue;
    }
    const pairs = rest.map((value, index) => `${header[index + 1] ?? ""}: ${value}`);
    const oneLine = pairs.join(" · ");
    if (oneLine.length <= 100) {
      lines.push(`• *${first}* — ${oneLine}`);
    } else {
      lines.push(`• *${first}*`, ...pairs.map((pair) => `    ${pair}`));
    }
  }
  return lines.join("\n");
}

/** Convert a Markdown fragment into Slack mrkdwn. */
export function toMrkdwn(markdown: string): string {
  // NUL is the placeholder delimiter; strip any that arrived in the input.
  const lines = markdown.replace(/\u0000/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(FENCE_OPEN);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence (or run off the end when unterminated)
      // Slack's fence takes no language tag; the tag would render literally.
      out.push("```\n" + escapeMrkdwn(body.join("\n")) + "\n```");
      continue;
    }
    // A Markdown table — header, separator, rows — becomes a list: a code
    // block keeps the columns but is unreadable on a phone, and Slack has
    // no table of its own.
    if (isTableRow(lines[i]) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = splitTableRow(lines[i]);
      let end = i + 2;
      const rows: string[][] = [];
      while (end < lines.length && isTableRow(lines[end])) {
        rows.push(splitTableRow(lines[end]));
        end += 1;
      }
      out.push(tableAsList(header, rows));
      i = end;
      continue;
    }
    if (isTableRow(lines[i])) {
      let end = i;
      while (end < lines.length && isTableRow(lines[end])) end += 1;
      if (end - i >= 2) {
        out.push("```\n" + escapeMrkdwn(lines.slice(i, end).join("\n")) + "\n```");
        i = end;
        continue;
      }
    }
    out.push(blockMrkdwn(lines[i]));
    i += 1;
  }
  return out.join("\n").trim();
}

/** One Slack-ready message. */
export interface SlackMessage {
  /** Body to post with `mrkdwn: true`. */
  text: string;
}

/**
 * Split `markdown` and convert each chunk, keeping every body inside
 * `SLACK_MAX_MESSAGE`. A chunk whose conversion overflows — escaping can
 * multiply length, `&` becoming `&amp;` — is re-split at a tighter budget.
 */
export function formatForSlack(markdown: string, limit = DEFAULT_CHUNK_CHARS): SlackMessage[] {
  const messages: SlackMessage[] = [];
  for (const chunk of splitMarkdown(markdown, limit)) {
    const text = toMrkdwn(chunk);
    if (text.length <= SLACK_MAX_MESSAGE || limit <= 256) {
      messages.push({ text });
      continue;
    }
    messages.push(...formatForSlack(chunk, Math.max(256, Math.floor(limit / 2))));
  }
  return messages;
}
