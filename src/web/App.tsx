import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FileText,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  Moon,
  Network,
  Settings2,
  ShieldCheck,
  Sun,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import { api, useResource } from "./api";
import type { User } from "./types";
import {
  Button,
  ErrorState,
  Field,
  Input,
  Loading,
  ToastProvider,
  useToast,
} from "./ui";
import { UserPage } from "./UserPages";
import { AdminPage } from "./AdminPages";

const userNav = [
  { key: "overview", label: "连接概览", icon: LayoutDashboard },
  { key: "nodes", label: "连接入口", icon: Network },
  { key: "traffic", label: "流量记录", icon: Activity },
  { key: "guides", label: "使用指南", icon: BookOpen },
  { key: "tickets", label: "联系管理员", icon: LifeBuoy },
  { key: "account", label: "账号设置", icon: Settings2 },
];
const adminNav = [
  { key: "overview", label: "运行概览", icon: LayoutDashboard },
  { key: "nodes", label: "节点管理", icon: Network },
  { key: "machines", label: "服务器", icon: Waypoints },
  { key: "users", label: "用户授权", icon: Users },
  { key: "groups", label: "权限组", icon: ShieldCheck },
  { key: "content", label: "公告和指南", icon: FileText },
  { key: "tickets", label: "问题会话", icon: LifeBuoy },
  { key: "settings", label: "站点设置", icon: Settings2 },
];
function readRoute() {
  const [area, page] = location.hash.replace(/^#\/?/, "").split("/");
  return {
    area: area === "admin" ? "admin" : "user",
    page: page || "overview",
  };
}
export default function App() {
  return (
    <ToastProvider>
      <Workspace />
    </ToastProvider>
  );
}
function Workspace() {
  const auth = useResource<{ setup_required: boolean; user: User | null }>(
    "auth/status",
  );
  const site = useResource<{ site_name: string; site_description: string }>(
    "site",
  );
  const [route, setRoute] = useState(readRoute);
  const [dark, setDark] = useState(
    () => localStorage.getItem("mboard-theme") === "dark",
  );
  const [mobile, setMobile] = useState(false);
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width:820px)").matches,
  );
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [navMarker, setNavMarker] = useState({ top: 0, height: 0 });
  const { notify } = useToast();
  useEffect(() => {
    const expired = () => auth.reload();
    window.addEventListener("mboard-session-expired", expired);
    return () => window.removeEventListener("mboard-session-expired", expired);
  }, [auth.reload]);
  const brand = site.data?.site_name.trim() || "mboard";
  const mark = Array.from(brand)[0] || "m";
  const wideMark = (mark.codePointAt(0) ?? 0) > 127;
  useEffect(() => {
    document.title = brand;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", `${brand} · 连接、授权和流量管理`);
  }, [brand]);
  useEffect(() => {
    site.reload();
  }, [route.area, route.page, site.reload]);
  useEffect(() => {
    const change = () => {
      setRoute(readRoute());
      setMobile(false);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("mboard-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const media = matchMedia("(max-width:820px)");
    const change = () => {
      setNarrow(media.matches);
      setMobile(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const targets = navRef.current?.querySelectorAll<HTMLElement>("a,button");
    targets?.[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobile(false);
        menuRef.current?.focus();
      }
      if (e.key === "Tab" && targets?.length) {
        const first = targets[0],
          last = targets[targets.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      menuRef.current?.focus();
    };
  }, [mobile]);
  const user = auth.data?.user;
  const admin = route.area === "admin" && user?.role === "admin";
  const nav = admin ? adminNav : userNav;
  const page = nav.some((n) => n.key === route.page) ? route.page : "overview";
  const name = nav.find((n) => n.key === page)?.label || "";
  useLayoutEffect(() => {
    const section = navRef.current?.querySelector<HTMLElement>(".nav-section");
    const active = section?.querySelector<HTMLElement>(".nav-item.is-active");
    if (!section || !active) return;
    const measure = () => setNavMarker(previous => {
      const top = active.offsetTop, height = active.offsetHeight;
      return previous.top === top && previous.height === height ? previous : { top, height };
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, [admin, page, narrow, user?.id]);
  function toggleTheme() {
    setDark(value => !value);
  }
  function navigate(p: string) {
    location.hash = `/${admin ? "admin" : "user"}/${p}`;
    setMobile(false);
  }
  async function logout() {
    try {
      await api("auth/logout", { method: "POST" });
      location.hash = "";
      auth.reload();
    } catch (e) {
      notify((e as Error).message, "danger");
    }
  }
  if (auth.loading)
    return (
      <div className="auth-loading">
        <Loading />
      </div>
    );
  if (auth.error)
    return (
      <main className="login-panel" style={{ minHeight: "100vh" }}>
        <div className="login-wrap">
          <h1>连接 {brand}</h1>
          <p>服务连接恢复后，可继续访问面板。</p>
          <ErrorState message={auth.error} retry={auth.reload} />
        </div>
      </main>
    );
  if (!user)
    return (
      <Auth
        setup={Boolean(auth.data?.setup_required)}
        refresh={auth.reload}
        description={site.data?.site_description}
        brand={brand}
        mark={mark}
        wideMark={wideMark}
      />
    );
  return (
    <div className="app-shell">
      <aside
        ref={navRef}
        className={`sidebar ${mobile ? "is-open" : ""}`}
        id="workspace-navigation"
        inert={narrow && !mobile}
        aria-label={admin ? "管理面板导航" : "用户面板导航"}
      >
        <a className="brand" href={`#/${admin ? "admin" : "user"}/overview`}>
          <span className={`brand-mark${wideMark ? " is-wide" : ""}`}>{mark}</span>
          <div>
            <strong>{brand}</strong>
            <span>{admin ? "CONTROL ROOM" : "YOUR WORKSPACE"}</span>
          </div>
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="mobile-close"
          aria-label="关闭导航"
          onClick={() => {
            setMobile(false);
            menuRef.current?.focus();
          }}
        >
          <X size={20} />
        </Button>
        <nav>
          <div className="nav-section">
            <div className="mb-custom-nav-marker" aria-hidden style={{ height: navMarker.height, transform: `translateY(${navMarker.top}px)`, opacity: navMarker.height ? 1 : 0 }} />
            <div className="nav-label">
              {admin ? "管理工作区" : "我的工作区"}
            </div>
            {nav.map((item) => (
              <a
                key={item.key}
                href={`#/${admin ? "admin" : "user"}/${item.key}`}
                className={`nav-item ${page === item.key ? "is-active" : ""}`}
                aria-current={page === item.key ? "page" : undefined}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
                {page === item.key && (
                  <ChevronRight size={14} className="nav-arrow" />
                )}
              </a>
            ))}
          </div>
        </nav>
        <div className="sidebar-footer">
          {user.role === "admin" && (
            <a
              className="nav-item"
              href={`#/${admin ? "user" : "admin"}/overview`}
            >
              {admin ? <ArrowLeft size={18} /> : <ShieldCheck size={18} />}
              <span>{admin ? "用户面板" : "管理面板"}</span>
              <ArrowUpRight size={14} className="nav-arrow" />
            </a>
          )}
          <button
            type="button"
            className="nav-item"
            onClick={() => void logout()}
          >
            <LogOut size={18} />
            <span>退出登录</span>
          </button>
          <div className="sidebar-note">{brand} · independent by design</div>
        </div>
      </aside>
      <button
          type="button"
          className={`sidebar-scrim ${mobile ? "is-open" : ""}`}
          inert={!mobile}
          aria-hidden={!mobile}
          tabIndex={mobile ? 0 : -1}
          onClick={() => {
            setMobile(false);
            menuRef.current?.focus();
          }}
          aria-label="关闭导航遮罩"
        />
      <div className="app-main" inert={mobile && narrow}>
        <header className="topbar">
          <button
            ref={menuRef}
            type="button"
            className="button button-ghost button-icon mobile-menu"
            aria-label="打开导航"
            aria-controls="workspace-navigation"
            aria-expanded={mobile}
            onClick={() => setMobile(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>{admin ? "管理面板" : "用户面板"}</span>
            <ChevronRight size={13} />
            <strong>{name}</strong>
          </div>
          <div className="topbar-actions">
            <span className="workspace-label">
              <span className="status-dot" />
              {brand}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? "切换浅色主题" : "切换深色主题"}
              onClick={toggleTheme}
            >
              <span key={dark ? "sun" : "moon"} className="mb-custom-theme-icon" aria-hidden>
                {dark ? <Sun size={18} /> : <Moon size={18} />}
              </span>
            </Button>
            <span className="avatar" title={`${user.name} · ${user.email}`}>
              {(user.name || user.email).slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        <main key={`${admin ? "admin" : "user"}-${page}`} className="page-content mb-custom-page-enter">
          {admin ? (
            <AdminPage
              key={`admin-${page}`}
              page={page}
              onNavigate={navigate}
            />
          ) : (
            <UserPage
              key={`user-${page}`}
              page={page}
              user={user}
              siteName={brand}
              onNavigate={navigate}
              onUserRefresh={auth.reload}
            />
          )}
          <footer className="page-footer">
            <span>{brand} / {admin ? "CONTROL ROOM" : "WORKSPACE"}</span>
            <span>连接由你掌握</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Auth({
  setup,
  refresh,
  description,
  brand,
  mark,
  wideMark,
}: {
  setup: boolean;
  refresh: () => void;
  description?: string;
  brand: string;
  mark: string;
  wideMark: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`auth/${setup ? "setup" : "login"}`, {
        method: "POST",
        body: JSON.stringify({ email, password, ...(setup ? { name } : {}) }),
      });
      location.hash = setup ? "/admin/overview" : "/user/overview";
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="login-page">
      <main className="login-panel">
        <div className="login-wrap">
          <div className="login-brand">
            <span className={`brand-mark${wideMark ? " is-wide" : ""}`}>{mark}</span>
            <strong>{brand}</strong>
          </div>
          <span className="eyebrow">
            {setup ? brand : "YOUR WORKSPACE"}
          </span>
          <h1>{setup ? "建立你的工作区" : "欢迎回来"}</h1>
          <p>
            {setup
              ? "创建首位管理员，开始配置你的连接和访问授权。"
              : description || "登录后查看订阅、节点状态和每一天的用量。"}
          </p>
          {error && <ErrorState message={error} />}
          <form className="login-form" onSubmit={submit}>
            {setup && (
              <Field label="管理员名称">
                <Input
                  required
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                />
              </Field>
            )}
            <Field label="邮箱">
              <Input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
                placeholder="you@example.com"
              />
            </Field>
            <Field
              label="密码"
              hint={
                setup ? "至少 12 位，推荐结合多个词语、数字和符号。" : undefined
              }
            >
              <Input
                type="password"
                required
                minLength={setup ? 12 : 1}
                maxLength={200}
                autoComplete={setup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" loading={saving}>
              {setup ? "创建工作区" : "进入工作区"}
              <ArrowUpRight size={17} />
            </Button>
          </form>
          <div className="login-footer">登录会话由 HttpOnly Cookie 保存。</div>
        </div>
      </main>
      <aside className="login-aside">
        <span className="eyebrow">{brand} / INDEPENDENT BY DESIGN</span>
        <div>
          <h2>
            你的网络，
            <br />
            <span>由你掌握。</span>
          </h2>
          <p>
            从授权到连接，从运行状态到流量记录。让每一个入口，都有清晰的管理方式。
          </p>
          <div className="login-feature">
            <ShieldCheck size={18} />
            权限组授权，访问范围清晰
          </div>
          <div className="login-feature">
            <Network size={18} />
            节点配置，统一分发
          </div>
          <div className="login-feature">
            <Activity size={18} />
            真实上报，每日用量可查
          </div>
        </div>
        <div className="login-aside-bottom">
          <span>OWN YOUR CONNECTION</span>
          <span>{brand}</span>
        </div>
      </aside>
    </div>
  );
}
