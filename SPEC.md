# Permadata Protocol Specification
**Version:** 0.8.0  
**Status:** Live on Mainnet  
**Chain:** X1 (SVM-compatible)  
**Program ID:** `BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq`  
**Author:** Arnett Esters / x1scroll.io  

---

## Overview

Permadata is a trustless, chain-enforced protocol for permanently storing any type of data on-chain. No servers. No SDK required. Anyone can stamp data by submitting a valid transaction to the Permadata on-chain program. The chain enforces the format. The chain is the authority.

**Core promise:** Compress any data → stamp it on X1 → retrieve and verify it forever. Fractions of a cent. No trust required. No recurring fees.

---

## Design Principles

1. **Chain-enforced** — the on-chain program is the law. Invalid format = rejected transaction.
2. **No SDK required** — any client in any language can construct transactions directly from this spec.
3. **Language-agnostic** — Python, Rust, JavaScript, Go, curl — if the bytes are right, the program accepts it.
4. **Immutable** — once finalized, a stamp cannot be modified or deleted.
5. **Verifiable** — any party can independently reconstruct and verify stamped data using only this spec and any X1 RPC node.
6. **Permanent** — pay once, stored forever. No subscription. No server to go down.

---

## Codec Registry

The `codec_type` byte identifies the type of data being stamped. The on-chain program enforces valid codec bytes at `finalize_stamp`.

| Byte   | Name       | Description                                              |
|--------|------------|----------------------------------------------------------|
| `0x01` | RAW        | Raw bytes — no transformation. Universal fallback.       |
| `0x02` | UTF8_TEXT  | UTF-8 text. Any natural language. Documents, legal, receipts. |
| `0x03` | UTF8_EN    | English-optimized text with adaptive entropy coding.     |
| `0x04` | MATHSCI    | Scientific/numerical data — float arrays, sensor readings, research datasets. |
| `0x05` | CBOR       | CBOR-encoded structured data (objects, arrays).          |
| `0x06` | IMAGE      | Photos, artwork, NFTs, medical scans. Supports v1 (raw) and v2 (delta+YCbCr). |
| `0x07` | AUDIO      | Music, voice, podcasts. Supports v1 (raw) and v2 (delta PCM). |
| `0x08` | VIDEO      | Clips, film, evidence footage. Supports v1 (raw) and v2 (delta frames). |
| `0x09` | BINARY     | Executables, firmware, compiled code, archives.          |
| `0x0A` | MULTIPART  | Large files split across multiple linked stamps. Manifest + child stamps. |

---

## Chunking

All data is split into 500-byte chunks before submission.

**Maximum chunk size:** 500 bytes  
**Maximum chunks per stamp:** 512  
**Maximum single stamp size:** ~256KB  
**Maximum MULTIPART file size:** ~65MB (256 child stamps × 512 chunks × 500 bytes)

Each chunk is submitted as a transaction memo (base64-encoded) plus a `register_*_chunk` instruction that stores the chunk hash on-chain in a PDA.

---

## PDA Seeds

### Chunk Record PDA
```
seeds = [b"perm_chunk", stamp_id (6 bytes), chunk_index (u16 LE)]
```

### Stamp Record PDA
```
seeds = [b"perm_stamp", stamp_id (6 bytes)]
```

---

## Stamp ID

```
stamp_id = hex(SHA256(compressed_payload))[0:12]  →  6 bytes
```

12 hex characters (6 bytes). Compact, collision-resistant for practical purposes.

---

## On-Chain Instructions

### Universal: `finalize_stamp`

Seals a stamp after all chunks are registered. Validates codec type. Immutable after finalization.

**Accounts:**
- `[writable, init]` stamp_record PDA
- `[writable, signer]` payer
- `[]` system_program
- `[remaining]` all chunk_record PDAs in order (validated on-chain)

**Instruction data:**
```
stamp_id: [u8; 6]
chunk_total: u16 LE
codec_type: u8          ← must be one of: 0x01-0x0A
data_length: u32 LE
checksum: u32 LE
payload_hash: [u8; 32]  ← SHA256 of full compressed payload
```

