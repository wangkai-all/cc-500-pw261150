import {
  computeOrderLine,
  computeAdjustmentLine,
  computeDifferenceLine,
} from './domain.js';

/**
 * 数据访问 + 结算工作流。所有多步写入都包在事务里。
 */
export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---------- 查询 ----------

  getRateVersion(id) {
    return this.db.prepare('SELECT * FROM rate_versions WHERE id = ?').get(id);
  }

  listRateVersions() {
    return this.db.prepare('SELECT * FROM rate_versions ORDER BY id').all();
  }

  listBatches() {
    return this.db
      .prepare(
        `SELECT b.*, r.name AS rate_name, r.rate_bps AS batch_rate_bps,
                (SELECT COUNT(*) FROM settlement_lines l WHERE l.batch_id = b.id) AS line_count,
                (SELECT COUNT(*) FROM disputes d WHERE d.batch_id = b.id AND d.status = 'open') AS open_disputes,
                p.paid_at
         FROM settlement_batches b
         JOIN rate_versions r ON r.id = b.rate_version_id
         LEFT JOIN payments p ON p.batch_id = b.id
         ORDER BY b.id`
      )
      .all();
  }

  getBatch(id) {
    return this.db
      .prepare(
        `SELECT b.*, r.name AS rate_name, r.rate_bps AS batch_rate_bps
         FROM settlement_batches b JOIN rate_versions r ON r.id = b.rate_version_id
         WHERE b.id = ?`
      )
      .get(id);
  }

  listLines(batchId) {
    return this.db
      .prepare(
        `SELECT l.*, o.merchant_id, m.name AS merchant_name, r.name AS rate_name
         FROM settlement_lines l
         JOIN orders o ON o.id = l.order_id
         JOIN merchants m ON m.id = o.merchant_id
         JOIN rate_versions r ON r.id = l.rate_version_id
         WHERE l.batch_id = ? ORDER BY l.id`
      )
      .all(batchId)
      .map((l) => ({ ...l, detail: JSON.parse(l.detail_json) }));
  }

  listDisputes() {
    return this.db
      .prepare(
        `SELECT d.*, l.order_id, l.commission_cents AS line_commission_cents,
                b.period, b.batch_type, r.name AS rate_name, r.rate_bps
         FROM disputes d
         JOIN settlement_lines l ON l.id = d.settlement_line_id
         JOIN settlement_batches b ON b.id = d.batch_id
         JOIN rate_versions r ON r.id = d.rate_version_id
         ORDER BY d.id`
      )
      .all();
  }

  listApprovals(batchId) {
    return this.db
      .prepare('SELECT * FROM approvals WHERE batch_id = ? ORDER BY id')
      .all(batchId);
  }

  /** 订单追溯：订单 → 拆分/优惠/退款/补贴 → 出现在哪些结算批次与版本 */
  traceOrder(orderId) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return null;
    const items = this.db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    const discounts = this.db.prepare('SELECT * FROM order_discounts WHERE order_id = ?').all(orderId);
    const refunds = this.db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY refunded_at').all(orderId);
    const subsidies = this.db.prepare('SELECT * FROM subsidies WHERE order_id = ?').all(orderId);
    const lines = this.db
      .prepare(
        `SELECT l.*, b.period, b.batch_type, b.status AS batch_status, r.name AS rate_name
         FROM settlement_lines l
         JOIN settlement_batches b ON b.id = l.batch_id
         JOIN rate_versions r ON r.id = l.rate_version_id
         WHERE l.order_id = ? ORDER BY l.id`
      )
      .all(orderId)
      .map((l) => ({ ...l, detail: JSON.parse(l.detail_json) }));
    return { order, items, discounts, refunds, subsidies, settlement_lines: lines };
  }

  listOrders() {
    return this.db
      .prepare(
        `SELECT o.*, m.name AS merchant_name,
                (SELECT COALESCE(SUM(amount_cents),0) FROM order_items i WHERE i.order_id = o.id) AS gross_cents
         FROM orders o JOIN merchants m ON m.id = o.merchant_id ORDER BY o.id`
      )
      .all();
  }

  listPayments() {
    return this.db.prepare('SELECT * FROM payments ORDER BY id').all();
  }

  // ---------- 费率版本 ----------

  createRateVersion({ name, rate_bps, effective_from, supersedes_id = null }) {
    const tx = this.db.prepare(
      `INSERT INTO rate_versions (name, rate_bps, effective_from, supersedes_id) VALUES (?,?,?,?)`
    );
    let newId;
    this.db.exec('BEGIN');
    try {
      if (supersedes_id) {
        this.db.prepare(`UPDATE rate_versions SET status = 'superseded' WHERE id = ?`).run(supersedes_id);
      }
      newId = tx.run(name, rate_bps, effective_from, supersedes_id).lastInsertRowid;
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getRateVersion(Number(newId));
  }

  // ---------- 结算运行（幂等 / 可重放） ----------

  /**
   * 运行某周期的常规结算。
   * 幂等规则：
   *  - 批次仍处 calculating：删除旧行事务性重算（可吸收新录入的退款/补贴），不产生重复数据；
   *  - 批次已提交/批准/付款（已冻结）：直接返回原批次（重放安全）。
   * 覆盖：订单拆分、优惠分摊、本期退款、跨期退款调整、本期/跨期补贴。
   */
  runSettlement(period, rateVersionId) {
    const rv = this.getRateVersion(rateVersionId);
    if (!rv) throw httpError(404, `费率版本 ${rateVersionId} 不存在`);

    const existing = this.db
      .prepare(
        `SELECT * FROM settlement_batches
         WHERE period = ? AND rate_version_id = ? AND batch_type = 'normal' AND status != 'rejected'`
      )
      .get(period, rateVersionId);
    if (existing && existing.status !== 'calculating') {
      return { batch: this.getBatch(existing.id), replayed: true };
    }

    this.db.exec('BEGIN');
    try {
      let batchId;
      let recalculated = false;
      if (existing) {
        // 重算：同事务删除旧行再写新行，行数与合计始终一致
        batchId = existing.id;
        recalculated = true;
        this.db.prepare('DELETE FROM settlement_lines WHERE batch_id = ?').run(batchId);
      } else {
        batchId = Number(
          this.db
            .prepare(
              `INSERT INTO settlement_batches (period, rate_version_id, batch_type) VALUES (?,?,'normal')`
            )
            .run(period, rateVersionId).lastInsertRowid
        );
      }

      const insertLine = this.db.prepare(
        `INSERT INTO settlement_lines
           (batch_id, order_id, line_type, gross_cents, discount_cents, refund_cents,
            subsidy_cents, base_cents, rate_version_id, rate_bps, commission_cents,
            payout_cents, source_line_id, detail_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const writeLine = (line, sourceLineId = null) =>
        insertLine.run(
          batchId, line.order_id, line.line_type, line.gross_cents, line.discount_cents,
          line.refund_cents, line.subsidy_cents, line.base_cents, rateVersionId,
          line.rate_bps, line.commission_cents, line.payout_cents, sourceLineId,
          JSON.stringify(line.detail)
        );

      // 1) 本期订单：拆分 + 优惠分摊 + 截至本期末的退款 + 本期补贴
      const orders = this.db.prepare('SELECT * FROM orders WHERE period = ? ORDER BY id').all(period);
      for (const order of orders) {
        const items = this.db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
        const discounts = this.db.prepare('SELECT * FROM order_discounts WHERE order_id = ?').all(order.id);
        const refunds = this.db
          .prepare('SELECT * FROM refunds WHERE order_id = ? AND period <= ?')
          .all(order.id, period);
        const subsidies = this.db
          .prepare('SELECT * FROM subsidies WHERE order_id = ? AND period = ?')
          .all(order.id, period);
        writeLine(computeOrderLine({ order, items, discounts, refunds, subsidies, rateBps: rv.rate_bps }));
      }

      // 2) 跨期退款调整：退款发生在本期、订单属于历史周期
      const crossRefunds = this.db
        .prepare(
          `SELECT r.*, o.period AS order_period FROM refunds r
           JOIN orders o ON o.id = r.order_id
           WHERE r.period = ? AND o.period < ?`
        )
        .all(period, period);
      for (const rf of crossRefunds) {
        writeLine(
          computeAdjustmentLine({
            order: { id: rf.order_id },
            kind: 'refund',
            amountCents: rf.amount_cents,
            label: `跨期退款 ${rf.id}（订单周期 ${rf.order_period}）`,
            rateBps: rv.rate_bps,
            refId: rf.id,
          })
        );
      }

      // 3) 跨期补贴调整：补贴生效在本期、订单属于历史周期
      const crossSubsidies = this.db
        .prepare(
          `SELECT s.*, o.period AS order_period FROM subsidies s
           JOIN orders o ON o.id = s.order_id
           WHERE s.period = ? AND o.period < ?`
        )
        .all(period, period);
      for (const sb of crossSubsidies) {
        writeLine(
          computeAdjustmentLine({
            order: { id: sb.order_id },
            kind: 'subsidy',
            amountCents: sb.amount_cents,
            label: `跨期补贴：${sb.label}（订单周期 ${sb.order_period}）`,
            rateBps: rv.rate_bps,
            refId: `SUB-${sb.id}`,
          })
        );
      }

      this.#recalcTotals(batchId);
      this.db.exec('COMMIT');
      return { batch: this.getBatch(batchId), replayed: false, recalculated };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * 费率修订：对已结算的常规批次按新费率生成差异批次（不改动原批次，历史可追溯）。
   * 同一原批次 + 同一新费率版本只生成一次（幂等）。
   */
  reviseRate(period, newRateVersionId) {
    const newRv = this.getRateVersion(newRateVersionId);
    if (!newRv) throw httpError(404, `费率版本 ${newRateVersionId} 不存在`);

    const parent = this.db
      .prepare(
        `SELECT * FROM settlement_batches
         WHERE period = ? AND batch_type = 'normal' AND status IN ('approved','paid')
         ORDER BY id DESC LIMIT 1`
      )
      .get(period);
    if (!parent) throw httpError(409, `周期 ${period} 没有已批准/已付款的常规批次，无法修订`);
    if (parent.rate_version_id === newRateVersionId)
      throw httpError(409, '新费率版本与原批次相同，无需修订');

    const dup = this.db
      .prepare(
        `SELECT * FROM settlement_batches
         WHERE parent_batch_id = ? AND rate_version_id = ? AND batch_type = 'difference' AND status != 'rejected'`
      )
      .get(parent.id, newRateVersionId);
    if (dup) return { batch: this.getBatch(dup.id), replayed: true };

    const oldRv = this.getRateVersion(parent.rate_version_id);
    const parentLines = this.db
      .prepare('SELECT * FROM settlement_lines WHERE batch_id = ?')
      .all(parent.id);

    this.db.exec('BEGIN');
    try {
      const batchId = Number(
        this.db
          .prepare(
            `INSERT INTO settlement_batches (period, rate_version_id, batch_type, parent_batch_id)
             VALUES (?,?,'difference',?)`
          )
          .run(period, newRateVersionId, parent.id).lastInsertRowid
      );
      const insertLine = this.db.prepare(
        `INSERT INTO settlement_lines
           (batch_id, order_id, line_type, gross_cents, discount_cents, refund_cents,
            subsidy_cents, base_cents, rate_version_id, rate_bps, commission_cents,
            payout_cents, source_line_id, detail_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const src of parentLines) {
        const line = computeDifferenceLine({
          sourceLine: src,
          oldBps: oldRv.rate_bps,
          newBps: newRv.rate_bps,
        });
        insertLine.run(
          batchId, line.order_id, line.line_type, line.gross_cents, line.discount_cents,
          line.refund_cents, line.subsidy_cents, line.base_cents, newRateVersionId,
          line.rate_bps, line.commission_cents, line.payout_cents, src.id,
          JSON.stringify(line.detail)
        );
      }
      this.#recalcTotals(batchId);
      this.db.exec('COMMIT');
      return { batch: this.getBatch(batchId), replayed: false };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- 审批流转 ----------

  #transition(batchId, from, to, action, actor, note) {
    const batch = this.getBatch(batchId);
    if (!batch) throw httpError(404, `批次 ${batchId} 不存在`);
    if (batch.status !== from)
      throw httpError(409, `批次 #${batchId} 当前状态为 ${batch.status}，不能执行 ${action}（要求 ${from}）`);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE settlement_batches SET status = ? WHERE id = ?').run(to, batchId);
      this.db
        .prepare('INSERT INTO approvals (batch_id, action, actor, note) VALUES (?,?,?,?)')
        .run(batchId, action, actor || 'system', note || null);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getBatch(batchId);
  }

  submit(batchId, actor) {
    return this.#transition(batchId, 'calculating', 'pending_approval', 'submit', actor);
  }

  approve(batchId, actor, note) {
    return this.#transition(batchId, 'pending_approval', 'approved', 'approve', actor, note);
  }

  reject(batchId, actor, note) {
    return this.#transition(batchId, 'pending_approval', 'rejected', 'reject', actor, note);
  }

  /**
   * 付款：仅 approved 批次可付；payments.batch_id 唯一约束 + 状态迁移
   * 双重保证，任何重复付款（含重放请求）都会被拒绝。
   */
  pay(batchId, actor, idempotencyKey = null) {
    const batch = this.getBatch(batchId);
    if (!batch) throw httpError(404, `批次 ${batchId} 不存在`);
    if (batch.status === 'paid') throw httpError(409, `批次 #${batchId} 已付款，拒绝重复付款`);
    if (batch.status !== 'approved')
      throw httpError(409, `批次 #${batchId} 状态为 ${batch.status}，未批准不能付款`);

    const key = idempotencyKey || `pay-batch-${batchId}`;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO payments (batch_id, amount_cents, idempotency_key) VALUES (?,?,?)')
        .run(batchId, batch.total_payout_cents, key);
      this.db.prepare(`UPDATE settlement_batches SET status = 'paid' WHERE id = ?`).run(batchId);
      this.db
        .prepare('INSERT INTO approvals (batch_id, action, actor, note) VALUES (?,?,?,?)')
        .run(batchId, 'pay', actor || 'system', `付款 ${batch.total_payout_cents} 分`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      if (String(e.message).includes('UNIQUE'))
        throw httpError(409, `批次 #${batchId} 已存在付款记录，拒绝重复付款`);
      throw e;
    }
    return this.getBatch(batchId);
  }

  // ---------- 争议（绑定结算版本） ----------

  createDispute({ settlement_line_id, reason }) {
    const line = this.db
      .prepare('SELECT * FROM settlement_lines WHERE id = ?')
      .get(settlement_line_id);
    if (!line) throw httpError(404, `结算行 ${settlement_line_id} 不存在`);
    // 争议针对已冻结（已提交及以后）的结算版本；计算中的批次可能重算删行
    const batch = this.db
      .prepare('SELECT status FROM settlement_batches WHERE id = ?')
      .get(line.batch_id);
    if (batch.status === 'calculating')
      throw httpError(409, '批次仍在计算中，提交审批后才能发起争议');
    const id = this.db
      .prepare(
        `INSERT INTO disputes (settlement_line_id, batch_id, rate_version_id, reason)
         VALUES (?,?,?,?)`
      )
      .run(settlement_line_id, line.batch_id, line.rate_version_id, reason).lastInsertRowid;
    return this.db.prepare('SELECT * FROM disputes WHERE id = ?').get(Number(id));
  }

  resolveDispute(id, { status, resolution }) {
    if (!['resolved', 'rejected'].includes(status))
      throw httpError(400, 'status 必须是 resolved 或 rejected');
    const d = this.db.prepare('SELECT * FROM disputes WHERE id = ?').get(id);
    if (!d) throw httpError(404, `争议 ${id} 不存在`);
    if (d.status !== 'open') throw httpError(409, `争议 ${id} 已结案（${d.status}）`);
    this.db
      .prepare(`UPDATE disputes SET status = ?, resolution = ?, resolved_at = datetime('now') WHERE id = ?`)
      .run(status, resolution || null, id);
    return this.db.prepare('SELECT * FROM disputes WHERE id = ?').get(id);
  }

  // ---------- 业务数据录入（演示/测试用） ----------

  addRefund({ id, order_id, item_id = null, amount_cents, refunded_at, period }) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
    if (!order) throw httpError(404, `订单 ${order_id} 不存在`);
    if (item_id) {
      const item = this.db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(item_id, order_id);
      if (!item) throw httpError(404, `明细 ${item_id} 不属于订单 ${order_id}`);
    }
    // 守卫：退款计入的周期若已有冻结（已提交/批准/付款）的常规批次，
    // 该退款永远不会被任何批次拾起 → 拒绝并提示计入后续开放周期
    const closed = this.db
      .prepare(
        `SELECT id, status FROM settlement_batches
         WHERE period = ? AND batch_type = 'normal' AND status IN ('pending_approval','approved','paid')`
      )
      .get(period);
    if (closed)
      throw httpError(409,
        `周期 ${period} 的批次 #${closed.id} 已冻结（${closed.status}），退款请计入后续开放周期，否则将漏结`);
    this.db
      .prepare('INSERT INTO refunds (id, order_id, item_id, amount_cents, refunded_at, period) VALUES (?,?,?,?,?,?)')
      .run(id, order_id, item_id, amount_cents, refunded_at, period);
    return this.db.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
  }

  #recalcTotals(batchId) {
    this.db
      .prepare(
        `UPDATE settlement_batches SET
           total_commission_cents = (SELECT COALESCE(SUM(commission_cents),0) FROM settlement_lines WHERE batch_id = ?),
           total_payout_cents     = (SELECT COALESCE(SUM(payout_cents),0)     FROM settlement_lines WHERE batch_id = ?)
         WHERE id = ?`
      )
      .run(batchId, batchId, batchId);
  }
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
