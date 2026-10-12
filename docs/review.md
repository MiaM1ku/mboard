# mboard 设计与集成验收

## 固定场景

Scenario: 初始化、用户仪表盘、管理仪表盘、密集列表、问题会话和编辑对话框。
Input: 浏览器测试创建 2 个测试账号、1 个访问分组、1 台接入机器、1 个授权节点、公告和指南。测试通过真实节点接口提交固定流量批次。截图数据属于验收数据。运行页面另用全新空数据库初始化。
Viewport: 1440 × 900；390 × 844。
Theme: 浅色和深色。共享双主题变量覆盖两端。
design.md version: 2026-10-13。
Generation context: 管理面板由独立新上下文根据 design.md 和固定 API 需求生成。共享组件、外壳和用户页面在主上下文生成。
Review method: Playwright 驱动实际 Bun HTTP 服务；DOM、computed styles、键盘操作、真实 CRUD；截图人工检查。
Result: pass。

## 证据

- `bun run build`：严格 TypeScript 检查和 Vite 生产构建通过。
- `bun run test`：30 个服务端及迁移测试通过，272 次断言。
- `bun run test:e2e`：5 个浏览器场景通过。场景覆盖 14 个页面的桌面和窄屏布局、双主题切换、初始化、真实用户问题会话、管理员回复、订阅下载、管理 CRUD、一次性令牌清理、站点展示和键盘操作。
- `bun audit`：依赖审计通过。
- Go 节点的 `go test -race ./...`、`go vet ./...` 和 `go build` 通过。
- `scripts/proxy-smoke.ts`：实际 Go 节点、Bun 面板和官方 sing-box 1.14.3 完成配置下发、心跳、VLESS 和 Shadowsocks HTTP 转发、队列确认和重复批次去重。
- 本机运行地址 `http://127.0.0.1:8787/` 显示全新工作区初始化页面。实际浏览器检查得到 1 个 h1，浏览器错误数组为空。

## 机械检查

1. 每个稳定页面拥有 1 个 h1。
2. 1440px 和 390px 视口下，document.scrollWidth 小于或等于视口宽度。
3. 每列 th 和 td 的 computed text-align 相同。
4. 页面用到的组件、CSS 原语、图标、系统字体和自有 favicon 都有实现。
5. 键盘聚焦按钮呈现 2px 外框。
6. 移动导航支持 Escape 关闭和焦点回归。对话框支持 Tab/Shift+Tab 循环、Escape 关闭和触发控件焦点回归。
7. 页面能力介绍、帮助和空状态通过正向文案检查。删除、凭据轮换等操作准确说明结果和需要采取的动作。
8. 单日图表只绘制真实数据点。SVG 轴标签的 font-size × screen transform 至少为 11.9px，目标为 12px。

## 观察与修复

### Implementation error

- 共享 Field 的隐式标签包含帮助文字，导致控件名称混合。改为显式 label、稳定 id 和 aria-describedby。
- 共享按钮 display 覆盖了移动控件的隐藏条件。修正为带控件类的选择器，桌面菜单和关闭按钮按视口显示。
- 抽屉关闭时主区域仍处于 inert 状态，过早恢复焦点。改为 DOM 更新后的 effect 清理恢复焦点。
- 原生 dialog 的 Shift+Tab 可进入浏览器焦点区。添加明确的对话框焦点循环。
- 单日序列的面积图表达了额外趋势。改为上传和总流量两个数据点，日期对齐到数据点。多日期按真实时间间距绘制。
- 固定 SVG viewBox 在手机上缩小了轴标签。改为按真实容器宽度绘制，保留实际 12px 标签。
- 手机仪表盘后的公告表面缺少区块间距。统一 .dashboard-grid 的结束间距。

### Requirement issue

