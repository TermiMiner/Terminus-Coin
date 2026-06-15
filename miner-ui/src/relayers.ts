// relayers.ts — multi-relayer discovery + selection (Phase 1 engine).
//
// Sources form a pluggable UNION, merged by baseUrl:
//   bundled fallback  ∪  runtime-fetched list  ∪  user customs (localStorage)
// An on-chain registry would slot in later as a 4th source — the merge layer is
// the seam; RelayerDescriptor never changes.
//
// Static entries are IDENTITY ONLY ({ name?, baseUrl }). Every live field —
// pubkey, floor (minTipTerm), balance, health — comes from probing
// ${baseUrl}/api/relayer-info. A static floor would lie (floors change after
// bootstrap, balances drain, relayers go down). pubkey is probed, never pinned:
// a wrong pubkey fails the broadcast signature, never steals (the claim is
// authority-signed; the relayer only signs as fee_payer). No list signing is
// needed for the same reason — a junk entry is at worst a dead relayer the
// client routes around.

import { PublicKey } from "@solana/web3.js";
import { fetchSharedRelayerInfo, type SharedRelayerInfo } from "./relayerAdapter";

export interface RelayerDescriptor {
  baseUrl: string;                       // "" = same-origin; else absolute https origin
  name?: string;                         // display hint only
  source: "bundled" | "list" | "custom";
}

export interface RelayerStatus {
  desc: RelayerDescriptor;
  reachable: boolean;
  // True when the probe THREW (network / CORS / non-2xx) — availability is
  // UNKNOWN (transient), as distinct from a definitive "not configured"
  // (reachable:false, unknown:false). Preserves fetchSharedRelayerInfo's
  // throw-vs-null contract so a SOL-less burner can wait instead of being
  // pushed to a topup that would also fail.
  unknown?: boolean;
  info?: SharedRelayerInfo;              // probed live fields (pubkey, minTipTerm, balance, …)
}

// ── Sources ──────────────────────────────────────────────────────────────────

// Always-present fallback: this deployment's own same-origin relayer.
const BUNDLED: RelayerDescriptor[] = [
  { baseUrl: "", name: "terminus", source: "bundled" },
];

// Optional runtime roster (token-list pattern): a static JSON file at a stable
// URL — freshness without a running service. Empty/unset → just bundled+customs.
const RELAYER_LIST_URL: string = (import.meta as any).env?.VITE_RELAYER_LIST_URL ?? "";

const CUSTOM_KEY = "terminus.custom_relayers";

// "" (same-origin) passes through; anything else must be an absolute https origin
// (an https UI cannot fetch an http relayer — mixed content). Trailing / stripped.
export function normalizeBaseUrl(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, "");
  if (s === "") return "";
  if (!/^https:\/\/[^ ]+$/i.test(s)) return null;
  return s;
}

export function getCustomRelayers(): RelayerDescriptor[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]");
    return (Array.isArray(raw) ? raw : [])
      .map((u: unknown) => normalizeBaseUrl(String(u)))
      .filter((u): u is string => !!u)
      .map((baseUrl) => ({ baseUrl, source: "custom" as const }));
  } catch {
    return [];
  }
}

// Returns false if the URL is invalid or same-origin (nothing to add).
export function addCustomRelayer(url: string): boolean {
  const baseUrl = normalizeBaseUrl(url);
  if (!baseUrl) return false;
  const cur = getCustomRelayers().map((d) => d.baseUrl);
  if (!cur.includes(baseUrl)) {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify([...cur, baseUrl]));
  }
  return true;
}

export function removeCustomRelayer(baseUrl: string): void {
  const cur = getCustomRelayers().map((d) => d.baseUrl).filter((u) => u !== baseUrl);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(cur));
}

async function fetchRuntimeList(): Promise<RelayerDescriptor[]> {
  if (!RELAYER_LIST_URL) return [];
  try {
    const res = await fetch(RELAYER_LIST_URL, { cache: "no-cache" });
    if (!res.ok) return [];
    const data = await res.json();
    const arr = Array.isArray(data) ? data : data?.relayers;
    return (Array.isArray(arr) ? arr : [])
      .map((e: any): RelayerDescriptor | null => {
        const baseUrl = normalizeBaseUrl(String(e?.baseUrl ?? ""));
        return baseUrl ? { baseUrl, name: e?.name, source: "list" } : null;
      })
      .filter((d): d is RelayerDescriptor => d !== null);
  } catch {
    return [];
  }
}

