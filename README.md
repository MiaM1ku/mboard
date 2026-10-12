# mboard

mboard 是独立的连接管理工作区。Bun 承载 HTTP 服务、账号会话和 SQLite 数据，React 承载用户面板和管理面板。配套 Go 节点仓库为 `mboard-node`，两端通过版本化协议通信。

## 可以做什么

- 用户面板：查看授权节点、复制订阅、下载 sing-box 配置、查看每日用量、阅读公告和指南、提交问题、更新密码和轮换订阅凭据。
- 管理面板：管理用户、访问分组、节点和接入机器，保存一次性接入令牌，处理问题会话，发布内容，调整站点信息，查阅操作审计。
- 节点部署：生成 VLESS、Trojan、Shadowsocks TCP 配置，按用户授权、有效期和流量额度分发连接凭据。TLS 证书由部署者配置。
- 节点通信：独立 Bearer 令牌、心跳、完整配置版本、流量批次账本。重复批次确认成功，累计用量计入一次。
- 数据迁移：离线 JSON 校验、预览迁移、全新数据库导入和新凭据文件。

**流量部署要求：**可信本地采集器提供每个用户、每个节点的字节增量。mboard-node 的 `ingest` 将增量落盘，然后自动重试上报。采集器应覆盖短连接和连接关闭时的最终用量。节点说明文档提供接入方式。

## 快速运行

运行环境：Bun 1.3.14 或更新版本。

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

打开 <http://127.0.0.1:8787> 创建首位管理员。数据库初始化为空，账号、分组、机器和节点从管理面板建立。

建议设置顺序：

1. 创建访问分组。
2. 创建接入机器，把一次性令牌保存到凭据管理器。
3. 创建节点，选择机器、端口、协议和访问分组。
4. 创建用户，把用户授权到相应分组。
5. 部署 Go 节点和 sing-box 核心。TLS 节点按节点 ID 放置证书和私钥。
6. 用户下载配置后导入客户端，检查连接和用量。

## 开发

两个终端分别运行服务端和前端：

```sh
# Terminal 1
MBOARD_PUBLIC_ORIGIN=http://127.0.0.1:5180 bun run dev

# Terminal 2
bun run dev:web
```

打开 <http://127.0.0.1:5180>。Vite 将 API 和订阅请求代理给 Bun。

## 配置与部署

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| MBOARD_HOST | 127.0.0.1 | HTTP 监听地址 |
| MBOARD_PORT | 8787 | HTTP 端口 |
| MBOARD_DATA_DIR | ./data | SQLite 数据目录 |
| MBOARD_PUBLIC_ORIGIN | 请求自身 origin | 公开访问 origin，如 https://panel.example.com |
| MBOARD_LOGIN_LIMIT | 10 | 每个账号和连接来源在 15 分钟内的登录尝试数 |
| MBOARD_PEER_LOGIN_LIMIT | 200 | 每个连接来源在 15 分钟内的总尝试数 |

生产部署用 HTTPS 反向代理，设置 `MBOARD_PUBLIC_ORIGIN` 为实际公开地址，服务监听在私有网络或本机回环。HTTPS origin 会开启 Secure Cookie。创建首位管理员时，在受控访问环境中初始化。

会话 Cookie 使用 HttpOnly、SameSite=Strict，密码用 Argon2id。机器令牌以 SHA-256 摘要存入数据库。JSON 请求上限为 1 MiB。管理操作写入审计记录。

备份 SQLite 时停止服务后复制数据库，或用 SQLite 在线备份流程。保存数据目录的访问权限。节点应用新配置会重启代理进程，正在进行的代理连接需要重新建立，配置更新安排在可接受的时段。

## 设计与协议

- [design.md](design.md)：ikadesign 视觉规则和公开原语。
- [API 协议](docs/api-contract.md)：用户、管理员和节点的自有 v1 接口。
- [设计验收](docs/review.md)：实际截图、操作测试和本轮检查范围。
- [迁移方案](docs/migration.md)：离线导出格式、字段映射、凭据轮换和切换流程。

面板用深墨色导航、青绿色主要动作和清晰的数据层级。桌面和移动端支持浅色、深色主题。界面文案直接说明能力、结果和下一步。

## Xboard 一次性迁移

```sh
bun run migrate:xboard --input /private/export.json
```

默认命令检查导出并打印迁移清单。确认清单后，用显式参数导入全新数据库：

```sh
bun run migrate:xboard \
  --input /private/export.json \
  --apply \
  --db /private/mboard-data/mboard.sqlite \
  --credentials-out /private/mboard-migration/credentials.json
```

导入会生成新密码、订阅凭据和机器令牌，客户端和节点随后用新配置接入。导出中的复杂路由、Reality 和加密模板要在旧环境解密整理，再按迁移清单逐项建立新配置。导入用户以普通用户角色进入新系统，导入后创建首位管理员。详细的映射、验证、私密凭据交付和回退流程见迁移方案。

## 测试

```sh
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e
```

浏览器验收在临时数据库上启动真实 Bun 服务，覆盖初始化、14 个页面的桌面和移动布局、两种主题、问题会话、订阅下载、管理 CRUD 和键盘操作。测试数据存放在独立临时目录。

可选真实代理验收：

```sh
MBOARD_CORE=/absolute/path/to/sing-box \
MBOARD_NODE=/absolute/path/to/mboard-node \
bun scripts/proxy-smoke.ts
```

它启动实际 Go 节点、Bun 面板和 sing-box 客户端，检查 VLESS、Shadowsocks HTTP 转发，再把测得的 HTTP 响应正文大小作为本轮测试增量送入持久化上报队列。生产用量由可信采集器提供。

## 仓库结构

```text
src/server/     Bun HTTP、SQLite 和配置生成
src/web/        独立 React 用户及管理面板
scripts/        离线迁移和真实代理验收
tests/          服务端和浏览器回归测试
docs/           自有协议、迁移方案和设计验收
```

运行依赖来自本仓库的源码和 Bun 锁文件。迁移工具把旧项目当作离线输入，运行服务和节点遵循 mboard 自有协议。
