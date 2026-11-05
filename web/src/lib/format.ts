import { formatUnits, parseUnits, type Address } from "viem";

export const USDC_DECIMALS = 6;

export function fmtUsdc(v: bigint | undefined, digits = 2): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, USDC_DECIMALS));
  return n.toLocaleString("en-US", { minimumFractionDigits: n >= 1000 ? 0 : digits, maximumFractionDigits: digits });
}

export function parseUsdc(s: string): bigint {
  try {
    return parseUnits((s || "0").trim(), USDC_DECIMALS);
  } catch {
    return 0n;
  }
}

export function fmtPct(fraction: number, digits = 2): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 1e18-scaled probability to a fraction. */
export const prob = (p: bigint) => Number(p) / 1e18;

export const short = (a?: Address | string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export function fmtDuration(s: number): string {
  if (s <= 0) return "已到期";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}
