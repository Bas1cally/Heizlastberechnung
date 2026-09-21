import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/app/config.js";
import { parseEnv } from "../../src/app/env.js";
import { createClock } from "../../src/feeds/clock.js";
import { createLogger, redact } from "../../src/observability/logger.js";

describe("live trading gate", () => {
  it("defaults to observe with live trading off", () => {
    const c = loadConfig({}, []);
    expect(c.mode).toBe("observe");
    expect(c.liveTradingEnabled).toBe(false);
  });
  it("needs BOTH the env flag and --mode live", () => {
    expect(loadConfig({ ENABLE_LIVE_TRADING: "true" }, []).liveTradingEnabled).toBe(false);
    const flagOnly = loadConfig({}, ["--mode", "live"]);
    expect(flagOnly.liveTradingEnabled).toBe(false);
    expect(flagOnly.mode).toBe("shadow");
    const both = loadConfig({ ENABLE_LIVE_TRADING: "true" }, ["--mode=live"]);
    expect(both.liveTradingEnabled).toBe(true);
    expect(both.mode).toBe("live");
  });
  it("rejects an unknown mode", () => {
    expect(() => loadConfig({}, ["--mode", "yolo"])).toThrow(ConfigError);
  });
  it("overrides limits from the environment and keeps the rest", () => {
    const c = loadConfig({ MAX_DAILY_LOSS_USD: "12.5" }, []);
    expect(c.limits.maxDailyLossUsd).toBe(12.5);
    expect(c.limits.maxOpenOrders).toBe(4);
  });
});

describe("parseEnv", () => {
  it("handles quotes, comments, export and CRLF", () => {
    expect(parseEnv('# c\r\nexport A="1"\r\nB=\'2\'\r\nC=x=y\r\n')).toEqual({ A: "1", B: "2", C: "x=y" });
  });
});

describe("logger", () => {
  it("redacts anything that looks like a credential and stringifies bigints", () => {
    expect(redact({ apiKey: "s3cret", stateVersion: 5n, nested: { privateKey: "pk", ok: 1 } }))
      .toEqual({ apiKey: "[redacted]", stateVersion: "5", nested: { privateKey: "[redacted]", ok: 1 } });
  });
  it("writes one JSON object per line above the level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", write: (l) => lines.push(l) }).child({ market: "m" });
    log.debug("hidden");
    log.info("shown", { TYPESAFE_API_KEY: "k" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", msg: "shown", market: "m", TYPESAFE_API_KEY: "[redacted]" });
  });
});

describe("clock drift", () => {
  it("tracks local-minus-server offset and fails closed past tolerance", () => {
    let wall = 10_000;
    const c = createClock({ wall: () => wall, alpha: 1 });
    expect(c.withinTolerance(100)).toBe(true); // unknown drift is not a violation
    c.observeServerTime(9_000);
    expect(c.driftMs()).toBe(1_000);
    expect(c.withinTolerance(500)).toBe(false);
    expect(c.withinTolerance(1_500)).toBe(true);
  });
});