// Merge sources, deduped by baseUrl (first occurrence wins — bundled, then list,
// then custom). Identity is the URL; a bad/absent list can't compromise funds.
export async function loadRelayers(): Promise<RelayerDescriptor[]> {
  const all = [...BUNDLED, ...(await fetchRuntimeList()), ...getCustomRelayers()];
  const seen = new Set<string>();
  const merged: RelayerDescriptor[] = [];
  for (const d of all) {
    if (seen.has(d.baseUrl)) continue;
    seen.add(d.baseUrl);
    merged.push(d);
  }
  // INVARIANT: the bundled (same-origin) relayer stays FIRST — selectCheapest's
  // prefer-home tie-break returns the first eligible within the cheapest band,
  // which is only "home" if BUNDLED leads the merge. Guard it in dev so a future
  // source reorder can't silently break prefer-home.
  if (import.meta.env.DEV && merged.length > 0 && merged[0].source !== "bundled") {
    console.warn("relayers: bundled relayer is not first in merge order — prefer-home selection may misbehave");
  }
  return merged;
}

// ── Probe ────────────────────────────────────────────────────────────────────

export async function probeRelayer(
  desc: RelayerDescriptor,
  walletPubkey?: PublicKey,
): Promise<RelayerStatus> {
  try {
    const info = await fetchSharedRelayerInfo(walletPubkey, desc.baseUrl);
    return { desc, reachable: info !== null, info: info ?? undefined };
  } catch {
    // network error / CORS / non-2xx → availability UNKNOWN (transient), distinct
    // from a clean null = "not configured". Selection still routes around it
    // (reachable:false); `unknown` lets callers keep waiting vs giving up.
    return { desc, reachable: false, unknown: true };
  }
}

export function probeAll(
  descs: RelayerDescriptor[],
  walletPubkey?: PublicKey,
): Promise<RelayerStatus[]> {
  return Promise.all(descs.map((d) => probeRelayer(d, walletPubkey)));
}

// ── Selection ────────────────────────────────────────────────────────────────

export const floorOf = (s: RelayerStatus): number => s.info?.minTipTerm ?? 0;

// A relayer needs enough daily headroom to actually service a claim. A near-zero
// remaining budget passes a `> 0` test but then 429s at /api/relay, which
// reserves up to ~5M lamports for a first claim — so the UI would show ● ready
// for a relayer every claim bounces off of. Mirror that pre-check bound.
export const MIN_DAILY_HEADROOM_LAMPORTS = 5_000_000;

// Daily-budget headroom for at least one claim (or no KV quota advertised).
export const hasQuota = (s: RelayerStatus): boolean =>
  s.info?.dailyRemaining === undefined || s.info.dailyRemaining >= MIN_DAILY_HEADROOM_LAMPORTS;

// Single source of truth for "is this relayer usable right now": reachable,
// advertises a pubkey, floor is feasible vs the base-block ceiling, and has daily
// headroom. Selection (eligibleRelayers) and the UI status both use it, so the
// ● ready dot can't disagree with what AUTO actually picks.
export function relayerReady(s: RelayerStatus, tipCeilRaw: number): boolean {
  return s.reachable && !!s.info?.pubkey && floorOf(s) <= tipCeilRaw && hasQuota(s);
}

// Human-readable panel status — the first failing clause of relayerReady(), in
// order, so the label always matches the boolean.
export function relayerStateLabel(s: RelayerStatus, tipCeilRaw: number): string {
  if (!s.reachable || !s.info?.pubkey) return "○ down";
  if (floorOf(s) > tipCeilRaw) return "⚠ floor too high";
  if (!hasQuota(s)) return "⚠ no quota";
  return "● ready";
}

// Eligible = relayerReady, as a filter for selection call sites.
export function eligibleRelayers(statuses: RelayerStatus[], tipCeilRaw: number): RelayerStatus[] {
  return statuses.filter((s) => relayerReady(s, tipCeilRaw));
}

// Deterministic "cheapest, prefer-home" selection: the lowest-floor eligible
// relayer, with near-ties (within CHEAPEST_TIER_BAND) broken by list order — which
// puts the bundled / same-origin relayer first. For a young network that's a
// deliberate policy: prefer the relayer you operate, monitor, and serve CORS-free
// over unvetted community ones, unless one is meaningfully cheaper.
//
// Intentionally NOT randomized load-spreading. Distributing load across ≥2
// production relayers needs a real ranking signal (health / least-loaded /
// reputation) AND a stable per-probe choice held in state — never a render-time
// Math.random (selectCheapest runs in App's render body, so random there would
// re-roll the selected relayer on every re-render). See MAINNET_CHECKLIST §7;
// revisit when a second production relayer actually exists.
const CHEAPEST_TIER_BAND = 100_000; // 0.1 TERM raw — cost-tolerance for prefer-home

export function selectCheapest(statuses: RelayerStatus[], tipCeilRaw: number): RelayerStatus | null {
  const eligible = eligibleRelayers(statuses, tipCeilRaw);
  if (eligible.length === 0) return null;
  const minFloor = Math.min(...eligible.map(floorOf));
  return eligible.find((s) => floorOf(s) <= minFloor + CHEAPEST_TIER_BAND) ?? eligible[0];
}
