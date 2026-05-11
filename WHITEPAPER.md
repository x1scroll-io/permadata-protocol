# Permadata Protocol
## A Chain-Native Permanent Data Storage Protocol

**Version:** 1.0.0  
**Date:** May 11, 2026  
**Author:** Arnett Esters / x1scroll.io  
**Program ID:** `BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq`  
**Chain:** X1 Mainnet (Solana-Compatible SVM)  
**Website:** permadata.io  

---

## Abstract

Permadata is a trustless, chain-enforced protocol for permanently storing any type of data on a Solana-compatible blockchain. Unlike existing solutions that store pointers to off-chain servers, Permadata places data directly inside transaction history — the most durable, decentralized storage layer a blockchain provides. The protocol enforces data format integrity through an on-chain program, supports ten distinct codec types covering text, scientific data, images, audio, video, binary executables, and large multi-part files, and requires no SDK, no server, and no recurring fees. Pay once. Stored forever.

---

## 1. Introduction

### 1.1 The Permanent Storage Problem

Digital data is fragile. Files stored on centralized servers disappear when companies shut down, change business models, or stop paying hosting bills. "Permanent" storage solutions built on blockchain frequently fail this promise by storing only a pointer — a URL or content hash — to data that lives on a separate system. When that system goes offline, the pointer becomes worthless.

This problem is acute across multiple domains:

- **Legal records** — contracts, deeds, and court documents stamped to chain point to servers that may not exist in ten years
- **Scientific research** — datasets linked in publications become inaccessible when hosting agreements expire
- **Digital art** — NFT images stored on IPFS or centralized CDNs disappear when pinning services stop
- **Medical records** — patient data stored off-chain is vulnerable to provider failures
- **Software releases** — binaries and firmware linked from blockchain records become unverifiable when servers go offline

Existing blockchain storage solutions — Arweave, Shadow Drive, IPFS pinning services — all suffer from the same architectural weakness: they separate the proof of existence (on-chain) from the data itself (off-chain). Permadata eliminates this separation.

### 1.2 The Permadata Solution

Permadata stores data directly in blockchain transaction history through two mechanisms:

1. **Transaction memos** — the raw data payload travels inside transaction memo fields, making it as permanent as the chain's transaction history
2. **PDA chunk records** — cryptographic hashes of each data chunk are stored in on-chain Program Derived Accounts (PDAs), enforcing integrity forever

The on-chain program validates data format at registration time. Invalid data is rejected before it reaches the chain. Valid data is sealed with a finalization instruction that creates an immutable stamp record — a permanent, queryable proof that specific data existed at a specific moment.

### 1.3 Design Philosophy

Permadata is built on five principles:

**Chain-enforced.** The on-chain program is the authority. No SDK, API, or third party can bypass its validation rules. Invalid format equals rejected transaction — period.

**Language-agnostic.** The protocol is defined by a wire format specification, not a library. Any language — Rust, Python, JavaScript, Go, C, or a shell script — can construct valid transactions if it follows the spec. The program does not care how the transaction was built.

**No SDK required.** The specification is the interface. Developers who read SPEC.md can integrate without installing any package or calling any API.

**Immutable.** Once finalized, a stamp cannot be modified, extended, or deleted. The chain is the record.

**Permanent.** Transaction history on a live blockchain is replicated across every validator. There is no single point of failure. There is nothing to go offline.

---

## 2. Architecture

### 2.1 Data Flow

```
User data
    │
    ▼
[Pre-processing]         ← codec-specific encoding (delta, YCbCr, etc.)
    │
    ▼
[Chunking]               ← split into 500-byte chunks
    │
    ├──► Transaction memo (raw chunk data, permanent in tx history)
    │
    └──► register_*_chunk instruction
              │
              ▼
         [On-chain program validates wire format]
              │
              ▼
         ChunkRecord PDA (hash + metadata, on-chain forever)
              │
              ▼
         finalize_stamp instruction
              │
              ▼
         StampRecord PDA (sealed, immutable, queryable)
```

### 2.2 On-Chain Accounts

**ChunkRecord PDA**
- Seeds: `[b"perm_chunk", stamp_id (6 bytes), chunk_index (u16 LE)]`
- Size: 96 bytes
- Contents: stamp_id, chunk_index, chunk_total, chunk_hash (SHA256), chunk_crc (CRC32), data_len, payer pubkey, slot

