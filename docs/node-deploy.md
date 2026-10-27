# 节点部署与掉线处理

本文覆盖三件事：给一台已有机器一键装节点、面板如何处理两类节点、节点"在线但不通"或"显示掉线"时怎么排查。
旧版 xboard-node 的切换流程见 [一键切换 mboard 节点](install-mboard-node.md)，两套脚本共用同一份面板协议。

## 一、一键部署

面板上机器已存在时，root 登录目标机器执行一条命令：

```sh
curl -fsSL https://panel.example/downloads/deploy-node.sh | sh -s -- \
  --machine-id 12 --token <64 位十六进制令牌>
```

`--panel` 省略时默认 `https://panel.example`，请显式指定真实面板 origin。

令牌来源有两种，都是面板侧动作：

- **已接入过的机器**：`POST /api/v1/admin/machines/<id>/token` 会签发新的 64 位十六进制令牌，同时清空 `last_seen_at`、`core_ready`、`telemetry_ready`，旧令牌立刻失效。换机器、重装系统、怀疑泄漏都走这条。
- **从未接入的机器**（面板里还是 `pending`）：用迁移时导入的原始机器凭据（32 或 64 位字母数字）。`/api/node/v1/enroll` 会据此派生出正式令牌。

脚本会做的事，全部在打印的步骤里有对应输出：

1. 用 `POST /api/node/v1/enroll` 换取令牌、配置、流量标签和 TLS 文件；令牌只在内存和 600 权限文件里出现。
2. 从 `<panel>/downloads` 下载 `mboard-node-linux-amd64` 和 `sing-box-linux-amd64`，按脚本内的发布 SHA256 校验。可用 `--binary-dir` 换成自建二进制，此时需自己给 `--sha-agent`/`--sha-core`，否则只打印实际摘要。
3. 用暂存路径跑 `sing-box check` 和 `mboard-node validate -config`，任何一步失败都不会动系统。
4. 备份旧目录、旧 unit 和 TLS，然后安装二进制、`agent.json`、`identity.json`、`/etc/mboard-node/tls/*`，写好 systemd unit 并启动。
5. 轮询本机 `data/state.json` 的 revision，匹配后调用 `POST /api/node/v1/activate`；面板还要求 90 秒内有一次核心与统计都就绪的心跳。
6. 打印机器号、revision、备份路径和回退命令。

常用参数：

| 参数 | 作用 |
|---|---|
| `--dry-run` | 走完鉴权、下载、校验和预检，不写系统目录。排障和验收先用它 |
| `--force` | 覆盖本机现有安装，先做 `/opt/mboard-node-backups/deploy-*` 快照 |
| `--binary-dir DIR` | 用本地构建的 `mboard-node`、`sing-box` 代替下载 |
| `--sha-agent HEX`、`--sha-core HEX` | 固定二进制摘要；默认值是当前发布版 |
| `--core-version V` | 面板未指定核心版本时写进 agent 配置的值 |

重复执行是安全的：同一台机器的同一份身份会被复用并重新核对，不会产生第二套凭据。已接入的机器带着旧令牌重跑会收到 `NODE_ENROLLED`/`NODE_CREDENTIAL_CHANGED`，此时按提示先轮换令牌。

### 升级已装节点的二进制

已经装好的机器只换二进制、不动身份和配置时用 `--upgrade`，不需要机器号也不需要令牌——它从 `/opt/mboard-node/identity.json` 读面板 origin 和机器号，从 `agent.json` 读令牌：

```sh
curl -fsSL https://panel.example/downloads/deploy-node.sh | sh -s -- --upgrade
```

它会下载发布版、校验摘要、用新的 agent 校验现有 `agent.json`、用新的核心校验已应用到磁盘的配置，然后备份旧二进制、重启服务，并确认进程报出的版本号等于目标版本。`--dry-run` 只做下载和预检，打印当前版本与目标版本。

重启会连同 sing-box 子进程一起重启，这台机器上的代理连接会断开重连，所以分批做、避开高峰。失败时脚本打印一条完整的回退命令，旧二进制在 `/opt/mboard-node-backups/upgrade-*`。

