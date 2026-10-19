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
import {
  api,
  formatBytes,
  formatDate,
  useResource,
  subscriptionUrl,
} from "./api";
import type {
  Node,
  NodeUsage,
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
  ShareBar,
  Textarea,
  useToast,
} from "./ui";
import { TrafficChart } from "./TrafficChart";
import { AnimatedValue } from "./motion";

function Kpi({
  title,
  value,
  format,
  hint,
  icon,
}: {
  title: string;
  value: number;
  format?: (n: number) => string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="kpi-card">
      <div className="kpi-top">
        <span>{title}</span>
        {icon}
      </div>
      <div className="kpi-value">
        <AnimatedValue value={value} format={format} />
      </div>
      <div className="kpi-hint">{hint}</div>
    </Card>
  );
}
function configDownloadName(siteName: string) {
  const base =
    siteName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() ||
    "mboard";
  return `${base}.json`;
}
export function UserPage({
  page,
  user,
  siteName,
  onNavigate,
  onUserRefresh,
}: {
  page: string;
  user: User;
  siteName: string;
  onNavigate: (s: string) => void;
  onUserRefresh: () => void;
}) {
  if (page === "nodes") return <Nodes />;
  if (page === "traffic") return <Traffic />;
  if (page === "guides") return <Guides />;
  if (page === "tickets") return <Tickets />;
  if (page === "account")
    return (
      <Account
        user={user}
        siteName={siteName}
        onUserRefresh={onUserRefresh}
      />
    );
  return <Home onNavigate={onNavigate} siteName={siteName} />;
}
function Home({
  onNavigate,
  siteName,
}: {
  onNavigate: (s: string) => void;
  siteName: string;
}) {
  const resource = useResource<Overview>("overview");
  const { notify } = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!resource.data) return;
    try {
      await navigator.clipboard.writeText(subscriptionUrl(resource.data.user));
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
  const data = resource.data;
  const stats = data
    ? [
        {
          title: "今日",
          value: data.today_bytes.upload_bytes + data.today_bytes.download_bytes,
          hint: `上传 ${formatBytes(data.today_bytes.upload_bytes)} · 下载 ${formatBytes(data.today_bytes.download_bytes)}`,
          icon: <Signal size={18} />,
        },
        {
          title: "近 7 天",
          value: data.week_bytes.upload_bytes + data.week_bytes.download_bytes,
          hint: `上传 ${formatBytes(data.week_bytes.upload_bytes)} · 下载 ${formatBytes(data.week_bytes.download_bytes)}`,
          icon: <ArrowUp size={18} />,
        },
        {
          title: "本月",
          value: data.month_bytes.upload_bytes + data.month_bytes.download_bytes,
          hint: `上传 ${formatBytes(data.month_bytes.upload_bytes)} · 下载 ${formatBytes(data.month_bytes.download_bytes)}`,
          icon: <ArrowDown size={18} />,
        },
      ]
    : [];
  return (
    <>
      <PageHeader
        title="我的用量"
        description="查看额度、每一天的流量，以及你最常用的节点。"
        eyebrow="MY USAGE"
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
      ) : data && u ? (
        <>
          <Card className="subscription-card">
            <span className="eyebrow">QUOTA</span>
            <h2>本期用量</h2>
            <div className="mb-custom-quota-figure">
              <span className="kpi-value">
                <AnimatedValue value={total} format={formatBytes} />
              </span>
              <span className="muted">
                {u.quota_bytes
                  ? ` / ${formatBytes(u.quota_bytes)}`
                  : " · 按实际用量累计"}
              </span>
            </div>
            {u.quota_bytes > 0 && (
              <div
                className="usage-track"
                role="progressbar"
                aria-label="额度用量"
                aria-valuenow={Math.round(percent)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span
                  className={percent >= 90 ? "is-warning" : ""}
                  style={{ width: `${Math.max(1, percent)}%` }}
                />
              </div>
            )}
            <div className="subscription-meta">
              <div>
                <span>剩余额度</span>
                <strong>
                  {u.quota_bytes
                    ? formatBytes(Math.max(0, u.quota_bytes - total))
                    : "按实际用量累计"}
                </strong>
              </div>
              <div>
                <span>有效期</span>
                <strong>{formatDate(u.expires_at)}</strong>
              </div>
              <div>
                <span>账号状态</span>
                <strong>{u.enabled ? "账号启用" : "账号暂停"}</strong>
              </div>
            </div>
            <div className="subscription-actions">
              <Button onClick={() => void copy()}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                复制订阅链接
              </Button>
              <a
                className="button button-secondary"
                href={subscriptionUrl(u)}
                download={configDownloadName(siteName)}
              >
                <Download size={16} />
                下载配置
              </a>
            </div>
          </Card>
          <div className="kpi-grid is-three">
            {stats.map((stat) => (
              <Kpi
                key={stat.title}
                title={stat.title}
                value={stat.value}
                format={formatBytes}
                hint={stat.hint}
                icon={stat.icon}
              />
            ))}
          </div>
          <div className="dashboard-grid">
            <div className="section-stack">
              <TrafficChart data={data.traffic} />
              <Card>
                <div className="card-header mb-custom-toolbar">
                  <div>
                    <h2>常用节点</h2>
                    <p>近 30 天你在各节点上的流量。</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => onNavigate("nodes")}
                  >
                    节点用量 →
                  </Button>
                </div>
                {data.top_nodes.length ? (
                  <div className="card-body mb-custom-record-list">
                    {data.top_nodes.map((node) => (
                      <div className="mb-custom-record" key={node.id}>
                        <div className="mb-custom-record-heading">
                          <strong>{node.name}</strong>
                          <span className="mb-custom-meta">
                            {formatBytes(node.bytes)}
                          </span>
                        </div>
                        <ShareBar share={node.share} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="card-body">
                    <p className="mb-custom-meta">
                      近 30 天暂无节点流量。
                    </p>
                  </div>
                )}
              </Card>
            </div>
            <div className="section-stack">
              {data.pools.length > 0 && (
                <Card>
                  <div className="card-header">
                    <div>
                      <h2>线路余量</h2>
                      <p>你可用线路所属流量池的剩余比例。</p>
                    </div>
                  </div>
                  <div className="card-body mb-custom-record-list">
                    {data.pools.map((pool) => (
                      <div className="mb-custom-record" key={pool.id}>
                        <div className="mb-custom-record-heading">
                          <strong>{pool.name}</strong>
                          <Badge
                            tone={
                              pool.status === "exceeded"
                                ? "danger"
                                : pool.status === "warning"
                                  ? "warning"
                                  : "success"
                            }
                          >
                            {pool.status === "exceeded"
                              ? "已超额度"
                              : pool.status === "warning"
                                ? "接近上限"
                                : "正常"}
                          </Badge>
                        </div>
                        <div
                          className="usage-track"
                          role="progressbar"
                          aria-label={`${pool.name} 剩余`}
                          aria-valuenow={pool.remaining_percent}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <span
                            className={`is-${pool.status === "ok" ? "ok" : pool.status}`}
                            style={{
                              width: `${Math.max(1, pool.remaining_percent)}%`,
                            }}
                          />
                        </div>
                        <span className="mb-custom-meta">
                          剩余 {pool.remaining_percent}% ·{" "}
                          {pool.cycle_end.slice(5)} 重置 · 还有 {pool.days_left}{" "}
                          天
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          </div>
          <Card>
            <div className="card-header">
              <div>
                <h2>站点公告</h2>
                <p>来自管理员的最新消息</p>
              </div>
            </div>
            {data.notices.length ? (
              <div className="card-body section-stack">
                {data.notices.map((n) => (
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
  const [days, setDays] = useState("30");
  const r = useResource<NodeUsage[]>(`me/node-usage?days=${days}`);
  return (
    <>
      <PageHeader
        title="节点用量"
        description="查看每个节点上的流量，挑出最顺手的那条线路。"
        eyebrow="NODE USAGE"
        actions={
          <div className="mb-custom-actions">
            <label>
              <Select
                aria-label="节点用量时间范围"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              >
                <option value="7">最近 7 天</option>
                <option value="30">最近 30 天</option>
                <option value="90">最近 90 天</option>
              </Select>
            </label>
            <Button variant="secondary" onClick={r.reload}>
              <RefreshCw size={16} />
              刷新数据
            </Button>
          </div>
        }
      />
      {r.error && <ErrorState message={r.error} retry={r.reload} />}
      <Card>
        {r.loading ? (
          <Loading />
        ) : r.data?.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>节点</th>
                  <th>合计</th>
                  <th>上传</th>
                  <th>下载</th>
                  <th>最近使用</th>
                  <th>所属线路</th>
                </tr>
              </thead>
              <tbody>
                {r.data.map((node) => (
                  <tr key={node.id}>
                    <td>
                      <div className="node-cell">
                        <Network size={17} className="muted" />
                        <strong>{node.name}</strong>
                      </div>
                      <div className="mb-custom-meta">
                        {node.available ? "可用" : "已停用"}
                      </div>
                    </td>
                    <td>
                      <div className="mb-custom-share">
                        <span>
                          {node.total_bytes
                            ? formatBytes(node.total_bytes)
                            : "这段时间暂无流量"}
                        </span>
                        <ShareBar share={node.share} />
                      </div>
                    </td>
                    <td>{formatBytes(node.upload_bytes)}</td>
                    <td>{formatBytes(node.download_bytes)}</td>
                    <td>{node.last_used_date ?? "这段时间暂无流量"}</td>
                    <td className="mb-custom-meta">
                      {node.pool_names.length
                        ? node.pool_names.join(" / ")
                        : "独立节点"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="等待分配节点"
            description="管理员接入节点并分配访问组后，你的用量会显示在这里。"
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
              value={up + down}
              format={formatBytes}
              hint={`最近 ${days} 天`}
              icon={<Signal size={18} />}
            />
            <Kpi
              title="区间上传"
              value={up}
              format={formatBytes}
              hint="设备发送流量"
              icon={<ArrowUp size={18} />}
            />
            <Kpi
              title="区间下载"
              value={down}
              format={formatBytes}
              hint="设备接收流量"
              icon={<ArrowDown size={18} />}
            />
            <Kpi
              title="记录天数"
              value={r.data?.length || 0}
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
  siteName,
  onUserRefresh,
}: {
  user: User;
  siteName: string;
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
      await navigator.clipboard.writeText(subscriptionUrl(user));
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
                  value={subscriptionUrl(user)}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
              <div className="mb-custom-actions">
                <Button variant="secondary" onClick={() => void copy()}>
                  <Copy size={16} />
                  复制链接
                </Button>
                <a
                  href={subscriptionUrl(user)}
                  download={configDownloadName(siteName)}
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
              ["账号状态", user.enabled ? "账号启用" : "账号暂停"],
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