**StampRecord PDA**
- Seeds: `[b"perm_stamp", stamp_id (6 bytes)]`
- Size: 98 bytes
- Contents: stamp_id, codec_type, chunk_total, data_length, checksum, payload_hash (SHA256), payer pubkey, slot, finalized flag

### 2.3 Stamp ID

```
stamp_id = SHA256(payload)[0:6]
```

Six bytes (12 hex characters). Compact and collision-resistant for practical use. Derived from the payload hash, making the stamp ID itself a fingerprint of the content.

### 2.4 Chunk Size

Maximum chunk size: **500 bytes**  
Maximum chunks per stamp: **512**  
Maximum single stamp size: **~256KB**

For larger files, the MULTIPART codec links multiple stamps into one logical file (see Section 3.10).

---

## 3. Codec Registry

The `codec_type` byte identifies the format of the stamped data. The on-chain program enforces this byte at `finalize_stamp` — invalid codec types are rejected.

| Byte | Name | Description |
|------|------|-------------|
| `0x01` | RAW | Raw bytes — no transformation |
| `0x02` | UTF8_TEXT | UTF-8 text, any language |
| `0x03` | UTF8_EN | English-optimized text |
| `0x04` | MATHSCI | Scientific and numerical data |
| `0x05` | CBOR | CBOR-encoded structured data |
| `0x06` | IMAGE | Photos, artwork, medical imaging |
| `0x07` | AUDIO | Music, voice, podcasts |
| `0x08` | VIDEO | Video clips and film |
| `0x09` | BINARY | Executables, firmware, archives |
| `0x0A` | MULTIPART | Large files spanning multiple stamps |

---

## 3.1 RAW Codec (0x01)

The RAW codec accepts any byte sequence without transformation or validation beyond chunk size limits. It serves as the universal fallback for data that does not fit a more specific codec.

**Use cases:** proprietary binary formats, encrypted blobs, experimental data, any file type without a dedicated codec.

**Wire format:** None beyond standard chunking. Data is split into 500-byte chunks and submitted as-is.

**Compression:** 1x (no compression applied at protocol level).

---

## 3.2 UTF8_TEXT Codec (0x02)

The UTF8_TEXT codec stores human-readable text in any natural language. No transformation is applied beyond standard chunking. The codec signals to readers that the payload is valid UTF-8 text, enabling correct character decoding during retrieval.

**Use cases:** legal contracts, academic papers, receipts, invoices, medical notes, correspondence, news articles, blog posts.

**Wire format:** Valid UTF-8 encoded bytes, chunked at 500-byte boundaries.

**Compression:** 2x–4x typical for English prose using adaptive entropy coding in pre-processing tools.

**On-chain log:**
```
PERMADATA_STAMP stamp=<hex> codec=0x02 chunks=<n> bytes=<n> hash=<hex>
```

---

## 3.3 UTF8_EN Codec (0x03)

The UTF8_EN codec extends UTF8_TEXT with English-language statistical optimization. Pre-processing applies adaptive arithmetic coding with a context model trained on English text patterns. The on-chain program does not validate the codec's effectiveness — it trusts the payer to use this codec appropriately for English content.

**Use cases:** English-language documents where maximum compression is desired — legal briefs, research papers, technical documentation.

**Wire format:** Same as UTF8_TEXT. The codec byte signals English-optimized encoding to retrieval tools.

**Compression:** 3x–5x for typical English prose.

---

## 3.4 MATHSCI Codec (0x04)

The MATHSCI codec stores structured numerical and scientific data with type-tagged binary encoding. It is designed for researchers, engineers, and IoT systems that produce streams of numbers requiring permanent, verifiable archival.

**Magic header (enforced on every chunk):** `[0x4D, 0x53, 0x43, 0x49]` — ASCII "MSCI"

**Record format** (packed after magic, repeating):
```
[type_tag: u8][count: u16 LE][values: count × sizeof(type)]
```

**Type tags:**