- 分组和机器删除确认原先暗示自动解绑，实际服务有依赖保护。改为先处理关联，再删除记录的真实操作说明。
- 0 字节配额在管理列表需要说明累计模式。现在按实际用量累计显示。
- Shadowsocks 协议选择自动进入 AES-128-GCM 加密模式，Trojan 使用 TLS，VLESS 的 TLS 保持可配置。
- 管理审计动作映射改为匹配实际服务端动作名称。
- 日用量标注 UTC 日期，完整时间用浏览器本地格式呈现。

### Environment issue

- 从桌面切到手机时，第一张截图捕获导航过渡帧。截图配置明确禁用动画以记录稳定布局。页面过渡行为继续按设计提供。
- 测试中的身份切换先前继承了旧页面的请求状态。验收在切换后重新加载实际页面，产品也在 401 响应时重新验证登录状态。
- 测试选择器先前混淆数据单元格和操作按钮，以及隐藏对话框标题和令牌输入框。验收现在按准确名称定位。

## 规则回写

- 时间序列单点和真实日期间距规则适用于两端时间序列图。来源是两端固定日数据场景。它属于展示规则，和数据字段定义保持分离。
- 容器实际宽度和 12px 轴标签规则适用于响应式图表。用原来相同的 390px 场景复核。
- 对话框和抽屉焦点规则适用于两端共享交互。用相同键盘场景复核。
- 620px 以下指标卡保留两列，表单和内容主区采用单列。这是明确设计决定，依据是窄屏可读数值和表单实际宽度。
- 公开原语表绑定到实际实现路径，包含指标、排布、信息组和强调表面。

## 计算样式记录

测量输入来自 [computed.json](review/computed.json)。字体为系统 ui-sans-serif 栈。1440px 深色用户仪表盘的标题为 30px、700、37.5px 行高。数值为 32px、650、38.4px 行高。主内容内边距为 32px 32px 64px。单个强调按钮为 13px、600。上述都是 DOM 的实际计算值。

## 截图

- [初始化](review/setup-desktop.png)
- [用户桌面](review/user-1440.png)
- [用户手机](review/user-390.png)
- [用户深色](review/user-dark.png)
- [管理桌面](review/admin-1440.png)
- [管理手机](review/admin-390.png)
- [用户管理列表](review/admin-users-1440.png)
- [首轮结果](review/initial/admin-1440.png)

首轮结果保存用于记录修复前的真实产物。复核使用相同输入和视口，最终结果保存为上面的当前截图。

## Deviations 和 Open questions

- 管理指标与用户指标采用各自适合的高度，主要信息层级和公开原语一致。
- 展示使用系统中文字体；实际字形取决于目标设备的系统字体。
- 屏幕阅读器专项检查、各平台客户端体验和大规模负载检查可作为上线验收项目。

## Limits

- 浏览器自动化基于 Chromium；运行环境为 Bun 1.3.14、Go 1.26.6 和本地 Linux。
- 真实代理测试覆盖 VLESS 和 Shadowsocks TCP HTTP 转发。Trojan/TLS 的证书、DNS和防火墙应按实际部署环境验收。
- 流量烟雾测试输入为实际测得的 HTTP 正文大小，用于验证持久化上报链路。生产流量需要可信采集器提供完整的用户/节点增量，包含连接关闭时的最终记录。
- 迁移测试基于固定离线 JSON 和临时数据库。实际旧库的导出一致性、复杂节点配置转换、加密模板解密和切换窗口按迁移方案检查。
- 本轮独立核心版包含 VLESS、Trojan 和 Shadowsocks TCP、单机器节点关联、权限组授权、sing-box JSON 订阅及增量上报接口。

## 参考依据

- [Bun runtime](https://bun.sh/docs)：内置 HTTP、SQLite 和密码 API。
- [Vite backend integration](https://vite.dev/guide/backend-integration)：独立前端构建和 HTTP 后端集成。
- [sing-box 1.14.3 多用户 Shadowsocks 实现](https://github.com/SagerNet/sing-box/blob/v1.14.3/protocol/shadowsocks/inbound_multi.go)：实际 aes-128-gcm 多用户配置支持。
