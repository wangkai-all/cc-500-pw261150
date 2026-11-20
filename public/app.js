/* 平台佣金结算分析 — 前端逻辑（零依赖，原生 fetch + SVG 图表） */

const $ = (sel) => document.querySelector(sel);
const state = { batches: [], rates: [], linesBatchId: null, traceOrderId: null };

// ---------- 工具 ----------
const fmt = (c) => {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}¥${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
};
const fmtSigned = (c) => (c > 0 ? '+' + fmt(c) : fmt(c));
const fmtRate = (bps) => (bps / 100).toFixed(bps % 100 ? 2 : 0) + '%';
const cls = (c) => (c < 0 ? 'neg' : 'pos');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

const STATUS_LABEL = {
  calculating: '计算中', pending_approval: '待审批', approved: '已批准',
  paid: '已付款', rejected: '已驳回', open: '待处理', resolved: '已解决',
};
const LINE_TYPE_LABEL = { order: '订单结算', adjustment: '跨期调整', difference: '费率差异' };

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => t.classList.add('hidden'), 3200);
}

function modal({ title, desc, placeholder }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalDesc').textContent = desc || '';
    const input = $('#modalInput');
    input.value = '';
    input.placeholder = placeholder || '填写说明…';
    m.classList.remove('hidden');
    input.focus();
    const done = (val) => { m.classList.add('hidden'); resolve(val); };
    $('#modalOk').onclick = () => done(input.value.trim() || true);
    $('#modalCancel').onclick = () => done(null);
  });
}

async function run(action, okMsg) {
  try {
    await action();
    if (okMsg) toast(okMsg);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 标签页 ----------
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
});

// ---------- 总览 ----------
async function renderDashboard() {
  const s = await api('/api/summary');
  const batches = state.batches;
  const paid = batches.filter((b) => b.status === 'paid');
  $('#statRow').innerHTML = `
    <div class="stat"><div class="label"><span class="dot" style="background:var(--series-1)"></span>累计佣金</div>
      <div class="value">${fmt(s.total_commission_cents)}</div><div class="sub">${s.batches} 个批次</div></div>
    <div class="stat"><div class="label"><span class="dot" style="background:var(--series-2)"></span>累计商家应付</div>
      <div class="value">${fmt(s.total_payout_cents)}</div><div class="sub">已付款批次 ${s.paid_batches} 个</div></div>
    <div class="stat"><div class="label">已付款金额</div>
      <div class="value">${fmt(paid.reduce((a, b) => a + b.total_payout_cents, 0))}</div><div class="sub">付款受幂等约束保护</div></div>
    <div class="stat"><div class="label">开放争议</div>
      <div class="value">${s.open_disputes}</div><div class="sub">争议均绑定结算版本</div></div>
    <div class="stat"><div class="label">结算周期</div>
      <div class="value">${s.periods.length}</div><div class="sub">${s.periods.join('、') || '—'}</div></div>`;
  renderBatchChart(batches);
}

