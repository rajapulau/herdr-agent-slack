import { describe, it, expect } from "vitest";
import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("emits structured JSON objects", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.info("hello", { count: 1 });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      name: "test",
      level: "info",
      message: "hello",
      count: 1,
    });
  });

  it("logs without extra data", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.warn("bare");

    expect(logs[0]).toMatchObject({ level: "warn", message: "bare" });
  });

  it("filters sensitive keys from data", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.info("config loaded", { bot_token: "secret123", debug: true });

    expect((logs[0] as any).bot_token).toBeUndefined();
  });
});

describe("reserved envelope fields", () => {
  it("keeps the log's own message when the data carries one too", () => {
    // Call sites pass an error under `message`. It used to overwrite the
    // envelope, so a failure was recorded as the error text alone with no
    // trace of what had failed.
    const written: Record<string, unknown>[] = [];
    const log = createLogger("daemon", (entry) => written.push(entry));

    log.error("Final answer delivery failed", { paneId: "w1:p1", message: "HttpError: boom" });

    expect(written[0].message).toBe("Final answer delivery failed");
    expect(written[0].message_detail).toBe("HttpError: boom");
    expect(written[0].paneId).toBe("w1:p1");
  });

  it("protects every envelope field, not just message", () => {
    const written: Record<string, unknown>[] = [];
    const log = createLogger("daemon", (entry) => written.push(entry));

    log.info("tick", { name: "impostor", level: "debug", timestamp: "1970" });

    expect(written[0].name).toBe("daemon");
    expect(written[0].level).toBe("info");
    expect(written[0].name_detail).toBe("impostor");
    expect(written[0].level_detail).toBe("debug");
    expect(written[0].timestamp_detail).toBe("1970");
  });
});
