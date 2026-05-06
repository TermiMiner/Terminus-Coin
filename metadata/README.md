# Token metadata

This folder contains the artifacts referenced by the on-chain Metaplex Token Metadata account for TERM.

## Files

| File | Purpose |
|---|---|
| `term.json` | Metaplex JSON descriptor — the URL stored on-chain points at this file |
| `logo.jpg` | Token logo, 1024×1024 JPEG, 198 KB. Referenced by `term.json` |
| `logo-source.png` | High-res lossless source kept for archival / future re-export |

## Hosting

### Devnet — GitHub + jsdelivr (free, immediate)

URLs in `term.json` are pre-wired to `TermiMiner/terminus-coin`. To activate:

1. Push the repo to `https://github.com/TermiMiner/terminus-coin` (main branch)
2. Wait ~1–2 minutes for jsdelivr to pick up the commit
3. Run `yarn metadata` — it pre-flight fetches the URL and refuses to broadcast if the JSON isn't reachable
4. Files become accessible at:
   ```
   https://cdn.jsdelivr.net/gh/TermiMiner/terminus-coin@main/metadata/term.json
   https://cdn.jsdelivr.net/gh/TermiMiner/terminus-coin@main/metadata/logo.jpg
   ```

### Mainnet — Arweave (permanent, costs ~$0.10)

For mainnet credibility, host on Arweave instead — files live forever even if GitHub goes away:

1. Get an Arweave wallet (e.g. ArConnect browser extension)
2. Buy a tiny amount of AR token
3. Upload `logo.png` first via [arweave.app](https://arweave.app) → note the tx ID (becomes `https://arweave.net/<TX_ID>`)
4. Edit `term.json`: change the `image` field and `properties.files[0].uri` to the Arweave URL
5. Upload `term.json` → note its tx ID
6. Run `yarn metadata --uri https://arweave.net/<JSON_TX_ID>`

## Updating later

The on-chain metadata account is created with `is_mutable: true`. The `update_authority` is set to your deployer wallet, so you can change the URI any time using the Metaplex update instruction without redeploying the program.

## Logo requirements (already met by current logo)

- **Format:** JPEG for photographic content (the current bronze coin), PNG for logos with sharp edges/text
- **Size:** at least 512×512, ideally 1024×1024 (wallets downscale, never upscale)
- **File size:** ≤200 KB (mobile wallets re-fetch frequently)
- **Background:** transparent or solid; Phantom shows it on a dark background by default
- **Shape:** square — many wallets crop to a circle on display