| Tag | Type | Bytes | Use Case |
|-----|------|-------|---------|
| `0x01` | f64 | 8 | Floating point measurements, coordinates |
| `0x02` | f32 | 4 | Single-precision floats |
| `0x03` | i64 | 8 | Signed 64-bit integers |
| `0x04` | i32 | 4 | Signed 32-bit integers |
| `0x05` | u64 | 8 | Unsigned 64-bit integers |
| `0x06` | u8 | 1 | Raw bytes, unsigned 8-bit |
| `0x07` | complex64 | 8 | f32 real + f32 imaginary (signal processing) |
| `0x08` | bool_array | 1 | Packed bits — 8 booleans per byte |
| `0x09` | timestamp | 8 | u64 Unix nanoseconds |

**Optional metadata block** (chunk 0 only, marked by `0xFF`):
```
[0xFF][unit_len: u8][unit_string: unit_len bytes][precision: u8][dimension_count: u8][dims: dimension_count × u16 LE]
```

**On-chain enforcement:** The program validates the MSCI magic header on every chunk. Invalid type tags are rejected. The first type tag in the payload is validated against the known range (0x01–0x09).

**Compression:** 5x–10x for numerical arrays. Scientific datasets with temporal correlation achieve the highest ratios.

**Primary users:** climate scientists, medical researchers, financial analysts, IoT sensor networks, physics and chemistry labs.

**On-chain log (chunk 0):**
```
PERMADATA_MATHSCI_CHUNK stamp=<hex> idx=0 total=<n> len=<n>
```

---

## 3.5 CBOR Codec (0x05)

The CBOR codec stores Concise Binary Object Representation data — a binary encoding of structured objects, arrays, maps, and primitives. CBOR is a standard (RFC 7049) that provides JSON-equivalent expressiveness at significantly smaller size.

**Use cases:** configuration records, structured event logs, IoT telemetry with mixed data types, API response archival.

**Wire format:** Valid CBOR-encoded bytes, chunked at 500-byte boundaries.

**Compression:** 1.5x–3x versus equivalent JSON.

---

## 3.6 IMAGE Codec (0x06)

The IMAGE codec stores visual data with format identification and optional compression preprocessing. The on-chain program enforces a magic header and validates format and color space metadata.

**Magic header (enforced on every chunk):** `[0x49, 0x4D, 0x47, 0x00]` — ASCII "IMG\0"

**Chunk 0 metadata layout:**
```
[magic: 4][format: 1][version: 1][width: 2 LE u16][height: 2 LE u16][color_space: 1][reserved: 1]
```
Total: 12 bytes

**Format tags:**

| Tag | Format | Notes |
|-----|--------|-------|
| `0x00` | GENERIC | Unknown format |
| `0x01` | JPEG | Lossy — magic: FF D8 FF |
| `0x02` | PNG | Lossless — magic: 89 50 4E 47 |
| `0x03` | WEBP | Lossy/lossless — RIFF container |
| `0x04` | GIF | Animated — magic: 47 49 46 38 |
| `0x05` | BMP | Uncompressed bitmap |
| `0x06` | TIFF | High-quality — lossless |
| `0x07` | AVIF | Modern AV1-based format |
| `0x08` | SVG | XML vector graphics |
| `0x09` | RAW_IMG | Camera RAW (CR2, NEF, ARW, DNG) |

**Encoding versions:**

- **V1_RAW (0x01):** stamps image bytes as-is. Use for JPEG, PNG, WEBP — already compressed.
- **V2_DELTA_YCBCR (0x02):** applies RGB→YCbCr color space transform followed by delta encoding before chunking. Achieves 2x–8x compression on uncompressed sources (BMP, TIFF, camera RAW). CMYK color space is incompatible with V2 — the program enforces this.

**Color spaces:** UNKNOWN (0x00), sRGB (0x01), Adobe RGB (0x02), Grayscale (0x03), CMYK (0x04), HDR (0x05)

**Use cases:** photographs, digital artwork, NFT source files, medical imaging (X-ray, MRI), scientific imagery, legal document scans.

**Value proposition:** Proves authorship and existence of an image at a specific moment. Chain timestamp is irrefutable proof that an artist created work before a given date — relevant for copyright, NFT provenance, and IP disputes.

**On-chain log (chunk 0):**
```
PERMADATA_IMAGE_META stamp=<hex> fmt=0x<nn> ver=0x<nn> w=<n> h=<n> cs=0x<nn>
```

---

## 3.7 AUDIO Codec (0x07)

The AUDIO codec stores sound recordings with format identification, channel/sample rate metadata, and optional delta PCM compression for uncompressed sources.

