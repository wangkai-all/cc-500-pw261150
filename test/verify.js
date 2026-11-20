// 端到端验证：部分退款、重放幂等、费率修订差异批次、重复付款拦截、争议绑定。
// 运行：npm run verify
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { allocate, mulBps } from '../src/domain.js';
import { createServer } from '../src/server.js';

const DB = 'verify-test.db';
for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch {} }

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
function section(t) { console.log(`\n■ ${t}`); }

const db = openDb(DB);
const store = new Store(db);

// ---------- 构造数据 ----------
db.prepare(`INSERT INTO merchants VALUES ('M1','测试商家A'), ('M2','测试商家B')`).run();
const rv10 = store.createRateVersion({ name: 'v1 费率10%', rate_bps: 1000, effective_from: '2026-10' });

db.prepare(`INSERT INTO orders VALUES ('O1','M1','2026-10-01 10:00:00','2026-10','completed')`).run();
// 拆分为 3 个子明细：100.00 / 200.00 / 50.00
const insItem = db.prepare('INSERT INTO order_items VALUES (?,?,?,?)');
insItem.run('O1-A', 'O1', '商品A', 10000);
insItem.run('O1-B', 'O1', '商品B', 20000);
insItem.run('O1-C', 'O1', '商品C', 5000);
db.prepare(`INSERT INTO order_discounts (order_id, label, amount_cents) VALUES ('O1','满减券',3500)`).run();
db.prepare(`INSERT INTO subsidies (order_id, label, amount_cents, period) VALUES ('O1','平台补贴',1000,'2026-10')`).run();

db.prepare(`INSERT INTO orders VALUES ('O2','M2','2026-10-02 10:00:00','2026-10','completed')`).run();
insItem.run('O2-A', 'O2', '商品X', 30000);

db.prepare(`INSERT INTO orders VALUES ('O3','M1','2026-11-01 10:00:00','2026-11','completed')`).run();
insItem.run('O3-A', 'O3', '商品Y', 8000);

// ---------- 1. 优惠分摊精度 ----------
section('1. 优惠分摊（最大余数法，总额分毫不差）');
const alloc = allocate(3500, [10000, 20000, 5000]);
check('3500 按 [10000,20000,5000] 分摊 = [1000,2000,500]',
  JSON.stringify(alloc) === JSON.stringify([1000, 2000, 500]));
const tricky = allocate(100, [1, 1, 1]); // 100 分给 3 项
check('100 分摊到 3 项合计仍为 100', tricky.reduce((a, b) => a + b, 0) === 100);
check('分摊结果各项相差不超过 1 分', Math.max(...tricky) - Math.min(...tricky) <= 1);

// ---------- 2. 常规结算：拆分 + 分摊 + 补贴 ----------
section('2. 常规结算（订单拆分 + 优惠分摊 + 补贴）');
const run1 = store.runSettlement('2026-10', rv10.id);
check('首次运行为新批次', !run1.replayed);
const b1 = run1.batch;
// O1: gross 35000 - disc 3500 = 31500; 佣金 3150; payout = 31500-3150+1000 = 29350
// O2: gross 30000; 佣金 3000; payout 27000
check('批次佣金合计 6150 分', b1.total_commission_cents === 6150, `实际 ${b1.total_commission_cents}`);
check('批次应付合计 56350 分', b1.total_payout_cents === 56350, `实际 ${b1.total_payout_cents}`);
const lines1 = store.listLines(b1.id);
const l1 = lines1.find((l) => l.order_id === 'O1');
check('O1 行含 3 条拆分明细快照', l1.detail.items.length === 3);
check('O1 明细分摊优惠合计 = 3500', l1.detail.items.reduce((a, i) => a + i.discount_cents, 0) === 3500);
check('O1 行记录费率版本与快照', l1.rate_version_id === rv10.id && l1.rate_bps === 1000);

// ---------- 3. 重放幂等 ----------
section('3. 重放幂等（重复运行不产生重复数据）');
// 3a. calculating 状态：事务性重算 —— 行被替换，合计不变、不重复
const run2 = store.runSettlement('2026-10', rv10.id);
check('计算中批次重运行为重算（同批次）', run2.recalculated === true && run2.batch.id === b1.id);
check('重算后行数不变', store.listLines(b1.id).length === lines1.length);
check('重算后合计不变', run2.batch.total_commission_cents === 6150 && run2.batch.total_payout_cents === 56350);
// 3b. 提交后批次冻结：重放直接返回原批次
store.submit(b1.id, 'ops');
const run3 = store.runSettlement('2026-10', rv10.id);
check('冻结批次重放返回原批次', run3.replayed === true && run3.batch.id === b1.id);
check('重放后行数仍不变', store.listLines(b1.id).length === lines1.length);

