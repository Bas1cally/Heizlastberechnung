export interface Series {
  n: number;
  time: Float64Array; open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array; volume: Float64Array;
}
/** Rows: [unixSeconds, open, high, low, close, volume] */
export type Candle = [number, number, number, number, number, number];
export function makeSeries(candles: readonly Candle[]): Series;
export function rolling(s: Series, L: number): { mean: Float64Array; std: Float64Array; hh: Float64Array };
export function zscore(s: Series, L: number, j: number): number;
export function volatility(s: Series, j: number, w?: number): number;
