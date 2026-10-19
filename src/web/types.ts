export interface User {
  id: number;
  email: string;
  name: string;
  role: "admin" | "user";
  enabled: boolean;
  created_at: string;
  upload_bytes: number;
  download_bytes: number;
  quota_bytes: number;
  expires_at: string | null;
  subscription_token: string;
  subscription_url?: string;
  group_ids?: number[];
}
export interface Group {
  id: number;
  name: string;
}
export interface Node {
  id: number;
  name: string;
  host: string;
  port: number;
  protocol: "vless" | "trojan" | "shadowsocks";
  enabled: boolean;
  machine_id: number | null;
  group_ids: number[];
  tls: boolean;
  server_name: string;
  entry_ips?: string[];
  entry_strategy?: string;
  online: boolean;
  created_at: string;
  runtime?: boolean;
  parent_id?: number | null;
  show?: boolean;
  server_port?: number;
  machine_ids?: number[];
  state?: string;
}
export interface Machine {
  id: number;
  name: string;
  host: string;
  enabled: boolean;
  last_seen_at: string | null;
  version: string | null;
  online: boolean;
  config_revision: number;
}
export interface TrafficPoint {
  date: string;
  upload_bytes: number;
  download_bytes: number;
}
export interface Notice {
  id: number;
  title: string;
  body: string;
  created_at: string;
}
export interface Guide extends Notice {
  category: string;
}
export interface Message {
  id: number;
  body: string;
  author_role: "admin" | "user";
  created_at: string;
}
export interface Ticket {
  id: number;
  subject: string;
  status: "open" | "closed";
  user_id: number;
  user_name: string;
  created_at: string;
  messages: Message[];
}
export type PoolKind = "entry" | "exit" | "node";
export type PoolStatus = "ok" | "warning" | "exceeded";
export interface PoolUsage {
  used_bytes: number;
  quota_bytes: number;
  remaining_bytes: number;
  percent: number;
  upload_bytes: number;
  download_bytes: number;
  cycle_start: string;
  cycle_end: string;
  days_left: number;
  projected_bytes: number | null;
  calibrated: boolean;
  status: PoolStatus;
  warnings: { code: string; message: string }[];
}
export interface TrafficPool {
  id: number;
  name: string;
  kind: PoolKind;
  quota_bytes: number;
  reset_day: number;
  billing: "single" | "double";
  visible_to_users: boolean;
  note: string;
  sort: number;
  calibration_bytes: number | null;
  calibrated_at: number | null;
  created_at: string;
  members: { type: "node" | "machine"; id: number; name: string }[];
  usage: PoolUsage;
}
export interface UserPoolStatus {
  id: number;
  name: string;
  kind: PoolKind;
  remaining_percent: number;
  status: PoolStatus;
  cycle_end: string;
  days_left: number;
}
export interface NodeUsage {
  id: number;
  name: string;
  upload_bytes: number;
  download_bytes: number;
  total_bytes: number;
  last_used_date: string | null;
  available: boolean;
  pool_names: string[];
  share: number;
}
export interface NodeTraffic {
  id: number;
  name: string;
  parent_name: string | null;
  machine_names: string[];
  online: boolean;
  users: number;
  upload_bytes: number;
  download_bytes: number;
}
export interface UserTraffic {
  id: number;
  name: string;
  email: string;
  bytes: number;
  quota_bytes: number;
  total_bytes: number;
}
export interface OverviewTopNode {
  id: number;
  name: string;
  bytes: number;
  share: number;
}
export interface AdminOverview {
  users: number;
  enabled_users: number;
  nodes: number;
  online_nodes: number;
  machines: number;
  online_machines: number;
  upload_bytes: number;
  download_bytes: number;
  traffic: TrafficPoint[];
  recent_machines: Machine[];
  days: number;
  range: { start: string; end: string };
  today: { upload_bytes: number; download_bytes: number };
  month: { upload_bytes: number; download_bytes: number };
  active_users: number;
  pools: TrafficPool[];
  top_nodes: NodeTraffic[];
  top_users: UserTraffic[];
  attention_machines: Machine[];
}
export interface Overview {
  user: User;
  nodes: Node[];
  traffic: TrafficPoint[];
  notices: Notice[];
  today_bytes: { upload_bytes: number; download_bytes: number };
  week_bytes: { upload_bytes: number; download_bytes: number };
  month_bytes: { upload_bytes: number; download_bytes: number };
  top_nodes: OverviewTopNode[];
  pools: UserPoolStatus[];
}
