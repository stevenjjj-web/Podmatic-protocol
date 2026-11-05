import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { parseEventLogs, type Address, type Hex } from "viem";
import { bidBookAbi, floorBookAbi, machineAbi, oddsAbi } from "../generated/abis";
import {
  bestBidsFor, useBids, useFloorOrders, useMachineAddresses, useMachines, useMyNfts, useOddsListings,
  type Bid, type MachineInfo,
} from "../hooks/useProtocol";
import { useDeployment } from "../hooks/useDeployment";
import { useTx } from "../hooks/useTx";
import { useApprovals } from "../hooks/useApprovals";
import { useChainTime } from "../hooks/useEvents";
import { NftTile, TraitList } from "../components/NftTile";
import { NftArt } from "../components/NftArt";
import { AmountPanel, Empty, Skeleton, TIER_NAMES } from "../components/ui";
import { fmtDuration, fmtUsdc, parseUsdc } from "../lib/format";
import { COLLECTION_TRAIT, proofFor, tokenTraitKeys, tokenTraits, traitLabel } from "../lib/traits";

type Exit = "bid" | "machine" | "pool" | "odds";
const PREMIUM_BPS = 200n;
const PRICING_FEE_BPS = 50n;
const YIELD_VESTING = 3n * 86400n;
const YIELD_FORFEIT = 7n * 86400n;

function tierFor(m: MachineInfo, value: bigint) {
  return m.tiers.findIndex((t) => value >= t.minValue && value <= t.maxValue);
}