**On-chain log:**
```
PERMADATA_STAMP stamp=<hex> codec=0x<nn> chunks=<n> bytes=<n> hash=<hex>
```

---

### Universal: `verify_stamp`

Read-only. Emits stamp metadata to logs.

**On-chain log:**
```
PERMADATA_VERIFY stamp=<hex> codec=0x<nn> chunks=<n> bytes=<n> hash=<hex> slot=<n> ok=true
```

---

## Codec Wire Formats

---

### `0x01` RAW

No wire format requirements beyond chunk size limits. Stamps raw bytes as-is.

---

### `0x02` UTF8_TEXT / `0x03` UTF8_EN

UTF-8 encoded text. No additional wire format beyond valid UTF-8.

- UTF8_TEXT: any language, any text
- UTF8_EN: English prose with adaptive context modeling for higher compression

**Typical compression:** 2x–5x

---

### `0x04` MATHSCI

Magic header enforced on every chunk.

**Magic:** `[0x4D, 0x53, 0x43, 0x49]` → `"MSCI"`

**Record format** (packed after magic, repeating):
```
[type_tag: u8][count: u16 LE][values: count × sizeof(type)]
```

**Type tags:**

| Tag    | Type       | Bytes each | Use case                        |
|--------|------------|------------|---------------------------------|
| `0x01` | f64        | 8          | Floating point — sensor readings, coordinates |
| `0x02` | f32        | 4          | Single precision float          |
| `0x03` | i64        | 8          | Signed 64-bit integer           |
| `0x04` | i32        | 4          | Signed 32-bit integer           |
| `0x05` | u64        | 8          | Unsigned 64-bit integer         |
| `0x06` | u8         | 1          | Raw byte / unsigned 8-bit       |
| `0x07` | complex64  | 8          | f32 real + f32 imaginary (signal processing) |
| `0x08` | bool_array | 1          | Packed bits — 8 booleans per byte |
| `0x09` | timestamp  | 8          | u64 Unix nanoseconds            |

**Optional metadata block** (chunk 0 only, marked by `0xFF`):
```
[0xFF][unit_len: u8][unit_string: unit_len bytes][precision: u8][dimension_count: u8][dims: dimension_count × u16 LE]
```

**Typical compression:** 5x–10x on numerical arrays

**On-chain log (chunk 0):**
```
PERMADATA_MATHSCI_CHUNK stamp=<hex> idx=0 total=<n> len=<n>
```

---

### `0x05` CBOR

CBOR-encoded structured data. No additional wire format enforced beyond chunk size.

---

### `0x06` IMAGE

Magic header enforced on every chunk.

**Magic:** `[0x49, 0x4D, 0x47, 0x00]` → `"IMG\0"`

**Chunk 0 metadata layout:**
```
[magic: 4][format: 1][version: 1][width: 2 LE u16][height: 2 LE u16][color_space: 1][reserved: 1]
```
Total: 12 bytes

**Format tags:**

| Tag    | Format   | Notes                    |
|--------|----------|--------------------------|
| `0x00` | GENERIC  | Unknown format           |
| `0x01` | JPEG     | Magic: FF D8 FF          |
| `0x02` | PNG      | Magic: 89 50 4E 47       |
| `0x03` | WEBP     | RIFF container           |
| `0x04` | GIF      | Magic: 47 49 46 38       |
| `0x05` | BMP      | Magic: 42 4D             |
| `0x06` | TIFF     | Magic: 49 49 or 4D 4D    |
| `0x07` | AVIF     | ftyp box                 |
| `0x08` | SVG      | XML vector               |
| `0x09` | RAW_IMG  | Camera RAW (CR2/NEF/DNG) |

**Version tags:**

| Tag    | Name           | Description                                      |
|--------|----------------|--------------------------------------------------|
| `0x01` | V1_RAW         | Stamps image bytes as-is                         |
| `0x02` | V2_DELTA_YCBCR | RGB→YCbCr transform + delta encoding pre-stamp. 2x–8x compression on uncompressed sources. CMYK not supported with V2. |

**Color space tags:**

| Tag    | Name       |
|--------|------------|
| `0x00` | UNKNOWN    |
| `0x01` | sRGB       |
| `0x02` | Adobe RGB  |
| `0x03` | Grayscale  |
| `0x04` | CMYK       |
| `0x05` | HDR        |

