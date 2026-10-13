# TrafficReport 独立迁移

## 口径和一次真实测试

旧插件的报告含用户邮箱。只有管理员可以看完整预览或手动发送。运行列表、设置 DTO、CLI 输出不包含报告正文、邮箱、Webhook 路径/查询参数或 Authorization。数据库内的消息快照和旧配置快照属于敏感数据，数据库及备份要保持文件 `0600`、目录 `0700`。

迁移测试消息单独标注 `# mboard Webhook 迁移测试（真实发送）`，使用合成内容，不带用户或流量记录。用户允许的 **一次真实测试要在父任务部署后发送**。本模块测试全部离线，不能把单元测试通过当成真实 Koishi 接收成功。部署人员为该次操作固定请求编号。CLI 固定使用 `migration-webhook-test-v1`，重复入队返回同一运行。父任务的管理员 HTTP 测试接口同样应固定这次操作的请求编号。

HTTP 发送是**至少一次**，不是恰好一次：接收端成功处理后、SQLite 写入 `sent` 前进程退出，租约回收后可能重复投递。每个运行的 `X-Mboard-Delivery-ID` 在重试中不变，接收端可以据此去重。不支持该头的接收端仍可能收到重复消息。配置编辑可以取消尚在队列中的运行，但不能撤回已经发出的消息或正在网络中处理的 POST。

## 父任务接线契约

实现入口：[traffic-reports.ts](../src/server/traffic-reports.ts)。CLI：[traffic-reports.ts](../scripts/traffic-reports.ts)。离线测试：[backend-traffic-reports.test.ts](../tests/backend-traffic-reports.test.ts)。本模块不修改应用路由、流量入口、服务器启动或 UI。

1. 完成归档导入和 runtime restore 后，应用接收第一批流量之前调用 `initializeTrafficReports(db, { now?: Date })`。这是同步、幂等、仅本地 SQLite 的附加初始化，不改变中央 `user_version`。不能在归档导入前初始化，否则空种子会按设计保持不变。
2. 流量入口验证节点归属、用户归属、profile 授权和计数安全范围之后，在原有流量事务内调用同步 `recordReportTraffic(...)`，然后提交并返回 ACK。重放批次必须由入口原有幂等逻辑拒绝，不能再写报告账本。
3. 管理员路由调用设置、预览、入队和安全运行列表。请求体异步读取后重新验证管理员会话。`enqueueReport` 不发送网络请求。不要在 HTTP 响应路径同步跑 worker。
4. 独立 timer/worker 每分钟运行 CLI `--tick`，或父任务直接调用 `tickReportSchedule` 后调用 `runReportWorker`。

### 导出 API

```ts
initializeTrafficReports(db, { now?: Date }): ReportSettingsDTO
getReportSettings(db): ReportSettingsDTO
saveReportSettings(db, patch: ReportSettingsPatch): ReportSettingsDTO
buildPreview(db, kind: 'daily'|'weekly'|'monthly'|'test', now?: Date): ReportPreview
enqueueReport(db, kind, now?: Date, { manual?: boolean, idempotencyKey?: string }): ReportRunDTO | null
listReportRuns(db, limit = 50): ReportRunDTO[]  // 1..100
getReportRun(db, id): ReportRunDTO | null
tickReportSchedule(db, now?: Date): ReportRunDTO[]
runReportWorker(db, { now?: Date, maxJobs?: number, resolve?, transport? }): Promise<ReportRunDTO[]>
recordReportTraffic(db, {
  source: 'runtime'|'basic', user_id: number, node_id: number,
  profile_id?: string, upload_bytes: number|bigint, download_bytes: number|bigint,
  accepted_at: Date
}): void
```

`ReportError` 导出 `status=400`、枚举 `code` 和同枚举 `message`，不会放入来源值。生产调用要捕获该类，不能返回底层异常详情。