从旧 xboard-node 切换、需要停旧服务并清理旧启动入口的，用 [install-mboard-node.sh](install-mboard-node.md)。

## 二、两类节点现在怎么处理

面板同时挂着两条节点轨，共用 `/api/node/v1` 前缀，靠令牌先匹配哪张表来分流。

| | xbnode 导入轨（在跑） | 自有 node 轨 |
|---|---|---|
| 数据表 | `runtime_nodes`、`runtime_machines`、`runtime_bindings` | `machines`、`nodes` |
| 来源 | `legacy_records` 里的 `v2_server`、`v2_server_machine`、`v2_server_machine_binding`，由 `restoreRuntime()` 导入 | 管理面板直接增删改 |
| 凭据 | `runtime_machines.token_hash`，sha256；只由 enroll 派生或管理员轮换产生 | `machines.token_hash`；`POST /api/v1/admin/machines/<id>/token` 轮换，`config_revision` 自增 |
| 配置 | `compileMachine()` 生成完整 sing-box 配置：按用户派生 UUID、路由模板、规则集、TLS 物料、出口模板 | `serverConfig()` 生成单机配置：`nodes` 表里的入站加 `users` 表里的凭据 |
| 计费 | 每用户标签 `mb:u:<uid>:n:<nid>[:p:<profile>]`，按小时入 `runtime_traffic_hourly`，按天入 `runtime_node_traffic` | 节点只上报 `user_id`/`node_id` 字节数，进同一套 `traffic_daily`/`users` 累计 |
| 上线条件 | `state='active'` 且机器 `active`、`core_ready`、`telemetry_ready` 全为真，且最近 90 秒有 `last_seen_at` | `last_seen_at` 在 90 秒内 |
| 新增机器 | 面板没有创建入口，只能重新导入 | 面板可直接创建 |

现状：生产 28 个节点、21 台机器、22 条绑定全部在 xbnode 导入轨；21 台机器都是 `active`，旧 `xboard-node` 服务已停止并从启动项移除。自有轨的两张表是空的，这条路径目前只作为新建自管机器的逃生口——它没有按用户标签的流量采集，接进来只做连通性，不计 per-user 用量。

两条轨的在线判定都要求"最近 90 秒有就绪心跳"，所以**机器活着不等于节点在线**：核心没跑起来或流量采集不健康，机器照样掉出节点列表和订阅。这一条是下面所有掉线的根因类别。

## 三、掉线排查

先看结论从哪来，避免在错误的方向上重启服务。

```sh
# 面板侧：机器状态与节点可见性
sqlite3 "file:/opt/mboard/data/mboard.sqlite?mode=ro" \
  "select id,state,active,core_ready,telemetry_ready,applied_revision,last_seen_at from runtime_machines order by id;"
# 节点侧：最近小时有没有真实流量
sqlite3 "file:/opt/mboard/data/mboard.sqlite?mode=ro" \
  "select node_id,datetime(max(hour),'unixepoch') from runtime_traffic_hourly group by node_id order by 1;"
```

| 现象 | 判据 | 处理 |
|---|---|---|
| 机器 `last_seen_at` 停止更新 | 心跳没到 | 看节点 `systemctl status mboard-node`，网络、面板 origin、令牌 |
| `core_ready=0` | sing-box 没跑或 revision 没应用 | 节点 `journalctl -u mboard-node`，看 `sing-box check` 与配置应用报错 |
| `telemetry_ready=0` | 采集不健康：统计端口没起、配置缺 `experimental.v2ray_api`、或 spool 满 | 见下面"spool 卡死" |
| 机器正常但节点没流量 | 机器通、入站没流量 | 查入口 IP、`runtime_bindings`、该节点 `group_ids` 与用户分组是否相交 |

### spool 卡死（会掉线，也会静默丢账）

