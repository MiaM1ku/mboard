# 动效增强复核

Scenario: 用户连接概览、管理概览、连接入口、问题弹窗和移动导航
Input: Playwright 隔离数据库中经真实 API 创建的账户、节点、机器、用量和问题会话。折线场景明确用测试响应扩展为两天数据。
Viewport: 1440 × 900、390 × 844
Theme: light、dark
 design.md version: motion-2026-10-13
Generation context: 数值和图表原语由独立上下文实现，共享 UI 和 CSS 在读过现有实现的主上下文中增强。
Review method: `bun run build`、Playwright 浏览器、截图及 DOM/computed styles、可控帧时钟、媒体偏好切换和键盘操作。
Result: pass

## 用户要求

“动画太少了”。沿用现有系统字体、深墨导航、青绿动作、布局和真实接口。增加可感知的页面切换、表面分阶段进场、数字插值、图表绘制、导航标记移动、主题切换、按钮反馈、加载节奏、弹窗和提示进退场。

## 缺失规则和实现位置

原 design.md 只定义了减少动态效果。新的节奏规则适用于用户和管理界面的共享原语，属于呈现规则。新值集中在 styles.css 的 --motion-*，动态数值由 motion.tsx 处理。没有新增依赖和并行主题系统。

## 第一次输出

`bun run build` 通过。原 6 个浏览器场景中的问题会话场景失败：关闭原生 dialog 之前等待 180ms，会挡住马上进行的补充说明输入。

分类：Implementation error，影响主要输入任务及焦点恢复。

修复：关闭动作立即执行 dialog.close、释放滚动和恢复焦点。退出阶段画面用 display/overlay 的离散过渡保留，退出画面 inert 且 pointer-events:none。内容在 180ms 后卸载。减少动态效果时立即卸载。把这一行为明确写入共享规则。

主题切换最初采用根 view-transition。目视检查发现，页面还在加载或改变内容尺寸时，根截图交叉缩放产生重影。改为实际表面颜色过渡和主题图标旋转，保持原页面结构与操作节点。

## 一次复查

`bun run build` 通过。`bun run test:e2e` 的 9 个场景通过，包含原 6 场景及 3 个新增动效场景。

- 每页一个 h1。
- 桌面、移动页面宽度保持在视口内。
- 表格同列标题和内容对齐。
- 图表轴文字在实际尺寸下保持 12px。
- 原有表单、问题提交和回复、管理 CRUD、订阅下载和跨域链接操作通过。
- 数字中间帧和最终值不同，最终值和真实 API 相符。可访问文本直接给出最终值，视觉插值为 aria-hidden。
- 数字在模拟 document.hidden 时暂停，恢复后到达最终值。
- 动画中途切换 prefers-reduced-motion 后立即到达最终值。
- 卡片阶梯延迟、页面淡入、导航标记过渡在 computed styles 中命中实际动画名称和时长。
- 一个真实日期保留两个真实数据点。
- 图表容器改变尺寸时保留原 plotted SVG group。
- 两天的测试响应绘制两条 pathLength=1 折线，命中 900ms 绘制动画。
- 对话框关闭立即退出原生 open 状态并恢复触发器焦点，退出画面为 inert。
- 移动导航 Escape 和弹窗键盘焦点行为通过。
- 减少动态效果时 animation delay 和 transition delay 为 0，CSS 时长最短。
- 浏览器运行错误数组为空，桌面浅色和移动深色截图完成目视复核。

## 截图

- [用户端桌面](motion/user-desktop.png)
- [用户端移动深色](motion/user-mobile-dark.png)

截图表达动画结束后的布局。动画行为由浏览器帧时钟、DOM 状态和媒体偏好检查验证。

## 线上部署复核

example-host 的现有 /opt/mboard 面板构建已切换到动效版本，已有静态下载和旧资源文件保留。Bun 服务持续运行，前端发布采用静态产物切换。

真实站点 Chromium 检查：管理概览命中 mb-page-enter、mb-surface-enter、四个原始指标和一个真实日期的图表；1440px 页面宽度正常。创建节点弹窗进场和 Escape 关闭通过。390px 减少动态效果模式的标题时长 0.00001s、延迟 0s，导航关闭焦点正常、横向溢出为 false、页面运行错误数组为空。短期私密验证会话随后退役。

Violations: 复查时为零。
Deviations: 原生 dialog 离散 display/overlay 过渡在支持该特性的浏览器中保留退出画面，较旧浏览器采用立即关闭，交互和焦点即时释放。
Open questions: 用户对动效强度的主观反馈需要在线看。
Limits: 渲染和交互复核使用 Chromium；移动测试是窄视口与浏览器交互，尚未在实体 iPhone Safari 上检查。
