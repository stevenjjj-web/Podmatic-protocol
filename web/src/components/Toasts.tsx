import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type Toast = { id: number; title: string; body?: string; kind: "pending" | "success" | "error"; href?: string };

type Ctx = { push: (t: Omit<Toast, "id">) => number; update: (id: number, t: Partial<Toast>) => void };
const ToastCtx = createContext<Ctx>({ push: () => 0, update: () => {} });

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId++;
      setToasts((ts) => [...ts, { ...t, id }]);
      if (t.kind !== "pending") setTimeout(() => dismiss(id), 6000);
      return id;
    },
    [dismiss],
  );
  const update = useCallback(
    (id: number, patch: Partial<Toast>) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      if (patch.kind && patch.kind !== "pending") setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  return (
    <ToastCtx.Provider value={{ push, update }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
            <div className="toast-icon">{t.kind === "pending" ? <span className="spinner" /> : t.kind === "success" ? "✓" : "!"}</div>
            <div>
              <div className="toast-title">{t.title}</div>
              {t.body && <div className="toast-body">{t.body}</div>}
              {t.href && (
                <a className="toast-link" href={t.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  在浏览器中查看 ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToasts = () => useContext(ToastCtx);