// ---------- 4. 部分退款（同期 + 跨期） ----------
section('4. 部分退款（同期冲减 + 跨期调整）');
// 4a. 结算前发生的同期部分退款：O2 退 90.00，但 O2 已在 10 月批次结算 → 属于跨期
//     先验证"结算前退款"：O3（11 月订单）在 11 月退 80.00 中的 30.00
store.addRefund({ id: 'RF-O3', order_id: 'O3', item_id: 'O3-A', amount_cents: 3000, refunded_at: '2026-11-05 10:00:00', period: '2026-11' });
// 4b. 跨期部分退款：O2（10 月订单）在 11 月退 90.00
store.addRefund({ id: 'RF-O2', order_id: 'O2', item_id: 'O2-A', amount_cents: 9000, refunded_at: '2026-11-03 10:00:00', period: '2026-11' });
// 跨期补贴：O1 在 11 月获得 15.00 补贴
db.prepare(`INSERT INTO subsidies (order_id, label, amount_cents, period) VALUES ('O1','返场补贴',1500,'2026-11')`).run();

const nov = store.runSettlement('2026-11', rv10.id).batch;
const novLines = store.listLines(nov.id);
const lO3 = novLines.find((l) => l.order_id === 'O3' && l.line_type === 'order');
check('O3 同期部分退款冲减基数: 8000-3000=5000', lO3.base_cents === 5000, `实际 ${lO3.base_cents}`);
check('O3 佣金 = 5000×10% = 500', lO3.commission_cents === 500);
const adjO2 = novLines.find((l) => l.order_id === 'O2' && l.line_type === 'adjustment');
check('O2 跨期部分退款生成调整行', !!adjO2);
check('调整行基数为负 -9000', adjO2.base_cents === -9000);
check('调整行佣金为负（冲回）-900', adjO2.commission_cents === -900);
check('调整行应付为负 -8100（商家退回）', adjO2.payout_cents === -8100);
const adjO1 = novLines.find((l) => l.order_id === 'O1' && l.line_type === 'adjustment');
check('O1 跨期补贴调整行 +1500', adjO1 && adjO1.subsidy_cents === 1500 && adjO1.payout_cents === 1500);
// 11 月合计：佣金 500 - 900 = -400；应付 (5000-500) - 8100 + 1500 = -2100
check('11 月批次佣金合计 -400', nov.total_commission_cents === -400, `实际 ${nov.total_commission_cents}`);
check('11 月批次应付合计 -2100', nov.total_payout_cents === -2100, `实际 ${nov.total_payout_cents}`);

// 4c. 计算中的批次可通过重算吸收新的部分退款（重放不重复）
store.addRefund({ id: 'RF-O3b', order_id: 'O3', item_id: 'O3-A', amount_cents: 1000, refunded_at: '2026-11-07 10:00:00', period: '2026-11' });
const novRe = store.runSettlement('2026-11', rv10.id);
check('重算吸收新部分退款', novRe.recalculated === true && novRe.batch.id === nov.id);
const lO3re = store.listLines(nov.id).find((l) => l.order_id === 'O3' && l.line_type === 'order');
check('O3 基数更新为 8000-3000-1000=4000', lO3re.base_cents === 4000, `实际 ${lO3re.base_cents}`);
check('重算后 11 月行数不变（无重复行）', store.listLines(nov.id).length === novLines.length);
check('重算后佣金合计 -500', novRe.batch.total_commission_cents === -500, `实际 ${novRe.batch.total_commission_cents}`);

// ---------- 5. 审批流转 + 付款 + 重复付款拦截 ----------
section('5. 审批流转与重复付款拦截');
store.approve(b1.id, 'finance'); // 批次在 3b 已提交
store.pay(b1.id, 'treasury');
check('批次进入 paid', store.getBatch(b1.id).status === 'paid');
let doublePayBlocked = false;
try { store.pay(b1.id, 'treasury'); } catch (e) { doublePayBlocked = e.status === 409; }
check('重复付款被拦截（409）', doublePayBlocked);
check('付款记录只有 1 条', store.listPayments().filter((p) => p.batch_id === b1.id).length === 1);
let skipApprovalBlocked = false;
try { store.pay(nov.id, 'treasury'); } catch (e) { skipApprovalBlocked = e.status === 409; }
check('未批准批次不能付款', skipApprovalBlocked);
let badTransition = false;
try { store.approve(b1.id, 'finance'); } catch (e) { badTransition = e.status === 409; }
check('已付款批次不能重复批准', badTransition);
// 关闭周期守卫：退款计入已付款周期会被拒绝（防止漏结）
let closedPeriodBlocked = false;
try {
  store.addRefund({ id: 'RF-LATE', order_id: 'O2', amount_cents: 100, refunded_at: '2026-10-31 23:00:00', period: '2026-10' });
} catch (e) { closedPeriodBlocked = e.status === 409; }
check('向已付款周期补录退款被拒绝（409）', closedPeriodBlocked);

