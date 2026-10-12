import {
  cloneElement,
  isValidElement,
  createContext,
  useContext,
  useEffect,
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
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      const previous = document.activeElement as HTMLElement | null;
      const trap = (event: KeyboardEvent) => {
        if (event.key !== "Tab") return;
        const targets = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = targets[0],
          last = targets[targets.length - 1];
        if (!first) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      dialog.addEventListener("keydown", trap);
      dialog.showModal();
      document.body.classList.add("modal-open");
      return () => {
        dialog.removeEventListener("keydown", trap);
        dialog.close();
        document.body.classList.remove("modal-open");
        previous?.focus();
      };
    } else dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${large ? "modal-large" : ""}`}
      aria-labelledby={id}
      aria-describedby={description ? `${id}-desc` : undefined}
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
      <div className="modal-body">{open && children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </dialog>
  );
}
const ToastContext = createContext<{
  notify: (message: string, tone?: "success" | "danger") => void;
}>({ notify: () => {} });
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<
    { id: number; message: string; tone: string }[]
  >([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const notify = (message: string, tone = "success") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, message, tone }]);
    timers.current.push(
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 4500),
    );
  };
  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toast-region" aria-live="polite">
        {items.map((x) => (
          <div key={x.id} className={`toast toast-${x.tone}`}>
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
              onClick={() => setItems((s) => s.filter((y) => y.id !== x.id))}
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
      <LoaderCircle className="spin" size={22} />
      正在读取数据…
    </div>
  );
}
