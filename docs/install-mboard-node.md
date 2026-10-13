# 一键切换 mboard 节点

脚本在下载、JSON/TLS 检查和二进制校验通过后才停止旧节点。**从停止旧服务到新核心启动，正在连接的客户端会断开，需要重连。** 新服务最多等约 90 秒确认本机统计端口和面板的就绪心跳。激活前的明确失败会恢复原来的文件和服务。激活请求的回复丢失时，新服务会继续运行，重跑同一条命令可确认面板状态并补做旧启动项清理。

适用于 Linux amd64、root、systemd 或 OpenRC。Alpine 用 BusyBox `sh` 即可。安装器会先安装缺少的 `jq` 和 `curl`，所以需要包仓库和面板的 HTTPS 网络访问。Python 只用于开发测试。

## 夜机命令

root 登录 HK_Night1（machine 10）后执行：

```sh
curl -fsSL https://panel.example/install-mboard-node.sh -o /tmp/install-mboard-node.sh && sh /tmp/install-mboard-node.sh --machine-id 10
```

root 登录 HK_Night2（machine 11）后执行：

```sh
curl -fsSL https://panel.example/install-mboard-node.sh -o /tmp/install-mboard-node.sh && sh /tmp/install-mboard-node.sh --machine-id 11
```

下载前，确认 `/tmp/install-mboard-node.sh` 是自己创建的普通文件，或者这个路径尚未创建。共享机器更适合用私有临时目录，下面的同一条命令同时支持 curl 和 BusyBox wget：

```sh
(umask 077; d=$(mktemp -d /tmp/mboard-install.XXXXXX) || exit 1; trap 'rm -rf "$d"' EXIT HUP INT TERM; if command -v curl >/dev/null 2>&1; then curl -q -fsS https://panel.example/install-mboard-node.sh -o "$d/install.sh"; else wget -q -O "$d/install.sh" https://panel.example/install-mboard-node.sh; fi && sh "$d/install.sh" --machine-id 10)
```

第二台把最后的 `10` 改成 `11`。机器号也可以省略，让脚本从源配置读取。

## 凭据和重复执行

- 默认从 `/etc/xboard-node/config.yml` 的唯一 `machine:` 记录取机器号和凭据。`panel.node_id: 1` 不参与判断。
- 支持字面值 64 位十六进制 `machine.token`，或 `machine.token_env` 引用 `/etc/xboard-node/credentials.env` 中的字面值。解析器不会执行该文件里的 shell 内容。
- 命令里的 `--machine-id` 必须与源记录一致。复杂 YAML、多个 machine 记录或重复凭据会要求先整理配置。
- 已经安装 mboard 的机器优先用安装时写入的身份和 agent 凭据。相同发布版、相同 revision 且已经运行的节点，重复执行只确认就绪。
- 手动凭据优先选终端隐藏输入，或 `MBOARD_NODE_TOKEN`。`--token TOKEN` 也支持，但 token 会出现在命令历史和进程参数里。
- `--force` 会先做私有快照，再替换已经由本脚本管理的节点。它也会让客户端重连。接管旧版人工安装要先由操作员核对身份，再补齐安装器的身份记录。
- `--panel` 只接受 HTTPS origin。`MBOARD_BINARY_BASE` 可改下载目录，但下载源必须仍是同一个面板 origin。

请用 `sh` 执行，保持默认输出即可。`sh -x` 会把凭据展开到日志中。

## 安装过程

1. 确认 root、amd64、服务管理器、源 machine 记录和旧服务的固定 executable/config 绑定。
2. 用私有 curl 配置传 Bearer 凭据，向 `POST /api/node/v1/enroll` 发 `{machine_id}`。解析 `{data:{token,revision,config,traffic_labels,files}}`。
3. 下载两个固定版本的 amd64 二进制，按脚本内 SHA256 常量校验。HTTPS 下载时不跟随跨站重定向。
4. 在 root 私有目录中写 JSON 和 TLS。TLS 只接受有界、唯一的 `.crt` 或 `.key` basename，统一以 600 权限写入。machine 2/node 180 的既有证书只从已知固定路径读取。
5. 对暂存证书路径运行 `sing-box check`，再运行 agent 的 `validate -config`。agent 的命令只校验 agent JSON，原生配置由前一步检查。
6. 备份旧配置、服务定义、二进制和已有 mboard 状态。停止已核对的旧服务，安装并启动新服务。
7. 看到本机 `127.0.0.1:19090` 监听和对应 state revision 后，向 `POST /api/node/v1/activate` 发 `{config_revision}`。面板还必须看到最近 90 秒内的核心和统计就绪心跳，并确认实际 revision。
8. 收到 `{data:{activated:true,machine_id,config_revision}}` 后，把旧启动入口和旧二进制移入私有备份。旧配置留在原位，备份中也有归档。

