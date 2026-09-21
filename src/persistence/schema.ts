/** SQLite schema. Every order and fill references the decision that produced it. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS markets (
  market_id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  question TEXT NOT NULL,
  up_asset_id TEXT NOT NULL,
  down_asset_id TEXT NOT NULL,
  opened_at_ms INTEGER NOT NULL,
  closes_at_ms INTEGER NOT NULL,
  tick_size REAL,
  min_order_size REAL,
  resolved_outcome TEXT,
  first_seen_ms INTEGER NOT NULL,
  start_lag_ms INTEGER,
  start_source TEXT,
  resolved_source TEXT
);

CREATE TABLE IF NOT EXISTS ticks (
  id INTEGER PRIMARY KEY,
  market_id TEXT NOT NULL,
  source TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  price REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ticks_market_ts ON ticks(market_id, ts_ms);

CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  id INTEGER PRIMARY KEY,
  market_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  bids_json TEXT NOT NULL,
  asks_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS books_market_ts ON orderbook_snapshots(market_id, received_at_ms);

CREATE TABLE IF NOT EXISTS jev_requests (
  decision_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  state_version TEXT NOT NULL,
  raw_state_version TEXT,
  material_reason TEXT,
  input_hash TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  jev_latency_ms REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS jev_requests_hash ON jev_requests(input_hash);

CREATE TABLE IF NOT EXISTS jev_answers (
  decision_id TEXT PRIMARY KEY REFERENCES jev_requests(decision_id),
  answers_json TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  risk_result TEXT NOT NULL,
  risk_reason TEXT
);

CREATE TABLE IF NOT EXISTS jev_cache (
  input_hash TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  latency_ms REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES jev_requests(decision_id),
  state_version TEXT NOT NULL,
  market_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  side TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  status TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  decision_id TEXT NOT NULL,
  state_version TEXT NOT NULL,
  market_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  side TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  ts_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id INTEGER PRIMARY KEY,
  market_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  inventory_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merges (
  id INTEGER PRIMARY KEY,
  market_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  tx_hash TEXT,
  quantity REAL NOT NULL,
  paired_cost_basis REAL NOT NULL,
  collateral_returned REAL NOT NULL,
  gas REAL NOT NULL DEFAULT 0,
  effective_pair_pnl REAL NOT NULL,
  ts_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY,
  market_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  tx_hash TEXT,
  gross_payout REAL NOT NULL,
  cost_basis REAL NOT NULL,
  fees_gas REAL NOT NULL DEFAULT 0,
  net_pnl REAL NOT NULL,
  ts_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS latency_measurements (
  id INTEGER PRIMARY KEY,
  decision_id TEXT,
  market_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  feed_to_state_ms REAL,
  state_to_jev_ms REAL,
  jev_ms REAL,
  jev_to_submit_ms REAL,
  submit_to_ack_ms REAL,
  feed_to_ack_ms REAL
);

CREATE TABLE IF NOT EXISTS shadow_orders (
  id INTEGER PRIMARY KEY,
  decision_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  side TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  signed INTEGER NOT NULL,
  sign_error TEXT,
  signing_ms REAL NOT NULL,
  expected_price REAL,
  price_at_ack REAL,
  moved_against_bps REAL,
  hypothetical_status TEXT,
  hypothetical_filled REAL,
  hypothetical_avg_price REAL
);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id INTEGER PRIMARY KEY,
  market_id TEXT,
  mode TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  pnl_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  market_id TEXT,
  component TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT
);
`;