// 分组条形图：每批次 佣金 / 应付（支持负值），含图例与悬浮提示
function renderBatchChart(batches) {
  const wrap = $('#batchChart');
  if (!batches.length) { wrap.innerHTML = '<p class="empty">暂无批次</p>'; return; }
  const W = Math.max(wrap.clientWidth || 720, 480), H = 300;
  const padL = 76, padR = 16, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(1, ...batches.flatMap((b) => [b.total_commission_cents, b.total_payout_cents, 0]));
  const minV = Math.min(0, ...batches.flatMap((b) => [b.total_commission_cents, b.total_payout_cents]));
  const span = maxV - minV || 1;
  const y = (v) => padT + ((maxV - v) / span) * plotH;
  const y0 = y(0);
  const groupW = plotW / batches.length;
  const barW = Math.min(26, (groupW - 18) / 2 - 2);

  const niceStep = (() => {
    const raw = span / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
    return 10 * mag;
  })();
  const ticks = [];
  for (let v = Math.ceil(minV / niceStep) * niceStep; v <= maxV; v += niceStep) ticks.push(Math.round(v));

  const series = [
    { key: 'total_commission_cents', name: '平台佣金', color: 'var(--series-1)' },
    { key: 'total_payout_cents', name: '商家应付', color: 'var(--series-2)' },
  ];
  let bars = '';
  batches.forEach((b, i) => {
    const cx = padL + i * groupW + groupW / 2;
    series.forEach((sr, j) => {
      const v = b[sr.key];
      const x = cx + (j - 0.5) * (barW + 2) - barW / 2;
      const top = y(Math.max(v, 0)), bot = y(Math.min(v, 0));
      const h = Math.max(bot - top, v === 0 ? 0 : 2);
      bars += `<rect class="bar" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}"
        rx="4" fill="${sr.color}" data-tip="${esc(`批次#${b.id} ${b.period} ${b.batch_type === 'difference' ? '·差异' : ''}｜${sr.name}: ${fmt(v)}`)}">
        ${v === 0 ? `<animate attributeName="height" from="0" to="0"/>` : ''}</rect>`;
    });
  });
  const grid = ticks.map((t) => `
    <line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--gridline)" stroke-width="1"/>
    <text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(t)}</text>`).join('');
  const labels = batches.map((b, i) => {
    const cx = padL + i * groupW + groupW / 2;
    return `<text x="${cx}" y="${H - 18}" text-anchor="middle" font-size="11" fill="var(--muted)">#${b.id} ${b.period}${b.batch_type === 'difference' ? ' 差异' : ''}</text>`;
  }).join('');

  wrap.innerHTML = `
    <div class="legend">${series.map((s) => `<span class="chip-lg"><span class="swatch" style="background:${s.color}"></span>${s.name}</span>`).join('')}</div>
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="各批次佣金与应付对比">
        ${grid}
        <line x1="${padL}" x2="${W - padR}" y1="${y0}" y2="${y0}" stroke="var(--baseline)" stroke-width="1.5"/>
        ${bars}${labels}
      </svg>
      <div class="chart-tooltip" id="chartTip"></div>
    </div>`;
  const tip = $('#chartTip');
  const tipBox = tip.parentElement;
  wrap.querySelectorAll('.bar').forEach((bar) => {
    bar.addEventListener('mouseenter', () => {
      tip.textContent = bar.dataset.tip;
      const r = bar.getBoundingClientRect(), wr = tipBox.getBoundingClientRect();
      tip.style.left = r.left - wr.left + r.width / 2 + 'px';
      tip.style.top = r.top - wr.top - 8 + 'px';
      tip.style.transform = 'translate(-50%, -100%)';
      tip.style.opacity = 1;
    });
    bar.addEventListener('mouseleave', () => (tip.style.opacity = 0));
  });
}

// ---------- 批次 ----------
const NEXT_ACTIONS = {
  calculating: [{ act: 'submit', label: '提交审批', cls: 'primary' }],
  pending_approval: [{ act: 'approve', label: '批准', cls: 'primary' }, { act: 'reject', label: '驳回', cls: '' }],
  approved: [{ act: 'pay', label: '付款', cls: 'warn' }],
};

