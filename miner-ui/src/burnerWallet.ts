import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Browser-localStorage keypair wallet — used both for "burner" mining wallets
 * and for the optional relayer that pays fees on burners' behalf.
 *
 * SECURITY: the secret key is plaintext-accessible to any JS on the page,
 * any browser extension, and anyone with dev-tools access to this device.
 * Use ONLY for devnet / testing. Never store mainnet TERM that has real value
 * here, and never put more than you'd be comfortable losing into the relayer.
 *
 * Storage format matches `solana-keygen` (JSON array of 64 bytes), so a
 * keypair can be exported and used via the standard CLI.
 */

export interface MinerWallet {
  publicKey: PublicKey | null;
  signTransaction:
    | (<T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>)
    | undefined;
}

export class BrowserKeypairWallet implements MinerWallet {
  private keypair: Keypair | null = null;

  constructor(private readonly storageKey: string) {
    this.loadFromStorage();
  }

  get publicKey(): PublicKey | null {
    return this.keypair?.publicKey ?? null;
  }

  get signTransaction(): MinerWallet["signTransaction"] {
    if (!this.keypair) return undefined;
    const kp = this.keypair;
    return async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (tx instanceof Transaction) tx.partialSign(kp);
      else (tx as VersionedTransaction).sign([kp]);
      return tx;
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  generate(): PublicKey {
    this.keypair = Keypair.generate();
    this.saveToStorage();
    return this.keypair.publicKey;
  }

  /**
   * Import a secret key in any of the formats users typically paste:
   *   • JSON array — `[123,45,67,...]` (solana-keygen / Solflare format)
   *   • base58 string — `vFM2d7k...` (Phantom export format, ≈88 chars)
   *   • hex string — `0a1b2c...` (less common, 128 chars)
   * The format is detected automatically from the input.
   */
  importFromJson(input: string): PublicKey {
    const trimmed = input.trim();
    let secret: Uint8Array | null = null;
    let formatTried = "";

    if (trimmed.startsWith("[")) {
      formatTried = "JSON array";
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error("JSON array must have exactly 64 numbers");
      }
      secret = new Uint8Array(arr);
    } else if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
      formatTried = "hex";
      secret = new Uint8Array(trimmed.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    } else {
      formatTried = "base58";
      try {
        const decoded = bs58.decode(trimmed);
        if (decoded.length !== 64) {
          throw new Error(`base58 string decoded to ${decoded.length} bytes, expected 64`);
        }
        secret = decoded;
      } catch (err: any) {
        throw new Error(`Couldn't parse as JSON, base58, or hex. Last format tried: ${formatTried}. (${err?.message ?? err})`);
      }
    }

    this.keypair = Keypair.fromSecretKey(secret);
    this.saveToStorage();
    return this.keypair.publicKey;
  }

  exportAsJson(): string | null {
    if (!this.keypair) return null;
    return JSON.stringify(Array.from(this.keypair.secretKey));
  }

  clear(): void {
    this.keypair = null;
    localStorage.removeItem(this.storageKey);
  }

  // ── Relayer-specific: send SOL to another address ─────────────────────

  async topUp(connection: Connection, recipient: PublicKey, lamports: number): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not initialised — generate or import first");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: this.keypair.publicKey });
    tx.add(SystemProgram.transfer({
      fromPubkey: this.keypair.publicKey,
      toPubkey: recipient,
      lamports,
    }));
    tx.sign(this.keypair);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private loadFromStorage(): void {
    const stored = localStorage.getItem(this.storageKey);
    if (!stored) return;
    try {
      const arr = JSON.parse(stored);
      this.keypair = Keypair.fromSecretKey(new Uint8Array(arr));
    } catch {
      localStorage.removeItem(this.storageKey);
    }
  }

  private saveToStorage(): void {
    if (!this.keypair) return;
    localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.keypair.secretKey)));
  }
}

// Backwards-compat alias
export const BurnerWallet = BrowserKeypairWallet;

export const BURNER_STORAGE_KEY = "terminus.burner_secret_v1";
export const RELAYER_STORAGE_KEY = "terminus.relayer_secret_v1";