设置 DTO：`enabled, webhook_configured, url_display`（只显示 hostname，可为 null），`authorization_configured, top_limit, timezone, schedule, revision`。`schedule` 为 `{daily:'00:00', weekly:'Sunday 00:00', monthly:'1st 00:00'}`。

PATCH 仅接受以下字段，未知字段拒绝：

| 字段 | 省略 | null | 空字符串 | 合法值 |
|---|---|---|---|---|
| `webhook_url` | 保持 | 清除 | 清除 | HTTPS URL |
| `authorization_header` | 保持 | 保持 | 清除 | 原样保存，最多 4096 UTF-8 字节，无控制字符 |
| `enabled` | 保持 | 拒绝 | 拒绝 | 显式 boolean |
| `top_limit` | 保持 | 拒绝 | 拒绝 | 整数 1..100 |

时区固定 `Asia/Shanghai`，schedule 固定，不能借 PATCH 修改 URL 安全策略。所有实际设置编辑增加 revision，并取消 queued/processing 旧运行，包括手动运行。发送前 worker 再检查 revision/租约，防止旧运行静默发送到新的 URL。网络 POST 一旦开始，配置变更不能撤回。

预览返回 `kind,title,start_date,end_date,timezone,message,nodes,users,warnings`。`nodes/users.bytes` 和 `topNode.bytes` 是十进制**字符串**，不要转 JS Number 后排序。预览有邮箱，只能在授权管理员界面显示。`kind='test'` 只返回合成迁移消息，不读流量、标签或邮箱。

运行 DTO 只含 `id,kind,status,period_key,start_date,end_date,timezone,attempts,http_status,error_code,created_at,next_attempt_at`，时间为 epoch 毫秒。没有 message、URL、Authorization 或源记录。手动入队总是创建独立运行，只有同一个 `idempotencyKey` 才返回同一个运行；同 key 不同 kind/手动模式拒绝。计划运行按 `(kind,source_start,source_end,timezone)` 唯一。停用计划后不会再创建或处理计划运行，显式管理员手动报告和测试仍可发送。

## 原配置种子

从 `legacy_records kind='v2_plugins' code='traffic_report'` 读取原插件配置，`config` 兼容 JSON 字符串和对象。原 `is_enabled='1'` 保持计划启用。归档原 JSON 文本和未默认化配置先写入私有 `traffic_report_seed.legacy_snapshot`，之后才校验/默认化。以后初始化不覆盖管理员编辑、原快照或 pre-hook baseline。

按照实际 PHP，仅 Webhook 和 Authorization 在插件值为空时使用 `v2_settings` 的 `daily_report_url`、`daily_report_header_authorization`。weekly 字段不参与 fallback。默认 Top 5，上限收紧为 100。畸形旧 URL/头会保留在私有原快照，安全设置禁用该源，不返回原值。种子只做 URL 形状检查，**不查 DNS、不发 HTTP**。

## 日期、完整历史和出口排行

- 每日：上海自然日昨天。
- 每周：昨天向前六天至昨天结束，共七个自然日；触发时间是周日 00:00。
- 每月：上一个完整自然月；触发时间是每月一日 00:00。先找到本月第一日再退一天，修复 31 日 month-subtract 溢出，含闰年二月。
- 新账本：按 `accepted_at` 写 epoch **小时** INTEGER，按 source/user/node/profile 分区。Shanghai 整点窗口可以准确选择。basic 和 runtime 即使节点数字 ID 相同，排行候选和标签也保持独立。计数 TEXT 存储十进制 BigInt，逐行累加，不用 SQLite `SUM` 或 JS 浮点求和。
- 旧历史：仅读取范围内 `v2_stat_server`、`v2_stat_user`、`v2_user_node_traffic` 的 `record_type='d'`。SQL 先过滤 kind、record_at、类型，整型字节由 SQLite JSON 提取为 TEXT，避免 JSON.parse 大数舍入。不会把数万条 user-node 历史全部解析后再筛选。
- 旧 profile 是物理总量子集：profile 映射即时 `parent_id` 物理根，按原 PHP 从物理节点减去其 profile 子集，再独立列出出口。旧用户排行保留 `v2_stat_user` 的计费口径，最高节点按旧 user-node 记录拆分。新小时账本已经分区，**不能再减 profile**。