function renderBatches() {
  const t = $('#batchTable');
  t.innerHTML = `<thead><tr>
    <th>批次</th><th>周期</th><th>类型</th><th>费率版本</th>
    <th class="num">佣金合计</th><th class="num">应付合计</th><th>明细行</th><th>争议</th>
    <th>状态</th><th>审批 / 付款</th><th>操作</th></tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');
  for (const b of state.batches) {
    const tr = document.createElement('tr');
    const actions = (NEXT_ACTIONS[b.status] || []).map((a) =>
      `<button class="btn small ${a.cls}" data-act="${a.act}" data-id="${b.id}">${a.label}</button>`).join('');
    tr.innerHTML = `
      <td>#${b.id}${b.parent_batch_id ? ` <span class="chip">源自 #${b.parent_batch_id}</span>` : ''}</td>
      <td>${b.period}</td>
      <td><span class="badge type-${b.batch_type}">${b.batch_type === 'normal' ? '常规' : '差异'}</span></td>
      <td>${esc(b.rate_name)} <span class="chip">${fmtRate(b.batch_rate_bps)}</span></td>
      <td class="num ${cls(b.total_commission_cents)}">${fmtSigned(b.total_commission_cents)}</td>
      <td class="num ${cls(b.total_payout_cents)}">${fmtSigned(b.total_payout_cents)}</td>
      <td>${b.line_count}</td>
      <td>${b.open_disputes ? `<span class="badge open">${b.open_disputes} 待处理</span>` : '—'}</td>
      <td><span class="badge ${b.status}">${STATUS_LABEL[b.status]}</span></td>
      <td>${b.paid_at ? `已于 ${b.paid_at} 付款` : '—'}</td>
      <td><div class="action-cell">${actions}<button class="btn small" data-view="${b.id}">明细</button></div></td>`;
    tb.appendChild(tr);
  }
  tb.onclick = async (e) => {
    const actBtn = e.target.closest('button[data-act]');
    const viewBtn = e.target.closest('button[data-view]');
    if (viewBtn) {
      state.linesBatchId = Number(viewBtn.dataset.view);
      document.querySelector('#tabs button[data-tab="lines"]').click();
      await renderLines();
      return;
    }
    if (!actBtn) return;
    const id = Number(actBtn.dataset.id);
    const act = actBtn.dataset.act;
    if (act === 'pay') {
      const ok = await modal({ title: `付款批次 #${id}`, desc: '付款操作受唯一约束保护，重复付款会被拒绝。' });
      if (ok === null) return;
      await run(() => api(`/api/batches/${id}/pay`, 'POST', {}), `批次 #${id} 已付款`);
    } else if (act === 'reject') {
      const note = await modal({ title: `驳回批次 #${id}`, desc: '驳回后可重新运行该周期结算。', placeholder: '驳回原因…' });
      if (note === null) return;
      await run(() => api(`/api/batches/${id}/reject`, 'POST', { note: String(note) }), `批次 #${id} 已驳回`);
    } else {
      await run(() => api(`/api/batches/${id}/${act}`, 'POST', {}), `批次 #${id} 操作成功`);
    }
  };
}

$('#runForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const period = $('#runPeriod').value, rate_version_id = Number($('#runRate').value);
  await run(async () => {
    const r = await api('/api/settlements/run', 'POST', { period, rate_version_id });
    toast(r.replayed
      ? `幂等重放：批次 #${r.batch.id} 已冻结，直接返回原批次`
      : r.recalculated
        ? `批次 #${r.batch.id} 已重算（吸收新退款/补贴，无重复行）`
        : `已生成批次 #${r.batch.id}`);
  });
});

// ---------- 结算明细 ----------
function renderLinesBatchSelect() {
  const sel = $('#linesBatchSelect');
  sel.innerHTML = state.batches.map((b) =>
    `<option value="${b.id}" ${b.id === state.linesBatchId ? 'selected' : ''}>批次 #${b.id} · ${b.period} · ${b.batch_type === 'normal' ? '常规' : '差异'} · ${STATUS_LABEL[b.status]}</option>`).join('');
}
$('#linesBatchSelect').addEventListener('change', async (e) => {
  state.linesBatchId = Number(e.target.value);
  await renderLines();
});

