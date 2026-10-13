# 订阅模板恢复和真实节点替换验收

## 结果

- 原自定义五份模板：Clash、ClashMeta、Stash、Surge、Surfboard，原样恢复到数据库和管理编辑器。
- 第六份 sing-box 原文与旧部署默认模板 JSON 语义一致，保留原文。新版本客户端按版本在响应时转换，数据库内容保持原字节。
- 总逻辑节点 28 个，生产验收时 26 个在线。总机器 21 台，18 台完成新节点替换并在线。
- HK Night1（机器 10）、HK Night2（机器 11）和 AWSJP（机器 16）按用户确认，交付自助脚本由用户执行。
- 实际自动流量批次持续入账。验收快照读到 7,294 个批次；父子入口和身份出口按独立认证标签归属。

## 模板入口

[站点设置](https://panel.example/#/admin/settings)中的“站点设置 → 订阅模板”提供读取、校验、保存和示例预览。每种格式独立保存，编辑器内容逐份与服务端原文比较一致。

线上 Chromium 管理验证覆盖六份原文、逐份校验和逐份示例预览。检查得到一个 h1，页面运行错误数组为空。使用短期验证会话，结束后清理。

源站六格式正常渲染。尊重站点管理员设置的 CDN 策略，用 `clash.meta/1.19.0` 代理客户端 UA 公网检查五份自定义格式，全部返回 200，原占位符完成展开。sing-box/1.14.3 公网配置返回 200，实际代理核心 `check` 退出 0。

原 `/s/<旧 token>` 和 `/api/v1/client/subscribe?token=<旧 token>` 订阅链接继续使用已导入用户身份更新。原 `flag` 格式参数保留。用户轮换订阅凭据时，原 token 链接和旧运行身份同步退役。

## 已完成机器

| 主机 | 机器 ID | 协议/入口 |
|---|---:|---|
| BitsFlow_US | 17 | Reality |
| Bage_Hk | 5 | SS2022 和子入口 |
| MHY_DE9929 | 7 | Reality 和身份出口 |
| Zouter_JP | 18 | Reality 和子入口 |
| LightSail_SG | 22 | SS2022 和子入口 |
| Ciallo HK | 26 | SS2022 和子入口 |
| DMIT_Pro | 23 | Reality 和子入口 |
| Akko_DE | 19 | Reality |
| bitsflow_DE | 21 | Reality |
| Zouter_HK | 15 | SS2022、Reality 两个物理监听 |
| hncloud | 2 | AnyTLS |
| Ciallo DE9929 | 25 | Reality，核对主机后补齐绑定 |
| Panstar_SG | 20 | Reality 和子入口 |
| Akko_US | 4 | Reality，Google/WARP 分流 |
| HK_Daily1 | 8 | 共享 Trojan 入口 |
| HK_Daily2 | 9 | 共享 Trojan 入口 |
| HK_Daily4 | 13 | 共享 Trojan 入口 |
| HK_Daily5 | 24 | 共享 Trojan 入口 |

逐台安装先核对机器 ID、当前期望配置和原启动定义，保存私密配置与旧启动/程序备份，然后验证新代理配置再切换。systemd 主机和 Alpine/OpenRC 主机分别使用对应的服务管理方式。旧启动项移除，旧程序和配置保存在回退目录。

hncloud 的 nginx 和 443 服务保持原状态。Panstar 的独立 ss-server 60000 保持原状态。Akko 的 WARP Docker 1080 保持原状态。

## 实际网络验证

- 从面板机器启动临时客户端，Reality、SS2022、AnyTLS 完成真实 HTTPS 转发。
- Zouter_HK 的两个物理入口分别验证。
- AliCDT 的共享域名 Trojan TLS 完成真实 HTTPS 转发，四台日间机器均有新进程、443 和 19090 监听及健康激活。
- Akko 直连 HTTP 200、Google/WARP HTTP 204；本机 WARP SOCKS 1080 检查 `warp=on`。
- 多个父子入口已经收到真实用户的独立流量记录，累计用户流量计入一次。

## 安装期间发现和修复

1. Ciallo 的规则缓存目录在配置校验阶段尚未创建，实际启动失败。补齐私密缓存目录和受限 service 写入路径，恢复新核心后实际 SS2022 转发通过。
2. Akko 系统 DNS 配置使用 resolvconf，核心尝试缺失的 systemd-resolved。给这台机器的原生配置添加明确 DNS 解析器，SRS 下载和 Google/WARP 实际转发通过。
3. 原机器令牌包含 32 字符字母数字形式。仅一次性迁移交换兼容原格式，正常节点令牌统一为新 64 位十六进制格式。实际 Alpine 安装和回归测试通过。
4. Panstar 原路由引用缺失的 WARP 出站。按管理员确认先直连恢复，原配置保留在归档里。

## 自助三台

[公共安装脚本](https://panel.example/install-mboard-node.sh)会自动读取原机器编号与凭据，验证发布哈希、配置、服务和健康状态，然后清理旧启动。验证过的同一份脚本已经在三台 Alpine 和一台 Debian 机器实际执行成功。

三台分别以 root 执行以下同一条命令即可：

```sh
(umask 077; f=$(mktemp); trap 'rm -f "$f"' EXIT; if command -v curl >/dev/null 2>&1; then curl -fsSL https://panel.example/install-mboard-node.sh -o "$f"; else wget -q -O "$f" https://panel.example/install-mboard-node.sh; fi && sh "$f")
```

显式编号分别为 10、11、16，也可以在最后的 `sh "$f"` 后加 `--machine-id 10` 等参数核对身份。脚本只对 Linux amd64 系统执行安装。原配置、证书与旧程序以私密备份保存。

节点切换会让正在使用这台机器的代理连接重新建立。先完成检查和备份，再停止旧服务。激活提交后的不确定响应保留新服务，重跑脚本核对状态。

## 版本和测试

- mboard-node 0.2.0：短连接的累计认证流量通过 V2Ray gRPC 获取，游标与待上报批次在同一持久化日志中保存，再经可靠队列确认。
- 代理核心：sing-box 1.14.3，固定构建标志包含 V2Ray stats 与 uTLS。
- 后端整套回归 163 项通过，6 个浏览器场景通过。后续旧链接兼容新增场景也通过。
- 安装脚本 24 项本地隔离测试通过，覆盖 BusyBox 工具、激活回复丢失和回退边界。

## 数据与回退

面板私有迁移与运行补充数据：`/opt/mboard-backups/runtime-restore/`。每台机器私密回退目录：`/opt/mboard-node-backups/cutover-*`。源 MySQL 和完整旧记录归档继续保留。

各主机目录为 0700，凭据、原生配置、私钥和回退配置为 0600。公共下载只提供固定校验值的程序和安装脚本。

## 具体边界

- 日间 18 台已经实际替换。两台夜间机器和 AWSJP 按管理员确认由管理员执行脚本。
- 认证路由统计记录应用层转发字节。核心崩溃时，最后一次持久化采样之后的字节需要按采样间隔理解。
- 新版 sing-box 的 sniff 保留域名识别和规则匹配，连接目标采用原始地址。原默认模板的旧版目标覆盖行为在校验提示中明确显示，旧版本输出维持原行为。
- hncloud 的已迁移 AnyTLS 证书使用独立续期组件和每日定时检查。真实证书有效期为 2026-11-22T02:13:16Z，当前检查返回 valid，服务保持运行。Cloudflare token 的只读验证返回 active。进入 30 天续期窗口后会执行 DNS-01，当前长有效期检查保持零签发请求。实际 ACME 续签在窗口到来后按定时任务执行；测试验证了私密存储、成对备份和失败回退。
