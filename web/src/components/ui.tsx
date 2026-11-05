import type { ReactNode } from "react";
import { useEffect } from "react";

export function Modal({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {title && (
          <div className="between" style={{ marginBottom: 12 }}>
            <div className="h3">{title}</div>
            <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stack-sm">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="small faint">{hint}</div>}
    </div>
  );
}

export function UsdcChip() {
  return (
    <span className="token-chip">
      <span className="usdc-icon">$</span>USDC
    </span>
  );
}

export function AmountPanel({
  label,
  value,
  onChange,
  right,
  footer,
  readOnly,
}: {
  label: ReactNode;
  value: string;
  onChange?: (v: string) => void;
  right?: ReactNode;
  footer?: ReactNode;
  readOnly?: boolean;
}) {
  return (
    <div className="panel stack-sm">
      <div className="field-label">{label}</div>
      <div className="row">
        <input
          className="amount-input mono"
          inputMode="decimal"
          placeholder="0"
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        {right ?? <UsdcChip />}
      </div>
      {footer && <div className="between small muted">{footer}</div>}
    </div>
  );
}

export function Skeleton({ h = 20, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export const TIER_COLORS = ["#9B9B9B", "#40B66B", "#4C82FB", "#B15DFF", "#FF9F0A"];
export const TIER_NAMES = ["普通", "罕见", "稀有", "史诗", "传说"];