async function renderLines() {
  renderLinesBatchSelect();
  if (!state.linesBatchId && state.batches.length) state.linesBatchId = state.batches[0].id;
  if (!state.linesBatchId) { $('#linesTable').innerHTML = ''; return; }
  const { batch, lines, approvals } = await api(`/api/batches/${state.linesBatchId}`);
  $('#linesMeta').innerHTML = `<div class="meta-grid">
    <div><span class="k">周期</span>${batch.period}</div>
    <div><span class="k">类型</span>${batch.batch_type === 'normal' ? '常规结算' : `费率差异（源自批次 #${batch.parent_batch_id}）`}</div>
    <div><span class="k">费率版本</span>${esc(batch.rate_name)}（${fmtRate(batch.batch_rate_bps)}）</div>
    <div><span class="k">状态</span><span class="badge ${batch.status}">${STATUS_LABEL[batch.status]}</span></div>
    <div><span class="k">佣金合计</span><span class="${cls(batch.total_commission_cents)}">${fmtSigned(batch.total_commission_cents)}</span></div>
    <div><span class="k">应付合计</span><span class="${cls(batch.total_payout_cents)}">${fmtSigned(batch.total_payout_cents)}</span></div>
    <div style="grid-column:1/-1"><span class="k">审批流水</span>${approvals.length ? approvals.map((a) => `<span class="chip">${a.created_at} · ${a.actor} · ${{ submit: '提交', approve: '批准', reject: '驳回', pay: '付款' }[a.action]}${a.note ? ' · ' + esc(a.note) : ''}</span>`).join('') : '暂无'}</div>
  </div>`;

  const t = $('#linesTable');
  t.innerHTML = `<thead><tr>
    <th>行</th><th>订单</th><th>商家</th><th>类型</th>
    <th class="num">订单总额</th><th class="num">优惠分摊</th><th class="num">退款</th><th class="num">补贴</th>
    <th class="num">计佣基数</th><th>费率（追溯）</th><th class="num">佣金</th><th class="num">商家应付</th><th></th></tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');
  for (const l of lines) {
    const tr = document.createElement('tr');
    tr.className = 'expandable';
    tr.innerHTML = `
      <td>#${l.id}</td><td>${l.order_id}</td><td>${esc(l.merchant_name)}</td>
      <td><span class="badge line-${l.line_type}">${LINE_TYPE_LABEL[l.line_type]}</span></td>
      <td class="num">${fmt(l.gross_cents)}</td>
      <td class="num">${l.discount_cents ? '-' + fmt(l.discount_cents) : '—'}</td>
      <td class="num">${l.refund_cents ? '-' + fmt(l.refund_cents) : '—'}</td>
      <td class="num">${l.subsidy_cents ? '+' + fmt(l.subsidy_cents) : '—'}</td>
      <td class="num ${cls(l.base_cents)}">${fmtSigned(l.base_cents)}</td>
      <td><span class="chip">${esc(l.rate_name)}</span><span class="chip">${fmtRate(l.rate_bps)}</span></td>
      <td class="num ${cls(l.commission_cents)}">${fmtSigned(l.commission_cents)}</td>
      <td class="num ${cls(l.payout_cents)}">${fmtSigned(l.payout_cents)}</td>
      <td>${batch.status !== 'calculating' ? `<button class="btn small" data-dispute="${l.id}">发起争议</button>` : ''}</td>`;
    tb.appendChild(tr);
    const dr = document.createElement('tr');
    dr.className = 'detail-row hidden';
    dr.innerHTML = `<td colspan="13">${renderLineDetail(l)}</td>`;
    tb.appendChild(dr);
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      dr.classList.toggle('hidden');
    });
  }
  tb.onclick = async (e) => {
    const btn = e.target.closest('button[data-dispute]');
    if (!btn) return;
    const reason = await modal({ title: `对结算行 #${btn.dataset.dispute} 发起争议`, desc: '争议将绑定该行所属的结算批次与费率版本。', placeholder: '争议原因…' });
    if (reason === null || reason === true) return;
    await run(() => api('/api/disputes', 'POST', { settlement_line_id: Number(btn.dataset.dispute), reason: String(reason) }), '争议已登记');
  };
}