**Magic header (enforced on every chunk):** `[0x41, 0x55, 0x44, 0x00]` — ASCII "AUD\0"

**Chunk 0 metadata layout:**
```
[magic: 4][format: 1][version: 1][channels: 1][bit_depth: 1][sample_rate: 4 LE u32][duration_ms: 4 LE u32]
```
Total: 16 bytes

**Format tags:**

| Tag | Format | Type | Recommended Version |
|-----|--------|------|---------------------|
| `0x00` | GENERIC | Unknown | V1 |
| `0x01` | WAV | Uncompressed PCM | V2 |
| `0x02` | MP3 | Lossy MPEG | V1 |
| `0x03` | FLAC | Lossless | V2 |
| `0x04` | AAC | Lossy Apple | V1 |
| `0x05` | OGG | Lossy Vorbis | V1 |
| `0x06` | OPUS | Lossy voice | V1 |
| `0x07` | AIFF | Uncompressed Apple | V2 |
| `0x08` | M4A | MPEG-4 Audio | V1 |

**Encoding versions:**

- **V1_RAW (0x01):** stamps audio bytes as-is. Correct for all lossy formats (MP3, AAC, OGG, OPUS, M4A) — these are already compressed and do not benefit from further encoding.
- **V2_DELTA_PCM (0x02):** encodes consecutive PCM sample differences before chunking. Since adjacent audio samples are highly correlated (especially in voice recordings), delta values are much smaller than raw values — enabling significant compression. Achieves 3x–6x on voice, 2x–4x on music. The program enforces that V2 is only used with uncompressed formats (WAV, AIFF, FLAC) — attempting V2 on a compressed format is rejected with `AudioV2CompressedNotSupported`.

**Use cases:** music archival, podcast preservation, voice memos, legal recordings, music rights proof (artist stamps master recording before release), spoken word archives.

**On-chain log (chunk 0):**
```
PERMADATA_AUDIO_META stamp=<hex> fmt=0x<nn> ver=0x<nn> ch=<n> bits=<n> rate=<n> dur_ms=<n>
```

---

## 3.8 VIDEO Codec (0x08)

The VIDEO codec stores moving image data with container format identification, video codec hints, frame rate, resolution metadata, and optional inter-frame delta compression for raw video sources.

**Magic header (enforced on every chunk):** `[0x56, 0x49, 0x44, 0x00]` — ASCII "VID\0"

**Chunk 0 metadata layout:**
```
[magic: 4][format: 1][version: 1][width: 2 LE u16][height: 2 LE u16][fps: 1][has_audio: 1][video_codec_hint: 1][audio_codec_hint: 1][duration_ms: 4 LE u32]
```
Total: 18 bytes

**Container format tags:**

| Tag | Format | Notes |
|-----|--------|-------|
| `0x00` | GENERIC | Unknown |
| `0x01` | MP4 | Most compatible — H.264/H.265 |
| `0x02` | MOV | QuickTime / Apple |
| `0x03` | MKV | Matroska open container |
| `0x04` | WEBM | Web-optimized — VP8/VP9/AV1 |
| `0x05` | AVI | Legacy Windows |
| `0x06` | TS | MPEG transport stream |
| `0x07` | FLV | Flash video (legacy) |
| `0x08` | RAW_VID | Uncompressed frame sequence |

**Video codec hints:**

| Tag | Codec | Notes |
|-----|-------|-------|
| `0x00` | UNKNOWN | |
| `0x01` | H264 | AVC — most compatible |
| `0x02` | H265 | HEVC — 2x better than H264 |
| `0x03` | VP9 | Google open codec |
| `0x04` | AV1 | Best compression, open |
| `0x05` | VP8 | Older Google codec |
| `0x06` | MPEG2 | Legacy broadcast |
| `0x07` | RAW | Uncompressed frames |

**Encoding versions:**

- **V1_RAW (0x01):** stamps container bytes as-is. Correct for all compressed containers (MP4, MOV, MKV, WEBM, AVI, TS, FLV).
- **V2_DELTA_FRAMES (0x02):** applies inter-frame delta encoding for raw/uncompressed frame sequences. Consecutive video frames share approximately 95% of their pixel data — delta encoding collapses identical regions to near-zero values, enabling 10x–50x compression on uncompressed sources. The program enforces that V2 is only used with RAW_VID or GENERIC containers — compressed containers are rejected with `VideoV2CompressedNotSupported`.

