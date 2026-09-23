// Price series with causal rolling indicators. Nothing here looks at future bars:
// the value at index j only uses bars 0..j (or 0..j-1 for the breakout high).

export function makeSeries(candles) {
  const n = candles.length;
  const s = {
    n,
    time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n),
    low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n),
    _cache: new Map(),
  };
  candles.forEach((c, i) => { s.time[i] = c[0]; s.open[i] = c[1]; s.high[i] = c[2]; s.low[i] = c[3]; s.close[i] = c[4]; s.volume[i] = c[5]; });
  return s;
}

// Rolling mean / std of close over [j-L+1, j] and the highest high over [j-L, j-1].
export function rolling(s, L) {
  let r = s._cache.get(L);
  if (r) return r;
  const { n, close, high } = s;
  const mean = new Float64Array(n).fill(NaN), std = new Float64Array(n).fill(NaN), hh = new Float64Array(n).fill(NaN);
  let sum = 0, sum2 = 0;
  for (let j = 0; j < n; j++) {
    sum += close[j]; sum2 += close[j] * close[j];
    if (j >= L) { sum -= close[j - L]; sum2 -= close[j - L] * close[j - L]; }
    if (j >= L - 1) {
      const m = sum / L;
      mean[j] = m; std[j] = Math.sqrt(Math.max(0, sum2 / L - m * m));
    }
  }
  // monotonic deque for the breakout high of the previous L bars
  const dq = [];
  for (let j = 0; j < n; j++) {
    if (j >= L) hh[j] = high[dq[0]];
    while (dq.length && high[dq[dq.length - 1]] <= high[j]) dq.pop();
    dq.push(j);
    while (dq[0] <= j - L) dq.shift();
  }
  r = { mean, std, hh };
  s._cache.set(L, r);
  return r;
}

export function zscore(s, L, j) {
  const r = rolling(s, L);
  const sd = r.std[j];
  return sd > 0 ? (s.close[j] - r.mean[j]) / sd : 0;
}

// Realised volatility of hourly log returns over the last `w` bars ending at j.
export function volatility(s, j, w = 24) {
  let a = 0, b = 0, k = 0;
  for (let i = Math.max(1, j - w + 1); i <= j; i++) { const x = Math.log(s.close[i] / s.close[i - 1]); a += x; b += x * x; k++; }
  if (k < 2) return 0;
  const m = a / k;
  return Math.sqrt(Math.max(0, b / k - m * m));
}
