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
  online: boolean;
  created_at: string;
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
}
export interface Overview {
  user: User;
  nodes: Node[];
  traffic: TrafficPoint[];
  notices: Notice[];
}
