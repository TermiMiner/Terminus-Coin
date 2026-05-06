import { keccak_256 } from "@noble/hashes/sha3";

export interface MineRequest {
  lastHash: number[];
  pubkey: number[];
  difficulty: string; // u64 serialised as decimal string
}

export interface MineResult {
  nonce: string; // bigint serialised as decimal string
  attempts: number;
  elapsed: number;
}

const MAX_U64 = (1n << 64n) - 1n;

self.onmessage = (ev: MessageEvent<MineRequest>) => {
  const { lastHash, pubkey, difficulty } = ev.data;

  const diff = BigInt(difficulty);
  const target = diff <= 1n ? MAX_U64 : MAX_U64 / diff;

  const input = new Uint8Array(72);
  input.set(lastHash, 8);
  input.set(pubkey, 40);
  const inputView = new DataView(input.buffer);

  const t0 = performance.now();
  let attempts = 0;

  for (let n = 0n; ; n++) {
    inputView.setBigUint64(0, n, true);
    attempts++;
    const hash = keccak_256(input);
    // Read first 8 bytes of hash as big-endian u64
    const hashHigh =
      (BigInt(hash[0]) << 56n) |
      (BigInt(hash[1]) << 48n) |
      (BigInt(hash[2]) << 40n) |
      (BigInt(hash[3]) << 32n) |
      (BigInt(hash[4]) << 24n) |
      (BigInt(hash[5]) << 16n) |
      (BigInt(hash[6]) <<  8n) |
       BigInt(hash[7]);
    if (hashHigh <= target) {
      const elapsed = performance.now() - t0;
      self.postMessage({ nonce: n.toString(), attempts, elapsed } satisfies MineResult);
      return;
    }
  }
};
