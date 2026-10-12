---
name: mboard-design
description: mboard 的用户和管理界面，覆盖仪表盘、密集列表、主从编辑器和登录表单，以清晰的数据层级服务桌面和移动阅读。
version: e02a4f5448e88bfa7d3e9b5dacf3dd49792c5eef
---

# mboard design

## 1. 范围和优先级
[MUST] 本规则用于用户和管理界面的浅色、深色主题。
[MUST] 优先满足真实信息、用户要求、可访问性和操作清晰度，再处理视觉表达。
[MUST] 每个页面用一个 h1 表达页面主题。

## 2. 品牌和读者
[SHOULD] Decision：用深墨导航、浅灰绿画布、青绿操作表达独立的工具品牌。来源：独立 mboard 重写要求和高密度管理界面的阅读需求。
[SHOULD] Decision：标题和数据用明显的尺寸对比，辅助信息保持 12px 以上。来源：原界面的 11px 元数据需要更清晰的阅读层级。
[MUST] 文案直接说明能力、结果和下一步操作。空状态给出可执行的入口。风险文案准确说明操作后果。

## 3. 页面结构和构图
[SHOULD] Decision：桌面导航固定宽 232px，主区域用顶部路径、页面标题和内容组成。来源：现有 Shell 的分区导航和桌面阅读密度。
[SHOULD] 仪表盘首屏先呈现主题和核心数值，然后呈现时间序列和相关列表。次要信息放在右侧或页面下半部。
[SHOULD] 密集列表用标题操作区、工具栏、可横向滚动的数据表和页脚组成。
[SHOULD] 主从编辑器以清晰标签分组，把动作放在表单末尾。长表单和弹窗各自滚动。
[SHOULD] 登录表单最大宽 420px。桌面另一栏用大标题、细线网格和简短能力描述组成。移动端先呈现表单。

## 4. 视觉规则
[SHOULD] Decision：字体沿用系统 ui-sans-serif 栈，中文用 Noto Sans SC 或设备中文字体。来源：现有本地可用字体，加载稳定。
[SHOULD] 使用 styles.css 的语义色变量。--background 是画布，--card 是内容面，--primary 是主要动作，--muted-foreground 是辅助文字。
[SHOULD] Decision：标题 30px/700/1.25，区块标题 15px/650/1.5，正文 14px/400/1.65，标签 12px/600/1.5，大数 32px/650/1.2。来源：提升原有信息层级。
[SHOULD] 数值使用 tabular-nums。长标识符允许换行，表格时间和短数值保持完整。
[SHOULD] 主内容最大宽 1560px，桌面边距 32px，区块间距 24px，组内间距 12px，卡片内边距 22px。
[SHOULD] 表面用 1px 边框和 12px 圆角。投影用于浮层和强调卡片。
[SHOULD] 图标沿用 lucide-react，普通图标 18px，线宽 1.75。图标依靠轮廓和含义表达作用。
[SHOULD] 图表上传用 --primary，总流量用 --info，坐标标注单位。空图表显示设置或数据采集入口。
[MUST] 图表按容器实际宽度绘制。轴标签在桌面和窄视口中保持 12px 的实际显示字号。
[MUST] focus-visible 用 2px --ring 外框和 3px 间距。每个图标按钮提供可访问名称。
[MUST] 导航抽屉关闭后，焦点回到打开导航的按钮。活动对话框中的 Tab 和 Shift+Tab 在其可操作控件之间循环。关闭对话框后，焦点回到触发控件。
[MUST] 数据表在 .table-wrap 内水平滚动，页面宽度保持在视口内。同列标题和单元格保持相同对齐。
[SHOULD] 状态使用文字和语义色，重要状态可加圆点。普通元数据用文本呈现。
[SHOULD] 820px 以下导航成为抽屉，主区域左边距归零。620px 以下标题操作垂直排列，表单成为一列。指标卡以两列显示，数字字号采用 26px。
[SHOULD] Decision：窄视口的指标保留两列，相关大区块采用单列。来源：390px 的用户和管理仪表盘复核，可读数值支持更紧凑的首屏。
[MUST] 时间序列只有一个日期时，用真实数据点表示上传和总流量。日期与数据点对齐。多个日期时按真实日期间距绘制折线。
[SHOULD] loading 显示骨架或旋转图标，提交状态锁定对应按钮。错误提示提供下一步操作。禁用状态降透明度并保持标签可读。
[MUST] prefers-reduced-motion 下动画和过渡取最短时长。

