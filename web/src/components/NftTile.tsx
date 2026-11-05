import type { ReactNode } from "react";
import { NftArt } from "./NftArt";
import { useDeployment } from "../hooks/useDeployment";
import { tokenTraits, TRAIT_NAMES } from "../lib/traits";

export function TraitList({ tokenId }: { tokenId: number | bigint }) {
  const { collection } = useDeployment();
  const traits = tokenTraits(collection, tokenId);
  if (!traits) return null;
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {Object.entries(traits).map(([k, v]) => (
        <span key={k} className="badge">
          {TRAIT_NAMES[k] ?? k} · {v}
        </span>
      ))}
    </div>
  );
}

export function NftTile({
  tokenId,
  selected,
  onClick,
  children,
}: {
  tokenId: number | bigint;
  selected?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const { collection } = useDeployment();
  return (
    <div className={`nft-tile ${selected ? "selected" : ""}`} onClick={onClick}>
      <NftArt tokenId={tokenId} traits={tokenTraits(collection, tokenId)} size="100%" rounded={0} />
      <div className="meta">
        <div className="between">
          <span style={{ fontWeight: 535 }}>{collection?.name ?? "NFT"} #{Number(tokenId)}</span>
        </div>
        {children}
      </div>
    </div>
  );
}
