#!/usr/bin/env node
/**
 * herdr-slack — drive herdr agent panes from Slack.
 *
 *   node dist/index.js --daemon   start the daemon (one process, every bot in config.toml)
 *   node dist/index.js --status   is it running?
 */
import { startSlackDaemon, defaultSlackStateDir } from "./slack-daemon.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removePidFileIfOwned } from "./daemon-pid.js";

// Always chdir to the script's own directory so paths like `./dist/` resolve
// correctly even when invoked from a different cwd (e.g. via `herdr plugin`).
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  process.chdir(__dirname);
} catch {
  // chdir can fail in some restricted environments — fall back to absolute paths later
}

const args = process.argv.slice(2);
const stateDir = process.env.HERDR_SLACK_STATE_DIR ?? defaultSlackStateDir();

function usage(): void {
  process.stdout.write(`herdr-slack — drive herdr agent panes from Slack

Usage:
  node dist/index.js --daemon   Start the daemon
  node dist/index.js --status   Check whether the daemon is running
  node dist/index.js --help     Show this help

Config: $HOME/.config/herdr-slack/config.toml
        ([slack] bot_token + app_token, or several [slack.<name>] sections)
State:  ${stateDir}/state.json

Tip: prefer "herdr plugin ..." commands over calling node directly.
     The herdr CLI handles dependency installation and lifecycle correctly.
`);
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

if (args.includes("--status")) {
  const pidFile = join(stateDir, "daemon.pid");
  let pid = "";
  try {
    pid = readFileSync(pidFile, "utf8").trim();
    process.kill(parseInt(pid, 10), 0);
  } catch {
    pid = "";
  }
  process.stdout.write(pid ? `Slack daemon: running (PID ${pid})\n` : "Slack daemon: not running\n");
  process.exit(0);
}

if (args.includes("--daemon")) {
  void runDaemon();
} else {
  usage();
  process.exit(1);
}

async function runDaemon(): Promise<void> {
  // Without these, a rejected promise anywhere in the delivery path takes the
  // daemon down leaving only an empty log — which is indistinguishable from a
  // clean shutdown, and impossible to diagnose after the fact.
  process.on("uncaughtException", (err) => {
    process.stderr.write(`uncaughtException: ${err?.stack ?? String(err)}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
    process.exit(1);
  });

  // Refuse to double-start
  const pidFile = join(stateDir, "daemon.pid");
  if (existsSync(pidFile)) {
    const oldPid = parseInt(readFileSync(pidFile, "utf8"), 10);
    try {
      process.kill(oldPid, 0);
      process.stderr.write(`Daemon already running (PID ${oldPid}). Use 'node dist/index.js --status' to check.\n`);
      process.exit(1);
    } catch {
      // Stale PID — overwrite below
    }
  }
  mkdirSync(stateDir, { recursive: true });
  try {
    const daemon = await startSlackDaemon({ stateDir });
    writeFileSync(pidFile, String(process.pid), "utf8");
    process.stdout.write(`Daemon started (PID ${process.pid})\n`);
    const shutdown = () => {
      void daemon.stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (err: any) {
    process.stderr.write(`Daemon failed to start: ${err.message}\n`);
    removePidFileIfOwned(pidFile, process.pid);
    process.exit(1);
  }

  process.on("exit", () => {
    removePidFileIfOwned(pidFile, process.pid);
  });
}
