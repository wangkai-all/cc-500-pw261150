// 领域计算：全部为纯函数，金额一律使用整数分（cents），费率使用基点（bps，10000 = 100%）。

/** 佣金 = 基数 × 费率（基点），四舍五入到分；负数对称处理（用于退款冲减）。 */
export function mulBps(cents, bps) {
  const sign = cents < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(cents) * bps) / 10000);
}

/**
 * 按比例分摊总额到若干权重（如订单级优惠分摊到各明细），
 * 使用最大余数法保证 Σ分摊结果 === totalCents，分毫不差。
 * weights: 正整数数组（通常为各明细金额）。返回与 weights 等长的整数数组。
 */
export function allocate(totalCents, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    // 权重全为 0 时均分，余数给最后一项
    const each = Math.floor(totalCents / n);
    const res = weights.map(() => each);
    res[n - 1] += totalCents - each * n;
    return res;
  }
  const floors = weights.map((w) => Math.floor((totalCents * w) / sum));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  // 按小数部分从大到小分配剩余的分；并列时权重大者优先
  const orderByFrac = weights
    .map((w, i) => ({ i, frac: (totalCents * w) / sum - floors[i] }))
    .sort((a, b) => b.frac - a.frac || weights[b.i] - weights[a.i] || a.i - b.i);
  const res = floors.slice();
  for (let k = 0; remainder > 0; k = (k + 1) % n) {
    res[orderByFrac[k].i] += 1;
    remainder -= 1;
  }
  return res;
}

/**
 * 计算一个订单的结算快照（纯函数，不写库）。
 * 输入：订单 + 明细 + 订单级优惠 + （截至本期末的）退款 + 本期补贴 + 费率基点。
 * 输出：结算行字段 + 逐项明细（detail），用于追溯。
 */
export function computeOrderLine({ order, items, discounts, refunds, subsidies, rateBps }) {
  const gross = items.reduce((a, it) => a + it.amount_cents, 0);

  // 1) 优惠分摊：订单级优惠按明细金额比例分摊
  const discountTotal = discounts.reduce((a, d) => a + d.amount_cents, 0);
  const discountAlloc = allocate(
    discountTotal,
    items.map((it) => it.amount_cents)
  );

  // 2) 退款归集：指定明细的退款落到该明细；订单级退款按比例分摊
  const refundAlloc = items.map(() => 0);
  for (const rf of refunds) {
    if (rf.item_id) {
      const idx = items.findIndex((it) => it.id === rf.item_id);
      if (idx >= 0) refundAlloc[idx] += rf.amount_cents;
    } else {
      const parts = allocate(
        rf.amount_cents,
        items.map((it) => it.amount_cents)
      );
      parts.forEach((p, i) => (refundAlloc[i] += p));
    }
  }

  // 3) 逐明细计佣基数 = 金额 - 分摊优惠 - 分摊退款（不为负）
  const itemBreakdown = items.map((it, i) => {
    const base = Math.max(0, it.amount_cents - discountAlloc[i] - refundAlloc[i]);
    return {
      item_id: it.id,
      title: it.title,
      amount_cents: it.amount_cents,
      discount_cents: discountAlloc[i],
      refund_cents: refundAlloc[i],
      base_cents: base,
    };
  });

  const refundTotal = refunds.reduce((a, r) => a + r.amount_cents, 0);
  const subsidyTotal = subsidies.reduce((a, s) => a + s.amount_cents, 0);
  const base = itemBreakdown.reduce((a, b) => a + b.base_cents, 0);
  const commission = mulBps(base, rateBps);
  // 商家应得 = 计佣基数 - 佣金 + 平台补贴（补贴不计佣）
  const payout = base - commission + subsidyTotal;

  return {
    order_id: order.id,
    line_type: 'order',
    gross_cents: gross,
    discount_cents: discountTotal,
    refund_cents: refundTotal,
    subsidy_cents: subsidyTotal,
    base_cents: base,
    rate_bps: rateBps,
    commission_cents: commission,
    payout_cents: payout,
    detail: {
      items: itemBreakdown,
      discounts: discounts.map((d) => ({ label: d.label, amount_cents: d.amount_cents })),
      refunds: refunds.map((r) => ({ id: r.id, item_id: r.item_id, amount_cents: r.amount_cents, period: r.period })),
      subsidies: subsidies.map((s) => ({ label: s.label, amount_cents: s.amount_cents })),
    },
  };
}

/**
 * 跨期调整行：本期发生的退款/补贴，但订单属于已结算的历史周期。
 * 退款 → 负基数、负佣金（冲回）；补贴 → 仅增加应付款。
 */
export function computeAdjustmentLine({ order, kind, amountCents, label, rateBps, refId }) {
  const isRefund = kind === 'refund';
  const base = isRefund ? -amountCents : 0;
  const commission = mulBps(base, rateBps);
  const subsidy = isRefund ? 0 : amountCents;
  return {
    order_id: order.id,
    line_type: 'adjustment',
    gross_cents: 0,
    discount_cents: 0,
    refund_cents: isRefund ? amountCents : 0,
    subsidy_cents: subsidy,
    base_cents: base,
    rate_bps: rateBps,
    commission_cents: commission,
    payout_cents: base - commission + subsidy,
    detail: { adjustment: { kind, label, ref_id: refId, amount_cents: amountCents } },
  };
}

/**
 * 费率修订差异行：同一基数在新旧费率下的佣金差。
 * commission 为差额（新 - 旧），payout 为其相反数（佣金降 → 商家多得）。
 */
export function computeDifferenceLine({ sourceLine, oldBps, newBps }) {
  const oldC = mulBps(sourceLine.base_cents, oldBps);
  const newC = mulBps(sourceLine.base_cents, newBps);
  const diff = newC - oldC;
  return {
    order_id: sourceLine.order_id,
    line_type: 'difference',
    gross_cents: 0,
    discount_cents: 0,
    refund_cents: 0,
    subsidy_cents: 0,
    base_cents: sourceLine.base_cents,
    rate_bps: newBps,
    commission_cents: diff,
    payout_cents: -diff,
    detail: {
      difference: {
        source_line_id: sourceLine.id,
        old_rate_bps: oldBps,
        new_rate_bps: newBps,
        old_commission_cents: oldC,
        new_commission_cents: newC,
      },
    },
  };
}

/** 分 → 元 显示 */
export function fmtCents(c) {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