function SellPanel({ tokenId, bids, bidsLoading, onDone }: { tokenId: bigint; bids: Bid[]; bidsLoading: boolean; onDone: () => void }) {
  const { deployment, collection } = useDeployment();
  const { machines } = useMachines();
  const { orders } = useFloorOrders();
  const { run, busy } = useTx();
  const { ensureNft } = useApprovals();
  const client = usePublicClient();
  const nft = deployment?.demoCollection;
  const [exit, setExit] = useState<Exit>("machine");
  const [machineAddr, setMachineAddr] = useState<Address | undefined>();
  const [floor, setFloor] = useState("");
  const [ask, setAsk] = useState("");

  const { fill, valuation } = bestBidsFor(bids, collection, nft, Number(tokenId));
  const bestOrder = [...orders]
    .filter((o) => o.active && o.cash >= o.bid)
    .sort((a, b) => (a.bid > b.bid ? -1 : 1))[0];
  const machine = machines.find((m) => m.address === machineAddr) ?? machines[0];
  const defaultFloor = valuation ? fmtUsdc((valuation.price * 97n) / 100n).replace(/,/g, "") : "";
  const floorValue = parseUsdc(floor || defaultFloor || "0");
  const settlement = valuation ? (valuation.price * (10000n + PREMIUM_BPS)) / 10000n : 0n;
  const tier = valuation && machine ? tierFor(machine, valuation.price) : -1;
  const drawable = !!valuation && tier >= 0 && settlement >= floorValue;

  // Trait to prove when consigning: the one the best valuation bid uses, else the trait with the highest active bid.
  const traitForListing: Hex = valuation?.traitKey ?? fill?.traitKey ?? COLLECTION_TRAIT;

  async function sellToBid() {
    if (!nft || !deployment || !fill) return;
    if (!(await ensureNft(nft, deployment.bidBook))) return;
    const ok = await run(`Sell to bid · $${fmtUsdc(fill.price)}`, (w) =>
      w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "fill", args: [BigInt(fill.id), tokenId, proofFor(collection, tokenId, fill.traitKey), fill.price] }),
    );
    if (ok) onDone();
  }

  async function consign() {
    if (!nft || !machine || !client) return;
    if (!(await ensureNft(nft, machine.address))) return;
    const receipt = await run(`Consign to ${machine.name}`, (w) =>
      w({ address: machine.address, abi: machineAbi, functionName: "list", args: [tokenId, floorValue, traitForListing, proofFor(collection, tokenId, traitForListing)] }),
    );
    if (!receipt) return;
    const [listed] = parseEventLogs({ abi: machineAbi, logs: receipt.logs, eventName: "Listed" });
    // Re-check eligibility on chain rather than trusting cached reads: the cache may still be loading.
    const candidates = [valuation, fill].filter((b): b is Bid => !!b && b.traitKey === traitForListing);
    let bidId: number | undefined;
    for (const b of candidates) {
      const ok = await client.readContract({
        address: deployment!.bidBook, abi: bidBookAbi, functionName: "isValuationEligible", args: [BigInt(b.id), nft, b.traitKey],
      });
      if (ok) { bidId = b.id; break; }
    }
    if (listed && bidId !== undefined) {
      await run("Value by bid and make drawable", (w) =>
        w({ address: machine.address, abi: machineAbi, functionName: "refreshValuation", args: [listed.args.listingId, BigInt(bidId)] }),
      );
    }
    onDone();
  }

  async function sellToPool() {
    if (!nft || !deployment || !bestOrder) return;
    if (!(await ensureNft(nft, deployment.floorBook))) return;
    const minOut = (bestOrder.bid * 98n) / 100n;
    const ok = await run(`Sell into pool order · $${fmtUsdc(bestOrder.bid)}`, (w) =>
      w({ address: deployment.floorBook, abi: floorBookAbi, functionName: "sellToOrder", args: [BigInt(bestOrder.id), tokenId, minOut] }),
    );
    if (ok) onDone();
  }

  async function listOdds() {
    if (!nft || !deployment) return;
    const a = parseUsdc(ask);
    if (a === 0n) return;
    if (!(await ensureNft(nft, deployment.odds))) return;
    const ok = await run(`Sell by odds · ask $${fmtUsdc(a)}`, (w) =>
      w({ address: deployment.odds, abi: oddsAbi, functionName: "list", args: [nft, tokenId, a] }),
    );
    if (ok) onDone();
  }

  return (
    <div className="card swap-card stack sticky">
      <div className="row">
        <NftArt tokenId={tokenId} traits={tokenTraits(collection, tokenId)} size={64} rounded={14} />
        <div className="stack-sm">
          <div className="h3">{collection?.name} #{Number(tokenId)}</div>
          <TraitList tokenId={tokenId} />
        </div>
      </div>
      <div className="grid grid-2" style={{ gap: 8 }}>
        <div className="panel stack-sm">
          <div className="small muted">Sell now for</div>
          <div className="stat-value">{fill ? `$${fmtUsdc(fill.price)}` : "—"}</div>
          <div className="small faint">{fill ? traitLabel(collection, fill.traitKey) : "No bids"}</div>
        </div>
        <div className="panel stack-sm">
          <div className="small muted">Machine value</div>
          <div className="stat-value">{valuation ? `$${fmtUsdc(valuation.price)}` : "—"}</div>
          <div className="small faint">{valuation ? "Eligible bid (rested 24h)" : "No eligible bid yet"}</div>
        </div>
      </div>

      <div className="segmented" style={{ alignSelf: "stretch", display: "grid", gridTemplateColumns: "repeat(4,1fr)" }}>
        {([["machine", "Machine"], ["bid", "Bid"], ["pool", "Pool"], ["odds", "Odds"]] as [Exit, string][]).map(([k, l]) => (
          <button key={k} className={exit === k ? "active" : ""} onClick={() => setExit(k)}>{l}</button>
        ))}
      </div>

      {exit === "machine" && (
        <div className="stack">
          <select className="select" value={machine?.address} onChange={(e) => setMachineAddr(e.target.value as Address)}>
            {machines.map((m) => <option key={m.address} value={m.address}>{m.name}</option>)}
          </select>
          <AmountPanel
            label="Floor price: won't sell below this"
            value={floor || defaultFloor}
            onChange={setFloor}
            footer={<><span>You get ≈ ${fmtUsdc(valuation ? (valuation.price * (10000n + PREMIUM_BPS - PRICING_FEE_BPS)) / 10000n : 0n)} + inventory yield when drawn</span><span>value × 1.015</span></>}
          />
          {valuation ? (
            drawable ? (
              <div className="notice notice-info">
                ✓ Goes into the {TIER_NAMES[tier]} tier and can be drawn. The bid sets the price, not your floor. While listed you share 1.5% of every spin as inventory yield (claimable after 3 days, forfeited if you delist within 7 days). If someone else later re-consigns and sells this NFT, you earn a 1% circulation royalty.
              </div>
            ) : (
              <div className="notice notice-warn">
                {tier < 0 ? "Its value is outside this machine's tiers." : "Your floor is above value × 1.02, so it cannot be drawn yet; it becomes drawable automatically when bids rise."}
              </div>
            )
          ) : (
            <div className="notice notice-neutral">No eligible bid can value it yet. You can consign now; once a bid appears, anyone can refresh the valuation.</div>
          )}
          <button className="btn btn-primary btn-lg" disabled={busy || !machine || bidsLoading} onClick={consign}>
            {bidsLoading ? "Loading bids…" : "Consign to machine"}
          </button>
        </div>
      )}

      {exit === "bid" && (
        <div className="stack">
          <div className="panel stack-sm">
            <div className="kv"><span>Best bid</span><span>{fill ? `$${fmtUsdc(fill.price)}` : "—"}</span></div>
            <div className="kv"><span>Bid type</span><span>{fill ? traitLabel(collection, fill.traitKey) : "—"}</span></div>
            <div className="kv"><span>You get (after 1% protocol fee)</span><span>{fill ? `$${fmtUsdc((fill.price * 99n) / 100n)}` : "—"}</span></div>
          </div>
          <button className="btn btn-primary btn-lg" disabled={busy || !fill} onClick={sellToBid}>
            {fill ? "Sell now" : "No bid to sell into"}
          </button>
        </div>
      )}

      {exit === "pool" && (
        <div className="stack">
          <div className="notice notice-neutral">Pool orders pay floor price only. Selling an NFT with rare traits here gives up its premium.</div>
          <div className="panel stack-sm">
            <div className="kv"><span>Best pool bid</span><span>{bestOrder ? `$${fmtUsdc(bestOrder.bid)}` : "—"}</span></div>
            <div className="kv"><span>You get (after 1% protocol fee)</span><span>{bestOrder ? `$${fmtUsdc((bestOrder.bid * 99n) / 100n)}` : "—"}</span></div>
          </div>
          <button className="btn btn-primary btn-lg" disabled={busy || !bestOrder} onClick={sellToPool}>Sell into pool order</button>
        </div>
      )}

      {exit === "odds" && (
        <div className="stack">
          <AmountPanel label="Ask: what you receive when someone wins it (plus a 1.5% bonus)" value={ask} onChange={setAsk} />
          <div className="notice notice-neutral">
            Buyers pay 1–50% of the ask for the same chance to win; the vault carries the variance. Buyers see this exact NFT, so an ask that is too high simply gets no buyers.
          </div>
          <button className="btn btn-primary btn-lg" disabled={busy || !ask} onClick={listOdds}>List on Odds</button>
        </div>
      )}
    </div>
  );
}

