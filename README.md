# Permadata Protocol

**Permanent hash anchors on-chain. Data retrievable via archival RPCs.**  
**Dual-chain: Solana + X1.**  
**Same model as Ethereum calldata — integrity on-chain, availability in history.**

---

## 🔴 Everyone else gives you a pointer. We give you the data.

Most "permanent" storage is lying to you:
- **Arweave** → storage proofs with 30x+ cost premium
- **IPFS** → dies when pinning services stop paying
- **Shadow Drive** → went dark for months in 2023
- **Magic Eden CDN** → centralized, they control your NFT metadata

**Permadata stores the SHA-256 hash of your data in a permanent on-chain PDA.**
The raw data is written to an immutable transaction instruction on Solana or X1.
The hash is the integrity anchor — permanent and trustless.
The data itself is retrievable through archival full-history RPC nodes.
This is the same separation Ethereum makes between calldata (historical) and state (active).

**Why this matters:** Storing 28.9MB in a transaction costs $0.000058.
Storing it in account state would cost tens of thousands of dollars in rent-exemption.
The hash gives you cryptographic proof forever. The archival layer gives you retrieval.

**On X1, retrieval is guaranteed** — we run the archival node (x1scroll.io).
**On Solana, retrieval is market-backed** — multiple RPC providers archive full history
(Triton, Helius, Syndica) because the chain has economic value.

The protocol makes a deliberate trade-off: integrity anchors on-chain,
availability through the archival market. Same design as Ethereum calldata,
not Filecoin's storage proofs — which is why it's orders of magnitude cheaper.

---

## 🚀 Live on Mainnet

| Chain | Program ID | Status |
|-------|-----------|--------|
| **Solana** | `ENkUDdUvd65KexkWBYPwy2BfyHepaY6puvjuVXpbsvMi` | ✅ **Live** |
| X1 Network | `BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq` | ✅ Live (proves portability) |

---

## 💰 Protocol Economics

| Operation | Cost | Fee |
|-----------|------|-----|
| `register_chunk` | Network fee only | FREE |
| `finalize_stamp` | ~◎0.000575 SOL (~$0.05) | Enforced on-chain |
| `verify_stamp` | Network fee only | FREE |

Fees are **hardcoded in the program** — cannot be bypassed by any caller.  
Treasury: `FSD3mywrvcFKE8AB4mwwQJkeHaftYsmtGw8cux6EhiR6`

---

## ⚡ Quick Start (No SDK Required)

**Setup:**
```bash
mkdir permadata && cd permadata
npm init -y
npm install @solana/web3.js@1.91.8 rpc-websockets@7.5.1 @mongodb-js/zstd
curl -s https://raw.githubusercontent.com/x1scroll-io/permadata-protocol/main/judge-package/stamp.mjs -o stamp.mjs
curl -s https://raw.githubusercontent.com/x1scroll-io/permadata-protocol/main/judge-package/retrieve.mjs -o retrieve.mjs
```

**Stamp any file:**
```bash
node stamp.mjs mydocument.txt
# Stamp ID: a75abaf30ee0
# Explorer: https://explorer.solana.com/tx/4wjjeeh...
```

**Delete it. Retrieve it from chain:**
```bash
rm mydocument.txt
node retrieve.mjs a75abaf30ee0
# Permadata Protocol - Arnett Esters - Detroit - Mon May 11...
# No server. No trust. Data lives on Solana forever.
```

**That's it.** Node.js + a funded wallet. No SDK. No API key. No account.

---

## 🎨 Use Cases

**NFT Metadata Permanence**  
NFT images and metadata hosted on IPFS or CDNs become 404s when services die. Stamp metadata to Permadata before minting — your art lives in Solana transaction history forever. No Magic Eden. No Pinata. No expiration.

**AI Agent Persistent Memory**  
AI agents need memory that survives server crashes, company shutdowns, and billing failures. Stamp knowledge, decisions, and datasets on-chain. Permadata is permanent storage for autonomous systems.

**Legal & Document Notarization**  
Stamp contracts, deeds, and agreements with cryptographic proof of existence at a specific moment. $0.05. No lawyer. No notary. No expiration.

**Music & Creative Rights**  
Artists stamp master recordings before release. Proof of authorship. Proof of date. Forever. No streaming platform owns your master.