**On-chain log (chunk 0):**
```
PERMADATA_IMAGE_META stamp=<hex> fmt=0x<nn> ver=0x<nn> w=<n> h=<n> cs=0x<nn>
```

---

### `0x07` AUDIO

Magic header enforced on every chunk.

**Magic:** `[0x41, 0x55, 0x44, 0x00]` → `"AUD\0"`

**Chunk 0 metadata layout:**
```
[magic: 4][format: 1][version: 1][channels: 1][bit_depth: 1][sample_rate: 4 LE u32][duration_ms: 4 LE u32]
```
Total: 16 bytes

**Format tags:**

| Tag    | Format  | Notes                          |
|--------|---------|--------------------------------|
| `0x00` | GENERIC | Unknown                        |
| `0x01` | WAV     | PCM — uncompressed             |
| `0x02` | MP3     | Lossy MPEG Layer 3             |
| `0x03` | FLAC    | Lossless — use V2              |
| `0x04` | AAC     | Lossy — use V1                 |
| `0x05` | OGG     | Lossy Vorbis — use V1          |
| `0x06` | OPUS    | Lossy voice-optimized — use V1 |
| `0x07` | AIFF    | Apple uncompressed — use V2    |
| `0x08` | M4A     | MPEG-4 Audio — use V1          |

**Version tags:**

| Tag    | Name          | Description                                      |
|--------|---------------|--------------------------------------------------|
| `0x01` | V1_RAW        | Stamps audio bytes as-is. Use for MP3/AAC/OGG/OPUS/M4A. |
| `0x02` | V2_DELTA_PCM  | Delta-encodes PCM samples before chunking. Use for WAV/AIFF/FLAC. 3x–6x compression on voice, 2x–4x on music. V2 blocked for compressed formats — chain enforces. |

**On-chain log (chunk 0):**
```
PERMADATA_AUDIO_META stamp=<hex> fmt=0x<nn> ver=0x<nn> ch=<n> bits=<n> rate=<n> dur_ms=<n>
```

---

### `0x08` VIDEO

Magic header enforced on every chunk.

**Magic:** `[0x56, 0x49, 0x44, 0x00]` → `"VID\0"`

**Chunk 0 metadata layout:**
```
[magic: 4][format: 1][version: 1][width: 2 LE u16][height: 2 LE u16][fps: 1][has_audio: 1][video_codec_hint: 1][audio_codec_hint: 1][duration_ms: 4 LE u32]
```
Total: 18 bytes

**Container format tags:**

| Tag    | Format  | Notes                          |
|--------|---------|--------------------------------|
| `0x00` | GENERIC | Unknown                        |
| `0x01` | MP4     | Most common container          |
| `0x02` | MOV     | QuickTime / Apple              |
| `0x03` | MKV     | Matroska open container        |
| `0x04` | WEBM    | Web-optimized (VP8/VP9/AV1)   |
| `0x05` | AVI     | Legacy Windows                 |
| `0x06` | TS      | MPEG transport stream          |
| `0x07` | FLV     | Flash video (legacy)           |
| `0x08` | RAW_VID | Raw frame sequence             |

**Video codec hints:**

| Tag    | Codec  | Notes                          |
|--------|--------|--------------------------------|
| `0x00` | UNKNOWN |                               |
| `0x01` | H264   | AVC — most compatible          |
| `0x02` | H265   | HEVC — 2x better than H264     |
| `0x03` | VP9    | Google open codec              |
| `0x04` | AV1    | Best compression, open         |
| `0x05` | VP8    | Older Google codec             |
| `0x06` | MPEG2  | Legacy broadcast               |
| `0x07` | RAW    | Uncompressed frames            |

**Version tags:**

| Tag    | Name             | Description                                      |
|--------|------------------|--------------------------------------------------|
| `0x01` | V1_RAW           | Stamps container bytes as-is. Use for all compressed containers (MP4/MOV/MKV/WEBM). |
| `0x02` | V2_DELTA_FRAMES  | Inter-frame delta encoding for RAW uncompressed frame sequences only. Consecutive frames share ~95% of pixels — compresses 10x–50x. V2 blocked on compressed containers — chain enforces. |

