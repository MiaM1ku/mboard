import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { LoaderCircle } from "lucide-react";
import { api, useResource, formatBytes, formatDate } from "./api";
import type {
  User,
  Node,
  Machine,
  TrafficPoint,
  Notice,
  Guide,
  Ticket,
  Group,
  AdminOverview,
  TrafficPool,
  PoolKind,
  PoolStatus,
} from "./types";
import {
  Button,
  Card,
  Badge,
  Field,
  Input,
  Select,
  Textarea,
  PageHeader,
  EmptyState,
  ErrorState,
  Modal,
  ShareBar,
  useToast,
} from "./ui";
import { TrafficChart } from "./TrafficChart";
import { AnimatedValue } from "./motion";
import { SubscriptionTemplates } from "./SubscriptionTemplates";
import { TrafficReports } from "./TrafficReports";

const ROOT = "/api/v1/admin";
const count = (value: number) => value.toLocaleString("zh-CN");
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作遇到问题，请重试。";
const request = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
});
type Resource<T> = {
  data: T | undefined;
  error: string;
  loading: boolean;
  reload: () => void;
};
type Column<T> = { label: string; render: (row: T) => ReactNode };
type WithId = { id: number; runtime?: boolean };
type AdminUser = User & { group_ids?: number[] };

function Loading({ label = "正在加载数据" }: { label?: string }) {
  return (
    <div className="mb-custom-loading" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={22} aria-hidden="true" />
      {label}
    </div>
  );
}
function ResourceView<T>({
  resource,
  children,
}: {
  resource: Resource<T>;
  children: (data: T) => ReactNode;
}) {
  if (resource.loading && resource.data === undefined) return <Loading />;
  if (resource.error)
    return <ErrorState message={resource.error} retry={resource.reload} />;
  if (resource.data === undefined) return <Loading />;
  return (
    <>
      {resource.loading && <Loading label="正在更新数据" />}
      {children(resource.data)}
    </>
  );
}
function Enabled({ value }: { value: boolean }) {
  return (
    <Badge tone={value ? "success" : "neutral"}>
      {value ? "启用" : "暂停"}
    </Badge>
  );
}
function Online({ value }: { value: boolean }) {
  return (
    <Badge tone={value ? "success" : "neutral"}>
      {value ? "在线" : "待连接"}
    </Badge>
  );
}
function Check({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="mb-custom-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {hint && <small className="mb-custom-meta">{hint}</small>}
      </span>
    </label>
  );
}
function CheckField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="field mb-custom-fieldset">
      <legend className="field-label">{label}</legend>
      {children}
    </fieldset>
  );
}
function GroupPicker({
  groups,
  selected,
  onChange,
}: {
  groups: Resource<Group[]>;
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  return (
    <CheckField label="访问分组">
      <ResourceView resource={groups}>
        {(items) =>
          items.length ? (
            <div className="mb-custom-checkbox-group">
              {items.map((group) => (
                <Check
                  key={group.id}
                  label={group.name}
                  checked={selected.includes(group.id)}
                  onChange={(checked) =>
                    onChange(
                      checked
                        ? [...selected, group.id]
                        : selected.filter((id) => id !== group.id),
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <p className="mb-custom-meta">
              在分组页面建立访问分组，再分配用户和节点。
            </p>
          )
        }
      </ResourceView>
      <p className="field-hint">用户和节点共享分组后，用户可访问相应节点。</p>
    </CheckField>
  );
}
function GroupNames({
  ids,
  groups,
}: {
  ids: number[];
  groups: Group[] | undefined;
}) {
  return (
    <span>
      {ids.length
        ? ids
            .map(
              (id) =>
                groups?.find((group) => group.id === id)?.name ?? `分组 #${id}`,
            )
            .join("、")
        : "待分配"}
    </span>
  );
}
function Table<T extends WithId>({
  rows,
  columns,
  actions,
}: {
  rows: T[];
  columns: Column<T>[];
  actions?: (row: T) => ReactNode;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.label}>
                {column.label}
              </th>
            ))}
            {actions && <th scope="col">操作</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td key={column.label}>{column.render(row)}</td>
              ))}
              {actions && (
                <td>
                  <div className="mb-custom-actions">{actions(row)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type CrudProps<T extends WithId, D> = {
  title: string;
  description: string;
  singular: string;
  endpoint: string;
  resource: Resource<T[]>;
  columns: Column<T>[];
  search: (item: T) => string;
  createDraft: () => D;
  editDraft: (item: T) => D;
  payload: (draft: D, editing: boolean) => unknown;
  fields: (
    draft: D,
    update: (patch: Partial<D>) => void,
    editing: boolean,
  ) => ReactNode;
  label: (item: T) => string;
  consequences: (item: T) => string;
  onCreated?: (value: unknown) => void;
  extraActions?: (item: T) => ReactNode;
  saveBlocked?: boolean;
  validate?: (draft: D) => string;
  toolbar?: ReactNode;
  runtimeAction?: (item: T) => ReactNode;
};
function CrudPage<T extends WithId, D>({
  title,
  description,
  singular,
  endpoint,
  resource,
  columns,
  search,
  createDraft,
  editDraft,
  payload,
  fields,
  label,
  consequences,
  onCreated,
  extraActions,
  saveBlocked,
  validate,
  toolbar,
  runtimeAction,
}: CrudProps<T, D>) {
  const { notify } = useToast();
  const formId = useId();
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ item: T | null; draft: D } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const open = (item: T | null) => {
    setMutationError("");
    setEditor({ item, draft: item ? editDraft(item) : createDraft() });
  };
  const update = (patch: Partial<D>) =>
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, ...patch } } : null,
    );
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || busy || saveBlocked) return;
    const validationError = validate?.(editor.draft);
    if (validationError) {
      setMutationError(validationError);
      return;
    }
    setBusy(true);
    setMutationError("");
    try {
      const value = await api<unknown>(
        editor.item ? `${endpoint}/${editor.item.id}` : endpoint,
        request(
          editor.item ? "PATCH" : "POST",
          payload(editor.draft, !!editor.item),
        ),
      );
      if (!editor.item) onCreated?.(value);
      setEditor(null);
      resource.reload();
      notify(
        editor.item ? `${singular}更新成功` : `${singular}创建成功`,
        "success",
      );
    } catch (error) {
      setMutationError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    setMutationError("");
    try {
      await api(`${endpoint}/${deleting.id}`, request("DELETE"));
      setDeleting(null);
      resource.reload();
      notify(`${singular}删除成功`, "success");
    } catch (error) {
      setMutationError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title={title}
        description={description}
        eyebrow="管理工作台"
        actions={<Button onClick={() => open(null)}>创建{singular}</Button>}
      />
      {toolbar}
      <Card>
        <div className="card-header mb-custom-toolbar">
          <Field label={`搜索${singular}`}>
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`输入${singular}名称或标识`}
            />
          </Field>
          <Button
            variant="secondary"
            onClick={resource.reload}
            disabled={resource.loading}
          >
            刷新列表
          </Button>
        </div>
        <ResourceView resource={resource}>
          {(items) => {
            const filtered = items.filter((item) =>
              search(item).toLowerCase().includes(query.trim().toLowerCase()),
            );
            if (!items.length)
              return (
                <EmptyState
                  title={`建立第一个${singular}`}
                  description={`创建${singular}后，可在此查看详情和调整配置。`}
                  action={
                    <Button onClick={() => open(null)}>创建{singular}</Button>
                  }
                />
              );
            if (!filtered.length)
              return (
                <EmptyState
                  title="调整搜索条件"
                  description={`输入更短的名称或标识，查找目标${singular}。`}
                  action={
                    <Button variant="secondary" onClick={() => setQuery("")}>
                      清空搜索
                    </Button>
                  }
                />
              );
            return (
              <>
                <Table
                  rows={filtered}
                  columns={columns}
                  actions={(item) => item.runtime ? (runtimeAction?.(item) ?? <Badge tone="info">运行配置</Badge>) : (
                    <>
                      <Button
                        variant="ghost"
                        size="small"
                        aria-label={`编辑${label(item)}`}
                        onClick={() => open(item)}
                      >
                        编辑
                      </Button>
                      {extraActions?.(item)}
                      <Button
                        variant="ghost"
                        size="small"
                        aria-label={`删除${label(item)}`}
                        onClick={() => {
                          setMutationError("");
                          setDeleting(item);
                        }}
                      >
                        删除
                      </Button>
                    </>
                  )}
                />
                <div className="card-body mb-custom-meta">
                  显示 {count(filtered.length)} 条，共 {count(items.length)} 条
                </div>
              </>
            );
          }}
        </ResourceView>
      </Card>
      <Modal
        open={!!editor}
        onClose={() => {
          if (!busy) setEditor(null);
        }}
        title={`${editor?.item ? "编辑" : "创建"}${singular}`}
        description="填写配置后保存，系统将应用新的设置。"
        large
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form={formId}
              loading={busy}
              disabled={busy || saveBlocked}
            >
              {editor?.item ? "保存更改" : `创建${singular}`}
            </Button>
          </>
        }
      >
        {editor && (
          <form id={formId} onSubmit={save}>
            <fieldset disabled={busy} className="mb-custom-fieldset">
              <div className="mb-custom-form-grid">
                {fields(editor.draft, update, !!editor.item)}
              </div>
            </fieldset>
            {mutationError && <ErrorState message={mutationError} />}
          </form>
        )}
      </Modal>
      <Modal
        open={!!deleting}
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
        title={`删除${singular}`}
        description={deleting ? `确认删除「${label(deleting)}」？` : ""}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy}
              onClick={remove}
            >
              确认删除
            </Button>
          </>
        }
      >
        {deleting && <p>{consequences(deleting)}</p>}
        {mutationError && <ErrorState message={mutationError} />}
      </Modal>
    </>
  );
}