function PendingExits() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { data: machines } = useMachineAddresses();
  const client = usePublicClient();
  const now = useChainTime();
  const { run, busy } = useTx();
  const { ensureNft } = useApprovals();
  const { isLocal } = useDeployment();
  const { data: won = [] } = useQuery({
    queryKey: ["won", address, machines.join()],
    enabled: !!client && !!address && machines.length > 0,
    refetchInterval: 5000,
    queryFn: async () => {
      const latest = await client!.getBlockNumber();
      const fromBlock = isLocal || latest < 50_000n ? 0n : latest - 50_000n;
      const all = await Promise.all(
        machines.map((m) => client!.getContractEvents({ address: m, abi: machineAbi, eventName: "SpinSettled", args: { player: address }, fromBlock })),
      );
      return all.flat().map((e) => ({ tokenId: e.args.tokenId!, earmarkId: e.args.earmarkId! }));
    },
  });

  const marks = useReadContracts({
    contracts: won.map((w) => ({ address: deployment?.bidBook, abi: bidBookAbi, functionName: "earmarks" as const, args: [w.earmarkId] as const })),
    query: { enabled: won.length > 0 && !!deployment, refetchInterval: 4000 },
  });
  const open = won
    .map((w, i) => ({ ...w, e: marks.data?.[i]?.result as { open: boolean; expiry: bigint; amount: bigint } | undefined }))
    .filter((x) => x.e?.open && now !== undefined && x.e.expiry >= now);
  if (!open.length) return null;
  return (
    <div className="card card-pad stack">
      <div className="h3">NFTs you won: sell at their value</div>
      {open.map((x) => (
        <div key={String(x.earmarkId)} className="between">
          <div className="row">
            <NftArt tokenId={x.tokenId} traits={tokenTraits(collection, x.tokenId)} size={44} rounded={10} />
            <div>
              <div style={{ fontWeight: 535 }}>#{Number(x.tokenId)}</div>
              <div className="small muted">{fmtDuration(Number(x.e!.expiry - now!))} left</div>
            </div>
          </div>
          <button
            className="btn btn-soft btn-sm"
            disabled={busy}
            onClick={async () => {
              if (!deployment?.demoCollection || !(await ensureNft(deployment.demoCollection, deployment.bidBook))) return;
              await run(`Sell #${Number(x.tokenId)} at its value`, (w) =>
                w({ address: deployment.bidBook, abi: bidBookAbi, functionName: "fillEarmark", args: [x.earmarkId] }),
              );
            }}
          >
            Sell ${fmtUsdc((x.e!.amount * 99n) / 100n)}
          </button>
        </div>
      ))}
    </div>
  );
}