### 接入前 UTC 整日基线

第一次初始化把现有 `traffic_daily` 和 `runtime_node_traffic` 拷贝成不变的 `traffic_report_baseline`。这些表在迁移接线前只保留 UTC 日期和节点/用户总量，无法恢复每小时或出口 profile。之后只加新小时账本，绝不再把持续增长的中央 daily 表叠加一次。

一个 UTC 日跨两个上海日。如果两个日报都计入相交整桶，接入前流量就会重复。这里选择明确的近似：**UTC 2026-10-13 整桶仅归入同名上海日期 2026-10-13 一次**。这保留已知全部字节，没有捏造小时分配，也不会在 10 月 14 日报告再计一次。对应时期的日报不是严格上海 00:00..24:00 时间分配。接入前合并在入口节点的 profile 流量无法凭汇总恢复，不能把入口总量再次拆成猜测的出口。

预览的动态 warnings 包括：

- `missing-history-boundary_warning`
- `pre-hook-utc-daily-unallocated`
- `pre-upgrade-profiles-merged-into-entry-node`
- `intersecting-utc-day-included-whole`
- `utc-day-attributed-to-same-calendar-label`
- `baseline_utc_dates:2026-10-13`（实际选中日期）
- `baseline_rows:users=28,node_users=414`（示例，按数据库实际行数生成）
- `sources:legacy-shanghai-daily,pre-hook-utc-daily,post-hook-epoch-hourly`

父 UI 应显示这些口径说明。不能声称接入前 profile 和边界日小时精度已经恢复。归档没有对应记录的历史窗口也会提示缺失边界。中央迁移须保证 pre-hook daily 是归档之后的新增流量，不是再次导入的旧 daily 汇总；本模块不能凭丢失的批次标识猜出同一字节是否曾被外部重复导入。

## 日历触发和 outbox

第一次初始化把 schedule 游标设为当天，无首启补发。timer 跨入紧邻下一天、距上海午夜最多 120 秒时，创建 just-due 的 daily，以及符合条件的 weekly/monthly。间隔多日或迟到超过 120 秒只推进游标，不补发积压历史。进程和 timer 离线可能错过计划，操作人员可用管理员手动报告补发所需周期。时间必须由可信服务器提供。

运行持久化 `message` 快照、周期边界、attempts、status、next_attempt_at、revision、created_at、lease token/expiry、HTTP 状态码和脱敏枚举错误。queued/processing/sent/failed/cancelled 是明确状态。worker 用短 `BEGIN IMMEDIATE` 原子 claim，60 秒租约，**不在事务内 await DNS/HTTP**。崩溃租约到期回收，最多三次尝试，普通错误等待 60 秒、120 秒再试。单次 worker 最多处理 10 个运行（可显式降低）。

## Webhook 安全和协议

生产仅 HTTPS，不支持 `allowPrivate` 或 HTTP 例外。真实公网目标不需要私网例外；离线测试注入 resolver/transport。URL 拒绝 userinfo（包括空 userinfo `https://@host`）、fragment（包括空 `#`）、原始/编码 CRLF、反斜线、非 HTTPS 协议。每次尝试重新解析所有 DNS 地址，任意一个非公网结果都拒绝，包括 localhost、IPv4 私网/回环/链路本地/元数据/保留地址、IPv4-mapped IPv6、ULA、IPv6 回环/链路本地以及保守拒绝的转换/文档地址。

