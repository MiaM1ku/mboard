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
export const jsonBody = (value: unknown) => JSON.stringify(value);
