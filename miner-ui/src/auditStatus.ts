// What the site says about the program's security audit: the header tag and
// its HELP entry. MAINNET_CHECKLIST §8 asks for "unaudited" to be said plainly
// until the external audit (§5) is done. When it is, publish the report and
// change this file the same day; nothing else on the site claims either way.
export const AUDIT_STATUS = {
  /** Shown in the header; pressing it opens HELP. */
  tag: "UNAUDITED",
  tagTitle: "The on-chain program has not had an external security audit. Press for details.",
  question: "Has the program been audited?",
  answer:
    "No. The on-chain program that mints TERM has not had an external security audit. " +
    "Its source is public (github.com/TermiMiner/Terminus-Coin). An audit is planned before the " +
    "project seeds any market for TERM, and its report will be published when it is done. " +
    "Until then, treat the program as experimental.",
  /** Ends the “Is my TERM safe?” answer. */
  safetyNote: "And the program itself has not had a security audit yet (see “Has the program been audited?”).",
};
