import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatDate } from "./api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  Select,
  Textarea,
  useToast,
} from "./ui";

// Keep the transport contract local so backend source values can evolve independently.
export type SubscriptionTemplate = {
  id: number;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
  source: string;
};
type Validation = {
  valid: boolean;
  errors: { message: string; line?: number; column?: number }[];
  warnings: string[];
};
type Preview = {
  template_name: string;
  content_type: string;
  content: string;
  node_count: number;
  warnings: string[];
};
type Feedback =
  | { kind: "validation"; result: Validation }
  | { kind: "preview"; result: Preview }
  | { kind: "saved" };
type Action = "save" | "validate" | "preview";

const ROOT = "/api/v1/admin/subscription/templates";
const MAX_BYTES = 512 * 1024;
const FORMATS = [
  { name: "singbox", label: "sing-box" },
  { name: "clash", label: "Clash" },
  { name: "clashmeta", label: "Clash Meta" },
  { name: "stash", label: "Stash" },
  { name: "surge", label: "Surge" },
  { name: "surfboard", label: "Surfboard" },
] as const;
const sourceLabel = (source: string) => {
  if (source === "legacy" || source === "imported") return "从旧模板恢复";
  if (source === "builtin") return "内置默认模板";
  if (source === "saved") return "已保存的模板";
  return "站点模板";
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作遇到问题，请重试。";
const sendContent = (method: string, content: string, signal: AbortSignal) => ({
  method,
  signal,
  body: JSON.stringify({ content }),
});
function isTemplate(value: unknown): value is SubscriptionTemplate {
  if (!value || typeof value !== "object") return false;
  const item = value as SubscriptionTemplate;
  return (
    typeof item.id === "number" &&
    typeof item.name === "string" &&
    typeof item.content === "string" &&
    typeof item.source === "string" &&
    typeof item.created_at === "string" &&
    typeof item.updated_at === "string"
  );
}
function isValidation(value: unknown): value is Validation {
  if (!value || typeof value !== "object") return false;
  const result = value as Validation;
  return (
    typeof result.valid === "boolean" &&
    Array.isArray(result.errors) &&
    result.errors.every((error) => error && typeof error.message === "string") &&
    Array.isArray(result.warnings) &&
    result.warnings.every((warning) => typeof warning === "string")
  );
}
function isPreview(value: unknown): value is Preview {
  if (!value || typeof value !== "object") return false;
  const result = value as Preview;
  return (
    typeof result.template_name === "string" &&
    typeof result.content_type === "string" &&
    typeof result.content === "string" &&
    Number.isInteger(result.node_count) &&
    result.node_count >= 0 &&
    Array.isArray(result.warnings) &&
    result.warnings.every((warning) => typeof warning === "string")
  );
}
function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="callout" role="status">
      <div>
        <strong>模板提示</strong>
        <ul className="notice-body">
          {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
        </ul>
      </div>
    </div>
  );
}

