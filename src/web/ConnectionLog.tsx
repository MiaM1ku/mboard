import { useEffect, useRef, useState } from "react";
import { RefreshCw, ScrollText } from "lucide-react";
import { api, formatDate, useResource } from "./api";
import type {
  ConnectionPage,
  ConnectionRow,
  Node,
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
  PageHeader,
  Select,
} from "./ui";

const ROOT = "/api/v1/admin";
const PAGE_SIZE = 100;
type Hours = "1" | "24" | "168";
type Filters = { user: string; node: string; q: string; hours: Hours };
const HOURS_LABEL: Record<Hours, string> = {
  "1": "最近 1 小时",
  "24": "最近 24 小时",
  "168": "最近 7 天",
};
const count = (value: number) => value.toLocaleString("zh-CN");
const pad = (value: number) => String(value).padStart(2, "0");
/** 表格内的时间统一按 MM-DD HH:mm 显示，完整时间放在 title 中。 */
function stamp(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 目标由后端规范成 主机:端口，长 IPv6 用方括号包裹。 */
function targetParts(target: string) {
  const at = target.lastIndexOf(":");
  return at > 0
    ? { host: target.slice(0, at), port: target.slice(at + 1) }
    : { host: target, port: "" };
}
const userName = (row: ConnectionRow) =>
  row.user?.name || row.user?.email || `用户 #${row.user_id}`;
const nodeSourceOf = (node: Node) => (node.runtime ? "runtime" : "basic");

function readFilters(): Filters {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const hours = params.get("hours");
  return {
    user: params.get("user") ?? "",
    node: params.get("node") ?? "",
    q: params.get("q") ?? "",
    hours: hours === "1" || hours === "24" || hours === "168" ? hours : "24",
  };
}
/** 页面地址反映筛选，`#/admin/connections?user=7` 可以直接打开。 */
function filtersHash(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.user) params.set("user", filters.user);
  if (filters.node) params.set("node", filters.node);
  if (filters.q) params.set("q", filters.q);
  if (filters.hours !== "24") params.set("hours", filters.hours);
  const suffix = params.toString();
  return `#/admin/connections${suffix ? `?${suffix}` : ""}`;
}
function requestQuery(filters: Filters, offset: number) {
  const params = new URLSearchParams({
    hours: filters.hours,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (filters.user) params.set("user_id", filters.user);
  const [source, id] = filters.node.split(":");
  if (id) {
    params.set("node_source", source === "basic" ? "basic" : "runtime");
    params.set("node_id", id);
  }
  if (filters.q) params.set("q", filters.q);
  return params.toString();
}

export function ConnectionLog() {
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [text, setText] = useState(() => readFilters().q);
  const users = useResource<User[]>(`${ROOT}/users`);
  const nodes = useResource<Node[]>(`${ROOT}/nodes`);
  const path = `admin/connections?${requestQuery(filters, 0)}`;
  const page = useResource<ConnectionPage>(path);
  const [more, setMore] = useState<{
    path: string;
    rows: ConnectionRow[];
    offset: number;
  }>({ path, rows: [], offset: PAGE_SIZE });
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  // 筛选写入地址栏；直接打开带查询串的地址时，从地址栏读回筛选。
  function apply(next: Filters) {
    setFilters(next);
    const hash = filtersHash(next);
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  useEffect(() => {
    const sync = () => {
      const next = readFilters();
      setFilters(next);
      setText(next.q);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    if (text === filters.q) return;
    const timer = setTimeout(() => {
      const next = { ...filters, q: text.trim() };
      setFilters(next);
      const hash = filtersHash(next);
      if (location.hash !== hash) history.replaceState(null, "", hash);
    }, 300);
    return () => clearTimeout(timer);
  }, [text, filters]);
  const extra = more.path === path ? more.rows : [];
  const offset = more.path === path ? more.offset : PAGE_SIZE;
  const rows = [...(page.data?.rows ?? []), ...extra];
  const filtered = Boolean(filters.user || filters.node || filters.q);
  const hoursChanged = filters.hours !== "24";
  function refresh() {
    setMore({ path, rows: [], offset: PAGE_SIZE });
    setMoreError("");
    page.reload();
  }
  function clear() {
    setText("");
    apply({ user: "", node: "", q: "", hours: "24" });
  }
  async function loadMore() {
    if (moreLoading || !page.data) return;
    const controller = new AbortController();
    active.current = controller;
    setMoreLoading(true);
    setMoreError("");
    try {
      const next = await api<ConnectionPage>(
        `admin/connections?${requestQuery(filters, offset)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setMore((current) => ({
        path,
        rows: [...(current.path === path ? current.rows : []), ...next.rows],
        offset: offset + PAGE_SIZE,
      }));
    } catch (error) {
      if (!controller.signal.aborted)
        setMoreError(
          error instanceof Error ? error.message : "请稍后重试加载更多记录。",
        );
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setMoreLoading(false);
    }
  }
  return (
    <div className="section-stack">
      <PageHeader
        eyebrow="管理工作台"
        title="连接日志"
        description="查看最近 7 天用户经由节点访问的目标，同一小时内的相同连接合并为一行。"
        actions={
          <Button
            variant="secondary"
            loading={page.loading}
            onClick={refresh}
          >
            <RefreshCw size={16} aria-hidden />
            刷新
          </Button>
        }
      />
      <Card>
        <div className="card-header mb-custom-toolbar mb-custom-conn-toolbar">
          <Field label="用户">
            <Select
              value={filters.user}
              onChange={(event) =>
                apply({ ...filters, user: event.target.value })
              }
            >
              <option value="">全部用户</option>
              {users.data?.map((user) => (
                <option key={user.id} value={String(user.id)}>
                  {user.name ? `${user.name} · ${user.email}` : user.email}
                </option>
              ))}
              {filters.user &&
                !users.data?.some((user) => String(user.id) === filters.user) && (
                  <option value={filters.user}>用户 #{filters.user}</option>
                )}
            </Select>
          </Field>
          <Field label="节点">
            <Select
              value={filters.node}
              onChange={(event) =>
                apply({ ...filters, node: event.target.value })
              }
            >
              <option value="">全部节点</option>
              {nodes.data?.map((node) => {
                const source = nodeSourceOf(node);
                return (
                  <option
                    key={`${source}:${node.id}`}
                    value={`${source}:${node.id}`}
                  >
                    {node.name} · {source === "runtime" ? "运行节点" : "基础节点"}
                  </option>
                );
              })}
              {filters.node &&
                !nodes.data?.some(
                  (node) => `${nodeSourceOf(node)}:${node.id}` === filters.node,
                ) && <option value={filters.node}>节点 {filters.node}</option>}
            </Select>
          </Field>
          <Field label="时间范围">
            <Select
              value={filters.hours}
              onChange={(event) =>
                apply({ ...filters, hours: event.target.value as Hours })
              }
            >
              {(Object.keys(HOURS_LABEL) as Hours[]).map((hours) => (
                <option key={hours} value={hours}>
                  {HOURS_LABEL[hours]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="搜索">
            <Input
              type="search"
              value={text}
              placeholder="目标或来源 IP"
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <Button
            variant="secondary"
            onClick={clear}
            disabled={!filtered && !hoursChanged}
          >
            清空筛选
          </Button>
        </div>
        {page.data && (
          <div className="card-body mb-custom-meta mb-custom-conn-summary">
            {count(page.data.total)} 条记录 · {count(page.data.connections)} 次连接 ·{" "}
            {count(page.data.targets)} 个目标 · {count(page.data.sources)} 个来源 IP
          </div>
        )}
        {page.error ? (
          <ErrorState message={page.error} retry={page.reload} />
        ) : page.loading && !page.data ? (
          <Loading />
        ) : !page.data ? (
          <Loading />
        ) : page.data.rows.length === 0 ? (
          filtered || hoursChanged ? (
            <EmptyState
              title="调整筛选条件"
              description="改换用户、节点或时间范围，查看对应时段的连接记录。"
              action={
                <Button variant="secondary" onClick={clear}>
                  清空筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="等待节点上报连接"
              description="升级到 0.3.0 的节点每分钟上报一次连接记录，上报后这里会显示用户、目标和来源 IP。"
            />
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table mb-custom-conn-table">
                <thead>
                  <tr>
                    <th scope="col">最近连接</th>
                    <th scope="col">用户</th>
                    <th scope="col">节点</th>
                    <th scope="col">目标</th>
                    <th scope="col">来源 IP</th>
                    <th scope="col" className="mb-custom-conn-count">
                      次数
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const target = targetParts(row.target);
                    const first = stamp(row.first_at);
                    const last = stamp(row.last_at);
                    return (
                      <tr
                        key={`${row.source}:${row.user_id}:${row.node_id}:${row.target}:${row.source_ip}:${row.network}:${row.first_at}`}
                      >
                        <td>
                          <span className="mono" title={formatDate(row.last_at)}>
                            {last}
                          </span>
                          {first !== last && (
                            <div className="mb-custom-meta">首次 {first}</div>
                          )}
                        </td>
                        <td className="mb-custom-conn-who">
                          {row.user ? (
                            <button
                              type="button"
                              className="mb-custom-conn-link"
                              aria-label={`按${userName(row)}筛选连接日志`}
                              onClick={() =>
                                apply({ ...filters, user: String(row.user_id) })
                              }
                            >
                              {userName(row)}
                            </button>
                          ) : (
                            <span>{userName(row)}</span>
                          )}
                          {row.user?.email && (
                            <div className="mb-custom-meta">{row.user.email}</div>
                          )}
                        </td>
                        <td className="mb-custom-conn-who">
                          {row.node ? (
                            <button
                              type="button"
                              className="mb-custom-conn-link"
                              aria-label={`按${row.node.name}筛选连接日志`}
                              onClick={() =>
                                apply({
                                  ...filters,
                                  node: `${row.node!.source}:${row.node!.id}`,
                                })
                              }
                            >
                              {row.node.name}
                            </button>
                          ) : (
                            <span>节点 #{row.node_id}</span>
                          )}
                          <div className="mb-custom-meta">#{row.node_id}</div>
                        </td>
                        <td className="mono mb-custom-conn-target">
                          <span className="mb-custom-conn-host">
                            {target.host}
                          </span>
                          {target.port && (
                            <span className="mb-custom-conn-port">
                              :{target.port}
                            </span>
                          )}
                          {row.network === "udp" && (
                            <Badge tone="info" className="mb-custom-conn-net">
                              UDP
                            </Badge>
                          )}
                        </td>
                        <td>
                          <span className="mono">{row.source_ip || "—"}</span>
                        </td>
                        <td className="mb-custom-conn-count">
                          {count(row.count)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card-body mb-custom-conn-foot">
              <span className="mb-custom-meta">
                显示 {count(rows.length)} 条，共 {count(page.data.total)} 条
              </span>
              {rows.length < page.data.total && (
                <Button
                  variant="secondary"
                  size="small"
                  loading={moreLoading}
                  onClick={loadMore}
                >
                  加载更多
                </Button>
              )}
            </div>
            {moreError && (
              <div className="card-body">
                <ErrorState message={moreError} retry={loadMore} />
              </div>
            )}
          </>
        )}
      </Card>
      <div className="callout">
        <ScrollText size={18} aria-hidden />
        <div>
          <strong>连接日志保留 {page.data?.retention_days ?? 7} 天</strong>
          <p>
            日志包含访问目标和来源 IP，保留{" "}
            {page.data?.retention_days ?? 7} 天后自动清理。请按管理员权限处理这些记录。
          </p>
        </div>
      </div>
    </div>
  );
}