工作目录是 `/opt/mboard-node-stage`，退出时清理。运行目录是 `/opt/mboard-node`，状态目录是其中的 `data`。原生缓存可写 `/var/lib/mboard-node`。这些目录和 TLS 目录均为 root 所有、700 权限。配置、凭据、归档和日志为 600 权限。私有备份里的服务和二进制快照保留原权限，以便 OpenRC 能正确恢复。

## 恢复边界

激活前发生安装、启动或明确的就绪拒绝，退出 trap 会停止新服务，恢复先前的 mboard 文件和服务，再按之前的运行状态启动旧服务。错误输出会给出私有备份路径。新服务停止失败时，脚本保留它正在使用的文件，要求操作员先停止它再恢复。文件恢复失败时，脚本让两个服务保持停止，要求操作员先修复备份恢复步骤。

激活请求超时、服务器错误、回复格式错误，或发出请求时收到终止信号，面板可能已经激活。这时脚本保留新节点，提示重跑命令与面板确认，确认成功后补做旧启动项清理。明确的 409 拒绝允许正常回退。私有 `rollback.log` 只供 root 操作员检查。

**面板激活成功后，旧 token 会失效，所以这时恢复旧二进制还需要面板操作员一起恢复旧认证和 owner。** 安装器会继续让新节点运行。最后一步删除旧启动入口失败时，输出会提示用备份路径完成清理，不能把这条提示当成旧服务卸载完成。

成功备份位于 `/opt/mboard-node-backups/cutover-时间戳.随机值`，包含私有 `result.json` 和服务操作日志。请只把安装器的普通状态输出发给操作员，配置、归档和私有日志请留在机器上。

systemd 检查命令：

```sh
systemctl is-active mboard-node.service
systemctl is-enabled mboard-node.service
systemctl is-active xboard-node.service
```

OpenRC 检查命令：

```sh
rc-service mboard-node status
rc-update show default
rc-service xboard-node status
```

新服务应为 active，旧服务应为 stopped，启动项应指向 mboard-node。完整回退请由操作员根据备份中的源服务管理器恢复定义、二进制及配置，再和面板恢复认证。归档中的旧二进制恢复后要设为 755 才能执行。

## 发布和开发验证

公开文件来自 [安装脚本](../deploy/install-mboard-node.sh)。固定二进制：

| 文件 | SHA256 |
| --- | --- |
| `/downloads/mboard-node-linux-amd64` | `81562d3681a4cbb60ac8409cda363c8df55d0c1ad8a98be9f9e05332fede2e1d` |
| `/downloads/sing-box-linux-amd64`（v1.14.3） | `1e6b4ef716062484f52d3490c3b1c4d7798e8cd76aeaba3f01e9f3320c63bd90` |

发布时一起核对脚本里的两个常量和面板的真实下载文件。公开 SHA256 sidecar 可用于人工核对，但安装器的信任锚是脚本里的固定值。

在仓库根目录运行 [安装器测试](../tests/test_install_mboard_node.py)：

```sh
sh -n deploy/install-mboard-node.sh
busybox sh -n deploy/install-mboard-node.sh
python3 -m unittest discover -s tests -p 'test_install_mboard_node.py' -v
```

这些测试用合成凭据验证 literal-YAML、env 安全解析、JSON 限制、文件权限、SHA 校验、两种服务模板和激活前后的恢复边界。发现 BusyBox 时，测试同时用它的 shell 和文件处理 applet。恢复测试模拟服务与生产路径的文件命令，验证退出 trap 的调用顺序、丢失激活回复、恢复失败和真实临时目录中的 OpenRC 可执行权限。真实 Alpine 服务启动、网络、证书和面板握手需要在试点机器单独验证。