/** Embedded under SettingsPage's h1; this section deliberately starts at h2. */
export function SubscriptionTemplates({ onSaved }: { onSaved?: () => void }) {
  const { notify } = useToast();
  const [templates, setTemplates] = useState<SubscriptionTemplate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string>("singbox");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const templatesRef = useRef(templates);
  const actionController = useRef<AbortController | null>(null);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  templatesRef.current = templates;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    api<unknown>(ROOT, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(value) || !value.every(isTemplate)) {
          throw new Error("模板数据读取遇到问题，请重新加载。");
        }
        const previous = templatesRef.current;
        // A refresh adopts DB content for clean editors and keeps every changed draft.
        setDrafts((current) => {
          const next = { ...current };
          for (const item of value) {
            const baseline = previous.find((old) => old.name === item.name);
            if (current[item.name] === undefined || current[item.name] === baseline?.content) {
              next[item.name] = item.content;
            }
          }
          return next;
        });
        setTemplates(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [version]);
  useEffect(() => () => actionController.current?.abort(), []);

  const current = templates.find((item) => item.name === selected);
  const content = drafts[selected] ?? current?.content ?? "";
  const dirty = !!current && content !== current.content;
  const dirtyCount = templates.filter((item) =>
    drafts[item.name] !== undefined && drafts[item.name] !== item.content,
  ).length;
  const contentBytes = new TextEncoder().encode(content).byteLength;
  const overLimit = contentBytes > MAX_BYTES;
  const locked = loading || busy !== null;
  useEffect(() => {
    if (!dirtyCount) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirtyCount]);

  function select(name: string) {
    if (locked || name === selected) return;
    if (dirty) {
      setSwitchTo(name);
      return;
    }
    setSelected(name);
    setActionError("");
    setFeedback(null);
  }
  async function run(action: Action) {
    if (locked || actionController.current || !current || overLimit || (action === "save" && !dirty)) return;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(action);
    setActionError("");
    setFeedback(null);
    const endpoint = `${ROOT}/${encodeURIComponent(selected)}`;
    try {
      if (action === "validate" || action === "save") {
        const result = await api<unknown>(
          `${endpoint}/validate`,
          sendContent("POST", content, controller.signal),
        );
        if (!isValidation(result)) throw new Error("校验结果读取遇到问题，请重新校验。");
        if (controller.signal.aborted) return;
        setFeedback({ kind: "validation", result });
        if (action === "validate" || !result.valid || result.errors.length > 0) return;
        const saved = await api<unknown>(endpoint, sendContent("PUT", content, controller.signal));
        if (controller.signal.aborted) return;
        if (!isTemplate(saved) || saved.name !== selected) {
          throw new Error("保存结果读取遇到问题，请刷新模板核对保存内容。");
        }
        setTemplates((items) => items.map((item) => item.name === saved.name ? saved : item));
        setDrafts((items) => ({ ...items, [saved.name]: saved.content }));
        setFeedback({ kind: "saved" });
        notify("订阅模板已保存，后续订阅更新使用保存的模板", "success");
        onSaved?.();
      } else {
        const result = await api<unknown>(
          `${endpoint}/preview`,
          sendContent("POST", content, controller.signal),
        );
        if (controller.signal.aborted) return;
        if (!isPreview(result) || result.template_name !== selected) {
          throw new Error("预览结果读取遇到问题，请重新生成预览。");
        }
        setFeedback({ kind: "preview", result });
      }
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorText(error));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
      if (actionController.current === controller) actionController.current = null;
    }
  }

  return (
    <Card>
      <div className="card-header mb-custom-toolbar">
        <div>
          <h2>站点设置 → 订阅模板</h2>
          <p className="mb-custom-meta">编辑客户端订阅格式，校验后保存，用示例节点查看输出。</p>
        </div>
        <Button variant="secondary" size="small" disabled={locked} onClick={() => {
          setActionError("");
          setFeedback(null);
          reload();
        }}>刷新模板</Button>
      </div>
      <div className="card-body mb-custom-section-stack" aria-busy={locked}>
        {loadError && <ErrorState message={loadError} retry={reload} />}
        {loading && <Loading />}
        <Field label="客户端格式" hint="每种格式单独保存。切换格式后可继续编辑各自的草稿。">
          <Select value={selected} disabled={locked} onChange={(event) => select(event.target.value)}>
            {FORMATS.map((format) => {
              const item = templates.find((template) => template.name === format.name);
              const changed = !!item && drafts[item.name] !== undefined && drafts[item.name] !== item.content;
              return <option key={format.name} value={format.name}>
                {format.label}{format.name === "singbox" && item?.source === "builtin" ? " · 默认模板" : ""}{changed ? " · 草稿待保存" : ""}
              </option>;
            })}
          </Select>
        </Field>
        {current ? <>
          <div className="mb-custom-actions">
            <Badge tone={dirty ? "warning" : "neutral"}>{dirty ? "草稿待保存" : "内容已同步"}</Badge>
            <span className="mb-custom-meta">{sourceLabel(current.source)}</span>
            <span className="mb-custom-meta">更新时间：{formatDate(current.updated_at)}</span>
          </div>
          <Field label={`${FORMATS.find((format) => format.name === selected)?.label ?? selected} 模板内容`}
            hint={`支持最多 ${MAX_BYTES.toLocaleString("zh-CN")} 个 UTF-8 字节（512 KB）。保留模板中的空格、换行和占位符，先校验再保存。`}>
            <Textarea className="mono" rows={18} spellCheck={false} autoCapitalize="off" autoCorrect="off"
              maxLength={MAX_BYTES} value={content} disabled={locked} onChange={(event) => {
                setDrafts((items) => ({ ...items, [selected]: event.target.value }));
                setFeedback(null);
                setActionError("");
              }} />
          </Field>
          <p className="mb-custom-meta" aria-live="polite">{contentBytes.toLocaleString("zh-CN")} / {MAX_BYTES.toLocaleString("zh-CN")} 个 UTF-8 字节{dirtyCount > 0 ? ` · ${dirtyCount} 份草稿待保存` : ""}</p>
          {overLimit && <ErrorState message="模板内容超过 512 KB，请精简内容后校验和保存。中文等字符会占用多个 UTF-8 字节。" />}
          {actionError && <ErrorState message={actionError} />}
          <div className="mb-custom-actions">
            <Button loading={busy === "save"} disabled={locked || !dirty || overLimit} onClick={() => void run("save")}>{busy === "save" ? "正在校验并保存" : "保存模板"}</Button>
            <Button variant="secondary" loading={busy === "validate"} disabled={locked || overLimit} onClick={() => void run("validate")}>校验模板</Button>
            <Button variant="secondary" loading={busy === "preview"} disabled={locked || overLimit} onClick={() => void run("preview")}>生成预览</Button>
          </div>
          <p className="field-hint">保存后，后续订阅更新使用保存的模板。示例节点预览使用演示凭据。</p>
          {feedback?.kind === "saved" && <p className="text-success" role="status">模板已保存。后续订阅更新使用保存的模板。</p>}
          {feedback?.kind === "validation" && <div className="mb-custom-section-stack" aria-live="polite">
            {feedback.result.valid && feedback.result.errors.length === 0
              ? <p className="text-success" role="status">校验通过，可以保存模板或生成预览。</p>
              : <div className="error-state" role="alert"><div>
                <strong>请按校验提示调整模板，再次校验。</strong>
                <ul>{feedback.result.errors.map((error, index) => <li key={index}>
                  {typeof error.line === "number" ? `第 ${error.line} 行` : ""}{typeof error.column === "number" ? `，第 ${error.column} 列` : ""}{typeof error.line === "number" || typeof error.column === "number" ? "：" : ""}{error.message}
                </li>)}</ul>
              </div></div>}
            <Warnings warnings={feedback.result.warnings} />
          </div>}
          {feedback?.kind === "preview" && <div className="mb-custom-section-stack">
            <Field label="示例节点预览" hint={`包含 ${feedback.result.node_count.toLocaleString("zh-CN")} 个示例节点 · ${feedback.result.content_type} · 使用演示凭据。`}>
              <Textarea className="mono" rows={16} readOnly spellCheck={false} value={feedback.result.content} />
            </Field>
            <Warnings warnings={feedback.result.warnings} />
          </div>}
        </> : !loading && !loadError && <EmptyState title="加载对应格式的模板" description="点击刷新模板，获取站点保存的内容和内置默认模板。" action={<Button variant="secondary" onClick={reload}>刷新模板</Button>} />}
      </div>
      <Modal open={switchTo !== null} onClose={() => setSwitchTo(null)} title="保留草稿并切换格式"
        description="这份草稿会留在本页。切回此格式后可继续编辑和保存，离开页面前请保存需要的草稿。"
        footer={<>
          <Button variant="secondary" onClick={() => setSwitchTo(null)}>继续编辑</Button>
          <Button onClick={() => {
            if (switchTo) setSelected(switchTo);
            setSwitchTo(null);
            setFeedback(null);
            setActionError("");
          }}>保留草稿并切换</Button>
        </>}>
        <p>切换后，各格式的草稿分别保留，保存只更新选中的模板。</p>
      </Modal>
    </Card>
  );
}