**Constraints:**
- `fps` must be 1–240
- `has_audio` must be 0 or 1
- `width` and `height` must both be > 0
- Large videos must use MULTIPART (see below)

**On-chain log (chunk 0):**
```
PERMADATA_VIDEO_META stamp=<hex> fmt=0x<nn> ver=0x<nn> w=<n> h=<n> fps=<n> audio=<n> vc=0x<nn> dur_ms=<n>
```

---

### `0x09` BINARY

Magic header enforced on every chunk.

**Magic:** `[0x42, 0x49, 0x4E, 0x00]` → `"BIN\0"`

**Byte 4 (chunk 0 only):** file type hint

| Tag    | Type     | Notes                     |
|--------|----------|---------------------------|
| `0x00` | GENERIC  | Unknown / catch-all       |
| `0x01` | ELF      | Linux/SBF executable      |
| `0x02` | WASM     | WebAssembly module        |
| `0x03` | MACHO    | macOS executable          |
| `0x04` | PE       | Windows executable        |
| `0x05` | FIRMWARE | Embedded firmware         |
| `0x06` | SO       | Shared library (.so/.dll) |
| `0x07` | AR       | Static archive            |
| `0x08` | ZIP      | Zip archive               |
| `0x09` | TAR      | Tar archive               |

File type hint is informational — the program validates the range but does not inspect content.

---

### `0x0A` MULTIPART

For files larger than ~256KB. Links multiple child stamps into one logical file.

**Magic:** `[0x4D, 0x50, 0x41, 0x52]` → `"MPAR"`

**Parent manifest chunk 0 layout:**
```
[magic: 4][inner_codec: 1][part_count: 2 LE u16][total_bytes: 8 LE u64][child_stamp_ids: 6 × part_count]
```

**Constraints:**
- `inner_codec` must be a valid data codec (0x01–0x09). Cannot be MULTIPART (no nesting).
- `part_count` must be 1–256
- `total_bytes` must be > 0
- Child stamp IDs must be 6 bytes each, in order

**Child stamps:**
- Each child uses its actual data codec (IMAGE, AUDIO, VIDEO, BINARY, etc.)
- Children are independent stamps, each independently verifiable
- Reconstruction: read parent manifest → collect children in order → concatenate → verify total hash

**Maximum file size:** 256 parts × 512 chunks × 500 bytes = **~65MB**

**On-chain log (chunk 0):**
```
PERMADATA_MULTIPART_MANIFEST stamp=<hex> inner=0x<nn> parts=<n> total_bytes=<n>
```

---

## Retrieval (No SDK Required)

To reconstruct any stamped data from chain without any SDK:

1. Query `getSignaturesForAddress` for program ID `BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq`
2. Filter transactions with log containing `PERMADATA_STAMP stamp=<your_stamp_id>`
3. For each chunk: fetch transaction, extract memo field (base64), decode
4. Sort chunks by `chunk_index`
5. Concatenate chunk data → compressed payload
6. Verify: SHA256(payload) matches `payload_hash` from stamp record
7. Decompress → original data
8. For MULTIPART: read manifest → repeat for each child stamp in order

---

## Cost Model

At current X1 network rates (~$0.001 per stamp transaction):

| Data Type | File Size | After Compression | Stamps Needed | Cost |
|-----------|-----------|------------------|---------------|------|
| Legal document | 50KB | ~12KB (4x) | ~25 | ~$0.025 |
| Photo (JPEG) | 3MB | ~3MB (1x, already compressed) | ~6,000 | ~$6.00 |
| Photo (RAW camera) | 25MB via MULTIPART | ~8MB (V2) | ~16,000 | ~$16.00 |
| MP3 album | 150MB | ~150MB (1x) | ~300,000 | ~$300 via MULTIPART |
| FLAC album | 400MB | ~150MB (V2) | ~300,000 | ~$300 via MULTIPART |
| Research dataset | 1MB (f64 arrays) | ~100KB (10x MATHSCI) | ~200 | ~$0.20 |
| Software release | 50MB | ~50MB (binary already compressed) | ~100,000 | ~$100 via MULTIPART |