const POOL_KIND_LABEL: Record<PoolKind, string> = {
  entry: "入口池",
  exit: "出口池",
  node: "独立节点",
};
const POOL_STATUS_LABEL: Record<PoolStatus, string> = {
  ok: "正常",
  warning: "接近上限",
  exceeded: "已超额度",
};
const POOL_STATUS_TONE: Record<PoolStatus, "success" | "warning" | "danger"> = {
  ok: "success",
  warning: "warning",
  exceeded: "danger",
};
function PoolCard({
  pool,
  onOpen,
}: {
  pool: TrafficPool;
  onOpen: () => void;
}) {
  const usage = pool.usage;
  const percent = Math.min(100, usage.percent);
  return (
    <article className="mb-custom-pool-card">
      <div className="mb-custom-pool-head">
        <div>
          <h3>{pool.name}</h3>
          <span className="mb-custom-meta">
            {POOL_KIND_LABEL[pool.kind]} · {pool.members.length} 个成员
          </span>
        </div>
        <Badge tone={POOL_STATUS_TONE[usage.status]}>
          {POOL_STATUS_LABEL[usage.status]}
        </Badge>
      </div>
      <div className="mb-custom-pool-figure">
        <strong>{formatBytes(usage.used_bytes)}</strong>
        <span className="muted"> / {formatBytes(usage.quota_bytes)}</span>
      </div>
      <div
        className="usage-track"
        role="progressbar"
        aria-label={`${pool.name} 用量`}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className={`is-${usage.status}`}
          style={{ width: `${Math.max(1, percent)}%` }}
        />
      </div>
      <p className="mb-custom-meta">
        剩余 {formatBytes(usage.remaining_bytes)} · {usage.cycle_end.slice(5)}{" "}
        重置 · 还有 {usage.days_left} 天
      </p>
      {usage.projected_bytes != null && (
        <p
          className={
            usage.projected_bytes > usage.quota_bytes
              ? "text-danger"
              : "mb-custom-meta"
          }
        >
          按现在速度，周期末约 {formatBytes(usage.projected_bytes)}
        </p>
      )}
      {usage.warnings.map((warning) => (
        <p className="mb-custom-meta" key={warning.code}>
          {warning.message}
        </p>
      ))}
      <Button variant="ghost" size="small" onClick={onOpen}>
        调整额度
      </Button>
    </article>
  );
}
function trafficTotal(value: { upload_bytes: number; download_bytes: number }) {
  return value.upload_bytes + value.download_bytes;
}
function OverviewPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [days, setDays] = useState("7");
  const overview = useResource<AdminOverview>(`${ROOT}/overview?days=${days}`);
  const [showAllNodes, setShowAllNodes] = useState(false);
  return (
    <>
      <PageHeader
        title="运行概览"
        eyebrow="管理工作台"
        description="看今天的流量、每个流量池的余量、节点用量和需要处理的机器。"
        actions={
          <div className="mb-custom-actions">
            <label>
              <Select
                aria-label="统计区间"
                value={days}
                onChange={(event) => setDays(event.target.value)}
              >
                <option value="1">今天</option>
                <option value="7">最近 7 天</option>
                <option value="30">最近 30 天</option>
              </Select>
            </label>
            <Button
              variant="secondary"
              onClick={overview.reload}
              disabled={overview.loading}
            >
              刷新数据
            </Button>
          </div>
        }
      />
      <ResourceView resource={overview}>
        {(data) => (
          <>
            <div className="kpi-grid">
              <Card>
                <div className="card-body">
                  <div className="mb-custom-meta">今日流量</div>
                  <div className="kpi-value">
                    <AnimatedValue
                      value={trafficTotal(data.today)}
                      format={formatBytes}
                    />
                  </div>
                  <p className="mb-custom-stat-note">
                    上传 {formatBytes(data.today.upload_bytes)} · 下载{" "}
                    {formatBytes(data.today.download_bytes)}
                  </p>
                </div>
              </Card>
              <Card>
                <div className="card-body">
                  <div className="mb-custom-meta">本月流量</div>
                  <div className="kpi-value">
                    <AnimatedValue
                      value={trafficTotal(data.month)}
                      format={formatBytes}
                    />
                  </div>
                  <p className="mb-custom-stat-note">
                    本月累计，按 UTC 日期统计
                  </p>
                </div>
              </Card>
              <Card>
                <div className="card-body">
                  <div className="mb-custom-meta">活跃用户</div>
                  <div className="kpi-value">
                    <AnimatedValue value={data.active_users} format={count} />
                  </div>
                  <p className="mb-custom-stat-note">
                    {count(data.enabled_users)} 个启用账户 · 区间内有流量
                  </p>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => onNavigate("users")}
                  >
                    管理用户 →
                  </Button>
                </div>
              </Card>
              <Card>
                <div className="card-body">
                  <div className="mb-custom-meta">节点在线</div>
                  <div className="kpi-value">
                    <AnimatedValue value={data.online_nodes} format={count} />
                    <span className="muted"> / {count(data.nodes)}</span>
                  </div>
                  <p className="mb-custom-stat-note">
                    机器 {count(data.online_machines)} / {count(data.machines)} 在线
                  </p>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => onNavigate("nodes")}
                  >
                    配置节点 →
                  </Button>
                </div>
              </Card>
            </div>
            <Card>
              <div className="card-header mb-custom-toolbar">
                <div>
                  <h2>流量池</h2>
                  <p>服务商给的周期额度，按节点上报的流量估算。</p>
                </div>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => onNavigate("pools")}
                >
                  管理流量池
                </Button>
              </div>
              {data.pools.length ? (
                <div className="card-body mb-custom-pool-grid">
                  {data.pools.map((pool) => (
                    <PoolCard
                      key={pool.id}
                      pool={pool}
                      onOpen={() => onNavigate("pools")}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="建立第一个流量池"
                  description="填上服务商给的额度和重置日，就能在这里看到每个池的余量。"
                  action={
                    <Button onClick={() => onNavigate("pools")}>
                      建立流量池
                    </Button>
                  }
                />
              )}
            </Card>
            <div className="dashboard-grid">
              <div className="section-stack">
                <TrafficChart
                  data={data.traffic as TrafficPoint[]}
                  title="近 30 天流量"
                  description="按 UTC 日期查看上传和下载用量。"
                />
              </div>
              <div className="section-stack">
                <Card>
                  <div className="card-header mb-custom-toolbar">
                    <div>
                      <h2>需要处理</h2>
                      <p>启用了但还没上报心跳的机器。</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => onNavigate("machines")}
                    >
                      查看机器
                    </Button>
                  </div>
                  {data.attention_machines.length ? (
                    <div className="card-body mb-custom-record-list">
                      {data.attention_machines.map((machine) => (
                        <div
                          className="mb-custom-record"
                          key={machine.id}
                        >
                          <div className="mb-custom-record-heading">
                            <strong>{machine.name}</strong>
                            <Badge tone="warning">等待心跳</Badge>
                          </div>
                          <span className="mb-custom-meta mono">
                            {machine.host}
                          </span>
                          <span className="mb-custom-meta">
                            {machine.last_seen_at
                              ? `最近心跳 ${formatDate(machine.last_seen_at)}`
                              : "等待首次心跳"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="card-body">
                      <p className="mb-custom-meta">
                        {count(data.machines)} 台机器都在线。
                      </p>
                    </div>
                  )}
                </Card>
                <Card>
                  <div className="card-header">
                    <div>
                      <h2>用户用量</h2>
                      <p>所选区间里用流量最多的账户。</p>
                    </div>
                  </div>
                  {data.top_users.length ? (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>用户</th>
                            <th>区间用量</th>
                            <th>累计 / 额度</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.top_users.map((user) => (
                            <tr key={user.id}>
                              <td>
                                <strong>{user.name}</strong>
                                <div className="mb-custom-meta">
                                  {user.email}
                                </div>
                              </td>
                              <td>{formatBytes(user.bytes)}</td>
                              <td>
                                {formatBytes(user.total_bytes)}
                                {user.quota_bytes > 0
                                  ? ` / ${formatBytes(user.quota_bytes)}`
                                  : " · 按实际用量累计"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="card-body">
                      <p className="mb-custom-meta">
                        所选区间里暂无账户流量。
                      </p>
                    </div>
                  )}
                </Card>
              </div>
            </div>
            <Card>
              <div className="card-header mb-custom-toolbar">
                <div>
                  <h2>节点用量</h2>
                  <p>所选区间里每个节点承载的流量，含入口和出口。</p>
                </div>
                {data.top_nodes.length > 10 && (
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => setShowAllNodes((value) => !value)}
                  >
                    {showAllNodes
                      ? "收起"
                      : `查看全部 ${data.top_nodes.length} 个`}
                  </Button>
                )}
              </div>
              {data.top_nodes.length ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>节点</th>
                        <th>服务器</th>
                        <th>状态</th>
                        <th>用户</th>
                        <th>上传</th>
                        <th>下载</th>
                        <th>合计</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(showAllNodes
                        ? data.top_nodes
                        : data.top_nodes.slice(0, 10)
                      ).map((node) => {
                        const total = node.upload_bytes + node.download_bytes;
                        const sum = data.top_nodes.reduce(
                          (value, item) =>
                            value + item.upload_bytes + item.download_bytes,
                          0,
                        );
                        return (
                          <tr key={node.id}>
                            <td>
                              <strong>{node.name}</strong>
                              {node.parent_name && (
                                <div className="mb-custom-meta">
                                  入口 {node.parent_name}
                                </div>
                              )}
                            </td>
                            <td className="mb-custom-meta">
                              {node.machine_names.length
                                ? node.machine_names.join(" / ")
                                : "待关联"}
                            </td>
                            <td>
                              <Badge
                                tone={node.online ? "success" : "warning"}
                              >
                                {node.online ? "在线" : "等待心跳"}
                              </Badge>
                            </td>
                            <td>{count(node.users)}</td>
                            <td>{formatBytes(node.upload_bytes)}</td>
                            <td>{formatBytes(node.download_bytes)}</td>
                            <td>
                              <div className="mb-custom-share">
                                <span>{formatBytes(total)}</span>
                                <ShareBar
                                  share={sum > 0 ? total / sum : 0}
                                />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="card-body">
                  <p className="mb-custom-meta">
                    所选区间里暂无节点流量。
                  </p>
                </div>
              )}
            </Card>
          </>
        )}
      </ResourceView>
    </>
  );
}

type PoolDraft = {
  name: string;
  kind: PoolKind;
  quota_amount: string;
  quota_unit: QuotaUnit;
  reset_day: string;
  billing: "single" | "double";
  visible_to_users: boolean;
  note: string;
  calibration_amount: string;
  calibration_unit: QuotaUnit;
  clear_calibration: boolean;
  members: string[];
};
function PoolsPage() {
  const pools = useResource<TrafficPool[]>(`${ROOT}/traffic-pools`);
  const nodes = useResource<Node[]>(`${ROOT}/nodes`);
  const machines = useResource<Machine[]>(`${ROOT}/machines`);
  const splitBytes = (bytes: number | null) => {
    if (bytes == null) return { amount: "", unit: "GB" as QuotaUnit };
    const parts = quotaParts(bytes);
    return { amount: parts.quota_amount, unit: parts.quota_unit as QuotaUnit };
  };
  return (
    <CrudPage<TrafficPool, PoolDraft>
      title="流量池"
      description="按服务商给的周期额度记录每个入口池、出口池和独立节点，随时看到剩余量。"
      singular="流量池"
      endpoint={`${ROOT}/traffic-pools`}
      resource={pools}
      search={(pool) => `${pool.name} ${POOL_KIND_LABEL[pool.kind]} ${pool.members.map((member) => member.name).join(" ")}`}
      label={(pool) => pool.name}
      createDraft={() => ({
        name: "",
        kind: "entry",
        quota_amount: "",
        quota_unit: "TB",
        reset_day: "1",
        billing: "single",
        visible_to_users: true,
        note: "",
        calibration_amount: "",
        calibration_unit: "GB",
        clear_calibration: false,
        members: [],
      })}
      editDraft={(pool) => {
        const quota = splitBytes(pool.quota_bytes);
        const calibration = splitBytes(pool.calibration_bytes);
        return {
          name: pool.name,
          kind: pool.kind,
          quota_amount: quota.amount,
          quota_unit: quota.unit,
          reset_day: String(pool.reset_day),
          billing: pool.billing,
          visible_to_users: pool.visible_to_users,
          note: pool.note,
          calibration_amount: calibration.amount,
          calibration_unit: calibration.unit,
          clear_calibration: false,
          members: pool.members.map((member) => `${member.type}:${member.id}`),
        };
      }}
      payload={(draft) => {
        const quota = quotaBytes(draft.quota_amount, draft.quota_unit);
        const calibration = draft.calibration_amount.trim()
          ? quotaBytes(draft.calibration_amount, draft.calibration_unit)
          : null;
        return {
          name: draft.name.trim(),
          kind: draft.kind,
          quota_bytes: quota,
          reset_day: Number(draft.reset_day),
          billing: draft.billing,
          visible_to_users: draft.visible_to_users,
          note: draft.note.trim(),
          members: draft.members.map((key) => {
            const [type, id] = key.split(":");
            return { type, id: Number(id) };
          }),
          ...(draft.clear_calibration
            ? { calibration_bytes: null }
            : calibration != null
              ? { calibration_bytes: calibration }
              : {}),
        };
      }}
      validate={(draft) => {
        if (!draft.name.trim()) return "请填写流量池名称。";
        if (!Number.isSafeInteger(quotaBytes(draft.quota_amount, draft.quota_unit)))
          return "请填写能换成整数字节的额度。";
        const day = Number(draft.reset_day);
        if (!Number.isInteger(day) || day < 1 || day > 31)
          return "重置日请填写 1 到 31 之间的数字。";
        if (!draft.members.length) return "请选择至少一个节点或服务器。";
        return "";
      }}
      saveBlocked={
        nodes.loading ||
        !!nodes.error ||
        machines.loading ||
        !!machines.error
      }
      consequences={() =>
        "删除只移除这个池的额度和成员设置，已经上报的流量记录继续保留。"
      }
      columns={[
        {
          label: "流量池",
          render: (pool) => (
            <>
              <strong>{pool.name}</strong>
              <div className="mb-custom-meta">
                {POOL_KIND_LABEL[pool.kind]} ·{" "}
                {pool.billing === "double" ? "双向计费" : "单向计费"}
              </div>
            </>
          ),
        },
        {
          label: "用量",
          render: (pool) => (
            <div className="mb-custom-share">
              <span>
                {formatBytes(pool.usage.used_bytes)} /{" "}
                {formatBytes(pool.usage.quota_bytes)}
              </span>
              <ShareBar share={pool.usage.percent / 100} />
            </div>
          ),
        },
        {
          label: "周期",
          render: (pool) => (
            <>
              <span>{pool.usage.cycle_end} 重置</span>
              <div className="mb-custom-meta">
                还有 {pool.usage.days_left} 天
                {pool.usage.calibrated ? " · 已校准" : ""}
              </div>
            </>
          ),
        },
        {
          label: "状态",
          render: (pool) => (
            <Badge tone={POOL_STATUS_TONE[pool.usage.status]}>
              {POOL_STATUS_LABEL[pool.usage.status]}
            </Badge>
          ),
        },
        {
          label: "成员",
          render: (pool) => (
            <>
              <span>{pool.members.length} 个</span>
              <div className="mb-custom-meta">
                {pool.members.slice(0, 3).map((member) => member.name).join(" / ")}
                {pool.members.length > 3 ? " …" : ""}
              </div>
            </>
          ),
        },
      ]}
      fields={(draft, update) => (
        <>
          <Field label="流量池名称" hint="写服务商和线路，例如 腾讯IX 或 BageHK。">
            <Input
              required
              maxLength={60}
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field label="类型" hint="入口池、出口池和独立节点只是分组标签。">
            <Select
              value={draft.kind}
              onChange={(event) =>
                update({ kind: event.target.value as PoolKind })
              }
            >
              <option value="entry">入口池</option>
              <option value="exit">出口池</option>
              <option value="node">独立节点</option>
            </Select>
          </Field>
          <Field label="周期额度" hint="按服务商账单填，例如 3 TB。">
            <Input
              required
              type="number"
              min="0"
              step="any"
              value={draft.quota_amount}
              onChange={(event) =>
                update({ quota_amount: event.target.value })
              }
            />
          </Field>
          <Field label="额度单位">
            <Select
              value={draft.quota_unit}
              onChange={(event) =>
                update({ quota_unit: event.target.value as QuotaUnit })
              }
            >
              <option value="GB">GB</option>
              <option value="TB">TB</option>
            </Select>
          </Field>
          <Field label="重置日" hint="每月几号清零，按上海时间。短月取月末那天。">
            <Input
              required
              type="number"
              min="1"
              max="31"
              value={draft.reset_day}
              onChange={(event) => update({ reset_day: event.target.value })}
            />
          </Field>
          <Field
            label="计费方式"
            hint="服务商把进和出两个方向合计时选双向，面板按两倍计算。"
          >
            <Select
              value={draft.billing}
              onChange={(event) =>
                update({ billing: event.target.value as "single" | "double" })
              }
            >
              <option value="single">单向（按实际流量）</option>
              <option value="double">双向（进和出合计）</option>
            </Select>
          </Field>
          <CheckField label="用户可见">
            <Check
              label="在用户概览显示剩余百分比"
              checked={draft.visible_to_users}
              onChange={(visible_to_users) => update({ visible_to_users })}
            />
          </CheckField>
          <div className="mb-custom-field-wide">
            <CheckField label="成员">
              <div className="mb-custom-section-stack">
                <p className="field-hint">
                  按节点上报的流量记账。旧版接入的机器和节点先照常显示，接入运行节点后开始记录用量。
                </p>
                <div>
                  <span className="mb-custom-meta">服务器</span>
                  <div className="mb-custom-checkbox-group">
                    {(machines.data ?? []).map((machine) => (
                      <Check
                        key={`machine:${machine.id}`}
                        label={`${machine.name} · ${machine.host}`}
                        checked={draft.members.includes(`machine:${machine.id}`)}
                        onChange={(checked) =>
                          update({
                            members: checked
                              ? [...draft.members, `machine:${machine.id}`]
                              : draft.members.filter(
                                  (key) => key !== `machine:${machine.id}`,
                                ),
                          })
                        }
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <span className="mb-custom-meta">节点</span>
                  <div className="mb-custom-checkbox-group">
                    {(nodes.data ?? []).map((node) => (
                      <Check
                        key={`node:${node.id}`}
                        label={`${node.name}${node.parent_id ? ` · 入口 ${node.parent_id}` : ""}`}
                        checked={draft.members.includes(`node:${node.id}`)}
                        onChange={(checked) =>
                          update({
                            members: checked
                              ? [...draft.members, `node:${node.id}`]
                              : draft.members.filter(
                                  (key) => key !== `node:${node.id}`,
                                ),
                          })
                        }
                      />
                    ))}
                  </div>
                </div>
              </div>
            </CheckField>
          </div>
          <Field
            label="校准已用量"
            hint="填服务商面板显示的本周期已用量。周期翻页后自动失效。"
          >
            <Input
              type="number"
              min="0"
              step="any"
              placeholder="留空表示按上报流量计算"
              value={draft.calibration_amount}
              onChange={(event) =>
                update({ calibration_amount: event.target.value })
              }
            />
          </Field>
          <Field label="校准单位">
            <Select
              value={draft.calibration_unit}
              onChange={(event) =>
                update({ calibration_unit: event.target.value as QuotaUnit })
              }
            >
              <option value="GB">GB</option>
              <option value="TB">TB</option>
            </Select>
          </Field>
          <CheckField label="校准选项">
            <Check
              label="清除现有校准值"
              checked={draft.clear_calibration}
              onChange={(clear_calibration) => update({ clear_calibration })}
            />
          </CheckField>
          <div className="mb-custom-field-wide">
            <Field label="备注">
              <Textarea
                rows={3}
                maxLength={500}
                value={draft.note}
                onChange={(event) => update({ note: event.target.value })}
              />
            </Field>
          </div>
        </>
      )}
    />
  );
}

type QuotaUnit = "MB" | "GB" | "TB";
const QUOTA_UNIT: Record<QuotaUnit, number> = {
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};
function quotaParts(bytes: number): { quota_amount: string; quota_unit: QuotaUnit } {
  if (!bytes) return { quota_amount: "0", quota_unit: "GB" };
  for (const unit of ["TB", "GB", "MB"] as const) {
    if (bytes % QUOTA_UNIT[unit] === 0)
      return { quota_amount: String(bytes / QUOTA_UNIT[unit]), quota_unit: unit };
  }
  const text = (bytes / QUOTA_UNIT.MB).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return { quota_amount: text, quota_unit: "MB" };
}
function quotaBytes(amount: string, unit: QuotaUnit): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return Number.NaN;
  const bytes = value * QUOTA_UNIT[unit];
  return Number.isSafeInteger(bytes) ? bytes : Number.NaN;
}
type UserDraft = {
  name: string;
  email: string;
  password: string;
  enabled: boolean;
  quota_amount: string;
  quota_unit: QuotaUnit;
  expires_at: string;
  expires_original: string | null;
  group_ids: number[];
};
function UsersPage() {
  const users = useResource<AdminUser[]>(`${ROOT}/users`);
  const groups = useResource<Group[]>(`${ROOT}/groups`);
  return (
    <CrudPage<AdminUser, UserDraft>
      title="用户管理"
      description="配置账户、流量配额和访问分组，管理服务有效期。"
      singular="用户"
      endpoint={`${ROOT}/users`}
      resource={users}
      search={(user) => `${user.name} ${user.email} ${user.id}`}
      label={(user) => user.name || user.email}
      createDraft={() => ({
        name: "",
        email: "",
        password: "",
        enabled: true,
        quota_amount: "0",
        quota_unit: "GB",
        expires_at: "",
        expires_original: null,
        group_ids: [],
      })}
      editDraft={(user) => ({
        name: user.name,
        email: user.email,
        password: "",
        enabled: user.enabled,
        ...quotaParts(user.quota_bytes),
        expires_at: user.expires_at ? user.expires_at.slice(0, 19) : "",
        expires_original: user.expires_at,
        group_ids: user.group_ids ?? [],
      })}
      payload={(draft, editing) => ({
        name: draft.name.trim(),
        email: draft.email.trim(),
        ...(!editing || draft.password ? { password: draft.password } : {}),
        enabled: draft.enabled,
        quota_bytes: quotaBytes(draft.quota_amount, draft.quota_unit),
        expires_at: draft.expires_at
          ? draft.expires_at === draft.expires_original?.slice(0, 19)
            ? draft.expires_original
            : new Date(`${draft.expires_at}Z`).toISOString()
          : null,
        group_ids: draft.group_ids,
      })}
      validate={(draft) =>
        Number.isSafeInteger(quotaBytes(draft.quota_amount, draft.quota_unit))
          ? ""
          : "配额要能换成整数字节。请改数量或单位。"
      }
      saveBlocked={
        groups.loading || !!groups.error || groups.data === undefined
      }
      consequences={() =>
        "删除将清理账户、订阅凭据、访问授权、登录会话和问题会话。请先保存需要留存的沟通记录。管理员账户适用最后一位管理员保护规则。"
      }
      columns={[
        {
          label: "用户",
          render: (user) => (
            <>
              <strong>{user.name}</strong>
              <div className="mb-custom-meta">{user.email}</div>
            </>
          ),
        },
        {
          label: "状态",
          render: (user) => (
            <>
              <Enabled value={user.enabled} />
              <div className="mb-custom-meta">
                {user.role === "admin" ? "管理员" : "用户"}
              </div>
            </>
          ),
        },
        {
          label: "用量 / 配额",
          render: (user) => (
            <>
              <span>
                {formatBytes(user.upload_bytes + user.download_bytes)}
              </span>
              <div className="mb-custom-meta">
                配额{" "}
                {user.quota_bytes
                  ? formatBytes(user.quota_bytes)
                  : "按实际用量累计"}
              </div>
            </>
          ),
        },
        {
          label: "访问分组",
          render: (user) => (
            <GroupNames ids={user.group_ids ?? []} groups={groups.data} />
          ),
        },
        {
          label: "有效期",
          render: (user) =>
            user.expires_at ? formatDate(user.expires_at) : "长期有效",
        },
      ]}
      fields={(draft, update, editing) => (
        <>
          <Field label="姓名">
            <Input
              required
              maxLength={120}
              value={draft.name}
              autoComplete="name"
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field label="电子邮箱">
            <Input
              type="email"
              required
              maxLength={254}
              value={draft.email}
              autoComplete="email"
              onChange={(event) => update({ email: event.target.value })}
            />
          </Field>
          <Field
            label={editing ? "重设密码（可选）" : "初始密码"}
            hint={
              editing
                ? "填写新密码会替换账户密码，留空沿用现有密码。"
                : "密码至少 12 个字符，请通过安全渠道交付。"
            }
          >
            <Input
              type="password"
              required={!editing}
              minLength={12}
              autoComplete="new-password"
              value={draft.password}
              onChange={(event) => update({ password: event.target.value })}
            />
          </Field>
          <Field label="流量配额" hint="0 表示不限。按 MB、GB 或 TB 填写，保存时换成字节。">
            <Input
              type="number"
              min="0"
              step="any"
              required
              value={draft.quota_amount}
              onChange={(event) => update({ quota_amount: event.target.value })}
            />
          </Field>
          <Field label="配额单位">
            <Select
              value={draft.quota_unit}
              onChange={(event) =>
                update({ quota_unit: event.target.value as QuotaUnit })
              }
            >
              <option value="MB">MB</option>
              <option value="GB">GB</option>
              <option value="TB">TB</option>
            </Select>
          </Field>
          <Field
            label="有效期截止时间（UTC）"
            hint="按 UTC 时间设置截止时刻。留空为长期有效。"
          >
            <Input
              type="datetime-local"
              step="1"
              value={draft.expires_at}
              onChange={(event) => update({ expires_at: event.target.value })}
            />
          </Field>
          <CheckField label="账户状态">
            <Check
              label="启用账户"
              checked={draft.enabled}
              onChange={(enabled) => update({ enabled })}
              hint="启用后按配额、有效期和访问分组提供服务。"
            />
          </CheckField>
          <div className="mb-custom-field-wide">
            <GroupPicker
              groups={groups}
              selected={draft.group_ids}
              onChange={(group_ids) => update({ group_ids })}
            />
          </div>
        </>
      )}
    />
  );
}

type NodeDraft = {
  name: string;
  host: string;
  port: string;
  protocol: Node["protocol"];
  enabled: boolean;
  machine_id: string;
  group_ids: number[];
  tls: boolean;
  server_name: string;
  entry_ips: string[];
  entry_strategy: string;
};
const ENTRY_STRATEGY_OPTIONS = [
  { value: "round-robin", label: "轮询（每个连接换一个入口）" },
  { value: "consistent-hashing", label: "按目标固定（同一个网站走同一个入口）" },
  { value: "sticky-sessions", label: "按来源固定（同一个会话走同一个入口）" },
] as const;
const ENTRY_STRATEGY_LABEL: Record<string, string> = {
  "round-robin": "轮询",
  "consistent-hashing": "按目标固定",
  "sticky-sessions": "按来源固定",
};
const ENTRY_HINT =
  "填写客户端连接用的 IP，可以填 1 到 16 个。支持负载均衡的客户端会把它们合成一个节点；其他客户端会显示为“节点名 1”“节点名 2”。留空时使用服务地址。";
function entrySummary(node: Node) {
  const ips = node.entry_ips ?? [];
  if (!ips.length) return `${node.host}:${node.port}`;
  if (ips.length === 1) return `入口 ${ips[0]}`;
  return `入口 ${ips.length} 个 · ${ENTRY_STRATEGY_LABEL[node.entry_strategy ?? "round-robin"] ?? "轮询"}`;
}
function entryListError(ips: string[]) {
  const list = ips.map((ip) => ip.trim()).filter(Boolean);
  if (list.length > 16) return "最多填写 16 个 IP。";
  if (new Set(list).size !== list.length) return "每个 IP 填写一次。";
  return "";
}
function EntryEditor({
  ips,
  strategy,
  onChange,
  ariaLabel,
  disabled,
  compact,
}: {
  ips: string[];
  strategy: string;
  onChange: (patch: { entry_ips?: string[]; entry_strategy?: string }) => void;
  ariaLabel: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="mb-custom-section-stack">
      {ips.map((ip, index) => (
        <div className="mb-custom-actions" key={index}>
          <Input
            value={ip}
            maxLength={45}
            placeholder="203.0.113.10"
            aria-label={`${ariaLabel} ${index + 1}`}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                entry_ips: ips.map((current, currentIndex) =>
                  currentIndex === index ? event.target.value : current,
                ),
              })
            }
          />
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              onChange({
                entry_ips: ips.filter(
                  (_, currentIndex) => currentIndex !== index,
                ),
              })
            }
          >
            移除
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() => onChange({ entry_ips: [...ips, ""] })}
      >
        添加入口
      </Button>
      {!compact && ips.filter((ip) => ip.trim()).length >= 2 ? (
        <Field
          label="分配方式"
          hint="客户端按这里的方式把连接分到各个入口。"
        >
          <Select
            value={strategy || "round-robin"}
            disabled={disabled}
            onChange={(event) =>
              onChange({ entry_strategy: event.target.value })
            }
          >
            {ENTRY_STRATEGY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </div>
  );
}
function NodesPage() {
  const nodes = useResource<Node[]>(`${ROOT}/nodes`);
  const machines = useResource<Machine[]>(`${ROOT}/machines`);
  const groups = useResource<Group[]>(`${ROOT}/groups`);
  const { notify } = useToast();
  const [configNode, setConfigNode] = useState<Node | null>(null);
  const [entryDraft, setEntryDraft] = useState<string[]>([]);
  const [entryStrategy, setEntryStrategy] = useState("round-robin");
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryError, setEntryError] = useState("");
  useEffect(() => {
    setEntryDraft([...(configNode?.entry_ips ?? [])]);
    setEntryStrategy(configNode?.entry_strategy ?? "round-robin");
    setEntryError("");
  }, [configNode]);
  return (
    <div className="mb-custom-section-stack">
    <CrudPage<Node, NodeDraft>
      title="节点管理"
      description="配置服务端点、协议和访问分组，将节点部署到接入机器。"
      singular="节点"
      endpoint={`${ROOT}/nodes`}
      resource={nodes}
      search={(node) => `${node.name} ${node.host} ${node.protocol} ${node.id}`}
      label={(node) => node.name}
      createDraft={() => ({
        name: "",
        host: "",
        port: "443",
        protocol: "vless",
        enabled: true,
        machine_id: "",
        group_ids: [],
        tls: true,
        server_name: "",
        entry_ips: [],
        entry_strategy: "round-robin",
      })}
      editDraft={(node) => ({
        name: node.name,
        host: node.host,
        port: String(node.port),
        protocol: node.protocol,
        enabled: node.enabled,
        machine_id: node.machine_id === null ? "" : String(node.machine_id),
        group_ids: node.group_ids,
        tls: node.tls,
        server_name: node.server_name,
        entry_ips: [...(node.entry_ips ?? [])],
        entry_strategy: node.entry_strategy ?? "round-robin",
      })}
      payload={(draft) => ({
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: Number(draft.port),
        protocol: draft.protocol,
        enabled: draft.enabled,
        machine_id: draft.machine_id ? Number(draft.machine_id) : null,
        group_ids: draft.group_ids,
        tls: draft.tls,
        server_name: draft.server_name.trim(),
        entry_ips: draft.entry_ips.map((ip) => ip.trim()).filter(Boolean),
        entry_strategy: draft.entry_strategy,
      })}
      validate={(draft) => {
        if (!draft.group_ids.length) return "选择至少一个访问分组，再保存节点。";
        return entryListError(draft.entry_ips);
      }}
      saveBlocked={
        groups.loading ||
        !!groups.error ||
        groups.data === undefined ||
        machines.loading ||
        !!machines.error ||
        machines.data === undefined
      }
      consequences={() =>
        "删除将从订阅和机器配置中移除这个节点。连接此节点的客户端需要选择其他可用节点。"
      }
      runtimeAction={(node) => (
        <Button
          variant="ghost"
          size="small"
          aria-label={`查看${node.name}的运行配置`}
          onClick={() => setConfigNode(node)}
        >
          配置
        </Button>
      )}
      columns={[
        {
          label: "节点 / 端点",
          render: (node) => (
            <>
              <strong>{node.name}</strong>
              <div
                className="mb-custom-meta mono"
                title={
                  node.entry_ips?.length ? node.entry_ips.join(" / ") : undefined
                }
              >
                #{node.id} · {entrySummary(node)}
              </div>
            </>
          ),
        },
        {
          label: "协议",
          render: (node) => (
            <>
              <span className="mono">{node.protocol.toUpperCase()}</span>
              <div className="mb-custom-meta">
                {node.tls ? "TLS 加密" : "协议传输"}
              </div>
            </>
          ),
        },
        {
          label: "状态",
          render: (node) => (
            <div className="mb-custom-actions">
              <Enabled value={node.enabled} />
              <Online value={node.online} />
            </div>
          ),
        },
        {
          label: "接入机器",
          render: (node) =>
            node.machine_id === null
              ? "待关联"
              : (machines.data?.find(
                  (machine) => machine.id === node.machine_id,
                )?.name ?? `机器 #${node.machine_id}`),
        },
        {
          label: "访问分组",
          render: (node) => (
            <GroupNames ids={node.group_ids} groups={groups.data} />
          ),
        },
      ]}
      fields={(draft, update, editing) => (
        <>
          <Field label="节点名称">
            <Input
              required
              maxLength={120}
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <div className="mb-custom-field-wide">
            <Field label="连接入口" hint={ENTRY_HINT}>
              <EntryEditor
                ips={draft.entry_ips}
                strategy={draft.entry_strategy}
                ariaLabel="连接入口 IP"
                onChange={(patch) => update(patch)}
              />
            </Field>
          </div>
          <Field label="服务地址" hint="填写客户端可访问的域名或 IP。填写连接入口后，订阅改用入口 IP 连接。">
            <Input
              required
              maxLength={253}
              value={draft.host}
              placeholder="node.example.com"
              onChange={(event) => update({ host: event.target.value })}
            />
          </Field>
          <Field label="监听端口" hint="同一台机器的节点使用各自的端口。">
            <Input
              required
              type="number"
              min="1"
              max="65535"
              step="1"
              value={draft.port}
              onChange={(event) => update({ port: event.target.value })}
            />
          </Field>
          <Field label="协议">
            <Select
              value={draft.protocol}
              onChange={(event) => {
                const protocol = event.target.value as Node["protocol"];
                update({
                  protocol,
                  tls:
                    protocol === "shadowsocks"
                      ? false
                      : protocol === "trojan"
                        ? true
                        : draft.tls,
                });
              }}
            >
              <option value="vless">VLESS</option>
              <option value="trojan">Trojan</option>
              <option value="shadowsocks">Shadowsocks · aes-128-gcm</option>
            </Select>
          </Field>
          <div className="mb-custom-field-wide">
            <ResourceView resource={machines}>
              {(items) => (
                <Field label="接入机器">
                  <Select
                    value={draft.machine_id}
                    onChange={(event) =>
                      update({ machine_id: event.target.value })
                    }
                  >
                    <option value="">稍后关联机器</option>
                    {items.map((machine) => (
                      <option key={machine.id} value={machine.id}>
                        {machine.name} · {machine.host}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </ResourceView>
          </div>
          <CheckField label="节点状态">
            <Check
              label="启用节点"
              checked={draft.enabled}
              onChange={(enabled) => update({ enabled })}
            />
          </CheckField>
          <CheckField label="传输加密">
            {draft.protocol === "vless" ? (
              <Check
                label="启用 TLS"
                checked={draft.tls}
                onChange={(tls) => update({ tls })}
              />
            ) : (
              <span className="mb-custom-meta">
                {draft.protocol === "trojan"
                  ? "Trojan 使用 TLS 加密"
                  : "Shadowsocks 使用 AES-128-GCM 加密"}
              </span>
            )}
          </CheckField>
          {draft.tls && (
            <div className="mb-custom-field-wide">
              <Field
                label="TLS 服务名称"
                hint="填写证书覆盖的域名，用于客户端 TLS 校验。"
              >
                <Input
                  required
                  value={draft.server_name}
                  maxLength={253}
                  placeholder="node.example.com"
                  onChange={(event) =>
                    update({ server_name: event.target.value })
                  }
                />
              </Field>
            </div>
          )}
          <div className="mb-custom-field-wide">
            <GroupPicker
              groups={groups}
              selected={draft.group_ids}
              onChange={(group_ids) => update({ group_ids })}
            />
          </div>
          {draft.tls && draft.protocol !== "shadowsocks" && (
            <div className="mb-custom-field-wide mb-custom-security-note">
              <h3>部署 TLS 证书</h3>
              <p>
                {editing ? "按节点列表中的节点 ID" : "保存后获取节点 ID，再"}
                在接入机器上放置证书和私钥：
              </p>
              <pre className="mb-custom-code">
                /etc/mboard-node/tls/&lt;节点ID&gt;.crt{"\n"}
                /etc/mboard-node/tls/&lt;节点ID&gt;.key
              </pre>
              <p>
                证书覆盖 TLS
                服务名称。设置私钥权限供节点服务读取，随后应用最新配置。证书续期后同步替换文件。
              </p>
            </div>
          )}
        </>
      )}
    />
    <Modal
      open={!!configNode}
      onClose={() => setConfigNode(null)}
      title={configNode ? configNode.name : "运行配置"}
      description="协议、证书和路由来自机器上的配置。这里可以设置连接入口和分配方式。"
      footer={
        <>
          <Button variant="secondary" disabled={entryBusy} onClick={() => setConfigNode(null)}>关闭</Button>
          <Button
            loading={entryBusy}
            disabled={entryBusy}
            onClick={async () => {
              if (!configNode) return;
              const entry_ips = entryDraft.map((ip) => ip.trim()).filter(Boolean);
              const listError = entryListError(entry_ips);
              if (listError) { setEntryError(listError); return; }
              setEntryBusy(true); setEntryError("");
              try {
                await api(`${ROOT}/runtime-nodes/${configNode.id}/entries`, request("PATCH", { entry_ips, entry_strategy: entryStrategy }));
                nodes.reload();
                notify("节点入口已保存", "success");
                setConfigNode(null);
              } catch (error) {
                setEntryError(errorText(error));
              } finally {
                setEntryBusy(false);
              }
            }}
          >
            保存入口
          </Button>
        </>
      }
    >
      {configNode && (
        <dl className="mb-custom-meta">
          <div>协议：{configNode.protocol.toUpperCase()}</div>
          <div>客户端地址：{configNode.host}:{configNode.port}</div>
          <Field label="连接入口" hint={ENTRY_HINT}>
            <EntryEditor
              ips={entryDraft}
              strategy={entryStrategy}
              ariaLabel="运行节点入口 IP"
              disabled={entryBusy}
              onChange={(patch) => {
                if (patch.entry_ips) setEntryDraft(patch.entry_ips);
                if (patch.entry_strategy) setEntryStrategy(patch.entry_strategy);
              }}
            />
          </Field>
          {entryError && <ErrorState message={entryError} />}
          {configNode.server_port ? <div>机器监听：{configNode.server_port}</div> : null}
          <div>状态：{configNode.enabled ? "启用" : "停用"} · {configNode.online ? "在线" : "离线"}{configNode.show === false ? " · 订阅中隐藏" : ""}</div>
          <div>接入机器：{configNode.machine_id === null ? "待关联" : (machines.data?.find((machine) => machine.id === configNode.machine_id)?.name ?? `机器 #${configNode.machine_id}`)}</div>
          {configNode.parent_id ? <div>上级节点：#{configNode.parent_id}</div> : null}
          <div>访问分组：<GroupNames ids={configNode.group_ids} groups={groups.data} /></div>
        </dl>
      )}
    </Modal>
    </div>
  );
}

type MachineDraft = { name: string; host: string; enabled: boolean };
function MachinesPage() {
  const machines = useResource<Machine[]>(`${ROOT}/machines`);
  const { notify } = useToast();
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(
    null,
  );
  const [rotating, setRotating] = useState<Machine | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  async function rotate() {
    if (!rotating || busy) return;
    setBusy(true);
    setMutationError("");
    try {
      const result = await api<{ token: string }>(
        `${ROOT}/machines/${rotating.id}/token`,
        request("POST"),
      );
      setSecret({ name: rotating.name, token: result.token });
      setRotating(null);
      machines.reload();
      notify("机器接入令牌已轮换", "success");
    } catch (error) {
      setMutationError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.token);
      notify("令牌已复制，请存入安全的凭据管理器", "success");
    } catch {
      notify("请选中令牌手动复制，存入安全的凭据管理器。", "danger");
    }
  }
  return (
    <div className="mb-custom-section-stack">
      <CrudPage<Machine, MachineDraft>
        title="机器管理"
        description="接入节点机器，查看心跳、服务版本和配置更新状态。"
        singular="机器"
        endpoint={`${ROOT}/machines`}
        resource={machines}
        search={(machine) =>
          `${machine.name} ${machine.host} ${machine.version ?? ""} ${machine.id}`
        }
        label={(machine) => machine.name}
        createDraft={() => ({ name: "", host: "", enabled: true })}
        editDraft={(machine) => ({
          name: machine.name,
          host: machine.host,
          enabled: machine.enabled,
        })}
        payload={(draft) => ({
          ...draft,
          name: draft.name.trim(),
          host: draft.host.trim(),
        })}
        onCreated={(value) => {
          const result = value as { machine: Machine; token: string };
          setSecret({ name: result.machine.name, token: result.token });
        }}
        extraActions={(machine) => (
          <Button
            variant="ghost"
            size="small"
            aria-label={`轮换${machine.name}的接入令牌`}
            onClick={() => {
              setMutationError("");
              setRotating(machine);
            }}
          >
            轮换令牌
          </Button>
        )}
        consequences={() =>
          "先转移或删除关联节点，再删除机器记录。删除成功后会清理机器接入凭据和流量批次确认记录。"
        }
        columns={[
          {
            label: "机器",
            render: (machine) => (
              <>
                <strong>{machine.name}</strong>
                <div className="mb-custom-meta mono">{machine.host}</div>
              </>
            ),
          },
          {
            label: "状态",
            render: (machine) => (
              <div className="mb-custom-actions">
                <Enabled value={machine.enabled} />
                <Online value={machine.online} />
              </div>
            ),
          },
          {
            label: "最近心跳",
            render: (machine) =>
              machine.last_seen_at
                ? formatDate(machine.last_seen_at)
                : "等待首次心跳",
          },
          {
            label: "服务版本",
            render: (machine) => machine.version ?? "等待版本上报",
          },
          {
            label: "配置版本",
            render: (machine) => (
              <span className="mono">{machine.config_revision}</span>
            ),
          },
        ]}
        fields={(draft, update) => (
          <>
            <Field label="机器名称">
              <Input
                required
                maxLength={120}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field label="机器地址" hint="用于识别接入机器的域名或 IP。">
              <Input
                required
                maxLength={253}
                value={draft.host}
                placeholder="machine.example.com"
                onChange={(event) => update({ host: event.target.value })}
              />
            </Field>
            <div className="mb-custom-field-wide">
              <CheckField label="接入状态">
                <Check
                  label="启用机器"
                  checked={draft.enabled}
                  onChange={(enabled) => update({ enabled })}
                  hint="启用后接受机器心跳、配置请求和流量上报。"
                />
              </CheckField>
            </div>
            <div className="mb-custom-field-wide mb-custom-security-note">
              <h3>接入步骤</h3>
              <p>
                创建机器后保存一次性令牌。把站点地址和令牌写入节点服务的受限配置，然后启动服务。心跳上报后可在列表查看连接状态。
              </p>
            </div>
          </>
        )}
      />
      <Modal
        open={!!rotating}
        onClose={() => {
          if (!busy) setRotating(null);
        }}
        title="轮换机器令牌"
        description={rotating ? `为「${rotating.name}」生成新的接入凭据。` : ""}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRotating(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy}
              onClick={rotate}
            >
              确认轮换
            </Button>
          </>
        }
      >
        <p>
          轮换后使用新令牌接入机器。旧令牌立即失效，心跳、配置获取和流量上报需更新凭据后继续。请准备好机器配置再确认。
        </p>
        {mutationError && <ErrorState message={mutationError} />}
      </Modal>
      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        title="保存机器接入令牌"
        description={
          secret ? `「${secret.name}」的令牌仅在这次操作后展示。` : ""
        }
        footer={
          <>
            <Button variant="secondary" onClick={copySecret}>
              复制令牌
            </Button>
            <Button onClick={() => setSecret(null)}>已安全保存</Button>
          </>
        }
      >
        {secret && (
          <>
            <div className="mb-custom-security-note">
              <p>
                关闭窗口后，这个令牌将从页面清除。请先存入凭据管理器，再写入节点服务的受限配置。
              </p>
            </div>
            <Field
              label="机器接入令牌"
              hint="令牌授予机器接入权限，请通过安全渠道传递。"
            >
              <Textarea
                readOnly
                autoComplete="off"
                spellCheck={false}
                rows={3}
                value={secret.token}
              />
            </Field>
            <p className="mb-custom-meta">
              令牌用于节点 API 的 Bearer 凭据。页面按临时状态持有这次令牌。
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}

function GroupsPage() {
  const groups = useResource<Group[]>(`${ROOT}/groups`);
  return (
    <CrudPage<Group, { name: string }>
      title="访问分组"
      description="把用户和节点组织到分组，以共享分组控制节点访问。"
      singular="分组"
      endpoint={`${ROOT}/groups`}
      resource={groups}
      label={(group) => group.name}
      search={(group) => `${group.name} ${group.id}`}
      createDraft={() => ({ name: "" })}
      editDraft={(group) => ({ name: group.name })}
      payload={(draft) => ({ name: draft.name.trim() })}
      consequences={() =>
        "先调整用户和节点的分组授权，再删除分组。删除成功后，这个分组会从可分配列表中清除。"
      }
      columns={[
        { label: "分组名称", render: (group) => <strong>{group.name}</strong> },
        {
          label: "分组 ID",
          render: (group) => <span className="mono">{group.id}</span>,
        },
      ]}
      fields={(draft, update) => (
        <div className="mb-custom-field-wide">
          <Field
            label="分组名称"
            hint="用地区、服务级别或团队名称表达分组用途。"
          >
            <Input
              required
              maxLength={120}
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
        </div>
      )}
    />
  );
}
function ContentPage() {
  const [tab, setTab] = useState<"notices" | "guides">("notices");
  const tabs = (
    <div className="mb-custom-content-tabs" role="group" aria-label="内容类型">
      <Button
        variant={tab === "notices" ? "primary" : "secondary"}
        aria-pressed={tab === "notices"}
        onClick={() => setTab("notices")}
      >
        公告
      </Button>
      <Button
        variant={tab === "guides" ? "primary" : "secondary"}
        aria-pressed={tab === "guides"}
        onClick={() => setTab("guides")}
      >
        使用指南
      </Button>
    </div>
  );
  return tab === "notices" ? (
    <NoticesPage toolbar={tabs} />
  ) : (
    <GuidesPage toolbar={tabs} />
  );
}
function NoticesPage({ toolbar }: { toolbar: ReactNode }) {
  const notices = useResource<Notice[]>(`${ROOT}/notices`);
  return (
    <CrudPage<Notice, { title: string; body: string }>
      title="内容管理"
      description="发布公告，让用户了解服务变化和使用安排。"
      singular="公告"
      endpoint={`${ROOT}/notices`}
      resource={notices}
      toolbar={toolbar}
      label={(notice) => notice.title}
      search={(notice) => `${notice.title} ${notice.body}`}
      createDraft={() => ({ title: "", body: "" })}
      editDraft={(notice) => ({ title: notice.title, body: notice.body })}
      payload={(draft) => ({
        title: draft.title.trim(),
        body: draft.body.trim(),
      })}
      consequences={() => "删除将移除这条公告，用户公告列表会同步更新。"}
      columns={[
        { label: "标题", render: (notice) => <strong>{notice.title}</strong> },
        {
          label: "发布时间",
          render: (notice) => formatDate(notice.created_at),
        },
      ]}
      fields={(draft, update) => (
        <>
          <div className="mb-custom-field-wide">
            <Field label="公告标题">
              <Input
                required
                maxLength={200}
                value={draft.title}
                onChange={(event) => update({ title: event.target.value })}
              />
            </Field>
          </div>
          <div className="mb-custom-field-wide">
            <Field label="公告正文" hint="以纯文本发布，支持分段阅读。">
              <Textarea
                required
                rows={10}
                maxLength={50000}
                value={draft.body}
                onChange={(event) => update({ body: event.target.value })}
              />
            </Field>
          </div>
        </>
      )}
    />
  );
}
function GuidesPage({ toolbar }: { toolbar: ReactNode }) {
  const guides = useResource<Guide[]>(`${ROOT}/guides`);
  return (
    <CrudPage<Guide, { title: string; body: string; category: string }>
      title="内容管理"
      description="整理接入步骤和使用知识，帮助用户按分类查阅指南。"
      singular="指南"
      endpoint={`${ROOT}/guides`}
      resource={guides}
      toolbar={toolbar}
      label={(guide) => guide.title}
      search={(guide) => `${guide.title} ${guide.body} ${guide.category}`}
      createDraft={() => ({ title: "", body: "", category: "" })}
      editDraft={(guide) => ({
        title: guide.title,
        body: guide.body,
        category: guide.category,
      })}
      payload={(draft) => ({
        title: draft.title.trim(),
        body: draft.body.trim(),
        category: draft.category.trim(),
      })}
      consequences={() => "删除将移除这篇指南，用户指南列表会同步更新。"}
      columns={[
        { label: "标题", render: (guide) => <strong>{guide.title}</strong> },
        { label: "分类", render: (guide) => guide.category },
        { label: "发布时间", render: (guide) => formatDate(guide.created_at) },
      ]}
      fields={(draft, update) => (
        <>
          <Field label="指南标题">
            <Input
              required
              maxLength={200}
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <Field label="指南分类">
            <Input
              required
              maxLength={120}
              value={draft.category}
              placeholder="例如：客户端接入"
              onChange={(event) => update({ category: event.target.value })}
            />
          </Field>
          <div className="mb-custom-field-wide">
            <Field
              label="指南正文"
              hint="以纯文本发布，按步骤分段帮助用户操作。"
            >
              <Textarea
                required
                rows={12}
                maxLength={50000}
                value={draft.body}
                onChange={(event) => update({ body: event.target.value })}
              />
            </Field>
          </div>
        </>
      )}
    />
  );
}

function TicketsPage() {
  const tickets = useResource<Ticket[]>(`${ROOT}/tickets`);
  const { notify } = useToast();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [closing, setClosing] = useState(false);
  const filtered = useMemo(
    () =>
      (tickets.data ?? []).filter(
        (ticket) =>
          (status === "all" || ticket.status === status) &&
          `${ticket.subject} ${ticket.user_name} ${ticket.id}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [tickets.data, query, status],
  );
  const selected = tickets.data?.find((ticket) => ticket.id === selectedId);
  const select = (id: number) => {
    setSelectedId(id);
    setReply("");
    setMutationError("");
  };
  async function sendReply(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy || !reply.trim()) return;
    setBusy(true);
    setMutationError("");
    try {
      await api<Ticket>(
        `/api/v1/tickets/${selected.id}/messages`,
        request("POST", { body: reply.trim() }),
      );
      setReply("");
      tickets.reload();
      notify("回复已发送", "success");
    } catch (error) {
      setMutationError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function closeTicket() {
    if (!selected || busy) return;
    setBusy(true);
    setMutationError("");
    try {
      await api<Ticket>(
        `/api/v1/tickets/${selected.id}`,
        request("PATCH", { status: "closed" }),
      );
      setClosing(false);
      tickets.reload();
      notify("工单已关闭", "success");
    } catch (error) {
      setMutationError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="工单管理"
        eyebrow="管理工作台"
        description="查看用户请求，发送回复并跟进处理结果。"
        actions={
          <Button
            variant="secondary"
            disabled={tickets.loading || busy}
            onClick={tickets.reload}
          >
            刷新工单
          </Button>
        }
      />
      <Card>
        <div className="card-header mb-custom-toolbar">
          <Field label="搜索工单">
            <Input
              type="search"
              value={query}
              placeholder="主题、用户或工单编号"
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <Field label="处理状态">
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="open">处理中</option>
              <option value="closed">已关闭</option>
            </Select>
          </Field>
        </div>
        <ResourceView resource={tickets}>
          {(items) =>
            !items.length ? (
              <EmptyState
                title="集中处理用户请求"
                description="用户提交的工单会显示在这里，选择工单即可回复和跟进。"
                action={
                  <Button variant="secondary" onClick={tickets.reload}>
                    刷新工单
                  </Button>
                }
              />
            ) : !filtered.length ? (
              <EmptyState
                title="调整筛选条件"
                description="更换主题关键词或处理状态，查看相应工单。"
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setStatus("all");
                    }}
                  >
                    重置筛选
                  </Button>
                }
              />
            ) : (
              <div className="mb-custom-split">
                <div className="mb-custom-ticket-list" aria-label="工单列表">
                  {filtered.map((ticket) => (
                    <button
                      className={selectedId === ticket.id ? "is-active" : ""}
                      key={ticket.id}
                      type="button"
                      aria-pressed={selectedId === ticket.id}
                      disabled={busy}
                      onClick={() => select(ticket.id)}
                    >
                      <span className="mb-custom-record-heading">
                        <strong>{ticket.subject}</strong>
                        <Badge
                          tone={
                            ticket.status === "open" ? "warning" : "neutral"
                          }
                        >
                          {ticket.status === "open" ? "处理中" : "已关闭"}
                        </Badge>
                      </span>
                      <span className="mb-custom-meta">
                        #{ticket.id} · {ticket.user_name} ·{" "}
                        {formatDate(ticket.created_at)}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mb-custom-ticket-thread">
                  {selected ? (
                    <>
                      <div className="mb-custom-record-heading">
                        <div>
                          <h2>{selected.subject}</h2>
                          <p className="mb-custom-meta">
                            工单 #{selected.id} · {selected.user_name}
                          </p>
                        </div>
                        {selected.status === "open" && (
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={busy}
                            onClick={() => {
                              setMutationError("");
                              setClosing(true);
                            }}
                          >
                            关闭工单
                          </Button>
                        )}
                      </div>
                      <div className="mb-custom-section-stack">
                        {selected.messages.map((message) => (
                          <article
                            key={message.id}
                            className={`mb-custom-message ${message.author_role === "admin" ? "mb-custom-message-admin" : ""}`}
                          >
                            <div className="mb-custom-record-heading">
                              <strong>
                                {message.author_role === "admin"
                                  ? "管理团队"
                                  : selected.user_name}
                              </strong>
                              <time
                                className="mb-custom-meta"
                                dateTime={message.created_at}
                              >
                                {formatDate(message.created_at)}
                              </time>
                            </div>
                            <p className="mb-custom-preserve-text">
                              {message.body}
                            </p>
                          </article>
                        ))}
                      </div>
                      {selected.status === "open" ? (
                        <form
                          onSubmit={sendReply}
                          className="mb-custom-section-stack"
                        >
                          <Field
                            label="回复内容"
                            hint="提交后，用户可以在工单中看到这条回复。"
                          >
                            <Textarea
                              required
                              maxLength={50000}
                              rows={5}
                              disabled={busy}
                              value={reply}
                              onChange={(event) => setReply(event.target.value)}
                            />
                          </Field>
                          {mutationError && !closing && (
                            <ErrorState message={mutationError} />
                          )}
                          <div className="mb-custom-actions">
                            <Button
                              type="submit"
                              loading={busy}
                              disabled={busy || !reply.trim()}
                            >
                              发送回复
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <p className="mb-custom-meta">
                          这个工单已关闭，可继续查阅完整沟通记录。
                        </p>
                      )}
                    </>
                  ) : (
                    <EmptyState
                      title="选择一个工单"
                      description="点击左侧工单查看完整沟通记录，并发送处理回复。"
                    />
                  )}
                </div>
              </div>
            )
          }
        </ResourceView>
      </Card>
      <Modal
        open={closing}
        onClose={() => {
          if (!busy) setClosing(false);
        }}
        title="关闭工单"
        description={selected ? `确认结束「${selected.subject}」的处理？` : ""}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setClosing(false)}
            >
              继续处理
            </Button>
            <Button loading={busy} disabled={busy} onClick={closeTicket}>
              确认关闭
            </Button>
          </>
        }
      >
        <p>
          关闭后，工单将转为完成状态，完整沟通记录可继续查阅。后续问题可提交新的工单。
        </p>
        {mutationError && <ErrorState message={mutationError} />}
      </Modal>
    </>
  );
}

type SiteSettings = { site_name: string; site_description: string };
type AuditEntry = {
  id: number;
  actor: string;
  action: string;
  target: string;
  created_at: string;
};
const auditAction: Record<string, string> = {
  setup: "初始化工作区",
  "users.create": "创建用户",
  "users.update": "更新用户",
  "users.delete": "删除用户",
  "nodes.create": "创建节点",
  "nodes.update": "更新节点",
  "nodes.delete": "删除节点",
  "machines.create": "创建机器",
  "machines.update": "更新机器",
  "machines.delete": "删除机器",
  "machine.token.rotate": "轮换机器令牌",
  "groups.create": "创建分组",
  "groups.update": "更新分组",
  "groups.delete": "删除分组",
  "notices.create": "发布公告",
  "notices.update": "更新公告",
  "notices.delete": "删除公告",
  "guides.create": "发布指南",
  "guides.update": "更新指南",
  "guides.delete": "删除指南",
  "settings.update": "更新站点设置",
  "runtime-nodes.entries": "更新节点入口",
  "password.change": "更新密码",
  "subscription.rotate": "轮换订阅凭据",
  "ticket.create": "提交问题",
  "ticket.reply": "回复问题",
  "ticket.close": "结束问题会话",
};
function SettingsPage() {
  const settings = useResource<SiteSettings>(`${ROOT}/settings`);
  const audit = useResource<AuditEntry[]>(`${ROOT}/audit`);
  const { notify } = useToast();
  const [draft, setDraft] = useState<SiteSettings>({
    site_name: "",
    site_description: "",
  });
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);
  const changed =
    !!settings.data &&
    (draft.site_name !== settings.data.site_name ||
      draft.site_description !== settings.data.site_description);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setMutationError("");
    try {
      await api<SiteSettings>(
        `${ROOT}/settings`,
        request("PATCH", {
          site_name: draft.site_name.trim(),
          site_description: draft.site_description.trim(),
        }),
      );
      settings.reload();
      audit.reload();
      notify("站点设置已保存", "success");
    } catch (error) {
      setMutationError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="站点设置"
        eyebrow="管理工作台"
        description="调整站点信息和订阅模板，查阅管理操作记录。"
      />
      <Card>
        <div className="card-header">
          <h2>站点信息</h2>
          <p className="mb-custom-meta">名称和介绍用于站点展示。</p>
        </div>
        <div className="card-body">
          <ResourceView resource={settings}>
            {() => (
              <form onSubmit={save} className="mb-custom-section-stack">
                <fieldset className="mb-custom-fieldset" disabled={busy}>
                  <div className="mb-custom-form-grid">
                    <Field label="站点名称">
                      <Input
                        required
                        maxLength={120}
                        value={draft.site_name}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            site_name: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <div className="mb-custom-field-wide">
                      <Field label="站点介绍">
                        <Textarea
                          rows={3}
                          maxLength={2000}
                          value={draft.site_description}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              site_description: event.target.value,
                            }))
                          }
                        />
                      </Field>
                    </div>
                  </div>
                </fieldset>
                {mutationError && <ErrorState message={mutationError} />}
                <div className="mb-custom-actions">
                  <Button
                    type="submit"
                    loading={busy}
                    disabled={busy || !changed || settings.loading}
                  >
                    保存设置
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || !changed}
                    onClick={() => {
                      if (settings.data) setDraft(settings.data);
                      setMutationError("");
                    }}
                  >
                    重置更改
                  </Button>
                </div>
              </form>
            )}
          </ResourceView>
        </div>
      </Card>
      <SubscriptionTemplates onSaved={audit.reload} />
      <TrafficReports onSaved={audit.reload} />
      <Card>
        <div className="card-header mb-custom-toolbar">
          <div>
            <h2>操作审计</h2>
            <p className="mb-custom-meta">
              查看最近 100 条管理操作，追踪操作者和变更对象。
            </p>
          </div>
          <Button
            variant="secondary"
            size="small"
            disabled={audit.loading}
            onClick={audit.reload}
          >
            刷新记录
          </Button>
        </div>
        <div className="card-body">
          <Field label="搜索审计记录">
            <Input
              type="search"
              value={query}
              placeholder="操作者、动作或对象"
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
        </div>
        <ResourceView resource={audit}>
          {(items) => {
            const filtered = items.filter((entry) =>
              `${entry.actor} ${entry.action} ${auditAction[entry.action] ?? ""} ${entry.target}`
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            );
            return !items.length ? (
              <EmptyState
                title="管理操作留有记录"
                description="完成用户、节点或站点设置等管理操作后，可以在这里查看审计记录。"
                action={
                  <Button variant="secondary" onClick={audit.reload}>
                    刷新记录
                  </Button>
                }
              />
            ) : !filtered.length ? (
              <EmptyState
                title="调整搜索条件"
                description="输入更短的操作者、动作或对象关键词。"
                action={
                  <Button variant="secondary" onClick={() => setQuery("")}>
                    清空搜索
                  </Button>
                }
              />
            ) : (
              <Table
                rows={filtered}
                columns={[
                  { label: "操作者", render: (entry) => entry.actor },
                  {
                    label: "动作",
                    render: (entry) =>
                      auditAction[entry.action] ?? entry.action,
                  },
                  {
                    label: "对象",
                    render: (entry) => (
                      <span className="mono">{entry.target}</span>
                    ),
                  },
                  {
                    label: "时间",
                    render: (entry) => formatDate(entry.created_at),
                  },
                ]}
              />
            );
          }}
        </ResourceView>
      </Card>
    </>
  );
}

export function AdminPage({
  page,
  onNavigate,
}: {
  page: string;
  onNavigate: (page: string) => void;
}) {
  switch (page) {
    case "overview":
      return <OverviewPage onNavigate={onNavigate} />;
    case "users":
      return <UsersPage />;
    case "nodes":
      return <NodesPage />;
    case "machines":
      return <MachinesPage />;
    case "pools":
      return <PoolsPage />;
    case "groups":
      return <GroupsPage />;
    case "content":
      return <ContentPage />;
    case "tickets":
      return <TicketsPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <OverviewPage onNavigate={onNavigate} />;
  }
}
