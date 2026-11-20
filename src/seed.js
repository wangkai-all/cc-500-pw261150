// 演示数据：覆盖订单拆分、优惠分摊、部分退款（同期+跨期）、补贴（同期+跨期）、
// 费率版本修订（差异批次）、争议绑定。运行：npm run seed
import { rmSync } from 'node:fs';
import { openDb } from './db.js';
import { Store } from './store.js';
import { fmtCents } from './domain.js';

const DB_PATH = process.env.DB_PATH || 'settlement.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const db = openDb(DB_PATH);
const store = new Store(db);

// ---- 基础数据 ----
db.prepare(`INSERT INTO merchants VALUES ('M1','老王烧烤'), ('M2','晨光文具')`).run();

const rv1 = store.createRateVersion({ name: '2026 标准佣金 10%', rate_bps: 1000, effective_from: '2026-10' });

const insOrder = db.prepare('INSERT INTO orders (id, merchant_id, created_at, period) VALUES (?,?,?,?)');
const insItem = db.prepare('INSERT INTO order_items (id, order_id, title, amount_cents) VALUES (?,?,?,?)');
const insDisc = db.prepare('INSERT INTO order_discounts (order_id, label, amount_cents) VALUES (?,?,?)');
const insSub = db.prepare('INSERT INTO subsidies (order_id, label, amount_cents, period) VALUES (?,?,?,?)');

// 2026-10 订单
insOrder.run('ORD-1001', 'M1', '2026-10-03 12:01:00', '2026-10');
insItem.run('ORD-1001-A', 'ORD-1001', '烤串套餐', 10000);
insItem.run('ORD-1001-B', 'ORD-1001', '烤鱼', 20000);
insItem.run('ORD-1001-C', 'ORD-1001', '饮料', 5000);
insDisc.run('ORD-1001', '满300减35', 3500);
insSub.run('ORD-1001', '新客补贴', 1000, '2026-10');

insOrder.run('ORD-1002', 'M2', '2026-10-05 09:20:00', '2026-10');
insItem.run('ORD-1002-A', 'ORD-1002', '笔记本', 8000);
insItem.run('ORD-1002-B', 'ORD-1002', '钢笔', 12000);
insDisc.run('ORD-1002', '会员券', 2000);

insOrder.run('ORD-1003', 'M1', '2026-10-11 18:40:00', '2026-10');
insItem.run('ORD-1003-A', 'ORD-1003', '宴席预订', 50000);
// 同期部分退款 ¥120
store.addRefund({ id: 'RF-1003a', order_id: 'ORD-1003', item_id: 'ORD-1003-A', amount_cents: 12000, refunded_at: '2026-10-15 10:00:00', period: '2026-10' });

insOrder.run('ORD-1004', 'M2', '2026-10-20 14:00:00', '2026-10');
insItem.run('ORD-1004-A', 'ORD-1004', '办公套装', 30000);
// 跨期部分退款 ¥90：11 月才发生
store.addRefund({ id: 'RF-1004a', order_id: 'ORD-1004', item_id: 'ORD-1004-A', amount_cents: 9000, refunded_at: '2026-11-02 11:00:00', period: '2026-11' });

// 2026-11 订单
insOrder.run('ORD-1005', 'M1', '2026-11-05 19:30:00', '2026-11');
insItem.run('ORD-1005-A', 'ORD-1005', '烤鸡翅', 6000);
insItem.run('ORD-1005-B', 'ORD-1005', '啤酒', 4000);
insDisc.run('ORD-1005', '夜宵券', 1000);

insOrder.run('ORD-1006', 'M2', '2026-11-08 10:00:00', '2026-11');
insItem.run('ORD-1006-A', 'ORD-1006', '打印纸', 15000);

// 跨期：10 月订单在 11 月发生的部分退款与补贴
store.addRefund({ id: 'RF-1001a', order_id: 'ORD-1001', item_id: 'ORD-1001-A', amount_cents: 2500, refunded_at: '2026-11-06 09:00:00', period: '2026-11' });
insSub.run('ORD-1002', '双11返场补贴', 1500, '2026-11');

// ---- 结算流转 ----
// 10 月：结算 → 提交 → 批准 → 付款
const oct = store.runSettlement('2026-10', rv1.id).batch;
store.submit(oct.id, 'ops');
store.approve(oct.id, 'finance', '10 月账单核对无误');
store.pay(oct.id, 'treasury');

// 11 月：结算 → 提交（待财务批准，演示审批中状态）
const nov = store.runSettlement('2026-11', rv1.id).batch;
store.submit(nov.id, 'ops');

// 费率修订：10 月费率 10% → 8%，生成差异批次
const rv2 = store.createRateVersion({
  name: '2026 优惠佣金 8%', rate_bps: 800, effective_from: '2026-10', supersedes_id: rv1.id,
});
const diff = store.reviseRate('2026-10', rv2.id).batch;

// 争议：商家对 10 月 ORD-1003 的退款分摊有异议（绑定 10 月批次 + 费率版本 v1）
const octLines = store.listLines(oct.id);
const line1003 = octLines.find((l) => l.order_id === 'ORD-1003');
store.createDispute({
  settlement_line_id: line1003.id,
  reason: '商家认为部分退款 ¥120 不应全额冲减计佣基数，要求人工复核',
});

const b = (x) => fmtCents(x);
console.log('✅ 演示数据已生成');
console.log(`费率版本: v${rv1.id} ${rv1.name} / v${rv2.id} ${rv2.name}`);
console.log(`批次 #${oct.id} 2026-10 normal    佣金 ${b(oct.total_commission_cents)} 应付 ${b(oct.total_payout_cents)} [paid]`);
console.log(`批次 #${nov.id} 2026-11 normal    佣金 ${b(nov.total_commission_cents)} 应付 ${b(nov.total_payout_cents)} [pending_approval]`);
console.log(`批次 #${diff.id} 2026-10 difference 佣金差 ${b(diff.total_commission_cents)} 补付 ${b(diff.total_payout_cents)} [calculating]`);
console.log('争议 1 条（open，绑定 10 月批次与费率 v1）');