**Constraints enforced on-chain:** fps must be 1–240, has_audio must be 0 or 1, width and height must both be greater than zero.

**Use cases:** evidence footage (legal, journalistic), film archival, screen recordings, security camera footage, artistic film, music videos, documentary footage.

**Note:** Most video files exceed the 256KB single-stamp limit. Use the MULTIPART codec for standard video files.

**On-chain log (chunk 0):**
```
PERMADATA_VIDEO_META stamp=<hex> fmt=0x<nn> ver=0x<nn> w=<n> h=<n> fps=<n> audio=<n> vc=0x<nn> dur_ms=<n>
```

---

## 3.9 BINARY Codec (0x09)

The BINARY codec stores compiled software, firmware, executables, archives, and any other binary file format that does not fit a more specific codec.

**Magic header (enforced on every chunk):** `[0x42, 0x49, 0x4E, 0x00]` — ASCII "BIN\0"

**Byte 4 (chunk 0 only):** file type hint — informational, validated for range but content is not verified.

**File type hints:**

| Tag | Type | Detection |
|-----|------|-----------|
| `0x00` | GENERIC | Unknown |
| `0x01` | ELF | Linux/SBF executable — magic: 7F 45 4C 46 |
| `0x02` | WASM | WebAssembly — magic: 00 61 73 6D |
| `0x03` | MACHO | macOS executable — magic: CF FA |
| `0x04` | PE | Windows executable — magic: 4D 5A |
| `0x05` | FIRMWARE | Embedded firmware / raw binary |
| `0x06` | SO | Shared library (.so / .dll) |
| `0x07` | AR | Static archive |
| `0x08` | ZIP | ZIP archive — magic: 50 4B 03 |
| `0x09` | TAR | Tar archive |

**Use cases:** software release verification (stamp a binary before distribution — users verify they downloaded the unmodified version), firmware archival for IoT devices, smart contract bytecode preservation, operating system image archival.

**Value proposition:** For software, the value is not compression (binaries are already compressed) but provenance — proving that a specific binary existed, unchanged, at a specific moment. Relevant for supply chain security, compliance, and audit trails.

**Compression:** 1x–1.2x (binaries are already optimally compressed).

---

## 3.10 MULTIPART Codec (0x0A)

The MULTIPART codec enables permanent storage of files larger than the 256KB single-stamp limit by linking multiple child stamps into one logical file through a parent manifest stamp.

**Magic header (enforced on every chunk):** `[0x4D, 0x50, 0x41, 0x52]` — ASCII "MPAR"

**Parent manifest chunk 0 layout:**
```
[magic: 4][inner_codec: 1][part_count: 2 LE u16][total_bytes: 8 LE u64][child_stamp_ids: 6 × part_count]
```

**Architecture:**

The parent stamp (codec=0x0A) acts as an ordered index. It contains:
- The codec type of the actual data (`inner_codec`) — must be a valid data codec, cannot be MULTIPART itself
- The total number of child stamps (`part_count`) — 1 to 256
- The total unassembled file size in bytes (`total_bytes`)
- The ordered list of child stamp IDs (6 bytes each)

Child stamps use their actual data codec (IMAGE, AUDIO, BINARY, etc.) for all chunk registrations. Each child stamp is independently verifiable.

**Constraints enforced on-chain:**
- `inner_codec` must be a recognized data codec (0x01–0x09)
- `part_count` must be 1–256
- `total_bytes` must be greater than zero
- MULTIPART cannot be nested (inner_codec cannot be 0x0A)

**Maximum file size:** 256 parts × 512 chunks × 500 bytes = **~65MB**

**Retrieval:** Read the parent manifest → collect child stamp IDs in order → retrieve each child's chunks → concatenate → verify total hash.

**Use cases:** music albums, full-length video, large software releases, operating system images, medical imaging studies (DICOM), research datasets, legal case files containing multiple documents.

**Example — 12MB camera RAW file:**
- Split into 48 child IMAGE stamps (~256KB each)
- One MULTIPART parent manifest referencing all 48 children in order
- Total: 49 stamps, permanently linked, independently verifiable

---

## 4. Fee Structure

### 4.1 Network Fees

Transaction fees are paid to X1 network validators at the standard network rate (~0.000058 XNT per transaction). These fees are not controlled by the Permadata protocol.

