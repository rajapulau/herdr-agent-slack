export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

type LogLevel = "info" | "warn" | "error" | "debug";

const SENSITIVE_KEYS = ["bot_token", "token", "chat_id", "password", "secret"];
/** Envelope fields a caller's data must not overwrite. */
const RESERVED_KEYS = new Set(["name", "level", "message", "timestamp"]);

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEYS.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export function createLogger(
  name: string,
  writeFn: (entry: Record<string, unknown>) => void = (e) => {
    process.stderr.write(JSON.stringify(e) + "\n");
  }
): Logger {
  function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    const entry: Record<string, unknown> = { name, level, message, timestamp: new Date().toISOString() };
    // The envelope wins. Call sites routinely pass an error under `message`,
    // which used to overwrite the log's own message — so a delivery failure
    // was recorded as `"message":"HttpError: …"` with no trace of WHAT had
    // failed, which is most of what a log line is for.
    if (data) {
      for (const [key, value] of Object.entries(redact(data))) {
        entry[RESERVED_KEYS.has(key) ? `${key}_detail` : key] = value;
      }
    }
    writeFn(entry);
  }
  return {
    info: (m, d) => log("info", m, d),
    warn: (m, d) => log("warn", m, d),
    error: (m, d) => log("error", m, d),
    debug: (m, d) => log("debug", m, d),
  };
}