// ---------- 6. 费率修订 → 差异批次 ----------
section('6. 费率修订生成差异批次（且幂等）');
const rv8 = store.createRateVersion({ name: 'v2 费率8%', rate_bps: 800, effective_from: '2026-10', supersedes_id: rv10.id });
check('旧版本置为 superseded', store.getRateVersion(rv10.id).status === 'superseded');
const diff1 = store.reviseRate('2026-10', rv8.id);
check('生成差异批次', !diff1.replayed && diff1.batch.batch_type === 'difference');
check('差异批次关联原批次', diff1.batch.parent_batch_id === b1.id);
// O1 base 31500: 3150→2520 差 -630；O2 base 30000: 3000→2400 差 -600；合计佣金差 -1230，补付 +1230
check('差异批次佣金差 -1230', diff1.batch.total_commission_cents === -1230, `实际 ${diff1.batch.total_commission_cents}`);
check('差异批次补付 +1230', diff1.batch.total_payout_cents === 1230);
const dLines = store.listLines(diff1.batch.id);
check('差异行可溯源到原结算行', dLines.every((l) => l.source_line_id != null));
check('差异行记录新旧费率快照', dLines[0].detail.difference.old_rate_bps === 1000 && dLines[0].detail.difference.new_rate_bps === 800);
const diff2 = store.reviseRate('2026-10', rv8.id);
check('重复修订幂等（同一差异批次）', diff2.replayed && diff2.batch.id === diff1.batch.id);
// 差异批次自身也走审批付款，且同样防重
store.submit(diff1.batch.id, 'ops');
store.approve(diff1.batch.id, 'finance');
store.pay(diff1.batch.id, 'treasury');
let diffDoublePay = false;
try { store.pay(diff1.batch.id, 'treasury'); } catch (e) { diffDoublePay = e.status === 409; }
check('差异批次重复付款被拦截', diffDoublePay);

// ---------- 7. 争议绑定结算版本 ----------
section('7. 争议与结算版本绑定');
const disp = store.createDispute({ settlement_line_id: l1.id, reason: '佣金计算有异议' });
check('争议绑定批次', disp.batch_id === b1.id);
check('争议绑定费率版本 v1（修订后仍指向原版本）', disp.rate_version_id === rv10.id);
const resolved = store.resolveDispute(disp.id, { status: 'resolved', resolution: '复核无误，维持原结算' });
check('争议可结案', resolved.status === 'resolved');
let reopenBlocked = false;
try { store.resolveDispute(disp.id, { status: 'resolved' }); } catch (e) { reopenBlocked = e.status === 409; }
check('已结案争议不能重复处理', reopenBlocked);
// 针对差异批次行也可独立发起争议（绑定新版本）
const disp2 = store.createDispute({ settlement_line_id: dLines[0].id, reason: '差异补付金额异议' });
check('差异行争议绑定新费率版本 v2', disp2.rate_version_id === rv8.id && disp2.batch_id === diff1.batch.id);

// ---------- 8. 订单追溯 ----------
section('8. 全链路追溯（订单 → 结算行 → 费率）');
const trace = store.traceOrder('O2');
check('O2 出现在 3 条结算行（10月正常 + 11月调整 + 差异）', trace.settlement_lines.length === 3,
  `实际 ${trace.settlement_lines.length}`);
check('每条结算行都能追到费率版本', trace.settlement_lines.every((l) => l.rate_name));
check('O2 退款记录完整', trace.refunds.length === 1 && trace.refunds[0].amount_cents === 9000);

// ---------- 9. HTTP 层（真实请求验证 409 与重放） ----------
section('9. HTTP API 层验证');
const { server } = createServer(DB);
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const replayApi = await api('POST', '/api/settlements/run', { period: '2026-10', rate_version_id: rv10.id });
check('API 重放返回原批次', replayApi.body.replayed === true && replayApi.body.batch.id === b1.id);
const payAgain = await api('POST', `/api/batches/${b1.id}/pay`, {});
check('API 重复付款返回 409', payAgain.status === 409);
const badReq = await api('POST', '/api/settlements/run', {});
check('缺参数返回 400', badReq.status === 400);
const traceApi = await api('GET', '/api/orders/O2/trace');
check('API 追溯接口正常', traceApi.status === 200 && traceApi.body.settlement_lines.length === 3);
const idx = await fetch(`http://127.0.0.1:${port}/`);
check('前端页面可访问', idx.status === 200 && (await idx.text()).includes('佣金结算'));
server.close();

// ---------- 汇总 ----------
console.log(`\n═══════════════════════════════════`);
console.log(`验证完成: ${passed} 通过, ${failed} 失败`);
for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch {} }
process.exit(failed ? 1 : 0);
