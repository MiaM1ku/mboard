# 同端口订阅域名分离验收

实现版本：`09f3f4a86a57989810c0db3b8a43243f9614892c`。

## 部署方式

```text
监听端口             127.0.0.1:8791
面板 Origin          https://panel.example
订阅 Origin          https://panelapifkgfw.example
服务                 mboard.service
```

两个域名使用同一服务。反代传入原始 Host，应用先按实际 Host 选择路由范围。订阅域名提供 GET 和 HEAD `/s/:64hex-token`，面板域名继续提供页面、管理和节点 API。原面板域名上的订阅链接继续有效。

面板复制链接、账号链接展示和下载操作使用服务端返回的 `subscription_url`。链接来自配置中的可信 Origin。下载返回附件响应头，浏览器可跨域保存配置。

## 回归证据

- `bun run build`：TypeScript 和前端构建通过。
- `bun run test`：49 个后端测试通过，2,263 次断言。
- `bun run test:e2e`：6 个浏览器场景通过，新增场景检查专用域名链接、复制、跨域下载和账号展示。
- 实际临时 Bun 监听测试验证 HTTP Host 的传递。直接 Request 测试覆盖 Host 和 URL authority 不同时的优先级。
- 大小写、有效端口和末尾点的规范化通过。异常 Host、未知域名、转发头伪装按安全边界处理。

## 生产验证

同一 `8791` 监听上，携带面板 Host 的首页返回 200。携带订阅 Host 的以下路径返回 404，即使附带有效管理员验证会话和伪装的 forwarded-host 也保持边界：

```text
/
/api/v1/site
/api/v1/auth/status
/api/v1/admin/users
/api/node/v1/config
/assets/index-D-y98p5a.js
```

用符合状态和额度条件的账号检查订阅：源站 GET 返回 200，HEAD 返回 200 且响应体为空。公网 HTTPS 用 `sing-box/1.14.3` User-Agent 返回 200 和原生 JSON 配置。验证程序打印状态与数量，真实订阅 token 留在服务器内存中。

生产接口返回的用户订阅 URL 使用独立订阅 Origin。46 个账号和 62,006 条归档记录保持原有数量。短期验证会话在检查后清理。

实际 Chromium 检查面板 HTTPS 登录页：返回 200，一个 h1，页面运行错误数组为空。

## 运行配置和回退

```env
MBOARD_PUBLIC_ORIGIN=https://panel.example
MBOARD_SUBSCRIPTION_ORIGIN=https://panelapifkgfw.example
```

本轮更新前保存了 SQLite 在线快照和原运行环境配置。前端在备用目录构建，切换时保留旧哈希静态资源供已有页面使用。

```text
/opt/mboard-backups/host-routing-20261013T032147Z/
  mboard.sqlite
  environment.before
  previous-dist/
```

服务更新用原端口重启。数据表结构和账号凭据沿用。源站及公网验证都通过后，验收记录提交到私有仓库。
