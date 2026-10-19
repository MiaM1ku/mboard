import { useId, useLayoutEffect, useRef, useState } from "react";
import type { TrafficPoint } from "./types";
import { formatBytes } from "./api";
import { Card, EmptyState } from "./ui";

export function TrafficChart({
  data,
  title = "流量趋势",
  description = "按 UTC 日期统计上传和下载 · 字节累计",
}: {
  data: TrafficPoint[];
  title?: string;
  description?: string;
}) {
  const id = useId().replace(/:/g, "");
  const seriesKey = JSON.stringify(
    data.map(({ date, upload_bytes, download_bytes }) => [
      date,
      upload_bytes,
      download_bytes,
    ]),
  );
  const svgRef = useRef<SVGSVGElement>(null);
  const [w, setWidth] = useState(840);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () =>
      setWidth(Math.max(240, Math.round(svg.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [Boolean(data.length)]);
  const max = Math.max(
    ...data.map((x) => x.upload_bytes + x.download_bytes),
    1,
  );
  const h = 210,
    left = 84,
    top = 18,
    bottom = 32;
  const chartW = w - left - 18,
    chartH = h - top - bottom;
  const first = data.length ? Date.parse(data[0].date) : 0;
  const last = data.length ? Date.parse(data[data.length - 1].date) : 0;
  const xAt = (i: number) =>
    left +
    (data.length === 1
      ? chartW / 2
      : ((Date.parse(data[i].date) - first) / Math.max(1, last - first)) *
        chartW);
  const point = (n: number, i: number) =>
    `${xAt(i)},${top + chartH - (n / max) * chartH}`;
  const totalPoints = data
    .map((x, i) => point(x.upload_bytes + x.download_bytes, i))
    .join(" ");
  const uploadPoints = data.map((x, i) => point(x.upload_bytes, i)).join(" ");
  const area = `${left},${top + chartH} ${totalPoints} ${left + chartW},${top + chartH}`;
  return (
    <Card className="traffic-card">
      <div className="card-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="chart-legend">
          <span>
            <i className="legend-download" />
            总流量
          </span>
          <span>
            <i className="legend-upload" />
            上传
          </span>
        </div>
      </div>
      {data.length ? (
        <>
          <div className="traffic-chart">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${w} ${h}`}
              role="img"
              aria-label={`${title}，详细数值见下方每日数据`}
            >
              <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--info)" stopOpacity=".16" />
                  <stop offset="100%" stopColor="var(--info)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line
                    x1={left}
                    y1={top + chartH - f * chartH}
                    x2={w - 18}
                    y2={top + chartH - f * chartH}
                    stroke="var(--border)"
                    strokeDasharray="3 5"
                  />
                  <text
                    x={left - 10}
                    y={top + chartH - f * chartH + 4}
                    textAnchor="end"
                    fill="var(--muted-foreground)"
                    fontSize="12"
                  >
                    {formatBytes(max * f)}
                  </text>
                </g>
              ))}
              <g
                key={seriesKey}
                className="mb-custom-chart-series"
                data-motion-points={data.length}
              >
                {data.length > 1 && (
                  <>
                    <polygon
                      className="mb-custom-chart-area"
                      points={area}
                      fill={`url(#${id})`}
                    />
                    <polyline
                      className="mb-custom-chart-line"
                      pathLength={1}
                      points={totalPoints}
                      fill="none"
                      stroke="var(--info)"
                      strokeWidth="2.5"
                      strokeLinejoin="round"
                    />
                    <polyline
                      className="mb-custom-chart-line"
                      pathLength={1}
                      points={uploadPoints}
                      fill="none"
                      stroke="var(--primary)"
                      strokeWidth="2.5"
                      strokeLinejoin="round"
                    />
                  </>
                )}
                {data.length === 1 && (
                  <>
                    <circle
                      className="mb-custom-chart-point"
                      cx={left + chartW / 2}
                      cy={
                        top +
                        chartH -
                        ((data[0].upload_bytes + data[0].download_bytes) / max) *
                          chartH
                      }
                      r={4}
                      fill="var(--info)"
                    />
                    <circle
                      className="mb-custom-chart-point"
                      cx={left + chartW / 2}
                      cy={top + chartH - (data[0].upload_bytes / max) * chartH}
                      r={4}
                      fill="var(--primary)"
                    />
                  </>
                )}
              </g>
              {data
                .filter(
                  (_, i) =>
                    i === 0 ||
                    i === data.length - 1 ||
                    i === Math.floor(data.length / 2),
                )
                .map((x) => (
                  <text
                    key={x.date}
                    x={xAt(data.indexOf(x))}
                    y={h - 8}
                    textAnchor={
                      data.length === 1
                        ? "middle"
                        : data.indexOf(x) === 0
                          ? "start"
                          : data.indexOf(x) === data.length - 1
                            ? "end"
                            : "middle"
                    }
                    fill="var(--muted-foreground)"
                    fontSize="12"
                  >
                    {x.date.slice(5)}
                  </text>
                ))}
            </svg>
          </div>
          <details className="chart-details">
            <summary>查看每日数据</summary>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>上传</th>
                    <th>下载</th>
                    <th>总计</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((x) => (
                    <tr key={x.date}>
                      <td>{x.date}</td>
                      <td>{formatBytes(x.upload_bytes)}</td>
                      <td>{formatBytes(x.download_bytes)}</td>
                      <td>{formatBytes(x.upload_bytes + x.download_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <EmptyState
          title="等待首条流量记录"
          description="节点上报流量后，这里会显示每日用量。"
        />
      )}
    </Card>
  );
}