### 4.2 Protocol Fees (Planned — v0.9.0)

The Permadata protocol will implement on-chain fee collection at `finalize_stamp` in version 0.9.0:

```
rent_xnt = compressed_bytes × 0.00000348
dev_fee  = rent_xnt × 0.38
burn_fee = rent_xnt × 0.02
total    = rent_xnt × 1.40
```

- **Dev fee (38% of rent):** transferred to the Permadata treasury at finalization
- **Burn fee (2% of rent):** permanently removed from XNT supply
- **Treasury:** `GmvrL1ymC9ENuQCUqymC9robGa9t9L59AbFiwhDDd4Ld`

Fees scale with file size — smaller files pay less, larger files pay proportionally more. There are no flat fees and no subscription costs.

### 4.3 Cost Examples @ Current XNT Price

| Data Type | File Size | After Encoding | Stamps | Approx. Cost |
|-----------|-----------|---------------|--------|-------------|
| Legal contract | 50KB text | ~12KB | ~25 | Fraction of XNT |
| Research dataset | 1MB f64 arrays | ~100KB (MATHSCI) | ~200 | Small fraction of XNT |
| Photo (JPEG) | 3MB | ~3MB (V1) | ~6,000 | Moderate XNT |
| Music album (FLAC, V2) | 400MB → ~150MB | 300,000 | Via MULTIPART | XNT at scale |
| Windows OS image | 5.4GB | ~5.4GB (BINARY) | ~10,800,000 | Large XNT volume |

All costs are paid once. No recurring fees. No subscription. No expiration.

---

## 5. Retrieval

Stamped data can be retrieved from any X1 RPC node without any SDK or proprietary tool:

1. Query `getSignaturesForAddress` for the Permadata program ID
2. Filter transactions containing `PERMADATA_STAMP stamp=<your_stamp_id>` in logs
3. For each chunk: fetch the transaction and extract the memo field (base64-encoded chunk data)
4. Sort chunks by `chunk_index`
5. Concatenate chunk data → compressed payload
6. Verify: SHA256(payload) matches `payload_hash` stored in the StampRecord PDA
7. Apply codec-specific decoding (reverse delta, reverse YCbCr transform, etc.)
8. For MULTIPART: read parent manifest → repeat retrieval for each child stamp in order

The StampRecord PDA can be queried directly:
```
PDA seeds: [b"perm_stamp", stamp_id_bytes]
Program: BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq
```

---

## 6. Security

### 6.1 Integrity Guarantee

Every chunk has two integrity checks:
- **CRC32** — fast corruption detection stored in ChunkRecord
- **SHA256** — cryptographic hash stored in ChunkRecord and verified at finalization

The `payload_hash` in StampRecord is the SHA256 of the complete payload. Any modification — even a single bit — produces a different hash and fails verification.

### 6.2 Immutability

StampRecord PDAs are created with `init` — they cannot be overwritten. ChunkRecord PDAs are similarly non-replaceable. Once finalized, a stamp is permanent. The upgrade authority of the program cannot modify existing stamps.

### 6.3 Privacy

All stamped data is currently public. Anyone with the stamp ID and an X1 RPC connection can retrieve and decode the content. Users requiring confidentiality should encrypt their data before stamping. The chain stores the encrypted payload — only parties with the decryption key can read the content.

Encrypted stamping tools with AES-256-GCM are planned for a future release.

### 6.4 Upgrade Authority

The program is currently upgradeable. The upgrade authority is held by the Permadata team. Future versions may lock the upgrade authority to a multisig or burn it entirely, making the program permanently immutable.

---

## 7. Competitive Analysis

| Feature | Arweave / Irys | Shadow Drive | IPFS + Pinning | Permadata |
|---------|---------------|--------------|----------------|-----------|
| Data on-chain | ❌ (Arweave) | ❌ (GenesysGo) | ❌ (IPFS nodes) | ✅ |
| No recurring fees | ✅ | ❌ | ❌ | ✅ |
| No pointer dependency | ❌ | ❌ | ❌ | ✅ |
| Format enforcement | ❌ | ❌ | ❌ | ✅ |
| Multi-codec | ❌ | ❌ | ❌ | ✅ |
| No SDK required | ❌ | ❌ | ❌ | ✅ |
| Open specification | ❌ | ❌ | Partial | ✅ |
| Language-agnostic | ❌ | ❌ | ❌ | ✅ |

