# Traffic Report 管理界面复核

Scenario: 管理面板站点设置中的流量 Webhook、报告预览和发送记录
Input: 隔离测试数据库中的真实 API 配置和排队记录；浏览器发送状态展示使用明确的 GET fixture。线上复核使用原配置和实际唯一迁移测试投递记录。
Viewport: 1440 × 900、390 × 844
Theme: light；既有深色共享原语继续复用，新增模块深色本轮没有单独截图。
design.md version: motion-2026-10-13
Generation context: 新组件由独立上下文按现有 design.md 和 UI 原语生成，主上下文完成真实 API 挂接和浏览器复核。
Review method: `bun run build`、10 项 Playwright 场景、DOM/computed styles、真实原配置管理员 API 和线上 Chromium。
Result: pass

## 第一轮发现与修复

新 Webhook 提交动作最初与站点信息同名“保存设置”，严格交互定位匹配两个按钮。修改为“保存 Webhook 设置”，让不同配置动作明确区分。类别：Implementation error / 操作定位。

## 复查

- 页面的 h1 保持一个。
- 1440px 和 390px 文档宽度保持视口内。
- 输入、标签、表格、Card、Modal 和按钮引用现有公开原语。
- Webhook 地址只回显主机名和配置状态，Authorization 为密码输入且 GET 保持空值。
- 改排行数量时未输入的原凭据保持原值。清除凭据使用单独勾选动作。
- 管理预览按日报、周报和月报生成，内容按原文只读处理。
- 发送前确认外部接收端会收到身份和邮箱信息，队列明确显示排队而非假称成功。
- 测试消息确认框、HTTP 202 入队和刷新显示已发送的 fixture 通过。
- 线上真实原 Top 5、三种周期预览和实际 HTTP 200 测试记录通过。
- 线上移动端横向溢出 false，浏览器运行错误数组为空。
- 发送测试的真实生产调用仅为明确允许的 migration-webhook-test-v1，一次尝试 HTTP 200。

## 截图

[宽视口](webhook/settings-1440.png)

[窄视口](webhook/settings-390.png)

Violations: 复查零。
Deviations: 设置区按同一页面内的配置、预览、记录三段呈现，复用现有密集管理样式。
Open questions: 用户可根据原接收端查看迁移测试消息的最终聊天展示。
Limits: 真实接收端检查到 HTTP 200 和持久化成功记录；没有访问 Koishi 聊天端内部 DOM。日间离线机器的采集升级在下一联网窗口任务继续，升级前出口分项保持在节点总量内。