*Costs at $0.001/stamp and XNT at $0.40. Costs scale with XNT price.*

---

## Error Reference

| Error | Meaning |
|-------|---------|
| `MathsciMissingMagic` | MATHSCI chunk missing `MSCI` header |
| `MathsciInvalidTypeTag` | MATHSCI type tag not in 0x01–0x09 |
| `ImageMissingMagic` | IMAGE chunk missing `IMG\0` header |
| `ImageInvalidFormat` | IMAGE format tag not in 0x00–0x09 |
| `ImageInvalidColorSpace` | IMAGE color space not in 0x00–0x05 |
| `ImageInvalidVersion` | IMAGE version not 0x01 or 0x02 |
| `ImageV2CmykNotSupported` | V2 delta+YCbCr incompatible with CMYK |
| `AudioMissingMagic` | AUDIO chunk missing `AUD\0` header |
| `AudioInvalidFormat` | AUDIO format tag not in 0x00–0x08 |
| `AudioInvalidVersion` | AUDIO version not 0x01 or 0x02 |
| `AudioInvalidChannels` | AUDIO channels not in 1–32 |
| `AudioInvalidSampleRate` | AUDIO sample rate is zero |
| `AudioV2CompressedNotSupported` | V2 delta PCM used on compressed format |
| `VideoMissingMagic` | VIDEO chunk missing `VID\0` header |
| `VideoInvalidFormat` | VIDEO format tag not in 0x00–0x08 |
| `VideoInvalidVersion` | VIDEO version not 0x01 or 0x02 |
| `VideoInvalidCodecHint` | VIDEO codec hint not in 0x00–0x07 |
| `VideoInvalidDimensions` | VIDEO width or height is zero |
| `VideoInvalidFps` | VIDEO fps not in 1–240 |
| `VideoInvalidHasAudio` | VIDEO has_audio not 0 or 1 |
| `VideoV2CompressedNotSupported` | V2 delta frames used on compressed container |
| `BinaryMissingMagic` | BINARY chunk missing `BIN\0` header |
| `BinaryInvalidFileType` | BINARY file type hint not in 0x00–0x09 |
| `MultipartMissingMagic` | MULTIPART chunk missing `MPAR` header |
| `MultipartInvalidInnerCodec` | Inner codec unrecognized or is MULTIPART |
| `MultipartInvalidPartCount` | Part count not in 1–256 |
| `MultipartInvalidTotalBytes` | Total bytes is zero |
| `InvalidCodecType` | codec_type not recognized at finalize_stamp |
| `InvalidChunkIndex` | chunk_index >= chunk_total |
| `InvalidChunkTotal` | chunk_total is 0 or > 512 |
| `InvalidChunkSize` | chunk data length is 0 or > 500 bytes |
| `MissingChunks` | Not all chunk PDAs present at finalization |
| `InvalidChunkPDA` | Chunk PDA address mismatch |
| `StampNotFinalized` | Stamp record not finalized |

---

## Changelog

| Version | Date       | What changed                                         |
|---------|------------|------------------------------------------------------|
| 0.1.0   | 2026-05-10 | Initial draft — RAW, UTF8_TEXT, UTF8_EN, MATHSCI, CBOR |
| 0.2.0   | 2026-05-11 | MATHSCI full implementation — magic, type tags, on-chain enforcement |
| 0.3.0   | 2026-05-11 | BINARY codec — `BIN\0` magic, file type hints, 10 types |
| 0.4.0   | 2026-05-11 | IMAGE codec — `IMG\0` magic, 9 formats, color spaces |
| 0.5.0   | 2026-05-11 | IMAGE V2 — delta+YCbCr transform, version byte, CMYK guard |
| 0.6.0   | 2026-05-11 | MULTIPART — `MPAR` magic, parent manifest, 256 child stamps, ~65MB max |
| 0.7.0   | 2026-05-11 | AUDIO codec — `AUD\0` magic, 8 formats, V2 delta PCM, compressed format guard |
| 0.8.0   | 2026-05-11 | VIDEO codec — `VID\0` magic, 8 containers, 7 codec hints, V2 delta frames, compressed container guard |