**The fundamental difference:** Every competitor stores a pointer to data that lives somewhere else. Permadata stores the data itself. When everything else goes offline, Permadata stamps remain readable from any X1 validator running the chain.

---

## 8. Use Cases by Sector

### Legal
- Contract execution timestamps
- Deed and title records
- Court filing timestamps
- Evidence chain-of-custody
- Notarization replacement

### Scientific Research
- Dataset provenance before publication
- Experimental result archival
- Climate sensor reading preservation
- Medical trial data integrity

### Creative / Entertainment
- Music master recording rights
- Artwork authorship proof
- Film archival
- Podcast preservation
- NFT source file permanence

### Software / Technology
- Binary release verification
- Firmware supply chain integrity
- Open source release archival
- Smart contract bytecode preservation

### Medical
- Patient record immutability
- Imaging study archival (DICOM)
- Clinical trial data integrity
- Prescription audit trails

### IoT / Industrial
- Sensor reading streams
- Equipment calibration records
- Environmental monitoring logs
- Supply chain event records

---

## 9. Roadmap

### v0.8.0 (Current — May 2026)
- ✅ All 10 codecs live on X1 mainnet
- ✅ SPEC.md published and stamped on-chain
- ✅ Demo scripts for all codecs
- ✅ Interactive stamp CLI with auto-detection
- ✅ Setup wizard for new users

### v0.9.0 (Planned)
- On-chain protocol fee collection (38% dev / 2% burn)
- Adjustable fee governance via upgrade authority
- Enhanced retrieve.mjs with codec-aware decoding

### v1.0.0 (Planned)
- Solana mainnet deployment
- Encrypted stamping (AES-256-GCM)
- permadata.io Pro and Business tiers
- Public API with rate limiting

### Future
- PermaStake — rent deposits earn yield via validator staking
- Multisig upgrade authority
- Permanent program lock option
- Cross-chain bridging

---

## 10. Conclusion

Permadata solves the permanent storage problem by eliminating the pointer. Data does not live on a server that references the chain — data lives in the chain itself, in the transaction history that every validator replicates and preserves. The on-chain program enforces format integrity, the chunk hash system ensures data integrity, and the finalization mechanism creates an immutable, permanently queryable record.

The protocol is open. The specification is published. No permission is required to use it. Any developer, in any language, can construct a valid stamp transaction by following SPEC.md. The chain is the interface.

One program ID. Ten codecs. Every data type. Permanent.

**Program ID:** `BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq`  
**Specification:** SPEC.md (stamped on-chain: `8020d25ffad2`)  
**Website:** permadata.io  

---

## Appendix A: Error Reference

| Error | Meaning |
|-------|---------|
| `MathsciMissingMagic` | MATHSCI chunk missing MSCI header |
| `MathsciInvalidTypeTag` | Type tag not in 0x01–0x09 |
| `ImageMissingMagic` | IMAGE chunk missing IMG\0 header |
| `ImageInvalidFormat` | Format tag not in 0x00–0x09 |
| `ImageInvalidColorSpace` | Color space not in 0x00–0x05 |
| `ImageInvalidVersion` | Version not 0x01 or 0x02 |
| `ImageV2CmykNotSupported` | V2 incompatible with CMYK |
| `AudioMissingMagic` | AUDIO chunk missing AUD\0 header |
| `AudioInvalidFormat` | Format tag not in 0x00–0x08 |
| `AudioInvalidVersion` | Version not 0x01 or 0x02 |
| `AudioInvalidChannels` | Channels not in 1–32 |
| `AudioInvalidSampleRate` | Sample rate is zero |
| `AudioV2CompressedNotSupported` | V2 used on compressed format |
| `VideoMissingMagic` | VIDEO chunk missing VID\0 header |
| `VideoInvalidFormat` | Container not in 0x00–0x08 |
| `VideoInvalidVersion` | Version not 0x01 or 0x02 |
| `VideoInvalidCodecHint` | Codec hint not in 0x00–0x07 |
| `VideoInvalidDimensions` | Width or height is zero |
| `VideoInvalidFps` | FPS not in 1–240 |
| `VideoInvalidHasAudio` | has_audio not 0 or 1 |
| `VideoV2CompressedNotSupported` | V2 used on compressed container |
| `BinaryMissingMagic` | BINARY chunk missing BIN\0 header |
| `BinaryInvalidFileType` | File type not in 0x00–0x09 |
| `MultipartMissingMagic` | MULTIPART chunk missing MPAR header |
| `MultipartInvalidInnerCodec` | Inner codec unrecognized or is MULTIPART |
| `MultipartInvalidPartCount` | Part count not in 1–256 |
| `MultipartInvalidTotalBytes` | Total bytes is zero |
| `InvalidCodecType` | codec_type not recognized at finalize |
| `InvalidChunkIndex` | chunk_index >= chunk_total |
| `InvalidChunkTotal` | chunk_total is 0 or > 512 |
| `InvalidChunkSize` | Chunk data length is 0 or > 500 bytes |
| `MissingChunks` | Not all chunk PDAs present at finalization |
| `InvalidChunkPDA` | Chunk PDA address mismatch |
| `StampNotFinalized` | Stamp record not finalized |

