// Lucky-block tier — single source for the bonus-bit cutoffs (8/6/4) and their
// glyph + name, shared by the terminal log (useMiner) and the full-screen reveal
// (ClaimReveal) so the two can't drift. Mirrors the on-chain BONUS_CAP tiers.
export type LuckClass = "jackpot" | "bighit" | "lucky" | "base";

export interface LuckTier {
  glyph: string;
  label: string;   // "" for the base tier (no luck flourish)
  cls: LuckClass;
}

export function luckTier(bits: number): LuckTier {
  if (bits >= 8) return { glyph: "🎰", label: "JACKPOT", cls: "jackpot" };
  if (bits >= 6) return { glyph: "⭐", label: "BIG HIT", cls: "bighit" };
  if (bits >= 4) return { glyph: "✨", label: "LUCKY",   cls: "lucky" };
  return { glyph: "🪙", label: "", cls: "base" };
}
