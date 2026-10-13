import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, formatDate, useResource } from "./api";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, Modal, Select, Textarea, useToast } from "./ui";

const ROOT = "/api/v1/admin/traffic-reports";
type Period = "daily" | "weekly" | "monthly";
type Kind = Period | "test";
type Settings = {
  enabled: boolean; webhook_configured: boolean; url_display: string | null;
  authorization_configured: boolean; top_limit: number; timezone: string;
  schedule: { daily: string; weekly: string; monthly: string }; revision: number;
};
type Job = {
  id: string; kind: Kind; status: "queued" | "processing" | "sent" | "failed" | "cancelled";
  period_key: string; start_date: string; end_date: string; timezone: string; attempts: number;
  http_status: number | null; next_attempt_at: number; created_at: number; error_code: string | null;
};
type Preview = {
  kind: Period; title: string; start_date: string; end_date: string; timezone: string;
  message: string; nodes: { label: string; bytes: string }[];
  users: { label: string; bytes: string; topNode?: { label: string; bytes: string } }[]; warnings: string[];
};
const kinds: Record<Kind, string> = { daily: "日报", weekly: "周报", monthly: "月报", test: "测试消息" };
const statuses: Record<Job["status"], { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  queued: { label: "排队中", tone: "info" }, processing: { label: "发送中", tone: "info" },
  sent: { label: "已发送", tone: "success" }, failed: { label: "发送失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};
const errorLabels: Record<string, string> = {
  INVALID_CONFIG: "请检查公网 HTTPS 地址、认证头和排行数量后保存。",
  DNS_FAILED: "请检查 Webhook 域名解析后重试。", PRIVATE_ADDRESS: "请填写可从公网访问的 HTTPS 接收地址。",
  TIMEOUT: "接收端响应超时，请检查服务后刷新发送记录。", NETWORK_ERROR: "连接遇到问题，请检查接收端后刷新发送记录。",
  HTTP_ERROR: "接收端返回错误，请检查 HTTP 状态和授权配置。", RESPONSE_TOO_LARGE: "接收端响应过大，请调整接收端后重试。",
};
const warningLabels: Record<string, string> = {
  "legacy-profile-total-exceeds-physical-total": "旧记录的出口总量大于对应节点总量，节点流量按零计入。",
  "missing-history-boundary_warning": "这个周期跨越统计升级时间，报告按各阶段的记录口径汇总。",
  "pre-hook-utc-daily-unallocated": "升级前的用量按同名日期整日计入。",
  "pre-upgrade-profiles-merged-into-entry-node": "升级前的出口流量保留在节点总量里，升级后开始按出口记录。",
  "intersecting-utc-day-included-whole": "升级前的 UTC 日期按同名上海日期整日计入。",
  "utc-day-attributed-to-same-calendar-label": "升级前的用量按同名日期整日计入，每个日期记录一次。",
  "sources:legacy-shanghai-daily,pre-hook-utc-daily,post-hook-epoch-hourly": "旧记录按上海自然日汇总，接入前记录按 UTC 整日汇总，接入后记录按小时汇总。",
};
const warningText = (code: string) => warningLabels[code] ?? (/^baseline_rows:users=\d+,node_users=\d+$/.test(code) ? "报告包含升级前的用户和节点流量记录。" : "历史记录按报告注明的统计口径汇总。");
const mutationError = (error: unknown, fallback: string) => error instanceof ApiError && errorLabels[error.message] ? errorLabels[error.message] : fallback;
const jobTime = (value: number) => formatDate(new Date(value).toISOString());
const request = (method: string, body: unknown, signal: AbortSignal): RequestInit => ({ method, body: JSON.stringify(body), signal });

export function TrafficReports({ onSaved }: { onSaved?: () => void | Promise<void> }) {
  const settings = useResource<Settings>(`${ROOT}/settings`);
  const runs = useResource<Job[]>(`${ROOT}/runs`);
  const { notify } = useToast();
  const [safe, setSafe] = useState<Settings>();
  const [enabled, setEnabled] = useState(false);
  const [topLimit, setTopLimit] = useState(5);
  const [webhook, setWebhook] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [clearWebhook, setClearWebhook] = useState(false);
  const [clearAuthorization, setClearAuthorization] = useState(false);
  const [kind, setKind] = useState<Period>("daily");
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState<"save" | "preview" | "send" | null>(null);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<Kind | null>(null);
  const attempts = useRef<Partial<Record<Kind, string>>>({});
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function apply(value: Settings) {
    setSafe(value); setEnabled(value.enabled); setTopLimit(value.top_limit);
    setWebhook(""); setAuthorization(""); setClearWebhook(false); setClearAuthorization(false);
    setPreview(undefined);
  }
  useEffect(() => { if (settings.data) apply(settings.data); }, [settings.data]);
  const changed = Boolean(safe && (enabled !== safe.enabled || topLimit !== safe.top_limit || webhook.trim() || authorization.trim() || clearWebhook || clearAuthorization));
  const locked = Boolean(busy || settings.loading || settings.error);
  const ready = Boolean(safe?.webhook_configured && !changed && !locked);
  function begin(stage: "save" | "preview" | "send") {
    const controller = new AbortController(); active.current = controller;
    setBusy(stage); setError(""); return controller;
  }
  function finish(controller: AbortController) {
    if (!controller.signal.aborted) setBusy(null);
    if (active.current === controller) active.current = null;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (locked || active.current || !changed) return;
    const controller = begin("save");
    try {
      const result = await api<Settings>(`${ROOT}/settings`, request("PATCH", {
        enabled, top_limit: topLimit,
        ...(clearWebhook ? { webhook_url: null } : webhook.trim() ? { webhook_url: webhook.trim() } : {}),
        ...(clearAuthorization ? { authorization_header: "" } : authorization.trim() ? { authorization_header: authorization.trim() } : {}),
      }, controller.signal));
      if (controller.signal.aborted) return;
      apply(result); notify("流量 Webhook 设置已保存"); void onSaved?.();
    } catch (error) {
      if (!controller.signal.aborted) setError(mutationError(error, "保存遇到问题，请检查配置后重试。凭据留空会保留原值。"));
    } finally { finish(controller); }
  }
  async function loadPreview() {
    if (locked || active.current || changed) return;
    const controller = begin("preview");
    setPreview(undefined);
    try {
      const result = await api<Preview>(`${ROOT}/preview`, request("POST", { kind }, controller.signal));
      if (!controller.signal.aborted) setPreview(result);
    } catch (error) {
      if (!controller.signal.aborted) setError(mutationError(error, "预览遇到问题，请重新生成报告预览。"));
    } finally { finish(controller); }
  }
  async function send() {
    if (!confirmation || active.current || !ready) return;
    const selected = confirmation;
    const controller = begin("send");
    const key = attempts.current[selected] ?? crypto.randomUUID();
    attempts.current[selected] = key;
    try {
      const job = await api<Job>(`${ROOT}/send`, request("POST", { kind: selected, idempotency_key: key }, controller.signal));
      if (controller.signal.aborted) return;
      delete attempts.current[selected]; setConfirmation(null); runs.reload();
      notify(job.status === "sent" ? "消息已发送" : job.status === "failed" ? "发送失败，请查看发送记录" : job.status === "cancelled" ? "任务已取消，请查看发送记录" : "已加入发送队列", job.status === "failed" || job.status === "cancelled" ? "danger" : "success");
    } catch (error) {
      if (!controller.signal.aborted) setError(mutationError(error, "请求遇到问题，可重试同一次发送。系统会复用请求标识。"));
    } finally { finish(controller); }
  }
  const openConfirmation = (selected: Kind) => { setError(""); setConfirmation(selected); };
  return (
    <div className="section-stack">
      <Card>
        <div className="card-header">
          <div><h2>流量 Webhook</h2><p>按上海时间发送每日、每周和每月节点、出口及用户排行。</p></div>
          {safe && <Badge tone={safe.enabled ? "success" : "neutral"}>{safe.enabled ? "定时发送启用" : "定时发送暂停"}</Badge>}
        </div>
        <div className="card-body">
          {settings.loading && !safe ? <Loading /> : settings.error ? <ErrorState message={settings.error} retry={settings.reload} /> : safe && (
            <form className="form-stack" onSubmit={save}>
              <fieldset className="mb-custom-fieldset" disabled={locked}>
                <div className="form-stack">
                  <label className="mb-custom-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>启用定时发送</span></label>
                  <div className="form-grid">
                    <Field label="排行数量" hint="节点、出口和用户各显示前几名。"><Input type="number" required min={1} max={100} value={topLimit} onChange={event => setTopLimit(Number(event.target.value))} /></Field>
                    <div className="info-list"><div className="info-row"><span>发送时间 · 上海</span><span>每日 00:00<br />每周日 00:00<br />每月 1 日 00:00</span></div></div>
                    <div className="form-stack">
                      <Field label="Webhook 地址" hint={safe.webhook_configured ? `已配置：${safe.url_display ?? "接收端"}。留空保留原地址。` : "填写公网 HTTPS 的 Koishi Webhook 地址，消息正文为 {message}。"}>
                        <Input type="url" autoComplete="off" spellCheck={false} value={webhook} disabled={clearWebhook} placeholder="https://" onChange={event => setWebhook(event.target.value)} />
                      </Field>
                      <label className="mb-custom-checkbox"><input type="checkbox" checked={clearWebhook} onChange={event => setClearWebhook(event.target.checked)} /><span>清除 Webhook 地址</span></label>
                    </div>
                    <div className="form-stack">
                      <Field label="Authorization 请求头" hint={safe.authorization_configured ? "已配置。留空保留原请求头。" : "按接收端要求填写完整的 Authorization 值。"}>
                        <Input type="password" autoComplete="off" spellCheck={false} value={authorization} disabled={clearAuthorization} onChange={event => setAuthorization(event.target.value)} />
                      </Field>
                      <label className="mb-custom-checkbox"><input type="checkbox" checked={clearAuthorization} onChange={event => setClearAuthorization(event.target.checked)} /><span>清除 Authorization 请求头</span></label>
                    </div>
                  </div>
                </div>
              </fieldset>
              <p className="muted">保存启用状态后，定时任务会在下一个报告时间运行。保存变更会取消原配置下待发送的任务。</p>
              {error && !confirmation && <ErrorState message={error} />}
              <div className="mb-custom-actions">
                <Button type="submit" loading={busy === "save"} disabled={locked || !changed}>保存 Webhook 设置</Button>
                <Button variant="secondary" disabled={locked || !changed} onClick={() => { apply(safe); setError(""); }}>重置更改</Button>
                <Button variant="secondary" disabled={!ready} onClick={() => openConfirmation("test")}>发送测试消息</Button>
              </div>
            </form>
          )}
        </div>
      </Card>
      <Card>
        <div className="card-header"><div><h2>报告预览</h2><p>查看最近一个完整周期。发送时会按最新统计生成报告。</p></div></div>
        <div className="card-body form-stack">
          <div className="form-grid">
            <Field label="报告周期"><Select value={kind} disabled={locked} onChange={event => { setKind(event.target.value as Period); setPreview(undefined); }}><option value="daily">日报</option><option value="weekly">周报</option><option value="monthly">月报</option></Select></Field>
            <div className="mb-custom-actions"><Button variant="secondary" loading={busy === "preview"} disabled={locked || changed || !safe} onClick={loadPreview}>生成预览</Button><Button variant="secondary" disabled={!ready} onClick={() => openConfirmation(kind)}>发送{kinds[kind]}</Button></div>
          </div>
          {changed && <p className="muted">保存配置后，可以生成预览和发送消息。</p>}
          {preview ? <>
            <div className="info-list"><div className="info-row"><span>{kinds[preview.kind]}</span><span>{preview.start_date} 至 {preview.end_date} · 上海时间</span></div></div>
            {preview.warnings?.map((warning, index) => <div className="callout" key={index}>{warningText(warning)}</div>)}
            <Field label="报告预览" hint="预览包含用户身份和流量排行，请按管理员权限处理。"><Textarea readOnly rows={16} value={preview.message} /></Field>
          </> : <EmptyState title="查看完整周期的报告" description="选择日报、周报或月报，点击生成预览查看节点、出口和用户排行。" />}
        </div>
      </Card>
      <Card>
        <div className="card-header"><div><h2>发送记录</h2><p>按任务状态查看发送结果和重试时间。</p></div><Button variant="secondary" size="small" disabled={runs.loading || Boolean(busy)} onClick={runs.reload}>刷新记录</Button></div>
        {runs.loading ? <Loading /> : runs.error ? <ErrorState message={runs.error} retry={runs.reload} /> : runs.data?.length ? (
          <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">报告</th><th scope="col">状态</th><th scope="col">统计周期</th><th scope="col">尝试次数</th><th scope="col">HTTP 状态</th><th scope="col">下次重试</th><th scope="col">创建时间</th></tr></thead><tbody>
            {runs.data.map(job => <tr key={job.id}><td>{kinds[job.kind] ?? "流量报告"}</td><td><div className="table-primary"><Badge tone={statuses[job.status]?.tone ?? "neutral"}>{statuses[job.status]?.label ?? "待更新"}</Badge>{job.error_code && <span>{errorLabels[job.error_code] ?? "请检查接收端后重试。"}</span>}</div></td><td>{job.kind === "test" ? "测试消息" : `${job.start_date} 至 ${job.end_date}`}</td><td>{job.attempts}</td><td>{job.http_status ?? "—"}</td><td>{job.status === "queued" && job.attempts > 0 ? jobTime(job.next_attempt_at) : "—"}</td><td>{jobTime(job.created_at)}</td></tr>)}
          </tbody></table></div>
        ) : <EmptyState title="发送结果会记录在这里" description="保存 Webhook 地址后，可以发送测试消息来检查接收端。" action={<Button variant="secondary" disabled={!ready} onClick={() => openConfirmation("test")}>发送测试消息</Button>} />}
      </Card>
      <Modal open={confirmation !== null} onClose={() => { if (busy !== "send") { setConfirmation(null); setError(""); } }} title={confirmation === "test" ? "发送测试消息" : `发送${confirmation ? kinds[confirmation] : "报告"}`} description={confirmation === "test" ? "测试消息会发往已保存的 Webhook 地址。" : "报告会发往已保存的外部 Webhook，包含用户邮箱、身份和流量排行。"} footer={<><Button variant="secondary" disabled={busy === "send"} onClick={() => { setConfirmation(null); setError(""); }}>取消</Button><Button loading={busy === "send"} disabled={!ready} onClick={send}>确认发送</Button></>}>
        <div className="form-stack"><p>{confirmation === "test" ? "接收端会收到一条固定测试消息，用于确认消息格式和授权配置。" : "确认接收端有权读取这些用户身份和流量数据。"}</p><p>队列会按至少一次投递方式重试，接收端可能收到重复消息。</p>{error && <ErrorState message={error} />}</div>
      </Modal>
    </div>
  );
}
