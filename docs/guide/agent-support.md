# Agent Support

All agents share the same turn pipeline: one `PaneAgent` per Herdr pane, one `AgentCommunicator`, and at most one active observe loop. The variable part is the output reader selected by the communicator.

| Agent | Output source | Notes |
|---|---|---|
| Claude Code | JSONL transcript under `~/.claude/projects` | Located by the session id Herdr reports. The model's own Markdown, delivered verbatim; the transcript logs the prompts too, so a question typed in the terminal is quoted with its answer. |
| OpenCode | SQLite session database | Uses the OpenCode DB when Herdr reports the session id. |
| Codex | JSONL rollout/session log | Resolves rollout file from Herdr session information. |
| Pi / OMP | Herdr-provided JSONL session path | Cumulative assistant text from JSONL. |
| Other agents | Screen scraping fallback | Used only when no structured source is validated. |

## Verbatim sources

A screen carries TUI chrome — spinner lines, tool summaries, the prompt row —
and so does OpenCode's log, so their text goes through the pane filters before
delivery. Those filters drop lines that look like chrome, and a Markdown answer
has lines that look like chrome: a path on its own line, a `<tag>` inside a
fence. A reader whose text is the model's own therefore declares `verbatim`,
and the bridge sends it as it is. Claude Code's transcript is one; it is also
the reason `**bold**` and code fences survive to Slack from that
agent, where a scrape had already lost them to the terminal's rendering.

## Progress and completion

`progress_interval_ms` controls the observe-loop polling cadence. New output is emitted as delta chunks. When there is no new output, the loop emits a Working heartbeat. The turn ends when its stop condition is satisfied. The Slack bridge delivers one answer per turn; the ticks refresh the status line.

The stop condition is:

```text
stop = deadline_reached AND (NOT wait_until_idle OR is_idle)
```

Messages are chunked to stay below Slack's limit. Longer output is split into multiple messages.