节点把流量批次写 `data/spool/*.json`，每轮只投递一个批次。面板对整批做授权校验，任一条记录不合规就整批 403；旧版实现遇到错误直接返回、**不删文件**，于是这一批永远占着队头，后面全部堵死。队列到 10000 个批次或 32 MiB 后采集器停止发布，`telemetry_ready` 变 0，节点从面板掉线，用量停在上一次成功投递。

判据：

```sh
systemctl status mboard-node | grep -E 'traffic|collector'
# 典型输出：traffic: panel returned HTTP 403 ... / collector: traffic spool holds N batches
ls /opt/mboard-node/data/spool | wc -l
```

处理：先备份，再逐条投递，把面板明确拒绝的批次隔离出来。面板按 `batch_id` 去重，重放已收下的批次不会重复计费。

```sh
mkdir -p /root/mboard-rescue && cd /opt/mboard-node/data
tar czf /root/mboard-rescue/spool-$(date -u +%Y%m%dT%H%M%SZ).tar.gz spool collector.json state.json
curl -fsSL https://panel.example/downloads/spool-drain.py -o /root/mboard-rescue/spool-drain.py
python3 /root/mboard-rescue/spool-drain.py --panel https://panel.example --token <本机 agent.json 里的 token> --dry-run
python3 /root/mboard-rescue/spool-drain.py --panel https://panel.example --token <同上>
```

`--dry-run` 只报告不删除。正式执行会把投递成功的批次删掉，把 4xx 批次移到 `data/spool-quarantine/`（沿用旧二进制按上面的流程修复时）或 `data/spool/rejected/`（已带隔离逻辑的节点）并留下报告。队列空出来后采集器在下一次轮询恢复（采集循环有最长 5 分钟退避），`telemetry_ready` 回到 1，节点重新上线。

节点上没有 python3（例如最小化的阿里云镜像）时用 shell 版本，语义相同：面板按 `batch_id` 去重，重放不会重复计费。先写一个只含两行 `header =` 的私有 curl 配置，避免令牌进命令历史：

```sh
(umask 077; jq -r '"header = \"Authorization: Bearer \(.token)\"\nheader = \"Content-Type: application/json\""' \
   /opt/mboard-node/agent.json > /root/curl.cfg)
spool=/opt/mboard-node/data/spool; quarantine=$spool-quarantine; mkdir -p "$quarantine"
find "$spool" -maxdepth 1 -name '*.json' -print0 | xargs -0 -P 8 -n 1 sh -c '
  f=$1; out=/tmp/drain.$$.json
  code=$(curl -sS -o "$out" -w "%{http_code}" --max-time 30 --config /root/curl.cfg \
      --data-binary "@$f" https://panel.example/api/node/v1/traffic)
  case "$code" in 2*) rm -f "$f";; *) echo "$(basename "$f") $code" >> /root/drain-fail.txt;; esac
  rm -f "$out"' _
# 失败的行逐条 move 到 $quarantine，再看面板是否回到 telemetry_ready=1
```

一万个批次、8 并发大约 5 分钟。

被隔离的批次仍需要判断：面板拒绝的原因通常是记录里的用户已删除、或用户分组与该节点 `group_ids` 不再相交。用户还在就补授权，用户已删除就让批次留在 `spool/rejected/` 作为凭证，别再投。

### 已修复的实现问题（agent 0.2.2）

`/downloads/mboard-node-linux-amd64` 当前是 0.2.2。0.2.2 只改投递行为，配置、`traffic_labels` 和 journal 格式不变，可直接读 0.2.1 的 journal 与队列。还跑 0.2.1 的节点仍会按老逻辑卡死，需要按上面的流程外部排空，或升级到 0.2.2——升级就是每台机器跑一次上面的 `--upgrade`。

0.2.2 的投递循环会区分错误的性质：