function renderLineDetail(l) {
  const d = l.detail;
  if (d.items) {
    return `<div class="detail-block">
      <h4>拆分明细与优惠分摊（费率快照 ${fmtRate(l.rate_bps)}，版本 ${esc(l.rate_name)}）</h4>
      <table><thead><tr><th>子明细</th><th>商品</th><th class="num">金额</th><th class="num">分摊优惠</th><th class="num">分摊退款</th><th class="num">计佣基数</th></tr></thead>
      <tbody>${d.items.map((it) => `<tr><td>${it.item_id}</td><td>${esc(it.title)}</td>
        <td class="num">${fmt(it.amount_cents)}</td><td class="num">-${fmt(it.discount_cents)}</td>
        <td class="num">-${fmt(it.refund_cents)}</td><td class="num">${fmt(it.base_cents)}</td></tr>`).join('')}</tbody></table>
      ${d.discounts.length ? `<h4>订单级优惠</h4>${d.discounts.map((x) => `<span class="chip">${esc(x.label)} ${fmt(x.amount_cents)}</span>`).join('')}` : ''}
      ${d.refunds.length ? `<h4>退款</h4>${d.refunds.map((x) => `<span class="chip">${x.id} → ${x.item_id || '整单分摊'} ${fmt(x.amount_cents)}（${x.period}）</span>`).join('')}` : ''}
      ${d.subsidies.length ? `<h4>平台补贴（不计佣）</h4>${d.subsidies.map((x) => `<span class="chip">${esc(x.label)} ${fmt(x.amount_cents)}</span>`).join('')}` : ''}
    </div>`;
  }
  if (d.adjustment) {
    const a = d.adjustment;
    return `<div class="detail-block"><h4>跨期调整</h4>
      <span class="chip">${a.kind === 'refund' ? '退款冲回' : '补贴补发'}</span>
      <span class="chip">来源单据 ${esc(a.ref_id)}</span>
      <span class="chip">${esc(a.label)}</span>
      <span class="chip">金额 ${fmt(a.amount_cents)}</span>
      <p class="hint">按批次费率 ${fmtRate(l.rate_bps)} 计算：基数 ${fmtSigned(l.base_cents)}，佣金 ${fmtSigned(l.commission_cents)}</p></div>`;
  }
  if (d.difference) {
    const x = d.difference;
    return `<div class="detail-block"><h4>费率修订差异</h4>
      <span class="chip">原结算行 #${x.source_line_id}</span>
      <span class="chip">旧费率 ${fmtRate(x.old_rate_bps)} → 新费率 ${fmtRate(x.new_rate_bps)}</span>
      <span class="chip">原佣金 ${fmt(x.old_commission_cents)} → 新佣金 ${fmt(x.new_commission_cents)}</span>
      <span class="chip">差额 ${fmtSigned(l.commission_cents)}</span></div>`;
  }
  return '<div class="detail-block">无附加明细</div>';
}

// ---------- 差异批次 ----------
function renderDiffs() {
  const diffs = state.batches.filter((b) => b.batch_type === 'difference');
  const t = $('#diffTable');
  if (!diffs.length) { t.innerHTML = '<tbody><tr><td class="empty">暂无差异批次。在「费率版本」页发起修订后自动生成。</td></tr></tbody>'; return; }
  t.innerHTML = `<thead><tr><th>批次</th><th>周期</th><th>原批次</th><th>新费率版本</th>
    <th class="num">佣金差额</th><th class="num">补付/扣回</th><th>状态</th><th></th></tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');
  for (const b of diffs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>#${b.id}</td><td>${b.period}</td><td>#${b.parent_batch_id}</td>
      <td>${esc(b.rate_name)} <span class="chip">${fmtRate(b.batch_rate_bps)}</span></td>
      <td class="num ${cls(b.total_commission_cents)}">${fmtSigned(b.total_commission_cents)}</td>
      <td class="num ${cls(b.total_payout_cents)}">${fmtSigned(b.total_payout_cents)}</td>
      <td><span class="badge ${b.status}">${STATUS_LABEL[b.status]}</span></td>
      <td><button class="btn small" data-view="${b.id}">查看差异行</button></td>`;
    tb.appendChild(tr);
  }
  tb.onclick = async (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    state.linesBatchId = Number(btn.dataset.view);
    document.querySelector('#tabs button[data-tab="lines"]').click();
    await renderLines();
  };
}

