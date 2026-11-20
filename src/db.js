import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 费率版本：每次修订产生新版本，旧版本置为 superseded，历史结算永远指向原版本
CREATE TABLE IF NOT EXISTS rate_versions (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  rate_bps      INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  effective_from TEXT NOT NULL,              -- 生效结算周期 YYYY-MM
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  supersedes_id INTEGER REFERENCES rate_versions(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merchants (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  created_at  TEXT NOT NULL,
  period      TEXT NOT NULL,                 -- 订单归属结算周期（按下单时间）
  status      TEXT NOT NULL DEFAULT 'completed'
);

-- 订单拆分：一笔订单拆成多个子明细
CREATE TABLE IF NOT EXISTS order_items (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  title        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);

-- 订单级优惠（结算时按比例分摊到明细）
CREATE TABLE IF NOT EXISTS order_discounts (
  id           INTEGER PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  label        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);

-- 退款：支持部分退款；period 为退款发生周期（可能晚于订单周期 → 跨期）
CREATE TABLE IF NOT EXISTS refunds (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  item_id      TEXT REFERENCES order_items(id),   -- NULL 表示订单级退款，按比例分摊
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  refunded_at  TEXT NOT NULL,
  period       TEXT NOT NULL
);

-- 平台补贴（不计佣，直接增加商家应得）
CREATE TABLE IF NOT EXISTS subsidies (
  id           INTEGER PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  label        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  period       TEXT NOT NULL                  -- 补贴生效周期（可跨期）
);

-- 结算批次：normal=常规结算，difference=费率修订差异批次
CREATE TABLE IF NOT EXISTS settlement_batches (
  id             INTEGER PRIMARY KEY,
  period         TEXT NOT NULL,
  rate_version_id INTEGER NOT NULL REFERENCES rate_versions(id),
  batch_type     TEXT NOT NULL DEFAULT 'normal' CHECK (batch_type IN ('normal','difference')),
  parent_batch_id INTEGER REFERENCES settlement_batches(id),  -- difference → 被修订的原批次
  status         TEXT NOT NULL DEFAULT 'calculating'
                 CHECK (status IN ('calculating','pending_approval','approved','paid','rejected')),
  total_commission_cents INTEGER NOT NULL DEFAULT 0,
  total_payout_cents     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 幂等约束①：同一周期+费率版本只允许一个未驳回的常规批次（重放安全）
CREATE UNIQUE INDEX IF NOT EXISTS uq_normal_batch
  ON settlement_batches (period, rate_version_id)
  WHERE batch_type = 'normal' AND status != 'rejected';

-- 幂等约束②：同一原批次对同一新费率版本只允许一个差异批次
CREATE UNIQUE INDEX IF NOT EXISTS uq_difference_batch
  ON settlement_batches (parent_batch_id, rate_version_id)
  WHERE batch_type = 'difference' AND status != 'rejected';

-- 结算明细行：每行可追溯到原订单与费率版本（含费率快照）
CREATE TABLE IF NOT EXISTS settlement_lines (
  id              INTEGER PRIMARY KEY,
  batch_id        INTEGER NOT NULL REFERENCES settlement_batches(id),
  order_id        TEXT NOT NULL REFERENCES orders(id),
  line_type       TEXT NOT NULL CHECK (line_type IN ('order','adjustment','difference')),
  gross_cents     INTEGER NOT NULL,
  discount_cents  INTEGER NOT NULL,
  refund_cents    INTEGER NOT NULL,
  subsidy_cents   INTEGER NOT NULL,
  base_cents      INTEGER NOT NULL,           -- 计佣基数
  rate_version_id INTEGER NOT NULL REFERENCES rate_versions(id),
  rate_bps        INTEGER NOT NULL,           -- 费率快照（防后续改库导致对不上）
  commission_cents INTEGER NOT NULL,
  payout_cents    INTEGER NOT NULL,
  source_line_id  INTEGER REFERENCES settlement_lines(id),  -- difference 行 → 原行
  detail_json     TEXT NOT NULL               -- 逐项分摊/退款/补贴快照
);
CREATE INDEX IF NOT EXISTS idx_lines_batch ON settlement_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_lines_order ON settlement_lines(order_id);

-- 付款记录：batch_id 唯一 → 从数据库层面阻止重复付款
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY,
  batch_id        INTEGER NOT NULL UNIQUE REFERENCES settlement_batches(id),
  amount_cents    INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  paid_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 争议：绑定结算行 + 结算批次 + 费率版本（即"结算版本"）
CREATE TABLE IF NOT EXISTS disputes (
  id                 INTEGER PRIMARY KEY,
  settlement_line_id INTEGER NOT NULL REFERENCES settlement_lines(id),
  batch_id           INTEGER NOT NULL REFERENCES settlement_batches(id),
  rate_version_id    INTEGER NOT NULL REFERENCES rate_versions(id),
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  resolution         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT
);

-- 审批流水
CREATE TABLE IF NOT EXISTS approvals (
  id         INTEGER PRIMARY KEY,
  batch_id   INTEGER NOT NULL REFERENCES settlement_batches(id),
  action     TEXT NOT NULL CHECK (action IN ('submit','approve','reject','pay')),
  actor      TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(path = process.env.DB_PATH || 'settlement.db') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
