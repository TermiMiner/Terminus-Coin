import { useEffect, useMemo, useState } from "react";
import type { MinerEvent } from "./useMiner";
import { luckTier } from "./luck";
import "./claimReveal.css";

// Reveal animation params (hold / confetti / count-up) layered on the shared
// luckTier glyph/label/cls — the bonus-bit cutoffs live ONLY in luck.ts, so the
// reveal can't drift from the terminal log.
function tierOf(bits: number) {
  const t = luckTier(bits);
  const fx =
    t.cls === "jackpot" ? { hold: 3400, confetti: 48, countUp: true } :
    t.cls === "bighit"  ? { hold: 2600, confetti: 22, countUp: true } :
    t.cls === "lucky"   ? { hold: 1900, confetti: 0,  countUp: false } :
                          { hold: 1100, confetti: 0,  countUp: false };
  return { ...t, ...fx };
}

const CONFETTI_COLORS = ["#00ff41", "#d4af37", "#ffd700", "#ff3333", "#00d4ff", "#ff66cc"];
const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Full-screen, non-blocking reveal played when a claim lands. Driven by useMiner's
 * `lastEvent`; intensity scales with the bonus tier (base pulse → ✨ → ⭐ + confetti
 * → 🎰 jackpot with confetti, shake, count-up). pointer-events:none and
 * auto-dismissed, so it never interrupts mining or clicks.
 */
export default function ClaimReveal({ lastEvent }: { lastEvent: MinerEvent | null }) {
  const [shown, setShown] = useState<MinerEvent | null>(null);
  const [displayTerm, setDisplayTerm] = useState(0);

  // Show on each new "claimed" event; auto-dismiss after the tier's hold.
  useEffect(() => {
    if (!lastEvent || lastEvent.kind !== "claimed") return;
    if (typeof document !== "undefined" && document.hidden) return; // no point on a hidden tab
    setShown(lastEvent);
    const { hold } = tierOf(lastEvent.bonusBits ?? 0);
    const id = window.setTimeout(
      () => setShown((cur) => (cur?.seq === lastEvent.seq ? null : cur)),
      hold,
    );
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent?.seq]);

  // Count-up for big reveals (skipped under reduced-motion or for small tiers).
  useEffect(() => {
    if (!shown) return;
    const t = tierOf(shown.bonusBits ?? 0);
    if (!t.countUp) return; // base/lucky read shown.termGross directly — no count-up, no state to set
    const target = shown.termGross ?? 0;
    if (target <= 0 || reducedMotion()) { setDisplayTerm(target); return; }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 750);
      setDisplayTerm(target * (1 - Math.pow(1 - p, 3))); // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.seq]);

  // Confetti pieces — randomized once per reveal.
  const confetti = useMemo(() => {
    if (!shown) return [];
    const n = tierOf(shown.bonusBits ?? 0).confetti;
    return Array.from({ length: n }, (_, i) => ({
      key: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.35,
      dur: 1.6 + Math.random() * 1.4,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      rot: Math.round(Math.random() * 720 - 360),
      size: 6 + Math.round(Math.random() * 7),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.seq]);

  if (!shown) return null;
  const t = tierOf(shown.bonusBits ?? 0);
  const term = t.countUp ? displayTerm : (shown.termGross ?? 0);

  return (
    <div className={`claim-reveal cr-${t.cls}`} key={shown.seq} aria-hidden="true">
      <div className="cr-flash" />
      {confetti.length > 0 && (
        <div className="cr-confetti">
          {confetti.map((c) => (
            <span
              key={c.key}
              className="cr-piece"
              style={{
                left: `${c.left}%`,
                width: `${c.size}px`,
                height: `${c.size}px`,
                background: c.color,
                animationDelay: `${c.delay}s`,
                animationDuration: `${c.dur}s`,
                ["--rot" as any]: `${c.rot}deg`,
              }}
            />
          ))}
        </div>
      )}
      <div className="cr-center">
        <div className="cr-glyph">{t.glyph}</div>
        {shown.termGross !== undefined && (
          <div className="cr-term">+{term.toFixed(2)} TERM</div>
        )}
        {t.label && <div className="cr-label">{t.label} · +{shown.bonusBits} bits</div>}
      </div>
    </div>
  );
}