## 5. 可用原语
以下名称是公开原语。页面扩展使用 mb-custom-*，扩展负责内容排列。共享字号、颜色和表面由 styles.css 统一管理。

| 角色 | 实现名或值 | 来源 | 使用条件 | 状态 |
|---|---|---|---|---|
| 语义色 | --background, --foreground, --card, --primary, --primary-foreground, --muted, --muted-foreground, --border, --input, --ring, --success, --warning, --danger, --info | src/web/styles.css | 两种主题 | 已实现 |
| 字号 | --text-title, --text-section, --text-body, --text-label, --text-number | src/web/styles.css | 各文字角色 | 已实现 |
| 布局 | .app-shell, .sidebar, .app-main, .topbar, .page-content, .page-header | src/web/styles.css | 主界面 | 已实现 |
| 动作 | Button variant=primary/secondary/ghost/danger | src/web/ui.tsx | 按钮 | 已实现 |
| 表面 | Card; .card-header, .card-body | src/web/ui.tsx, styles.css | 数据分组 | 已实现 |
| 表单 | Field, Input, Select, Textarea | src/web/ui.tsx | 标签和控件配对 | 已实现 |
| 状态 | Badge, EmptyState, ErrorState | src/web/ui.tsx | 状态反馈 | 已实现 |
| 浮层 | Modal | src/web/ui.tsx | 对话框和主从编辑器 | 已实现 |
| 数据 | .data-table, .table-wrap, .kpi-grid, .kpi-value, .mono | src/web/styles.css | 表格和数值 | 已实现 |
| 图表 | TrafficChart | src/web/TrafficChart.tsx | 按日期的字节时间序列 | 已实现 |
| 排布 | .dashboard-grid, .section-stack, .form-grid, .form-stack, .form-actions, .page-actions, .content-grid | src/web/styles.css | 数据分区与表单排列 | 已实现 |
| 文字 | .eyebrow, .muted, .text-success, .text-danger, .notice-body, .category-label | src/web/styles.css | 层级、状态和长文 | 已实现 |
| 表格内容 | .node-cell, .table-primary, .table-actions | src/web/styles.css | 表内主体与操作 | 已实现 |
| 指标 | .kpi-card, .kpi-top, .kpi-value, .kpi-hint | src/web/styles.css | 计数与用量概览 | 已实现 |
| 信息组 | .info-list, .info-row, .callout | src/web/styles.css | 键值数据和解释 | 已实现 |
| 强调表面 | .subscription-card, .subscription-actions, .subscription-meta, .usage-track, .quick-link, .guide-details | src/web/styles.css | 主要入口、比例和展开长文 | 已实现 |

[SHOULD] 最小组合：`<Card><div className="card-header"><h2>标题</h2></div><div className="card-body">内容</div></Card>`。
[SHOULD] 控件组合：`<Field label="名称"><Input required /></Field>`。

## 6. 文案和数值格式
[MUST] 标题用简短名词，按钮用明确动词，帮助文字说明作用和下一步。
[MUST] 页面介绍写可用能力。数据来自真实接口，示例数据标注为演示。
[SHOULD] 字节按 B、KB、MB、GB、TB 显示，保留最多 2 位小数。整数计数用千位分隔，时间显示本地日期，完整时间可用 title 提示。
[SHOULD] 空状态说明建立内容的方法，错误状态说明可尝试的修复动作。
[MUST] 删除、凭据轮换和重启等操作在确认对话框中说明具体后果。

## 7. 常见模式的处理
[SHOULD] 让首屏结构跟随内容密度，仪表盘使用左对齐标题。
[SHOULD] 同一数据组用一层表面表达，内部以线条和间距分区。
[SHOULD] 普通装饰图标保持透明背景。
[SHOULD] 字号、字重和色值从公开原语读取。
[SHOULD] 主要信息用正文色和至少 14px 字号。
[SHOULD] 常规元数据以文本呈现，胶囊用于状态。

## 8. 实现集成
[SHOULD] 共享样式入口为 src/web/styles.css。字体使用本地系统栈。
[SHOULD] document.documentElement 的 .dark 类控制深色变量。主题选择存放 mboard-theme。
[SHOULD] 组件入口为 src/web/ui.tsx。图标由 lucide-react 提供。

## 术语
| 概念 | 名称 |
|---|---|
| 页面画布 | --background |
| 内容表面 | Card / --card |
| 主操作 | Button / --primary |
| 页面容器 | .page-content |
| 标签控件组 | Field |
| 时间序列 | TrafficChart |