function MyListings() {
  const { address } = useAccount();
  const { deployment, collection } = useDeployment();
  const { machines } = useMachines();
  const { listings: oddsListings } = useOddsListings();
  const { run, busy } = useTx();
  const calls = machines.flatMap((m) =>
    Array.from({ length: Number(m.listingCount) }, (_, i) => ({ address: m.address, abi: machineAbi, functionName: "listings" as const, args: [BigInt(i)] as const })),
  );
  const rows = useReadContracts({ contracts: calls, query: { enabled: calls.length > 0, refetchInterval: 5000 } });
  const now = useChainTime();
  const mine = (rows.data ?? [])
    .map((r, i) => ({ l: r.result as { seller: Address; tokenId: bigint; floorPrice: bigint; value: bigint; status: number; tier: number; listedAt: bigint } | undefined, call: calls[i] }))
    .filter((x) => x.l && address && x.l.seller.toLowerCase() === address.toLowerCase() && (x.l.status === 1 || x.l.status === 2));
  const yields = useReadContracts({
    contracts: mine.map(({ call }) => ({ address: call.address, abi: machineAbi, functionName: "pendingYieldOf" as const, args: call.args })),
    query: { enabled: mine.length > 0, refetchInterval: 5000 },
  });
  const myOdds = oddsListings.filter((l) => address && l.seller.toLowerCase() === address.toLowerCase() && l.active);
  if (!mine.length && !myOdds.length) return null;
  return (
    <div className="card card-pad stack">
      <div className="h3">My listings</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>NFT</th><th>Where</th><th>Floor / ask</th><th>Value</th><th>Status</th><th>Inventory yield</th><th /></tr></thead>
          <tbody>
            {mine.map(({ l, call }, idx) => {
              const m = machines.find((x) => x.address === call.address)!;
              const owed = (yields.data?.[idx]?.result as bigint | undefined) ?? 0n;
              const vested = now !== undefined && now >= l!.listedAt + YIELD_VESTING;
              const safeToDelist = now !== undefined && now >= l!.listedAt + YIELD_FORFEIT;
              return (
                <tr key={`${call.address}-${call.args[0]}`}>
                  <td><div className="row"><NftArt tokenId={l!.tokenId} traits={tokenTraits(collection, l!.tokenId)} size={32} rounded={8} />#{Number(l!.tokenId)}</div></td>
                  <td>{m.name}</td>
                  <td>${fmtUsdc(l!.floorPrice)}</td>
                  <td>{l!.value ? `$${fmtUsdc(l!.value)}` : "—"}</td>
                  <td>{l!.status === 2 ? <span className="badge badge-ok">Drawable · {TIER_NAMES[l!.tier]}</span> : <span className="badge">Out of range</span>}</td>
                  <td>
                    <div className="row">
                      <span className="mono">${fmtUsdc(owed, 4)}</span>
                      <button className="btn btn-sm btn-soft" disabled={busy || !vested || owed === 0n}
                        title={vested ? "" : "Claimable after 3 days listed"}
                        onClick={() => run(`Claim inventory yield #${Number(l!.tokenId)}`, (w) => w({ address: call.address, abi: machineAbi, functionName: "claimYield", args: call.args }))}>
                        {vested ? "Claim" : "< 3 days"}
                      </button>
                    </div>
                  </td>
                  <td>
                    <button className="btn btn-sm btn-ghost" disabled={busy}
                      title={safeToDelist ? "" : "Listed under 7 days: delisting forfeits unclaimed inventory yield"}
                      onClick={() => run(`Delist #${Number(l!.tokenId)}`, (w) => w({ address: call.address, abi: machineAbi, functionName: "delist", args: call.args }))}>
                      Delist{!safeToDelist && owed > 0n ? " (forfeits yield)" : ""}
                    </button>
                  </td>
                </tr>
              );
            })}
            {myOdds.map((l) => (
              <tr key={`odds-${l.id}`}>
                <td><div className="row"><NftArt tokenId={l.tokenId} traits={tokenTraits(collection, l.tokenId)} size={32} rounded={8} />#{Number(l.tokenId)}</div></td>
                <td>Odds</td>
                <td>${fmtUsdc(l.ask)}</td>
                <td>—</td>
                <td>{l.pending ? <span className="badge badge-warn">Revealing</span> : <span className="badge badge-ok">Listed</span>}</td>
                <td>—</td>
                <td>
                  <button className="btn btn-sm btn-ghost" disabled={busy || l.pending}
                    onClick={() => run(`Delist #${Number(l.tokenId)}`, (w) => w({ address: deployment!.odds, abi: oddsAbi, functionName: "delist", args: [BigInt(l.id)] }))}>
                    Delist
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Sell() {
  const { address } = useAccount();
  const { collection, deployment } = useDeployment();
  const { tokens, isLoading } = useMyNfts();
  const { bids, isLoading: bidsLoading } = useBids();
  const [selected, setSelected] = useState<bigint | undefined>();
  const current = selected !== undefined && tokens.includes(selected) ? selected : tokens[0];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <h1 className="h2">Sell</h1>
        <div className="muted">Sellers only set a floor; bids set the price. Four exits: consign to a machine, sell to a bid, sell into a pool order, or sell by odds.</div>
      </div>
      <PendingExits />
      <div className="page-cols">
        <div className="card card-pad stack">
          <div className="between">
            <div className="h3">My NFTs</div>
            <span className="small muted">{tokens.length} items</span>
          </div>
          {!address ? (
            <Empty>Connect a wallet to see your NFTs.</Empty>
          ) : !deployment?.demoCollection ? (
            <Empty>No demo collection is registered on this chain.</Empty>
          ) : isLoading ? (
            <div className="grid grid-nft">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={200} />)}</div>
          ) : tokens.length === 0 ? (
            <Empty>You do not own any {collection?.name} yet. Spin for one, or buy a floor NFT on the Pool page.</Empty>
          ) : (
            <div className="grid grid-nft">
              {tokens.map((id) => {
                const { fill } = bestBidsFor(bids, collection, deployment.demoCollection, Number(id));
                const rare = tokenTraitKeys(collection, id).some((k) => fill?.traitKey === k);
                return (
                  <NftTile key={String(id)} tokenId={id} selected={id === current} onClick={() => setSelected(id)}>
                    <div className="between small">
                      <span className="muted">{fill ? `$${fmtUsdc(fill.price)}` : "no bids"}</span>
                      {rare && <span className="badge badge-accent">Trait</span>}
                    </div>
                  </NftTile>
                );
              })}
            </div>
          )}
        </div>
        {current !== undefined && <SellPanel tokenId={current} bids={bids} bidsLoading={bidsLoading} onDone={() => setSelected(undefined)} />}
      </div>
      <MyListings />
    </div>
  );
}
