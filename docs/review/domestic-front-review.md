# 可选国内前置与管理展示复核

## 订阅配置

Clash Meta 模板增加五个用户提供的静态 HTTP 代理和 `🇨🇳 国内前置` select 组。端口全部为 443，协议保持明文 HTTP（`tls:false`），前置 UDP 为 false。Host、X-T5-Auth、User-Agent 按用户提供值写入私密模板，凭据原值不进入 Git。

组成员为 DIRECT 和五个国内前置，`default-selected:DIRECT`。动态授权出口节点下发 `dialer-proxy: 🇨🇳 国内前置`。前置节点和前置组不注入动态出口，因此形成单向链路。

模板 helper `x-mboard-dialer-proxy` 只在 Clash Meta 保存模板中声明绑定关系，输出时删除。校验要求静态 select 成员，拒绝动态 marker、缺失成员、循环、带二次 dialer 的前置和请求头换行。其他客户端格式保持原逻辑。

更新客户端订阅后在 `🇨🇳 国内前置` 中选择指定前置，DIRECT 恢复原直连。HTTP 前置主要承载 TCP，UDP 行为不作为已通过的验证项。

## 真实验证

官方 Mihomo v1.19.32 核心接受合成的前置和实际 Panstar Reality 配置，`-t` 退出 0。用短期本地控制端逐项选择，客户端通过真实 Panstar 节点请求 Cloudflare HTTPS：

| 选择 | 实际 Reality HTTPS 转发 |
|---|---|
| DIRECT | 通过 |
| 广州移动 183.240.98.84 | 从部署机器测试失败 |
| 南京移动 36.155.169.188 | 从部署机器测试失败 |
| 苏州联通 157.0.146.158 | 通过 |
| 南京联通 153.3.237.117 | 通过 |
| 广州联通 163.177.17.6 | 通过 |

部署端位于海外。两个移动节点的国内用户网络可达性待用户本地选择验证，因此保留可选但默认 DIRECT。之前 curl CONNECT 检查三个联通返回 200；直接访问 Reality 端口的普通 TLS 并非真正代理验证，最终结论以 Mihomo/VLESS 实际转发为准。

公网 Clash Meta 下发 HTTP 200。五个地址、443、tls/udp 参数和请求头逐个一致。前置组没有动态出口成员，前置节点没有 dialer 回指。24 个允许出口引用前置组，大流量分组 HK 成员为 0。原规则数组和值保持一致。

## 管理展示

移除节点和机器管理页的 PendingImportPanel 及其 imports 请求，运行列表继续显示实际配置、状态和操作。恢复型运行行用“运行配置”标签保护完整配置。来源记录继续服务历史报告和回退，界面展示按用户要求删除。

Scenario: 节点管理、机器管理、Clash Meta 订阅
Input: Playwright 隔离测试账户和实际生产原模板/用户提供的前置；生产凭据保存在远程私密模板。
Viewport: 1440 × 900、390 × 844
Theme: 共享 light/dark 原语
 design.md version: motion-2026-10-13
Generation context: 管理展示由独立上下文按既有原语修改；订阅逻辑由主上下文实现。
Review method: TypeScript、50 个订阅回归场景、10 个浏览器场景、官方 Mihomo 配置校验和真实 TCP/HTTPS 转发。
Result: pass；移动前置可达性存在上表所述部署端网络限制。
Violations: 管理页归档组件和对应网络请求已移除，原 CRUD 和运行保护场景通过。
Deviations: 不改变现有布局和设计原语。
Open questions: 两个移动地址在用户本地网络的可达性。
Limits: HTTP 前置的 UDP/QUIC 通道没有验证。对源站普通 TLS 的 curl 失败不能推断 Reality 链路失败。

公网管理浏览器检查 1440px、390px 的节点和机器页面：归档展示零出现，imports 请求零次，一个 h1、页面横向溢出 false。站点设置中的 Clash Meta 模板包含可编辑前置 helper 和选择组，在线校验通过，页面运行错误数组为空。短期验证会话随后撤销。

## 数据与回退

原 Clash Meta 内容以 0600 保存在远程 `pre-domestic-front-clashmeta.txt`。新增代理认证字段只在远程私密配置和经授权订阅中出现。临时 Mihomo 控制器在测试结束后关闭。
