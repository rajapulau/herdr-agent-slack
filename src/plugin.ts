// Called by herdr on `pane.agent_status_changed` events. Its only job: make
// sure the daemon is running. If it is not, start it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSlackStateDir } from "./slack-daemon.js";

const stateDir = process.env.HERDR_SLACK_STATE_DIR ?? defaultSlackStateDir();
const pidFile = join(stateDir, "daemon.pid");

function isRunning(): boolean {
  if (!existsSync(pidFile)) return false;
  try {
    process.kill(parseInt(readFileSync(pidFile, "utf8"), 10), 0);
    return true;
  } catch {
    return false;
  }
}

if (!isRunning()) {
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [join(here, "index.js"), "--daemon"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
