import {
  cloneElement,
  isValidElement,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from "react";
import { AlertCircle, Check, LoaderCircle, X } from "lucide-react";

export function Button({
  variant = "primary",
  size = "default",
  loading,
  className = "",
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "small" | "icon" | "default";
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={Boolean(loading || disabled)}
      className={`button button-${variant} button-${size} ${className}`}
      aria-busy={loading || undefined}
    >
      {loading && <LoaderCircle size={16} className="spin" aria-hidden />}
      {children}
    </button>
  );
}
export function Card({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={`card ${className}`} {...props} />;
}
export function Badge({
  tone = "neutral",
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  return <span className={`badge badge-${tone} ${className}`} {...props} />;
}
export function Input({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...props} />;
}
export function Select({
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`input select ${className}`} {...props} />;
}
export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`input textarea ${className}`} {...props} />;
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const child = isValidElement<{ id?: string; "aria-describedby"?: string }>(
    children,
  )
    ? children
    : null;
  const id = child?.props.id || generated;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {child
        ? cloneElement(child, {
            id,
            "aria-describedby":
              [child.props["aria-describedby"], hint ? `${id}-hint` : null]
                .filter(Boolean)
                .join(" ") || undefined,
          })
        : children}
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
export function PageHeader({
  title,
  description,
  actions,
  eyebrow = "WORKSPACE",
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden>
        ↗
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div role="alert" className="error-state">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && (
        <Button variant="secondary" size="small" onClick={retry}>
          重新加载
        </Button>
      )}
    </div>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  large = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  large?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const content = useRef(children);
  if (open) content.current = children;
  const [present, setPresent] = useState(open);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => setPresent(false);
    const release = () => {
      dialog.close();
      document.body.classList.toggle("modal-open", Boolean(document.querySelector("dialog[open]")));
      if (restoreFocus.current?.isConnected) restoreFocus.current.focus();
    };
    const motionChanged = () => { if (media.matches) { clearTimeout(timer); finish(); } };
    if (open) {
      setPresent(true);
      dialog.dataset.phase = "enter";
      dialog.inert = false;
      if (!dialog.open) {
        restoreFocus.current = document.activeElement as HTMLElement | null;
        dialog.showModal();
      }
      document.body.classList.add("modal-open");
    } else if (dialog.open) {
      dialog.dataset.phase = "exit";
      dialog.inert = true;
      release();
      if (media.matches) finish();
      else { timer = setTimeout(finish, 180); media.addEventListener("change", motionChanged); }
    }
    return () => { clearTimeout(timer); media.removeEventListener("change", motionChanged); };
  }, [open]);
  useEffect(() => () => {
    ref.current?.close();
    document.body.classList.toggle("modal-open", Boolean(document.querySelector("dialog[open]")));
    if (restoreFocus.current?.isConnected) restoreFocus.current.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${large ? "modal-large" : ""}`}
      aria-labelledby={id}
      aria-describedby={description ? `${id}-desc` : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || !open) return;
        const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        )).filter(element => element.getClientRects().length > 0);
        const first = targets[0], last = targets[targets.length - 1];
        if (!first) { event.preventDefault(); event.currentTarget.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header className="modal-header">
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p id={`${id}-desc`}>{description}</p>}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭对话框"
          onClick={onClose}
        >
          <X size={20} />
        </Button>
      </header>
      <div className="modal-body">{(open || present) && content.current}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </dialog>
  );
}
const ToastContext = createContext<{
  notify: (message: string, tone?: "success" | "danger") => void;
}>({ notify: () => {} });
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<
    { id: number; message: string; tone: string; exiting?: boolean }[]
  >([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const schedule = (action: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.current.delete(timer); action(); }, delay);
    timers.current.add(timer);
  };
  const dismiss = (id: number) => {
    setItems(items => items.map(item => item.id === id ? { ...item, exiting: true } : item));
    schedule(() => setItems(items => items.filter(item => item.id !== id)), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  };
  const notify = (message: string, tone = "success") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, message, tone }]);
    schedule(() => dismiss(id), 4500);
  };
  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toast-region" aria-live="polite">
        {items.map((x) => (
          <div key={x.id} className={`toast toast-${x.tone}`} data-exiting={x.exiting || undefined} inert={x.exiting}>
            {x.tone === "success" ? (
              <Check size={18} />
            ) : (
              <AlertCircle size={18} />
            )}
            <span>{x.message}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭提示"
              onClick={() => dismiss(x.id)}
            >
              <X size={16} />
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
export function Loading() {
  return (
    <div className="mb-custom-loading" role="status">
      <LoaderCircle className="spin" size={22} aria-hidden />
      <span>正在读取数据<span className="mb-custom-loading-dots" aria-hidden><i /><i /><i /></span></span>
    </div>
  );
}
