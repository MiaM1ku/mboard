# example-host 部署

应用在 example-host 的独立目录运行，systemd 使用专用 mboard 用户。源代码来自私有 Git 仓库。

```text
应用目录       /opt/mboard
运行时         /opt/mboard-runtime/bun/bun
运行环境配置   /opt/mboard/.env
SQLite 数据库  /opt/mboard/data/mboard.sqlite
服务           mboard.service
监听           http://127.0.0.1:8791
公开 Origin    https://panel.example
附加面板       https://panelb.example
订阅 Origin    https://panelapifkgfw.example
节点源码       /opt/mboard-node
```

## 反向代理

域名反代由站点管理员配置。上游为本机回环地址。可用以下 Nginx location：

```nginx
location / {
    proxy_pass http://127.0.0.1:8791;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
}
```

浏览器入口使用 HTTPS。这些域名共用 `127.0.0.1:8791` 上游，反代用 `proxy_set_header Host $host` 传入原始域名。`panel.example` 和 `MBOARD_PANEL_ORIGINS` 里的附加面板域名都提供页面、管理 API 和节点 API。提交操作时，浏览器 Origin 必须和当前访问的那个面板域名一致。订阅域名只提供 `GET` 和 `HEAD /s/:token`。应用在路由前完成 Host 分流，其他主机名返回 404。订阅链接仍由 `MBOARD_SUBSCRIPTION_ORIGIN` 生成。

Bun 按固定的 `MBOARD_PUBLIC_ORIGIN` 校验面板操作来源，设置 HttpOnly、SameSite=Strict、Secure 会话 Cookie。复制链接、账号展示和配置下载使用服务端生成的订阅域名 URL。配置下载带附件响应头，支持跨域保存。

## 服务配置

```env
MBOARD_HOST=127.0.0.1
MBOARD_PORT=8791
MBOARD_DATA_DIR=/opt/mboard/data
MBOARD_PUBLIC_ORIGIN=https://panel.example
MBOARD_PANEL_ORIGINS=https://panelb.example
MBOARD_SUBSCRIPTION_ORIGIN=https://panelapifkgfw.example
MBOARD_LOGIN_LIMIT=10
MBOARD_PEER_LOGIN_LIMIT=200
```

配置文件为 0600，专用服务用户读取。代码目录由 root 管理，mboard 用户以只读权限运行。数据目录为 0700，数据库文件为 0600。服务沙箱提供私有临时目录、只读系统目录和指定数据写入目录。旧数据库配置和迁移备份目录对服务进程隔离。

服务文件见 [mboard.service](../deploy/mboard.service)。

```sh
systemctl status mboard.service
journalctl -u mboard.service --since '15 minutes ago'
curl http://127.0.0.1:8791/api/v1/auth/status
```

## 记录先行迁移

本次源数据规模为 46 个账号、3 个访问组、28 个节点、21 台机器。只读一致性快照归档 42 张表的 62,006 条记录。原登录密码的 bcrypt 哈希和管理员角色沿用，账号累计流量与额度写入新 SQLite。

旧节点和机器以“待接入”状态展示。完整的协议、Reality、SS2022、父子关系、机器绑定和加密模板保存在私有归档中。运营者随后按记录逐台配置 mboard-node，验证新凭据、端口和访问范围。

导出工具见 [export-xboard.py](../scripts/export-xboard.py)。它从源环境配置读取 MySQL 连接，在同一只读事务中输出一致的 JSON，同时保存独立 SQL 备份。连接凭据以私有临时配置文件传给客户端，控制台打印记录数量。

```sh
python3 scripts/export-xboard.py \
  --env /www/wwwroot/panel.example/.env \
  --output-dir /opt/mboard-backups
```

导入工具见 [import-archive.ts](../scripts/import-archive.ts)。先检查，确认数量和格式后再应用到全新数据库：

```sh
bun scripts/import-archive.ts \
  --input /opt/mboard-backups/<批次>/archive.json \
  --db /opt/mboard/data/mboard.sqlite \
  --dry-run

bun scripts/import-archive.ts \
  --input /opt/mboard-backups/<批次>/archive.json \
  --db /opt/mboard/data/mboard.sqlite \
  --apply
```

导入前保持目标服务停止。数据库和完整归档在一个事务中提交。导入后使用原管理员账号和密码登录。新会话由 mboard 签发，新订阅和新节点凭据随逐台接入更新。详细规则见 [记录先行迁移](staged-migration.md)。

## 更新和回退

更新前停止服务并备份 SQLite（或调用 SQLite 在线备份流程）。匹配代码提交和备份数据库一起保存。随后拉取已验证的 Git 提交、安装锁定依赖、构建页面，再启动服务。

部署目录只保存运行产物，git 工作区保持干净。历史提交经过重写，所以更新用 `fetch` 加 `reset --hard`，不要用 `pull`。执行前先确认 `git status` 干净，确认后再丢弃任何本地改动。

```sh
systemctl stop mboard.service
# 此时保存数据库及必要的 WAL/SHM 文件，或执行 SQLite backup。
git status --short   # 确认干净
git fetch origin
git reset --hard origin/main
/opt/mboard-runtime/bun/bun install --frozen-lockfile
/opt/mboard-runtime/bun/bun run build
systemctl start mboard.service
```

首次升级到带流量池的版本时，新的表在启动时自动建立，旧的小时上报记录会一次性回填到按机器的台账。回填只跑一次，用 `runtime_metadata` 里的 `traffic-pools:backfill:v1` 标记。

回退时停止服务，恢复匹配的代码提交和数据库快照，再启动。反向代理的切换由站点管理员操作。源 MySQL 保留为迁移来源和独立回退数据。

## 节点接入

节点仓库与编译程序位于独立目录。接入某台机器时，在面板创建新机器和节点，保存一次性接入令牌，再在那台机器上安装 mboard-node、代理核心和需要的证书。归档记录用于校对端口、协议和访问组。每台机器验证配置和实际转发后，客户端导入新订阅。

流量采集器提供用户和节点的增量，mboard-node 负责持久化队列和重试上报。用量归属按新配置验证后再启用采集。