// ---------- 争议 ----------
async function renderDisputes() {
  const list = await api('/api/disputes');
  const t = $('#disputeTable');
  if (!list.length) { t.innerHTML = '<tbody><tr><td class="empty">暂无争议</td></tr></tbody>'; return; }
  t.innerHTML = `<thead><tr><th>争议</th><th>结算行</th><th>订单</th><th>绑定批次</th><th>绑定费率版本</th>
    <th>原因</th><th>状态</th><th>处理结果</th><th>操作</th></tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');
  for (const d of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>#${d.id}</td><td>#${d.settlement_line_id}</td><td>${d.order_id}</td>
      <td>#${d.batch_id}（${d.period} ${d.batch_type === 'difference' ? '差异' : '常规'}）</td>
      <td><span class="chip">${esc(d.rate_name)}</span><span class="chip">${fmtRate(d.rate_bps)}</span></td>
      <td>${esc(d.reason)}</td>
      <td><span class="badge ${d.status}">${STATUS_LABEL[d.status] || d.status}</span></td>
      <td>${d.resolution ? esc(d.resolution) : '—'}</td>
      <td>${d.status === 'open' ? `<div class="action-cell">
          <button class="btn small primary" data-resolve="${d.id}" data-st="resolved">结案</button>
          <button class="btn small" data-resolve="${d.id}" data-st="rejected">驳回</button></div>` : ''}</td>`;
    tb.appendChild(tr);
  }
  tb.onclick = async (e) => {
    const btn = e.target.closest('button[data-resolve]');
    if (!btn) return;
    const note = await modal({ title: `处理争议 #${btn.dataset.resolve}`, desc: btn.dataset.st === 'resolved' ? '结案说明' : '驳回原因' });
    if (note === null) return;
    await run(() => api(`/api/disputes/${btn.dataset.resolve}/resolve`, 'POST',
      { status: btn.dataset.st, resolution: String(note === true ? '' : note) }), '争议已处理');
  };
}

// ---------- 费率版本 ----------
function renderRates() {
  const t = $('#rateTable');
  t.innerHTML = `<thead><tr><th>版本</th><th>名称</th><th>费率</th><th>生效周期</th><th>状态</th><th>替代关系</th><th>创建时间</th></tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');
  for (const r of state.rates) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>v${r.id}</td><td>${esc(r.name)}</td><td class="num">${fmtRate(r.rate_bps)}（${r.rate_bps} bps）</td>
      <td>${r.effective_from}</td>
      <td><span class="badge ${r.status}">${r.status === 'active' ? '生效中' : '已被替代'}</span></td>
      <td>${r.supersedes_id ? `替代 v${r.supersedes_id}` : '—'}</td><td>${r.created_at}</td>`;
    tb.appendChild(tr);
  }
  const opts = state.rates.map((r) => `<option value="${r.id}">v${r.id} · ${esc(r.name)} · ${fmtRate(r.rate_bps)}</option>`).join('');
  $('#runRate').innerHTML = opts;
  $('#reviseRate').innerHTML = opts;
}

$('#rateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('#rateName').value, rate_bps: Number($('#rateBps').value), effective_from: $('#rateFrom').value };
  await run(async () => {
    const r = await api('/api/rates', 'POST', body);
    toast(`已创建费率版本 v${r.id}`);
  });
});

$('#reviseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { period: $('#revisePeriod').value, new_rate_version_id: Number($('#reviseRate').value) };
  await run(async () => {
    const r = await api('/api/rates/revise', 'POST', body);
    toast(r.replayed ? `差异批次 #${r.batch.id} 已存在（幂等）` : `已生成差异批次 #${r.batch.id}，佣金差 ${fmtSigned(r.batch.total_commission_cents)}`);
  });
});

