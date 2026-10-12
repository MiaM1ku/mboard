import { useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  Copy,
  Download,
  KeyRound,
  LifeBuoy,
  Network,
  RefreshCw,
  ShieldCheck,
  Signal,
  SlidersHorizontal,
} from "lucide-react";
import { api, formatBytes, formatDate, useResource } from "./api";
import type {
  Node,
  Overview,
  TrafficPoint,
  Guide,
  Ticket,
  User,
} from "./types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from "./ui";
import { TrafficChart } from "./TrafficChart";

function Kpi({
  title,
  value,
  hint,
  icon,
}: {
  title: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="kpi-card">
      <div className="kpi-top">
        <span>{title}</span>
        {icon}
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-hint">{hint}</div>
    </Card>
  );
}
export function UserPage({
  page,
  user,
  onNavigate,
  onUserRefresh,
}: {
  page: string;
  user: User;
  onNavigate: (s: string) => void;
  onUserRefresh: () => void;
}) {
  if (page === "nodes") return <Nodes />;
  if (page === "traffic") return <Traffic />;
  if (page === "guides") return <Guides />;
  if (page === "tickets") return <Tickets />;
  if (page === "account")
    return <Account user={user} onUserRefresh={onUserRefresh} />;
  return <Home onNavigate={onNavigate} />;
}
function Home({ onNavigate }: { onNavigate: (s: string) => void }) {
  const resource = useResource<Overview>("overview");
  const { notify } = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!resource.data) return;
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/s/${resource.data.user.subscription_token}`,
      );
      setCopied(true);
      notify("订阅链接已经复制。");
    } catch {
      notify("请在账号设置中选择链接后复制。", "danger");
    }
  }
  const u = resource.data?.user;
  const total = (u?.upload_bytes || 0) + (u?.download_bytes || 0);
  const percent = u?.quota_bytes
    ? Math.min(100, (total / u.quota_bytes) * 100)
    : 0;
  return (
    <>
      <PageHeader
        title="连接，从这里开始"
        description="查看访问授权、订阅入口和每一天的用量。"
        eyebrow="YOUR CONNECTION"
        actions={
          <Button variant="secondary" onClick={resource.reload}>
            <RefreshCw size={16} />
            刷新状态
          </Button>
        }
      />
      {resource.error && (
        <ErrorState message={resource.error} retry={resource.reload} />
      )}{" "}
      {resource.loading ? (
        <Loading />
      ) : resource.data && u ? (
        <>
          <div className="kpi-grid">
            <Kpi
              title="累计用量"
              value={formatBytes(total)}
              hint="上传 + 下载"
              icon={<Signal size={18} />}
            />
            <Kpi
              title="可用节点"
              value={String(resource.data.nodes.length)}
              hint="按权限组分配"
              icon={<Network size={18} />}
            />
            <Kpi
              title="上传流量"
              value={formatBytes(u.upload_bytes)}
              hint="节点上报累计"
              icon={<ArrowUp size={18} />}
            />
            <Kpi
              title="下载流量"
              value={formatBytes(u.download_bytes)}
              hint="节点上报累计"
              icon={<ArrowDown size={18} />}
            />
          </div>
          <div className="dashboard-grid">
            <div className="section-stack">
              <Card className="subscription-card">
                <span className="eyebrow">SUBSCRIPTION</span>
                <h2>一个链接，接入你的网络</h2>
                <p>
                  复制订阅链接或下载 sing-box 配置，导入客户端后选择连接入口。
                </p>
                <div className="subscription-actions">
                  <Button onClick={() => void copy()}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    复制订阅链接
                  </Button>
                  <a
                    className="button button-secondary"
                    href={`/s/${u.subscription_token}`}
                    download="mboard.json"
                  >
                    <Download size={16} />
                    下载配置
                  </a>
                </div>
                <div className="subscription-meta">
                  <div>
                    <span>访问状态</span>
                    <strong>{u.enabled ? "授权开启" : "等待授权"}</strong>
                  </div>
                  <div>
                    <span>有效期</span>
                    <strong>{formatDate(u.expires_at)}</strong>
                  </div>
                </div>
              </Card>
              <TrafficChart data={resource.data.traffic} />
            </div>
            <div className="section-stack">
              <Card>
                <div className="card-header">
                  <div>
                    <h2>用量概况</h2>
                    <p>掌握你的访问额度</p>
                  </div>
                  <ShieldCheck size={18} className="muted" />
                </div>
                <div className="card-body">
                  <div className="info-row">
                    <span>累计用量</span>
                    <strong>{formatBytes(total)}</strong>
                  </div>
                  <div className="info-row">
                    <span>额度模式</span>
                    <strong>
                      {u.quota_bytes
                        ? formatBytes(u.quota_bytes)
                        : "按实际用量累计"}
                    </strong>
                  </div>
                  {u.quota_bytes > 0 && (
                    <>
                      <div
                        className="usage-track"
                        role="progressbar"
                        aria-label="额度用量"
                        aria-valuenow={Math.round(percent)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <span style={{ width: `${percent}%` }} />
                      </div>
                      <span className="muted">
                        剩余额度{" "}
                        {formatBytes(Math.max(0, u.quota_bytes - total))}
                      </span>
                    </>
                  )}
                </div>
              </Card>
              <Card>
                <div className="card-header">
                  <h2>开始使用</h2>
                </div>
                <div className="card-body">
                  {[
                    {
                      page: "nodes",
                      title: "选择连接入口",
                      text: "查看协议和节点状态",
                      icon: Network,
                    },
                    {
                      page: "guides",
                      title: "阅读使用指南",
                      text: "配置客户端和连接方式",
                      icon: BookOpen,
                    },
                    {
                      page: "tickets",
                      title: "联系管理员",
                      text: "提交问题并查看回复",
                      icon: LifeBuoy,
                    },
                  ].map((item) => (
                    <button
                      type="button"
                      className="quick-link"
                      key={item.page}
                      onClick={() => onNavigate(item.page)}
                      style={{
                        width: "100%",
                        borderLeft: 0,
                        borderRight: 0,
                        borderTop: 0,
                        background: "transparent",
                        textAlign: "left",
                      }}
                    >
                      <item.icon size={19} />
                      <div>
                        <strong>{item.title}</strong>
                        <span>{item.text}</span>
                      </div>
                      <ArrowUpRight size={16} className="muted" />
                    </button>
                  ))}
                </div>
              </Card>
            </div>
          </div>
          <Card>
            <div className="card-header">
              <div>
                <h2>站点公告</h2>
                <p>来自管理员的最新消息</p>
              </div>
            </div>
            {resource.data.notices.length ? (
              <div className="card-body section-stack">
                {resource.data.notices.map((n) => (
                  <article key={n.id}>
                    <div className="mb-custom-record-heading">
                      <h3>{n.title}</h3>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {formatDate(n.created_at)}
                      </span>
                    </div>
                    <p className="notice-body">{n.body}</p>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="关注站点消息"
                description="管理员发布公告后，消息会显示在这里。"
              />
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
function Nodes() {
  const r = useResource<Node[]>("nodes");
  const [search, setSearch] = useState("");
  const list =
    r.data?.filter((n) =>
      `${n.name} ${n.host} ${n.protocol}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  return (
    <>
      <PageHeader
        title="连接入口"
        description="查看你的授权节点，选择合适的协议和入口。"
        eyebrow="NETWORK"
        actions={
          <Button variant="secondary" onClick={r.reload}>
            <RefreshCw size={16} />
            刷新状态
          </Button>
        }
      />
      {r.error && <ErrorState message={r.error} retry={r.reload} />}
      <Card>
        <div className="mb-custom-toolbar">
          <label className="mb-custom-filter">
            <Input
              aria-label="搜索节点"
              placeholder="搜索名称、地址或协议"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <span className="muted">
            {r.loading ? "正在读取节点…" : `${list.length} 个连接入口`}
          </span>
        </div>
        {r.loading ? (
          <Loading />
        ) : list.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>节点名称</th>
                  <th>协议</th>
                  <th>入口地址</th>
                  <th>传输安全</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {list.map((n) => (
                  <tr key={n.id}>
                    <td>
                      <div className="node-cell">
                        <Network size={17} className="muted" />
                        <strong>{n.name}</strong>
                      </div>
                    </td>
                    <td>
                      <Badge tone="info">{n.protocol.toUpperCase()}</Badge>
                    </td>
                    <td className="mono">
                      {n.host}:{n.port}
                    </td>
                    <td>{n.tls ? "TLS 加密" : "协议原生传输"}</td>
                    <td>
                      <Badge tone={n.online ? "success" : "warning"}>
                        {n.online ? "运行中" : "等待心跳"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={search ? "调整搜索关键词" : "等待分配连接入口"}
            description={
              search
                ? "用节点名称、地址或协议搜索。"
                : "管理员配置权限组后，授权节点会显示在这里。"
            }
          />
        )}
      </Card>
    </>
  );
}
function Traffic() {
  const [days, setDays] = useState("30");
  const r = useResource<TrafficPoint[]>(`traffic?days=${days}`);
  const up = r.data?.reduce((a, x) => a + x.upload_bytes, 0) || 0,
    down = r.data?.reduce((a, x) => a + x.download_bytes, 0) || 0;
  return (
    <>
      <PageHeader
        title="每一天的用量"
        description="按 UTC 日期查看上传、下载和总流量，所有数值来自节点上报。"
        eyebrow="TRAFFIC"
        actions={
          <label>
            <Select
              aria-label="流量时间范围"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            >
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="90">最近 90 天</option>
            </Select>
          </label>
        }
      />
      {r.error && <ErrorState message={r.error} retry={r.reload} />}{" "}
      {r.loading ? (
        <Loading />
      ) : (
        <>
          <div className="kpi-grid">
            <Kpi
              title="区间总流量"
              value={formatBytes(up + down)}
              hint={`最近 ${days} 天`}
              icon={<Signal size={18} />}
            />
            <Kpi
              title="区间上传"
              value={formatBytes(up)}
              hint="设备发送流量"
              icon={<ArrowUp size={18} />}
            />
            <Kpi
              title="区间下载"
              value={formatBytes(down)}
              hint="设备接收流量"
              icon={<ArrowDown size={18} />}
            />
            <Kpi
              title="记录天数"
              value={String(r.data?.length || 0)}
              hint="有上报记录的日期"
              icon={<SlidersHorizontal size={18} />}
            />
          </div>
          <TrafficChart data={r.data || []} />
        </>
      )}
    </>
  );
}
function Guides() {
  const r = useResource<Guide[]>("guides");
  const [search, setSearch] = useState("");
  const guides =
    r.data?.filter((g) =>
      `${g.title} ${g.category} ${g.body}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  return (
    <>
      <PageHeader
        title="使用指南"
        description="找到连接方法、客户端配置和常见问题的解答。"
        eyebrow="GET STARTED"
      />
      <div
        className="mb-custom-toolbar"
        style={{ border: 0, padding: "0 0 22px" }}
      >
        <Input
          aria-label="搜索使用指南"
          placeholder="搜索指南标题或关键词"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {r.error && <ErrorState message={r.error} retry={r.reload} />}{" "}
      {r.loading ? (
        <Loading />
      ) : guides.length ? (
        <div className="content-grid">
          {guides.map((g) => (
            <Card key={g.id}>
              <details className="guide-details">
                <summary>
                  <span className="category-label">
                    {g.category || "使用说明"}
                  </span>
                  {g.title}
                </summary>
                <div className="notice-body">{g.body}</div>
              </details>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            title={search ? "调整指南关键词" : "指南持续更新"}
            description="管理员发布的配置说明会在这里按类别展示。"
          />
        </Card>
      )}
    </>
  );
}
function Tickets() {
  const r = useResource<Ticket[]>("tickets");
  const [selected, setSelected] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reply, setReply] = useState("");
  const [saving, setSaving] = useState(false);
  const { notify } = useToast();
  const ticket = r.data?.find((t) => t.id === selected) || null;
  async function create(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const t = await api<Ticket>("tickets", {
        method: "POST",
        body: JSON.stringify({ subject, body }),
      });
      setNewOpen(false);
      setBody("");
      setSubject("");
      setSelected(t.id);
      r.reload();
      notify("问题已经提交。");
    } catch (e) {
      notify((e as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!ticket) return;
    setSaving(true);
    try {
      await api(`tickets/${ticket.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: reply }),
      });
      setReply("");
      r.reload();
      notify("回复已经发送。");
    } catch (e) {
      notify((e as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  }
  async function close() {
    if (!ticket) return;
    setSaving(true);
    try {
      await api(`tickets/${ticket.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "closed" }),
      });
      r.reload();
      notify("问题已经结束。");
    } catch (e) {
      notify((e as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <PageHeader
        title="联系管理员"
        description="描述你的问题，在同一条会话里查看回复和处理进展。"
        eyebrow="SUPPORT"
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <LifeBuoy size={16} />
            提交问题
          </Button>
        }
      />
      {r.error && <ErrorState message={r.error} retry={r.reload} />}{" "}
      {r.loading ? (
        <Loading />
      ) : r.data?.length ? (
        <div className="mb-custom-split">
          <div className="mb-custom-ticket-list">
            {r.data.map((t) => (
              <button
                type="button"
                key={t.id}
                className={selected === t.id ? "is-active" : ""}
                onClick={() => {
                  setSelected(t.id);
                  setReply("");
                }}
              >
                <div className="mb-custom-record-heading">
                  <strong>{t.subject}</strong>
                  <Badge tone={t.status === "open" ? "info" : "neutral"}>
                    {t.status === "open" ? "处理中" : "已结束"}
                  </Badge>
                </div>
                <span className="mb-custom-meta">
                  {formatDate(t.created_at)}
                </span>
              </button>
            ))}
          </div>
          <Card>
            {ticket ? (
              <>
                <div className="card-header">
                  <h2>{ticket.subject}</h2>
                  {ticket.status === "open" && (
                    <Button
                      variant="secondary"
                      size="small"
                      loading={saving}
                      onClick={() => void close()}
                    >
                      结束会话
                    </Button>
                  )}
                </div>
                <div className="card-body">
                  <div className="mb-custom-ticket-thread">
                    {ticket.messages.map((m) => (
                      <article
                        className={`mb-custom-message ${m.author_role === "admin" ? "mb-custom-message-admin" : ""}`}
                        key={m.id}
                      >
                        <div className="mb-custom-meta">
                          {m.author_role === "admin" ? "管理员" : "我的回复"} ·{" "}
                          {formatDate(m.created_at)}
                        </div>
                        {m.body}
                      </article>
                    ))}
                  </div>
                  {ticket.status === "open" && (
                    <form onSubmit={send} className="form-stack">
                      <Field label="补充说明">
                        <Textarea
                          required
                          maxLength={10000}
                          value={reply}
                          onChange={(e) => setReply(e.target.value)}
                          placeholder="补充操作步骤、发生时间或错误提示"
                        />
                      </Field>
                      <div className="form-actions">
                        <Button type="submit" loading={saving}>
                          发送回复
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              </>
            ) : (
              <EmptyState
                title="选择一个问题"
                description="点击左侧会话查看回复记录。"
              />
            )}
          </Card>
        </div>
      ) : (
        <Card>
          <EmptyState
            title="需要帮助？从一个问题开始"
            description="填写连接场景和操作步骤，管理员会在这里回复。"
            action={<Button onClick={() => setNewOpen(true)}>提交问题</Button>}
          />
        </Card>
      )}
      <Modal
        open={newOpen}
        onClose={() => {
          if (!saving) setNewOpen(false);
        }}
        title="提交问题"
        description="清晰的操作步骤有助于管理员定位问题。"
      >
        <form onSubmit={create} className="form-stack">
          <Field label="问题标题">
            <Input
              required
              maxLength={160}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="例如：客户端配置方法"
            />
          </Field>
          <Field label="问题描述">
            <Textarea
              required
              maxLength={10000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => setNewOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" loading={saving}>
              提交问题
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
function Account({
  user,
  onUserRefresh,
}: {
  user: User;
  onUserRefresh: () => void;
}) {
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [saving, setSaving] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const { notify } = useToast();
  async function change(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api("me/password", {
        method: "PATCH",
        body: JSON.stringify({
          current_password: oldPassword,
          new_password: newPassword,
        }),
      });
      setOld("");
      setNew("");
      notify("新密码已经生效，其他设备登录会话会重新验证。");
    } catch (e) {
      notify((e as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  }
  async function rotate() {
    setSaving(true);
    try {
      await api("me/subscription/rotate", { method: "POST" });
      setRotateOpen(false);
      onUserRefresh();
      notify("订阅凭据已经更新，请重新导入配置。");
    } catch (e) {
      notify((e as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/s/${user.subscription_token}`,
      );
      notify("订阅链接已经复制。");
    } catch {
      notify("请选择下方链接后复制。", "danger");
    }
  }
  return (
    <>
      <PageHeader
        title="账号设置"
        description="管理密码和订阅凭据，掌握你的访问状态。"
        eyebrow="ACCOUNT"
      />
      <div className="dashboard-grid">
        <div className="section-stack">
          <Card>
            <div className="card-header">
              <div>
                <h2>更新登录密码</h2>
                <p>设置至少 12 位的新密码</p>
              </div>
              <KeyRound size={19} className="muted" />
            </div>
            <form className="card-body form-stack" onSubmit={change}>
              <Field label="现在的密码">
                <Input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={oldPassword}
                  onChange={(e) => setOld(e.target.value)}
                />
              </Field>
              <Field
                label="新密码"
                hint="推荐结合多个词语、数字和符号。更新后其他设备需要重新登录。"
              >
                <Input
                  type="password"
                  minLength={12}
                  maxLength={200}
                  required
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNew(e.target.value)}
                />
              </Field>
              <div className="form-actions">
                <Button type="submit" loading={saving}>
                  更新密码
                </Button>
              </div>
            </form>
          </Card>
          <Card>
            <div className="card-header">
              <div>
                <h2>订阅凭据</h2>
                <p>链接属于个人访问凭据，请用私密渠道保存。</p>
              </div>
            </div>
            <div className="card-body form-stack">
              <Field label="订阅链接">
                <Input
                  readOnly
                  value={`${location.origin}/s/${user.subscription_token}`}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
              <div className="mb-custom-actions">
                <Button variant="secondary" onClick={() => void copy()}>
                  <Copy size={16} />
                  复制链接
                </Button>
                <a
                  href={`/s/${user.subscription_token}`}
                  download="mboard.json"
                  className="button button-secondary"
                >
                  <Download size={16} />
                  下载配置
                </a>
                <Button variant="ghost" onClick={() => setRotateOpen(true)}>
                  轮换凭据
                </Button>
              </div>
            </div>
          </Card>
        </div>
        <Card>
          <div className="card-header">
            <h2>账号信息</h2>
          </div>
          <div className="card-body info-list">
            {[
              ["名称", user.name],
              ["邮箱", user.email],
              ["账号角色", user.role === "admin" ? "管理员" : "用户"],
              ["访问授权", user.enabled ? "授权开启" : "等待授权"],
              ["有效期", formatDate(user.expires_at)],
              ["创建时间", formatDate(user.created_at)],
            ].map(([label, value]) => (
              <div className="info-row" key={label}>
                <span>{label}</span>
                <span style={{ overflowWrap: "anywhere" }}>{value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Modal
        open={rotateOpen}
        onClose={() => {
          if (!saving) setRotateOpen(false);
        }}
        title="轮换订阅凭据"
        description="轮换后使用新订阅链接和新连接凭据。现有客户端需要重新导入配置。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => setRotateOpen(false)}
            >
              取消
            </Button>
            <Button loading={saving} onClick={() => void rotate()}>
              确认轮换
            </Button>
          </>
        }
      >
        <div className="callout">
          <ShieldCheck size={20} />
          <div>
            <strong>更新每个客户端的配置</strong>
            <p>请保存新链接，然后在已连接的设备上重新导入订阅。</p>
          </div>
        </div>
      </Modal>
    </>
  );
}