默认 sender 是 `node:https.request`，每个运行新连接 `agent:false`，custom lookup 只返回刚验证的地址，保留原 hostname 作为 TLS/SNI 和证书验证目标。连接期间不会第二次执行系统 DNS，因此 DNS rebind 无法把已通过检查的 hostname 换成私网连接。响应 3xx 是错误，绝不跟随重定向。DNS 和 HTTP 合计尝试预算 10 秒，响应体最多 64 KiB，丢弃内容；错误和日志不读取、展示响应体或底层异常字符串。POST 为 JSON `{message:string}`，总 payload 最多 256 KiB，Authorization 使用保存的**原值**，不自动添加 Bearer。

使用的 Bun/Node API 文档：[Bun node:https 自定义 lookup 回归测试](https://github.com/oven-sh/bun/blob/main/test/regression/issue/27890.test.ts)、[Bun net 自定义 lookup 路径](https://github.com/oven-sh/bun/blob/main/src/js/node/net.ts)、[Bun DNS](https://github.com/oven-sh/bun/blob/main/docs/runtime/networking/dns.mdx)。本地测试运行版本 Bun 1.3.14；引文描述当前官方实现。除离线请求工厂外，还用临时自签测试 CA、虚构 hostname 和 `127.0.0.1` 上的 TLS 接收器验证了实际 `node:https.request` 的 lookup pinning、Host 和 hostname 证书验证。该测试只注入测试 CA，证书验证保持启用；它不联系公网，也不是 Koishi 迁移测试。

## CLI 和 systemd 调度例子

仅使用现有绝对路径的私有普通 SQLite 文件，拒绝符号链接和非 `0600` 文件。没有 URL/Authorization 参数或环境变量，CLI 不输出正文、邮箱或响应内容。`--preview` 只输出安全周期/count/warnings，完整正文用授权管理员预览。

```sh
bun scripts/traffic-reports.ts --db /private/mboard.sqlite --settings
bun scripts/traffic-reports.ts --db /private/mboard.sqlite --list
bun scripts/traffic-reports.ts --db /private/mboard.sqlite --preview daily
bun scripts/traffic-reports.ts --db /private/mboard.sqlite --tick --max-jobs 4
# 只在父任务部署后执行一次；入队不等于接收成功，下一次 --tick 才 POST。
bun scripts/traffic-reports.ts --db /private/mboard.sqlite --enqueue test --manual --request-id migration-webhook-test-v1 --allow-real-migration-test
# 显式管理员手动日报，同一 request-id 重试只创建一个运行。
bun scripts/traffic-reports.ts --db /private/mboard.sqlite --enqueue daily --manual --request-id operator-daily-20261014
```

下面是部署文档范例，不由本模块安装。timer 每分钟运行，午夜 grace 120 秒；不能替代进程 uptime。`Persistent=false` 不补跑关机期间时间点。确认 SQLite 路径、Bun 路径和服务用户之后由父任务安装。

```ini
# mboard-traffic-reports.service
[Unit]
Description=mboard traffic report outbox tick
After=mboard.service
[Service]
Type=oneshot
User=mboard
WorkingDirectory=/opt/mboard
ExecStart=/opt/bun/bin/bun scripts/traffic-reports.ts --db /private/mboard.sqlite --tick --max-jobs 4
UMask=0077
TimeoutStartSec=120
NoNewPrivileges=true

# mboard-traffic-reports.timer
[Unit]
Description=mboard traffic report minute tick
[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s
Persistent=false
Unit=mboard-traffic-reports.service
[Install]
WantedBy=timers.target
```

## 离线验收

```sh
bun test tests/backend-traffic-reports.test.ts
bunx tsc --noEmit
```

测试使用虚构域名、模拟公共 DNS 和注入的本地内存 transport/request 工厂，不加载真实敏感归档、不联系真实 Webhook。覆盖种子/fallback/不覆盖编辑、月末闰年/上海边界、原 profile 扣除和新 profile 分区、BigInt/SQL SUM 溢出安全、基线不重复、schedule/no backfill、idempotency、并发 claim、崩溃租约、三次退避、旧 revision、错误脱敏、SSRF、多 DNS 地址/rebind、无 redirect、payload/response 限制、TLS pinning 参数和超时。
