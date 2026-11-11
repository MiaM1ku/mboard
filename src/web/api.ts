import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith("/api/")
    ? path
    : `/api/v1/${path.replace(/^\//, "")}`;
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  let body: { data?: T; error?: { message?: string } } = {};
  try {
    body = await response.json();
  } catch {
    throw new ApiError("请检查服务连接后重试。", response.status);
  }
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/v1/auth/"))
      window.dispatchEvent(new Event("mboard-session-expired"));
    throw new ApiError(
      body.error?.message || "请核对填写内容后重试。",
      response.status,
    );
  }
  return body.data as T;
}
export function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(undefined);
    api<T>(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "请重试加载。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, version]);
  return { data, error, loading, reload };
}
export function formatBytes(n = 0) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 5);
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: i ? 2 : 0 }).format(n / 1024 ** i)} ${units[i]}`;
}
export function formatDate(s?: string | null) {
  if (!s) return "持续有效";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? "请核验日期"
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
}
const RELATIVE_UNITS: { limit: number; step: number; label: string }[] = [
  { limit: 60, step: 60, label: "分钟" },
  { limit: 3600, step: 3600, label: "小时" },
  { limit: 7 * 86400, step: 86400, label: "天" },
];
/** 刚刚 / N 分钟前 / N 小时前 / N 天前；超过 30 天回到完整日期。 */
export function formatRelative(iso?: string | null, now = Date.now()) {
  if (!iso) return "暂无记录";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "请核验时间";
  const elapsed = Math.max(0, Math.floor((now - time) / 1000));
  if (elapsed < 60) return "刚刚";
  if (elapsed >= 30 * 86400) return formatDate(iso);
  const unit = RELATIVE_UNITS.find((item) => elapsed < item.limit) ?? RELATIVE_UNITS[2]!;
  return `${Math.floor(elapsed / unit.step)} ${unit.label}前`;
}
export function subscriptionUrl(user: {
  subscription_token: string;
  subscription_url?: string;
}) {
  if (user.subscription_url) {
    try {
      const value = new URL(user.subscription_url);
      if (
        ["http:", "https:"].includes(value.protocol) &&
        !value.username &&
        !value.password
      )
        return value.href;
    } catch {
      /* Fall through to same-origin development links. */
    }
  }
  return new URL(
    `/s/${encodeURIComponent(user.subscription_token)}`,
    window.location.origin,
  ).href;
}
export const jsonBody = (value: unknown) => JSON.stringify(value);