**Scientific Data Integrity**  
Researchers stamp datasets before publication. Immutable proof that data was not modified after results were known.

---

## 🔧 10 Codec Types (All Enforced On-Chain)

| Codec | Byte | Compression | Use Case |
|-------|------|-------------|---------|
| RAW | `0x01` | 1x | Any raw bytes |
| UTF8_TEXT | `0x02` | 2x–5x | Documents, legal, receipts |
| UTF8_EN | `0x03` | 3x–5x | English prose |
| MATHSCI | `0x04` | 5x–10x | Scientific/sensor data |
| CBOR | `0x05` | 1.5x–3x | Structured data |
| IMAGE | `0x06` | 1x–8x | Photos, NFTs, medical scans |
| AUDIO | `0x07` | 1x–6x | Music, voice, podcasts |
| VIDEO | `0x08` | 1x–50x | Clips, film, evidence |
| BINARY | `0x09` | 1x | Code, firmware, executables |
| MULTIPART | `0x0A` | — | Large files up to ~65MB |

Each codec enforces a magic header on every chunk. Invalid format = rejected transaction.

---

## 📐 Architecture

```
User data
    │
    ▼
[Compression + codec encoding]
    │
    ▼
[Chunked into 500-byte pieces]
    │
    ├──► Transaction memo field   ← raw data, permanent in Solana tx history
    │
    └──► register_chunk instruction
              │
              ▼
         ChunkRecord PDA (SHA256 hash, enforces integrity forever)
              │
              ▼
         finalize_stamp instruction (collects fee, seals stamp)
              │
              ▼
         StampRecord PDA (immutable, queryable forever)
```

**Max single stamp:** ~256KB (512 chunks × 500 bytes)  
**Max multipart file:** ~65MB (256 stamps × 512 chunks × 500 bytes)

---

## 📜 Protocol Spec

Full wire format specification: [SPEC.md](./SPEC.md)  
Stamped on-chain (immutable proof of authorship): `8020d25ffad2`

Technical whitepaper: [WHITEPAPER.md](./WHITEPAPER.md)  
Stamped on-chain: `ce15dc1054be`

---

## 🏗️ Repository Structure

```
permadata-protocol/
├── permadata-program/          ← Rust/Anchor on-chain program
│   └── programs/permadata-program/src/lib.rs   ← 1,200+ lines, 10 codecs
├── demos/                      ← Working demo scripts (Node.js)
│   ├── stamp.mjs               ← Interactive stamp CLI
│   ├── retrieve.mjs            ← Retrieve by stamp ID
│   ├── demo-text.mjs           ← Text/document demo
│   ├── demo-mathsci.mjs        ← Scientific data demo
│   ├── demo-image.mjs          ← Image demo
│   ├── demo-audio.mjs          ← Audio demo
│   └── demo-binary.mjs         ← Binary/executable demo
├── judge-package/              ← Self-contained package for judges
│   ├── stamp.mjs               ← Stamp any file
│   └── retrieve.mjs            ← Retrieve by stamp ID
├── SPEC.md                     ← Full protocol specification
└── WHITEPAPER.md               ← Technical whitepaper
```

---

## 🧪 Verify It Yourself

The Solana program is live. Check it:
```bash
solana program show ENkUDdUvd65KexkWBYPwy2BfyHepaY6puvjuVXpbsvMi --url mainnet-beta
```

See a live stamp on Solana Explorer:  
`https://explorer.solana.com/tx/4wjjeehUSAoZX3vXSFs22nHE2b5t2xE8tMB9yZLP7Rxr7tGwK6PNcPUbUmMzyipkJjHy3HWczHaPrW2HpSTmHCFN`

---

## 👤 Builder

**Arnett Esters** | Detroit, Michigan  
Former trauma nurse → blockchain infrastructure builder  
x1scroll.io | permadata.io | @ArnettX1

*"Protocols are just bodies that can't bleed. Same precision. Same zero-error discipline. Different stakes."*

---

*Permadata Protocol v1.0.0 — Built during the Solana Frontier Hackathon, May 2026*  
*Deployed on Solana mainnet and X1 Network. No servers. No subscriptions. Forever.*