---

## Appendix B: Quick Reference

**Stamp a text message (one-liner, no setup):**
```bash
node -e "import('@solana/web3.js').then(async ({Connection,Keypair,Transaction,TransactionInstruction,PublicKey,SystemProgram,sendAndConfirmTransaction,ComputeBudgetProgram})=>{const fs=await import('fs');const crypto=await import('crypto');const PROG=new PublicKey('BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq');const MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');const conn=new Connection('https://rpc.mainnet.x1.xyz','confirmed');const wallet=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.PERMADATA_KEY||process.env.HOME+'/.config/solana/id.json'))));const data=Buffer.from('Hello from Permadata - '+new Date().toISOString());const sid=crypto.createHash('sha256').update(data).digest().slice(0,6);const hash=crypto.createHash('sha256').update(data).digest();const crc=((b)=>{let c=0xFFFFFFFF;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c&1)?(c>>>1)^0xEDB88320:c>>>1;}return(~c)>>>0;})(data);const disc=crypto.createHash('sha256').update('global:register_chunk').digest().slice(0,8);const [pda]=PublicKey.findProgramAddressSync([Buffer.from('perm_chunk'),sid,Buffer.from(new Uint16Array([0]).buffer)],PROG);const [spda]=PublicKey.findProgramAddressSync([Buffer.from('perm_stamp'),sid],PROG);const preview=data.slice(0,Math.min(32,data.length));const ix=Buffer.alloc(8+6+2+2+32+4+2+4+preview.length);disc.copy(ix,0);sid.copy(ix,8);ix.writeUInt16LE(0,14);ix.writeUInt16LE(1,16);hash.copy(ix,18);ix.writeUInt32LE(crc,50);ix.writeUInt16LE(data.length,54);ix.writeUInt32LE(preview.length,56);preview.copy(ix,60);const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:200000})).add(new TransactionInstruction({programId:MEMO,keys:[],data:Buffer.from(data.toString('base64'))})).add(new TransactionInstruction({programId:PROG,keys:[{pubkey:pda,isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:ix}));await sendAndConfirmTransaction(conn,tx,[wallet],{commitment:'confirmed'});const fdisc=crypto.createHash('sha256').update('global:finalize_stamp').digest().slice(0,8);const fix=Buffer.alloc(8+6+2+1+4+4+32);fdisc.copy(fix,0);sid.copy(fix,8);fix.writeUInt16LE(1,14);fix[16]=0x02;fix.writeUInt32LE(data.length,17);fix.writeUInt32LE(crc,21);hash.copy(fix,25);const ftx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:400000})).add(new TransactionInstruction({programId:PROG,keys:[{pubkey:spda,isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:pda,isSigner:false,isWritable:false}],data:fix}));const sig=await sendAndConfirmTransaction(conn,ftx,[wallet],{commitment:'confirmed'});console.log('Stamp ID: '+sid.toString('hex'));console.log('Tx: '+sig);})"
```

**RPC endpoint:** `https://rpc.mainnet.x1.xyz`  
**Explorer:** `https://explorer.x1.xyz`  
**Chain:** X1 Mainnet (SVM-compatible)  

---

*Permadata Protocol — Permanent. Immutable. On-chain. No server required.*

*Copyright 2026 Arnett Esters / x1scroll.io. This specification is stamped on X1 mainnet (Stamp ID: 8020d25ffad2) as proof of authorship and date of creation.*
