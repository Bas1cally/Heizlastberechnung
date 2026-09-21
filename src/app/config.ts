import { z } from "zod";
import { DEFAULT_LIMITS, type RiskLimits } from "../risk/limits.js";

export const BOT_MODES = ["observe", "paper", "shadow", "live"] as const;
export type BotMode = (typeof BOT_MODES)[number];

const bool = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()));

const num = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? fallback : Number(v)))
    .pipe(z.number().finite());

const EnvSchema = z.object({
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_DEFAULT_MODEL: z.string().optional(),

  POLYMARKET_PRIVATE_KEY: z.string().optional(),
  POLYMARKET_DEPOSIT_WALLET: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  BOT_MODE: z.enum(BOT_MODES).default("observe"),
  ENABLE_LIVE_TRADING: bool,

  MAX_MARKET_EXPOSURE_USD: num(DEFAULT_LIMITS.maxMarketExposureUsd),
  MAX_TOTAL_EXPOSURE_USD: num(DEFAULT_LIMITS.maxTotalExposureUsd),
  MAX_UNPAIRED_EXPOSURE_USD: num(DEFAULT_LIMITS.maxUnpairedExposureUsd),
  MAX_DAILY_LOSS_USD: num(DEFAULT_LIMITS.maxDailyLossUsd),
  MAX_CHAINLINK_AGE_MS: num(DEFAULT_LIMITS.maxChainlinkAgeMs),
  MAX_ORDERBOOK_AGE_MS: num(DEFAULT_LIMITS.maxOrderbookAgeMs),
  MAX_JEV_LATENCY_MS: num(DEFAULT_LIMITS.maxJevLatencyMs),

  // Limited live (brief §40): deliberately small, separate from the simulation limits.
  LIVE_MAX_ORDER_SIZE_SHARES: num(5),
  LIVE_MAX_MARKET_EXPOSURE_USD: num(10),
  LIVE_MAX_TOTAL_EXPOSURE_USD: num(20),
  LIVE_MAX_UNPAIRED_EXPOSURE_USD: num(10),
  LIVE_MAX_DAILY_LOSS_USD: num(10),

  // Market window length; the slug is derived from the clock (src/market/window.ts).
  MARKET_DURATION_SECONDS: num(300),
  CHAINLINK_SYMBOL: z.string().default("btc/usd"),
  /** TWAP window the markets resolve on (market rules: 60 s). */
  CHAINLINK_TWAP_SECONDS: z.string().optional().transform((v) => (v === "30" ? 30 : 60)).pipe(z.union([z.literal(30), z.literal(60)])),

  // Decision cadence.
  JEV_COALESCE_MS: num(15),
  JEV_MIN_INTERVAL_MS: num(1_000),
  JEV_HEARTBEAT_MS: num(5_000),
  MAX_CLOCK_DRIFT_MS: num(3_000),
});

export interface AppConfig {
  readonly mode: BotMode;
  readonly liveTradingEnabled: boolean;
  readonly typesafeApiKey: string | undefined;
  readonly typesafeModel: string | undefined;
  readonly databaseUrl: string;
  readonly limits: RiskLimits;
  /** The limits a live bot runs under: the simulation limits capped by the LIVE_* values. */
  readonly liveLimits: RiskLimits;
  readonly marketDurationSeconds: number;
  readonly chainlinkSymbol: string;
  readonly chainlinkTwapSeconds: 30 | 60;
  readonly jev: { readonly coalesceMs: number; readonly minIntervalMs: number; readonly heartbeatMs: number };
  readonly maxClockDriftMs: number;
  readonly hasPolymarketKey: boolean;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Build the config. Live execution needs BOTH the env flag and `--mode live`;
 * with either missing, `mode` is downgraded and submission stays impossible.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;

  const modeArg = argv.find((a, i) => argv[i - 1] === "--mode") ?? argv.find((a) => a.startsWith("--mode="))?.split("=")[1];
  let mode: BotMode = e.BOT_MODE;
  if (modeArg !== undefined) {
    if (!(BOT_MODES as readonly string[]).includes(modeArg)) throw new ConfigError(`unknown --mode ${modeArg}`);
    mode = modeArg as BotMode;
  }

  const liveTradingEnabled = mode === "live" && e.ENABLE_LIVE_TRADING;
  if (mode === "live" && !e.ENABLE_LIVE_TRADING) mode = "shadow";

  const limits: RiskLimits = {
    ...DEFAULT_LIMITS,
    maxMarketExposureUsd: e.MAX_MARKET_EXPOSURE_USD,
    maxTotalExposureUsd: e.MAX_TOTAL_EXPOSURE_USD,
    maxUnpairedExposureUsd: e.MAX_UNPAIRED_EXPOSURE_USD,
    maxDailyLossUsd: e.MAX_DAILY_LOSS_USD,
    maxChainlinkAgeMs: e.MAX_CHAINLINK_AGE_MS,
    maxOrderbookAgeMs: e.MAX_ORDERBOOK_AGE_MS,
    maxJevLatencyMs: e.MAX_JEV_LATENCY_MS,
  };
  return {
    mode,
    liveTradingEnabled,
    typesafeApiKey: e.TYPESAFE_API_KEY?.trim() || undefined,
    typesafeModel: e.TYPESAFE_DEFAULT_MODEL?.trim() || undefined,
    databaseUrl: e.DATABASE_URL?.trim() || "data/bot.sqlite",
    limits,
    // A live bot never runs above the LIVE_* caps, whatever the simulation limits say.
    liveLimits: {
      ...limits,
      maxOrderSizeShares: Math.min(limits.maxOrderSizeShares, e.LIVE_MAX_ORDER_SIZE_SHARES),
      maxMarketExposureUsd: Math.min(limits.maxMarketExposureUsd, e.LIVE_MAX_MARKET_EXPOSURE_USD),
      maxTotalExposureUsd: Math.min(limits.maxTotalExposureUsd, e.LIVE_MAX_TOTAL_EXPOSURE_USD),
      maxUnpairedExposureUsd: Math.min(limits.maxUnpairedExposureUsd, e.LIVE_MAX_UNPAIRED_EXPOSURE_USD),
      maxDailyLossUsd: Math.min(limits.maxDailyLossUsd, e.LIVE_MAX_DAILY_LOSS_USD),
    },
    marketDurationSeconds: e.MARKET_DURATION_SECONDS,
    chainlinkSymbol: e.CHAINLINK_SYMBOL,
    chainlinkTwapSeconds: e.CHAINLINK_TWAP_SECONDS,
    jev: { coalesceMs: e.JEV_COALESCE_MS, minIntervalMs: e.JEV_MIN_INTERVAL_MS, heartbeatMs: e.JEV_HEARTBEAT_MS },
    maxClockDriftMs: e.MAX_CLOCK_DRIFT_MS,
    hasPolymarketKey: Boolean(e.POLYMARKET_PRIVATE_KEY?.trim()),
  };
}
