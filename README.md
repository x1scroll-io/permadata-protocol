# Permadata Protocol

**Permanent, compressed, chain-enforced data storage on X1.**

No UI. No server. No SDK required. The chain is the law.

---

## What It Is

Permadata is an open protocol for stamping any data permanently on the X1 blockchain. Once stamped, the data is:

- **Permanent** — stored in transaction history forever
- **Verifiable** — SHA256 hash + CRC32 checksum enforced on-chain
- **Compressed** — zstd compression reduces cost by 2–15x depending on data type
- **Trustless** — the on-chain program enforces the format; no trust in us required

**Cost:** ~0.003–0.015 XNT per stamp (~$0.003–$0.013 at current XNT price). Permanent, no recurring fees.

---

## Live on X1 Mainnet

| | |
|---|---|
| **Program ID** | `BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq` |
| **RPC** | `https://rpc.mainnet.x1.xyz` |
| **Chain** | X1 Mainnet (SVM-compatible) |
| **Chunk size** | 500 bytes |
| **Spec** | [SPEC.md](./SPEC.md) |

---

## Quick Start (Node.js)

### Install dependencies

```bash
npm install @solana/web3.js @mongodb-js/zstd
```

### Stamp a file

```bash
node demo.mjs myfile.txt --codec text
```

### Retrieve by Stamp ID

```bash
node retrieve.mjs <stamp_id_hex> --out recovered.txt
```

### Example output

```
✅ STAMP COMPLETE
  Stamp ID:     60812828cde4
  Program:      BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq
  Codec:        0x02 (text)
  Chunks:       1
  Data:         135 → 117 bytes (1.15x)
  Cost:         ~0.000116 XNT

🔗 Permanent. Immutable. On-chain. No server required.
```

```
✅ RETRIEVAL COMPLETE
  Stamp ID:     60812828cde4
  CRC32:        ✅ verified
  Hash:         ✅ verified
  Integrity:    ✅ PERFECT

🔗 Data retrieved from X1 chain. No server. No trust required.
```

---

## How It Works

```
YOUR DATA
    ↓
[1] Add Permadata header (PERD magic + codec + CRC32 + length)
    ↓
[2] Compress with zstd level 3
    ↓
[3] Split into 500-byte chunks
    ↓
[4] For each chunk:
    ├── Store chunk data in transaction MEMO field (permanent)
    └── Register chunk SHA256 hash via on-chain program (enforced)
    ↓
[5] Finalize: on-chain program seals the StampRecord PDA (immutable)
    ↓
─── ON CHAIN FOREVER ───
    ↓
[6] Retrieve: fetch PDAs → scan tx logs → verify hashes
    ↓
[7] Decompress → verify CRC32 → original file ✅
```

---

## Build Your Own Client

You don't need our scripts. Any developer can implement Permadata directly from the spec.

### Instruction: `register_chunk`

```
Discriminator: sha256("global:register_chunk")[0:8]

Accounts:
  [writable] chunk_record PDA  seeds=["perm_chunk", stamp_id(6), chunk_index_le(2)]
  [writable, signer] payer
  [] system_program

Data (little-endian):
  stamp_id:       [u8; 6]   — first 6 bytes of sha256(compressed_payload)
  chunk_index:    u16       — 0-based
  chunk_total:    u16       — total chunks
  chunk_hash:     [u8; 32]  — sha256(chunk_data)
  chunk_crc:      u32       — crc32(chunk_data)
  chunk_data_len: u16       — actual bytes in this chunk (max 500)

Memo (separate tx, same session):
  "PERM:<stamp_id_hex>:<chunk_index>:<chunk_total>:<base64(chunk_data)>"
```

### Instruction: `finalize_stamp`

```
Discriminator: sha256("global:finalize_stamp")[0:8]

Accounts:
  [writable] stamp_record PDA  seeds=["perm_stamp", stamp_id(6)]
  [writable, signer] payer
  [] system_program
  [] chunk_record PDAs (remaining accounts, all chunks in order)

Data (little-endian):
  stamp_id:      [u8; 6]
  chunk_total:   u16
  codec_type:    u8        — 0x01=RAW, 0x02=UTF8_TEXT, 0x03=UTF8_EN, 0x04=MATHSCI, 0x05=CBOR
  data_length:   u32       — original uncompressed data length
  checksum:      u32       — crc32(original data)
  payload_hash:  [u8; 32]  — sha256(compressed_payload)
```

### Instruction: `verify_stamp` (read-only)

```
Discriminator: sha256("global:verify_stamp")[0:8]

Accounts:
  [] stamp_record PDA

Returns metadata in program logs:
  "PERMADATA_VERIFY stamp=<hex> codec=<hex> chunks=<n> bytes=<n> hash=<hex> slot=<n> ok=true"
```

---

## Codec Types

| ID | Name | Description |
|----|------|-------------|
| `0x01` | RAW | Raw bytes, zstd compressed |
| `0x02` | UTF8_TEXT | UTF-8 text, any language |
| `0x03` | UTF8_EN | English-optimized text |
| `0x04` | MATHSCI | Math/science structured data |
| `0x05` | CBOR | CBOR-encoded objects |

---

## Permadata Header Format

Every payload begins with a 16-byte header before compression:

```
Offset  Size  Field
0       4     Magic: 0x50455244 ("PERD")
4       1     Protocol version: 0x01
5       1     Codec type (see above)
6       2     Reserved: 0x0000
8       4     Original data length (u32 LE)
12      4     CRC32 of original data (u32 LE)
```

---

## Retrieve Without Our Scripts

To retrieve stamped data using only a Solana RPC client:

1. Derive stamp PDA: `findPDA(["perm_stamp", stamp_id], PROGRAM_ID)`
2. Fetch PDA account → decode StampRecord (see SPEC.md for layout)
3. For each chunk: derive chunk PDA `findPDA(["perm_chunk", stamp_id, chunk_index_le], PROGRAM_ID)`
4. Scan transaction logs from the payer address for: `Memo (len N): "PERM:<stamp_id>:<idx>:<total>:<base64>"`
5. Verify each chunk: `sha256(chunk_data)` must match `chunk_record.chunk_hash`
6. Concatenate chunks → zstd decompress → strip 16-byte header → verify CRC32

Any RPC client in any language. No SDK needed.

---

## Live Stamps (Examples)

| Stamp ID | Codec | Data | Chunks |
|----------|-------|------|--------|
| `60812828cde4` | UTF8_TEXT | 135 bytes | 1 |
| `be2df2d3afb8` | UTF8_TEXT | 1,195 bytes | 1 |
| `6124397f0aa1` | MATHSCI | 10,392 bytes | 8 |
| `65cc8935117d` | UTF8_TEXT | 268 bytes | 1 |

All permanently retrievable from X1 mainnet. No expiry. No fees.

---

## File Structure

```
permadata-protocol/
├── README.md          ← you are here
├── SPEC.md            ← full protocol specification
├── ROADMAP.md         ← development roadmap
├── demo.mjs           ← stamp any file to X1
├── retrieve.mjs       ← retrieve any stamp from X1
└── permadata-program/ ← Anchor on-chain program (Rust)
    └── programs/
        └── permadata-program/
            └── src/lib.rs
```

---

## License

MIT. Build on it.

---

*"The chain is the law. Everything else is optional."*