// ---------- 订单追溯 ----------
async function renderTraceOrderSelect() {
  const orders = await api('/api/orders');
  const sel = $('#traceOrderSelect');
  sel.innerHTML = orders.map((o) =>
    `<option value="${o.id}" ${o.id === state.traceOrderId ? 'selected' : ''}>${o.id} · ${esc(o.merchant_name)} · ${o.period} · ${fmt(o.gross_cents)}</option>`).join('');
  if (!state.traceOrderId && orders.length) state.traceOrderId = orders[0].id;
}
$('#traceOrderSelect').addEventListener('change', async (e) => {
  state.traceOrderId = e.target.value;
  await renderTrace();
});

async function renderTrace() {
  await renderTraceOrderSelect();
  if (!state.traceOrderId) { $('#traceView').innerHTML = '<p class="empty">暂无订单</p>'; return; }
  const t = await api(`/api/orders/${state.traceOrderId}/trace`);
  const v = $('#traceView');
  v.innerHTML = `
    <div class="trace-section"><h3>订单</h3>
      <div class="meta-grid">
        <div><span class="k">订单号</span>${t.order.id}</div>
        <div><span class="k">商家</span>${t.order.merchant_id}</div>
        <div><span class="k">下单时间</span>${t.order.created_at}</div>
        <div><span class="k">归属周期</span>${t.order.period}</div>
      </div></div>
    <div class="trace-section"><h3>拆分与费用事件</h3>
      <div>${t.items.map((i) => `<span class="chip">${i.id} · ${esc(i.title)} · ${fmt(i.amount_cents)}</span>`).join('')}</div>
      <div style="margin-top:6px">${t.discounts.map((d) => `<span class="chip">优惠：${esc(d.label)} -${fmt(d.amount_cents)}</span>`).join('')}
        ${t.refunds.map((r) => `<span class="chip">退款：${r.id} → ${r.item_id || '整单'} -${fmt(r.amount_cents)}（${r.period}）</span>`).join('')}
        ${t.subsidies.map((s) => `<span class="chip">补贴：${esc(s.label)} +${fmt(s.amount_cents)}（${s.period}）</span>`).join('')}</div></div>
    <div class="trace-section"><h3>结算记录（每笔都可追溯到费率版本）</h3>
      ${t.settlement_lines.length ? `<div class="table-wrap"><table><thead><tr>
        <th>结算行</th><th>批次</th><th>类型</th><th class="num">计佣基数</th><th>费率版本</th>
        <th class="num">佣金</th><th class="num">应付</th><th>批次状态</th></tr></thead><tbody>
        ${t.settlement_lines.map((l) => `<tr>
          <td>#${l.id}</td><td>#${l.batch_id}（${l.period}）</td>
          <td><span class="badge line-${l.line_type}">${LINE_TYPE_LABEL[l.line_type]}</span></td>
          <td class="num ${cls(l.base_cents)}">${fmtSigned(l.base_cents)}</td>
          <td><span class="chip">${esc(l.rate_name)}</span><span class="chip">${fmtRate(l.rate_bps)}</span></td>
          <td class="num ${cls(l.commission_cents)}">${fmtSigned(l.commission_cents)}</td>
          <td class="num ${cls(l.payout_cents)}">${fmtSigned(l.payout_cents)}</td>
          <td><span class="badge ${l.batch_status}">${STATUS_LABEL[l.batch_status]}</span></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty">该订单尚未进入任何结算批次</p>'}</div>`;
}

// ---------- 刷新 ----------
async function refresh() {
  [state.batches, state.rates] = await Promise.all([api('/api/batches'), api('/api/rates')]);
  if (!state.linesBatchId && state.batches.length) state.linesBatchId = state.batches[0].id;
  await renderDashboard();
  renderBatches();
  await renderLines();
  renderDiffs();
  await renderDisputes();
  renderRates();
  await renderTrace();
}

refresh().catch((e) => toast(e.message, true));
window.addEventListener('resize', () => renderBatchChart(state.batches));
