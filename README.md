# 平台佣金结算分析

零依赖（Node.js 内置 `http` + `node:sqlite`）的佣金结算系统，覆盖订单拆分、优惠分摊、退款、补贴、跨期结算、费率版本、差异批次、争议与审批全流程。

## 快速开始

```bash
npm run seed     # 生成演示数据（settlement.db）
npm start        # 启动服务 http://localhost:3000
npm run verify   # 端到端验证（55 项断言：部分退款/重放/差异批次/重复付款/争议绑定）
```

## 核心概念

| 概念 | 实现 |
|---|---|
| 订单拆分 | 订单 → 多个子明细（`order_items`），结算按明细逐一计算 |
| 优惠分摊 | 订单级优惠按明细金额比例分摊，最大余数法保证分毫不差（`allocate()`） |
| 退款 | 支持部分退款；同期退款冲减当期基数，跨期退款在发生周期生成**负向调整行**（佣金冲回） |
| 补贴 | 平台补贴不计佣，直接增加商家应付；支持跨期补贴调整 |
| 跨期结算 | 调整行（`line_type=adjustment`）挂在退款/补贴实际发生的周期批次 |
| 费率版本 | `rate_versions` 版本化；每条结算行冗余存储费率快照（`rate_bps`），永久可追溯 |
| 费率修订 | 不改动历史批次，生成**差异批次**（`batch_type=difference`），每行记录新旧费率与佣金差，独立走审批付款 |
| 重复付款拦截 | `payments.batch_id` 唯一约束 + 状态机（仅 `approved` 可付）双重保证 |
| 争议 | 绑定结算行 + 批次 + 费率版本（即结算版本）；修订后历史争议仍指向原版本 |
| 重放幂等 | 同周期同费率版本：`calculating` 状态事务性重算（吸收新退款，无重复行）；已冻结批次直接返回原批次 |

## 结算公式

```
计佣基数 = Σ(明细金额 - 分摊优惠 - 分摊退款)     （逐明细计算，不为负）
佣金     = round(计佣基数 × 费率bps / 10000)
商家应付 = 计佣基数 - 佣金 + 平台补贴
```

金额一律整数分（cents），费率整数基点（bps），无浮点误差。

## 审批状态机

```
calculating → pending_approval → approved → paid
                  ↓ (驳回)
               rejected（该周期可重新运行结算）
```

## 页面

- **总览**：佣金/应付统计卡片 + 各批次对比图
- **结算批次**：批次列表、状态徽章、提交/批准/驳回/付款操作、运行结算（幂等）
- **结算明细**：每订单一行，展开查看逐项分摊快照；每行可发起争议；含审批流水
- **差异批次**：费率修订产生的差异批次及新旧费率对比
- **争议**：列表与结案处理，显示绑定的批次与费率版本
- **费率版本**：版本列表、新建版本、发起修订（生成差异批次）
- **订单追溯**：订单 → 拆分/优惠/退款/补贴 → 全部结算行及费率版本

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/settlements/run` | 运行结算 `{period, rate_version_id}`（幂等/重算） |
| POST | `/api/rates` | 新建费率版本 |
| POST | `/api/rates/revise` | 费率修订 `{period, new_rate_version_id}` → 差异批次 |
| POST | `/api/batches/:id/submit|approve|reject|pay` | 审批流转与付款 |
| GET | `/api/batches/:id` | 批次 + 明细行 + 审批流水 |
| POST | `/api/disputes` / `/api/disputes/:id/resolve` | 争议登记与结案 |
| GET | `/api/orders/:id/trace` | 订单全链路追溯 |
| POST | `/api/refunds` | 录入退款（已冻结周期会被 409 拒绝，防漏结） |

## 目录结构

```
src/domain.js   纯函数：分摊、佣金、调整行、差异行
src/db.js       SQLite schema（含幂等唯一索引）
src/store.js    工作流：结算运行、费率修订、审批、付款、争议
src/server.js   HTTP API + 静态服务
src/seed.js     演示数据
test/verify.js  55 项端到端验证
public/         前端单页应用
```
