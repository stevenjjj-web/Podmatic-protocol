import { memo } from "react";

const FUR: Record<string, [string, string]> = {
  Brown: ["#9A6B4F", "#C79A7A"],
  Grey: ["#8A8F98", "#B9BEC6"],
  White: ["#E9E4DC", "#FFFFFF"],
  Gold: ["#E0A92E", "#FFE08A"],
};
const BG = ["#FFD9F3", "#D8E7FF", "#DDF7E6", "#FFF0CF", "#E9DDFF", "#FFE0D6"];

function hash(n: number) {
  let x = (n + 1) * 2654435761;
  x ^= x >>> 16;
  return Math.abs(x);
}

/** Deterministic artwork for the demo collection, drawn from the token's snapshot traits. */
export const NftArt = memo(function NftArt({
  tokenId,
  traits,
  size = 160,
  rounded = 16,
}: {
  tokenId: number | bigint;
  traits?: Record<string, string>;
  size?: number | string;
  rounded?: number;
}) {
  const id = Number(tokenId);
  const fur = FUR[traits?.Fur ?? "Brown"] ?? FUR.Brown;
  const hat = traits?.Hat ?? "None";
  const eyes = traits?.Eyes ?? "Calm";
  const bg = BG[hash(id) % BG.length];
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} style={{ borderRadius: rounded, display: "block" }} aria-label={`#${id}`}>
      <defs>
        <radialGradient id={`f${id}`} cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor={fur[1]} />
          <stop offset="1" stopColor={fur[0]} />
        </radialGradient>
        {traits?.Fur === "Gold" && (
          <linearGradient id={`shine${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity=".7" />
            <stop offset=".5" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        )}
      </defs>
      <rect width="120" height="120" fill={bg} />
      <circle cx="26" cy="62" r="13" fill={fur[0]} />
      <circle cx="94" cy="62" r="13" fill={fur[0]} />
      <circle cx="26" cy="62" r="7" fill="#F2C6B0" />
      <circle cx="94" cy="62" r="7" fill="#F2C6B0" />
      <ellipse cx="60" cy="64" rx="36" ry="38" fill={`url(#f${id})`} />
      <ellipse cx="60" cy="78" rx="24" ry="18" fill="#F2C6B0" />
      {eyes === "Laser" ? (
        <>
          <rect x="34" y="52" width="52" height="5" rx="2.5" fill="#FF2D55" opacity=".9" />
          <circle cx="46" cy="55" r="5" fill="#FF2D55" />
          <circle cx="74" cy="55" r="5" fill="#FF2D55" />
        </>
      ) : eyes === "Sleepy" ? (
        <>
          <path d="M40 56 q6 5 12 0" stroke="#2B2B2B" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M68 56 q6 5 12 0" stroke="#2B2B2B" strokeWidth="3" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="46" cy="55" r="5" fill="#2B2B2B" />
          <circle cx="74" cy="55" r="5" fill="#2B2B2B" />
          <circle cx="47.5" cy="53.5" r="1.6" fill="#fff" />
          <circle cx="75.5" cy="53.5" r="1.6" fill="#fff" />
        </>
      )}
      <ellipse cx="54" cy="74" rx="2.4" ry="2" fill="#6B4433" />
      <ellipse cx="66" cy="74" rx="2.4" ry="2" fill="#6B4433" />
      <path d="M50 84 q10 7 20 0" stroke="#6B4433" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      {hat === "Cap" && <path d="M28 40 q32 -26 64 0 l10 4 h-74 z" fill="#2F6BFF" />}
      {hat === "Beanie" && <path d="M30 40 q30 -30 60 0 v4 h-60 z" fill="#FF8A3D" />}
      {hat === "Crown" && <path d="M36 36 l8 -16 l8 12 l8 -16 l8 16 l8 -12 l8 16 z" fill="#FFC531" stroke="#D99A00" strokeWidth="1.5" />}
      {hat === "Halo" && <ellipse cx="60" cy="16" rx="22" ry="6" fill="none" stroke="#FFE15A" strokeWidth="4" />}
      {traits?.Fur === "Gold" && <ellipse cx="60" cy="64" rx="36" ry="38" fill={`url(#shine${id})`} />}
    </svg>
  );
});