- 400/403/409/410/413/415/422 视为对批次本身不可挽回的判定，直接隔离到 `spool/rejected/` 并继续投递下一批，每轮最多隔离 64 批，避免占满一轮。
- 401、404、405、408、429、5xx 和传输错误仍然重试，因为这些都可能是暂时的：令牌刚轮换、面板升级、端点临时不可用。
- 队列里损坏的 JSON 和自身校验不通过的批次也隔离，不再堵住队头。
- 采集器的队列上限只统计 `.json` 批次文件，隔离目录和暂存文件不占名额。
- 日志从每次重试一行变成 `traffic: retired batch <id>: panel returned HTTP 403 (TRAFFIC_GRANT)` 一次性说明，同时文件留在 `spool/rejected/` 可查。

### 案例：🇺🇸Akko SJC 掉线

机器 4 的心跳一直在，`applied_revision=7`，但 `telemetry_ready=0`，节点 23 最后一次按小时记账停在 2026-10-23 12:00，节点从订阅里消失。

`journalctl` 里是连续两条告警：`traffic: panel returned HTTP 403` 和 `collector: traffic spool entry limit reached`。队列 10000 个文件，其中批次 `85cf6f54…` 含用户 21 的流量；该用户已在 2026-10-15 被管理员删除（`audit` 里有 `users.delete 21`），面板按 `TRAFFIC_GRANT` 拒绝整批，于是这一批成了永久队头。

按上面的流程 drain 之后：9999 个批次入账（1.76 GB 上行 / 28.8 GB 下行，32 个用户），1 个批次进 `data/spool-quarantine/`，采集器恢复发布，`telemetry_ready` 回到 1，节点重新上线。补入账的量落在恢复当天的小时桶里，这是面板按"接受时间"记账的正常表现。

注意：当时节点上跑的还是不含隔离逻辑的旧二进制，所以这次是靠外部脚本排空的；新实现上线后同类批次会由节点自己隔离，不会再堵住队列。

### 案例二：🇭🇰AliHK-Night2（machine 11，节点 190）

同一轮排查里发现第二台同样的卡死：`telemetry_ready=0`、心跳正常、队列 10000 个批次、日志里同样是 `panel returned HTTP 403` 加 `traffic spool entry limit reached`。排空后 9997 个批次入账，3 个批次被隔离，隔离批次里都是用户 18 的流量。

两台的触发源是同一件事：2026-10-15 16:01–16:09 管理员删除了用户 18、21、41、83、85，这些用户在被删除前最后一批流量已经进了各节点的磁盘队列，投递时面板按 `TRAFFIC_GRANT` 拒绝整批。**删除用户不会通知节点清空它的待投批次**，所以这类卡死会在删人之后的一两天内随机出现在某些节点上。以后删用户后，顺手看一眼各机器 `telemetry_ready`，或等带隔离逻辑的版本铺开。

## 四、发布物

| 文件 | 用途 | SHA256 |
|---|---|---|
| `/downloads/mboard-node-linux-amd64` | 节点程序 | `458ccfbcfc24f428184b9125456c7c246db9508c5d343bfa510c43294847490d` |
| `/downloads/sing-box-linux-amd64` | 核心 v1.14.3 | `1e6b4ef716062484f52d3490c3b1c4d7798e8cd76aeaba3f01e9f3320c63bd90` |
| `/downloads/deploy-node.sh` | 一键部署 | 源码见 [deploy-node.sh](../deploy/deploy-node.sh) |
| `/downloads/spool-drain.py` | 队列排空与隔离 | 源码见 [spool-drain.py](../deploy/spool-drain.py) |
| `/install-mboard-node.sh` | 旧 xboard-node 切换 | 源码见 [install-mboard-node.sh](../deploy/install-mboard-node.sh) |

`deploy-node.sh` 与 `install-mboard-node.sh` 里的发布摘要必须同时更新；`tests/test_deploy_node.py` 会校验两者一致。

## 五、验证

```sh
python3 -m unittest discover -s tests -p 'test_*.py'   # 安装器与部署脚本
bun run test                                          # 面板协议与计费
cd ../mboard-node && go test ./...                    # 节点投递与采集
```

部署脚本本身先用 `--dry-run` 验收；它会在真机上跑真实的面板鉴权、二进制下载、核心预检和 agent 预检，但不写系统目录。
