# example-host 部署验收

验收日期：2026-10-12 UTC。

## 发布版本

- mboard 运行源码：`7e19691ece001c63cd6213370ab65705d4a717de`。
- mboard-node 源码：`90859556549d6fcb3ebfc7b83de14192dbdd436f`。
- [mboard 私有仓库](https://github.com/MiaM1ku/mboard) 和 [mboard-node 私有仓库](https://github.com/MiaM1ku/mboard-node) 的可见性都为 PRIVATE。
- 两个仓库的 GitHub Actions 检查都通过。mboard 检查覆盖 41 个服务端测试、5 个浏览器场景和严格构建。

## 运行结果

```text
Host               example-host
App                /opt/mboard
Node source/binary /opt/mboard-node
SQLite             /opt/mboard/data/mboard.sqlite
Runtime            Bun 1.3.14
Listen             127.0.0.1:8791
Public URL         https://panel.example
Service            mboard.service
User/Group         mboard:mboard
State              active/running
Service restarts   0（本轮检查时）
```

上游监听和本机接口返回成功。站点管理员配置反代后，公开 HTTPS 登录页返回 200。实际 Chromium 打开页面，标题为 `mboard · mboard`，页面拥有一个 h1，页面运行错误数组为空。

公开 HTTPS 的管理员归档接口用临时、短期验证会话检查，返回 28 个待接入节点和 21 台待接入机器。验证会话随后清理。匿名请求返回 401。页面构建引用的 CSS 和 JavaScript 文件可访问。

## 迁移结果

- 账号：46 个，目标密码哈希逐条和源快照比较，46 个一致。
- 管理员：原启用管理员角色沿用，初始化入口处于关闭状态。
- 访问组：3 个。
- 待接入节点：28 个。
- 待接入机器：21 台。
- 完整原始归档：42 张表，62,006 条记录。
- SQLite 完整性检查：`ok`。

原密码验证函数支持 PHP bcrypt 的 72 字节截断语义，单元测试覆盖长 UTF-8 密码。生产数据检查比较了哈希原值。用户可用原账号和密码登录。

节点和机器以记录先行方式迁移。完整 Reality、SS2022、父子入口、绑定、路由和加密模板留在私有归档里，后续逐台配置新节点和客户端。新面板的机器心跳由新接入程序上报。

## 数据和权限

```text
/opt/mboard/data                         0700  mboard:mboard
/opt/mboard/data/mboard.sqlite           0600  mboard:mboard
/opt/mboard/.env                         0600  mboard:mboard
/opt/mboard-backups                      0700  root:root
迁移 JSON                                0600  root:root
```

systemd 启用 `ProtectSystem=strict`、`ProtectHome=true` 和指定的数据写入目录。旧源环境配置和备份目录以 `InaccessiblePaths` 对服务隔离。仓库拉取使用各自的只读部署密钥。

## 回退材料

```text
/opt/mboard-backups/migration-20261012T195213Z/
  source.env
  archive.json
  mysql-complete.sql.gz
  inventory.json
  mboard-post-import.sqlite
```

源 MySQL JSON 在同一只读事务中导出。独立 SQL 快照和源环境配置存放在同一个私密目录。SQLite 导入后的在线备份为 32,964,608 字节，完整性检查为 `ok`。回退步骤见 [部署说明](deployment.md)。

## 节点程序

服务器能执行 mboard-node `0.1.0`。Linux amd64 静态程序在本机编译和上传后，校验值相同：

```text
sha256 1e0715c8bab3831ad7749abc2dfacde58fd7bf0c53a4f965eaa7293ced2acecf
```

接入某台机器时，先在面板建立新机器和节点，保存新的接入令牌，然后配置代理核心、证书和流量采集器。配置及实际转发验收后启用客户端订阅。
