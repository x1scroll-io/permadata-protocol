use anchor_lang::prelude::*;

declare_id!("BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq");

// ─────────────────────────────────────────────────────────────────
//  PERMADATA PROTOCOL — On-Chain Program v1.0.0
//  Chain: X1 (SVM-compatible / Solana)
//
//  Architecture:
//  - Chunk DATA lives in transaction memo fields (cheap, permanent)
//  - Chunk HASHES are registered on-chain in PDAs (enforces integrity)
//  - Stamp RECORD seals the full set and makes it queryable forever
//
//  No SDK required. Construct raw transactions from SPEC.md.
// ─────────────────────────────────────────────────────────────────

pub const STAMP_ID_LEN: usize = 6;
pub const MAX_CHUNK_SIZE: u16 = 500; // protocol spec: 500 bytes per chunk
pub const MAX_CHUNKS: usize = 512;   // max chunks per stamp

// ─── Protocol Fee Constants ──────────────────────────────────────────────
// Treasury wallet — HARDCODED. All fees route here. Non-configurable by caller.
// X1: GmvrL1ymC9ENuQCUqymC9robGa9t9L59AbFiwhDDd4Ld
// Solana: GmvrL1ymC9ENuQCUqymC9robGa9t9L59AbFiwhDDd4Ld
// Treasury pubkey as bytes — FSD3mywrvcFKE8AB4mwwQJkeHaftYsmtGw8cux6EhiR6
// Solana dev fee wallet — controlled by Arnett Esters
pub const TREASURY_WALLET_BYTES: [u8; 32] = [
    0xd6, 0x78, 0xc2, 0x7e, 0xd9, 0xae, 0xd8, 0x1f,
    0x9c, 0xfe, 0xde, 0x9d, 0x60, 0x56, 0x6f, 0x83,
    0x3c, 0xea, 0x5a, 0x3b, 0x5b, 0x79, 0x5f, 0xb4,
    0xe6, 0x15, 0xa4, 0x0e, 0xbb, 0xda, 0xdf, 0x29,
];

// Fee: ~0.000575 SOL (~5 cents at $87/SOL) per finalize_stamp
// 100% to treasury. No burn on Solana.
pub const PROTOCOL_FEE_LAMPORTS: u64 = 575_000;  // ~$0.05 at $87/SOL
pub const PROTOCOL_FEE_DEV: u64      = 575_000;  // 100% to treasury
pub const PROTOCOL_FEE_BURN: u64     = 0;        // no burn on Solana

pub mod codec {
    pub const RAW: u8 = 0x01;
    pub const UTF8_TEXT: u8 = 0x02;
    pub const UTF8_EN: u8 = 0x03;
    pub const MATHSCI: u8 = 0x04;
    pub const CBOR: u8 = 0x05;
    pub const BINARY: u8    = 0x09;  // compiled code, firmware, executables, generic binary
    pub const IMAGE: u8     = 0x06;  // photos, artwork, NFT source files, medical scans
    pub const MULTIPART: u8 = 0x0A;  // large files split across multiple linked stamps
    pub const AUDIO: u8     = 0x07;  // music, voice memos, podcasts, spoken word
    pub const VIDEO: u8     = 0x08;  // clips, film, evidence footage, screen recordings
}

// ─── VIDEO Wire Format Constants ──────────────────────────────────
// Magic header: first 4 bytes of every VIDEO chunk must be [0x56, 0x49, 0x44, 0x00] ("VID\0")
// Chunk 0 carries video metadata: format, version, width, height, fps, duration_ms,
//   has_audio flag, video_codec_hint, audio_codec_hint
pub const VIDEO_MAGIC: [u8; 4] = [0x56, 0x49, 0x44, 0x00];
pub const VIDEO_HEADER_LEN: usize = 4;

// VIDEO chunk 0 metadata layout (after magic):
// [format:1][version:1][width:2 LE u16][height:2 LE u16][fps:1][has_audio:1]
// [video_codec_hint:1][audio_codec_hint:1][duration_ms:4 LE u32]
// Total: 4 (magic) + 1+1+2+2+1+1+1+1+4 = 18 bytes
pub const VIDEO_META_LEN: usize = 18;

// VIDEO container format tags
pub mod video_format {
    pub const MP4: u8    = 0x01;  // MPEG-4 container — most common
    pub const MOV: u8    = 0x02;  // QuickTime / Apple
    pub const MKV: u8    = 0x03;  // Matroska — open container
    pub const WEBM: u8   = 0x04;  // Web-optimized (VP8/VP9/AV1)
    pub const AVI: u8    = 0x05;  // Legacy Windows
    pub const TS: u8     = 0x06;  // MPEG transport stream (broadcast)
    pub const FLV: u8    = 0x07;  // Flash video (legacy)
    pub const RAW_VID: u8 = 0x08; // raw frame sequence (no container)
    pub const GENERIC: u8 = 0x00;

    pub fn is_valid(f: u8) -> bool { f <= 0x08 }
}

// VIDEO codec hints (what compression the video track uses inside the container)
pub mod video_codec_hint {
    pub const H264: u8  = 0x01;  // AVC — most compatible
    pub const H265: u8  = 0x02;  // HEVC — 2x better compression than H264
    pub const VP9: u8   = 0x03;  // Google open codec
    pub const AV1: u8   = 0x04;  // next-gen open codec, best compression
    pub const VP8: u8   = 0x05;  // older Google codec
    pub const MPEG2: u8 = 0x06;  // legacy broadcast
    pub const RAW: u8   = 0x07;  // uncompressed frames
    pub const UNKNOWN: u8 = 0x00;

    pub fn is_valid(c: u8) -> bool { c <= 0x07 }
}

// VIDEO encoding versions
pub mod video_version {
    /// V1: raw container bytes stamped as-is. Use for already-compressed video.
    /// MP4/MOV/MKV/WEBM are already compressed — V1 is correct for these.
    pub const V1_RAW: u8 = 0x01;
    /// V2: inter-frame delta encoding applied before chunking.
    /// For raw/uncompressed frame sequences ONLY.
    /// Consecutive frames in video are ~95% similar — delta encoding
    /// collapses identical regions to near-zero. 10x–50x compression on raw frames.
    /// Do NOT use on already-compressed containers — chain enforces this.
    pub const V2_DELTA_FRAMES: u8 = 0x02;

    pub fn is_valid(v: u8) -> bool { v == V1_RAW || v == V2_DELTA_FRAMES }
}

// ─── AUDIO Wire Format Constants ──────────────────────────────────
// Magic header: first 4 bytes of every AUDIO chunk must be [0x41, 0x55, 0x44, 0x00] ("AUD\0")
// Chunk 0 carries audio metadata: format, sample_rate, channels, bit_depth, duration_ms, version
pub const AUDIO_MAGIC: [u8; 4] = [0x41, 0x55, 0x44, 0x00];
pub const AUDIO_HEADER_LEN: usize = 4;

// AUDIO chunk 0 metadata layout (after magic):
// [format: 1][version: 1][channels: 1][bit_depth: 1][sample_rate: 4 LE u32][duration_ms: 4 LE u32]
// Total: 4 (magic) + 1 + 1 + 1 + 1 + 4 + 4 = 16 bytes
pub const AUDIO_META_LEN: usize = 16;

// AUDIO format tags
pub mod audio_format {
    pub const WAV: u8   = 0x01;  // PCM WAV — magic: 52 49 46 46 ("RIFF")
    pub const MP3: u8   = 0x02;  // MPEG Layer 3 — magic: FF FB or ID3
    pub const FLAC: u8  = 0x03;  // Free Lossless — magic: 66 4C 61 43 ("fLaC")
    pub const AAC: u8   = 0x04;  // Advanced Audio Coding
    pub const OGG: u8   = 0x05;  // Ogg Vorbis — magic: 4F 67 67 53 ("OggS")
    pub const OPUS: u8  = 0x06;  // Opus codec (voice optimized)
    pub const AIFF: u8  = 0x07;  // Apple AIFF — magic: 46 4F 52 4D ("FORM")
    pub const M4A: u8   = 0x08;  // MPEG-4 Audio
    pub const GENERIC: u8 = 0x00; // unknown format

    pub fn is_valid(f: u8) -> bool { f <= 0x08 }
}

// AUDIO encoding versions
pub mod audio_version {
    /// V1: raw audio bytes, no pre-processing. Stamps as-is.
    pub const V1_RAW: u8 = 0x01;
    /// V2: delta-encoded PCM samples before chunking.
    /// For uncompressed audio (WAV/AIFF/FLAC source): consecutive sample differences
    /// are much smaller than raw values — compresses 3x–6x on voice, 2x–4x on music.
    /// MP3/AAC/OGG already compressed — use V1 for those.
    pub const V2_DELTA_PCM: u8 = 0x02;

    pub fn is_valid(v: u8) -> bool { v == V1_RAW || v == V2_DELTA_PCM }
}

// ─── MULTIPART Wire Format Constants ───────────────────────────────
//
// MULTIPART links multiple stamps into one logical file.
// A PARENT stamp (codec=0x0A) acts as a manifest — it stores the ordered list
// of CHILD stamp IDs that together form the complete file.
//
// Parent stamp chunk 0 layout:
//   [magic: 4 bytes]     "MPAR"
//   [inner_codec: 1 byte] codec of the actual data (IMAGE, AUDIO, VIDEO, etc.)
//   [part_count: 2 bytes LE] total number of child stamps
//   [total_bytes: 8 bytes LE] u64 — full unassembled file size in bytes
//   [part_index: 2 bytes LE] this child's position (0-based), 0xFFFF = this IS the parent manifest
//   [child_stamp_id: 6 bytes each, repeated part_count times]
//
// Child stamps:
//   - Use their actual data codec (IMAGE, BINARY, etc.) for all chunks
//   - Chunk 0 of each child includes a back-reference to the parent stamp ID
//   - Back-reference: last 6 bytes of chunk 0 preview = parent_stamp_id
//
// Max parts: 256 child stamps × 512 chunks × 500 bytes = ~65MB per multipart file
pub const MULTIPART_MAGIC: [u8; 4] = [0x4D, 0x50, 0x41, 0x52]; // "MPAR"
pub const MULTIPART_HEADER_MIN: usize = 15; // magic(4) + inner_codec(1) + part_count(2) + total_bytes(8)
pub const MULTIPART_MAX_PARTS: u16 = 256;

// ─── IMAGE Wire Format Constants ─────────────────────────────────
// Magic header: first 4 bytes of every IMAGE chunk must be [0x49, 0x4D, 0x47, 0x00] ("IMG\0")
// Chunk 0 additionally carries image metadata: format, width, height, color_space
pub const IMAGE_MAGIC: [u8; 4] = [0x49, 0x4D, 0x47, 0x00];
pub const IMAGE_HEADER_LEN: usize = 4;

// IMAGE format tags — byte 4 of chunk 0, identifies the original image format
// Program detects format by inspecting native magic bytes in the payload AND this tag must match
pub mod image_format {
    pub const JPEG: u8   = 0x01;  // magic: FF D8 FF
    pub const PNG: u8    = 0x02;  // magic: 89 50 4E 47 0D 0A 1A 0A
    pub const WEBP: u8   = 0x03;  // magic: 52 49 46 46 ... 57 45 42 50
    pub const GIF: u8    = 0x04;  // magic: 47 49 46 38
    pub const BMP: u8    = 0x05;  // magic: 42 4D
    pub const TIFF: u8   = 0x06;  // magic: 49 49 2A 00 or 4D 4D 00 2A
    pub const AVIF: u8   = 0x07;  // magic: ftyp box
    pub const SVG: u8    = 0x08;  // XML-based vector, text magic
    pub const RAW_IMG: u8 = 0x09; // camera RAW (CR2, NEF, ARW, DNG)
    pub const GENERIC: u8 = 0x00; // unknown format — accepted, not validated

    pub fn is_valid(f: u8) -> bool { f <= 0x09 }
}

// IMAGE chunk 0 metadata layout (after magic + format byte):
// [version: u8] [width: u16 LE] [height: u16 LE] [color_space: u8] [reserved: u8]
// Total metadata header: 4 (magic) + 1 (format) + 1 (version) + 2 (width) + 2 (height) + 1 (color_space) + 1 (reserved) = 12 bytes
pub const IMAGE_META_LEN: usize = 12;

// IMAGE encoding versions
pub mod image_version {
    /// V1: raw image bytes, no pre-processing. Stamps file as-is.
    pub const V1_RAW: u8 = 0x01;
    /// V2: delta-encoded + YCbCr color space transform applied before chunking.
    /// Pre-processing: RGB → YCbCr → delta encode each channel → pack → chunk.
    /// Achieves 2x–8x compression on uncompressed/lightly-compressed sources.
    /// Reconstruction: reverse delta → YCbCr → RGB (all steps enforced by decoder on-chain).
    pub const V2_DELTA_YCBCR: u8 = 0x02;

    pub fn is_valid(v: u8) -> bool { v == V1_RAW || v == V2_DELTA_YCBCR }
}

pub mod image_color_space {
    pub const UNKNOWN: u8  = 0x00;
    pub const SRGB: u8     = 0x01;
    pub const ADOBE_RGB: u8 = 0x02;
    pub const GRAYSCALE: u8 = 0x03;
    pub const CMYK: u8     = 0x04;
    pub const HDR: u8      = 0x05;

    pub fn is_valid(c: u8) -> bool { c <= 0x05 }
}

// ─── BINARY Wire Format Constants ─────────────────────────────────
// Magic header: first 4 bytes of every BINARY chunk must be [0x42, 0x49, 0x4E, 0x00] ("BIN\0")
pub const BINARY_MAGIC: [u8; 4] = [0x42, 0x49, 0x4E, 0x00];
pub const BINARY_HEADER_LEN: usize = 4;

// BINARY file type hints — byte 4 (after magic), chunk_index=0 only
// Informational only — program stores it, does not enforce content
pub mod binary_type {
    pub const GENERIC: u8   = 0x00; // unknown / catch-all
    pub const ELF: u8       = 0x01; // Linux/SBF executable
    pub const WASM: u8      = 0x02; // WebAssembly module
    pub const MACHO: u8     = 0x03; // macOS executable
    pub const PE: u8        = 0x04; // Windows PE executable
    pub const FIRMWARE: u8  = 0x05; // embedded firmware / raw binary
    pub const SO: u8        = 0x06; // shared library (.so / .dll)
    pub const AR: u8        = 0x07; // archive / static lib
    pub const ZIP: u8       = 0x08; // zip archive
    pub const TAR: u8       = 0x09; // tar archive

    pub fn is_valid(t: u8) -> bool { t <= 0x09 }
}

// ─── MATHSCI Wire Format Constants ────────────────────────────────
// Magic header: first 4 bytes of every MATHSCI chunk must be [0x4D, 0x53, 0x43, 0x49] ("MSCI")
pub const MATHSCI_MAGIC: [u8; 4] = [0x4D, 0x53, 0x43, 0x49];
pub const MATHSCI_HEADER_LEN: usize = 4; // magic only; type_tag + count follow per-record

// MATHSCI type tags — packed after magic header, one per record block
pub mod mathsci_type {
    pub const F64: u8 = 0x01;       // 8 bytes each — IEEE 754 double
    pub const F32: u8 = 0x02;       // 4 bytes each — IEEE 754 single
    pub const I64: u8 = 0x03;       // 8 bytes each — signed 64-bit int
    pub const I32: u8 = 0x04;       // 4 bytes each — signed 32-bit int
    pub const U64: u8 = 0x05;       // 8 bytes each — unsigned 64-bit int
    pub const U8:  u8 = 0x06;       // 1 byte each  — raw byte / unsigned 8-bit
    pub const COMPLEX64: u8 = 0x07; // 8 bytes each — f32 real + f32 imag (signal processing)
    pub const BOOL_ARRAY: u8 = 0x08;// 1 byte per 8 bools — packed bits
    pub const TIMESTAMP: u8 = 0x09; // 8 bytes each — u64 Unix nanoseconds

    pub fn byte_size(tag: u8) -> Option<usize> {
        match tag {
            0x01 => Some(8), // f64
            0x02 => Some(4), // f32
            0x03 => Some(8), // i64
            0x04 => Some(4), // i32
            0x05 => Some(8), // u64
            0x06 => Some(1), // u8
            0x07 => Some(8), // complex64 (f32+f32)
            0x08 => Some(1), // bool_array (packed bits)
            0x09 => Some(8), // timestamp (u64 ns)
            _ => None,
        }
    }
}

#[program]
pub mod permadata_program {
    use super::*;

    // ─── MATHSCI Instructions ──────────────────────────────────────

    /// Register a MATHSCI chunk — enforces wire format on-chain.
    /// Chunk data must begin with magic [0x4D, 0x53, 0x43, 0x49] ("MSCI").
    /// After the magic: [type_tag: u8][count: u16 LE][values: count * sizeof(type)]
    /// Multiple records may be packed back-to-back within the 500-byte limit.
    /// Metadata block (units, dims) may appear in chunk_index=0 only, marked by 0xFF.
    pub fn register_mathsci_chunk(
        ctx: Context<RegisterChunk>,
        stamp_id: [u8; STAMP_ID_LEN],
        chunk_index: u16,
        chunk_total: u16,
        chunk_hash: [u8; 32],
        chunk_crc: u32,
        chunk_data_len: u16,
        chunk_data_preview: Vec<u8>, // first min(32, len) bytes for on-chain validation
    ) -> Result<()> {
        require!(chunk_index < chunk_total, PermdataError::InvalidChunkIndex);
        require!(chunk_total > 0 && chunk_total <= MAX_CHUNKS as u16, PermdataError::InvalidChunkTotal);
        require!(chunk_data_len > 0 && chunk_data_len <= MAX_CHUNK_SIZE, PermdataError::InvalidChunkSize);
        require!(chunk_data_preview.len() >= MATHSCI_HEADER_LEN, PermdataError::MathsciMissingMagic);

        // Enforce magic header — MSCI
        require!(
            chunk_data_preview[0..4] == MATHSCI_MAGIC,
            PermdataError::MathsciMissingMagic
        );

        // Validate first record type_tag if enough preview bytes supplied
        if chunk_data_preview.len() > 4 {
            let type_tag = chunk_data_preview[4];
            require!(
                mathsci_type::byte_size(type_tag).is_some(),
                PermdataError::MathsciInvalidTypeTag
            );
        }

        let rec = &mut ctx.accounts.chunk_record;
        rec.stamp_id = stamp_id;
        rec.chunk_index = chunk_index;
        rec.chunk_total = chunk_total;
        rec.chunk_hash = chunk_hash;
        rec.chunk_crc = chunk_crc;
        rec.data_len = chunk_data_len;
        rec.payer = ctx.accounts.payer.key();
        rec.slot = Clock::get()?.slot;

        msg!(
            "PERMADATA_MATHSCI_CHUNK stamp={} idx={} total={} len={}",
            hex::encode(stamp_id),
            chunk_index,
            chunk_total,
            chunk_data_len
        );

        Ok(())
    }

    /// Decode a finalized MATHSCI stamp — reads all chunk PDAs and emits decoded
    /// record metadata to program logs. The log IS the output. No off-chain decoder needed.
    /// Emits: PERMADATA_MATHSCI_DECODE type=<tag> count=<n> chunk=<i> slot=<s>
    pub fn decode_mathsci_stamp(ctx: Context<DecodeMathsci>) -> Result<()> {
        let stamp = &ctx.accounts.stamp_record;
        require!(stamp.finalized, PermdataError::StampNotFinalized);
        require!(stamp.codec_type == codec::MATHSCI, PermdataError::InvalidCodecType);

        msg!(
            "PERMADATA_MATHSCI_DECODE stamp={} chunks={} bytes={} slot={}",
            hex::encode(stamp.stamp_id),
            stamp.chunk_total,
            stamp.data_length,
            stamp.slot
        );

        // Emit per-chunk decode metadata from remaining_accounts (chunk PDAs)
        for (i, acct) in ctx.remaining_accounts.iter().enumerate() {
            let (expected, _) = Pubkey::find_program_address(
                &[b"perm_chunk", &stamp.stamp_id, &(i as u16).to_le_bytes()],
                ctx.program_id,
            );
            require!(acct.key() == expected, PermdataError::InvalidChunkPDA);
            let chunk_data = acct.try_borrow_data()?;
            msg!(
                "PERMADATA_MATHSCI_CHUNK_META idx={} len={}",
                i,
                chunk_data.len()
            );
        }

        msg!("PERMADATA_MATHSCI_DECODE_COMPLETE ok=true");
        Ok(())
    }

    // ─── IMAGE Instructions ───────────────────────────────────────

    /// Register an IMAGE chunk — enforces wire format on-chain.
    /// Chunk 0 must begin with magic [0x49, 0x4D, 0x47, 0x00] ("IMG\0") followed by:
    ///   [format: u8] [width: u16 LE] [height: u16 LE] [color_space: u8] [reserved: u8]
    /// Subsequent chunks only need the 4-byte magic header.
    /// Format tag must match one of image_format constants (0x00-0x09).
    /// Color space must be valid (0x00-0x05).
    /// Width and height are stored as metadata — program does NOT enforce image dimensions.
    pub fn register_image_chunk(
        ctx: Context<RegisterChunk>,
        stamp_id: [u8; STAMP_ID_LEN],
        chunk_index: u16,
        chunk_total: u16,
        chunk_hash: [u8; 32],
        chunk_crc: u32,
        chunk_data_len: u16,
        chunk_data_preview: Vec<u8>, // first min(IMAGE_META_LEN, len) bytes for validation
    ) -> Result<()> {
        require!(chunk_index < chunk_total, PermdataError::InvalidChunkIndex);
        require!(chunk_total > 0 && chunk_total <= MAX_CHUNKS as u16, PermdataError::InvalidChunkTotal);
        require!(chunk_data_len > 0 && chunk_data_len <= MAX_CHUNK_SIZE, PermdataError::InvalidChunkSize);
        require!(chunk_data_preview.len() >= IMAGE_HEADER_LEN, PermdataError::ImageMissingMagic);

        // Enforce magic header — IMG\0
        require!(
            chunk_data_preview[0..4] == IMAGE_MAGIC,
            PermdataError::ImageMissingMagic
        );

        // Chunk 0: validate format, version, width, height, color space from metadata header
        // Layout: [magic:4][format:1][version:1][width:2 LE][height:2 LE][color_space:1][reserved:1]
        if chunk_index == 0 && chunk_data_preview.len() >= IMAGE_META_LEN {
            let format      = chunk_data_preview[4];
            let version     = chunk_data_preview[5];
            let width       = u16::from_le_bytes([chunk_data_preview[6], chunk_data_preview[7]]);
            let height      = u16::from_le_bytes([chunk_data_preview[8], chunk_data_preview[9]]);
            let color_space = chunk_data_preview[10];

            require!(
                image_format::is_valid(format),
                PermdataError::ImageInvalidFormat
            );
            require!(
                image_version::is_valid(version),
                PermdataError::ImageInvalidVersion
            );
            require!(
                image_color_space::is_valid(color_space),
                PermdataError::ImageInvalidColorSpace
            );

            // V2: delta+YCbCr — enforce that color space is NOT CMYK (incompatible with YCbCr)
            if version == image_version::V2_DELTA_YCBCR {
                require!(
                    color_space != image_color_space::CMYK,
                    PermdataError::ImageV2CmykNotSupported
                );
            }

            msg!(
                "PERMADATA_IMAGE_META stamp={} fmt=0x{:02x} ver=0x{:02x} w={} h={} cs=0x{:02x}",
                hex::encode(stamp_id),
                format,
                version,
                width,
                height,
                color_space
            );
        }

        let rec = &mut ctx.accounts.chunk_record;
        rec.stamp_id = stamp_id;
        rec.chunk_index = chunk_index;
        rec.chunk_total = chunk_total;
        rec.chunk_hash = chunk_hash;
        rec.chunk_crc = chunk_crc;
        rec.data_len = chunk_data_len;
        rec.payer = ctx.accounts.payer.key();
        rec.slot = Clock::get()?.slot;

        msg!(
            "PERMADATA_IMAGE_CHUNK stamp={} idx={} total={} len={}",
            hex::encode(stamp_id),
            chunk_index,
            chunk_total,
            chunk_data_len
        );

        Ok(())
    }

    /// Verify an IMAGE stamp — read-only. Enforces codec=0x06, confirms finalized.
    pub fn verify_image_stamp(ctx: Context<VerifyImage>) -> Result<()> {
        let s = &ctx.accounts.stamp_record;
        require!(s.finalized, PermdataError::StampNotFinalized);
        require!(s.codec_type == codec::IMAGE, PermdataError::InvalidCodecType);

        msg!(
            "PERMADATA_IMAGE_VERIFY stamp={} codec=0x{:02x} chunks={} bytes={} hash={} slot={} ok=true",
            hex::encode(s.stamp_id),
            s.codec_type,
            s.chunk_total,
            s.data_length,
            hex::encode(s.payload_hash),
            s.slot
        );

        Ok(())
    }

    // ─── VIDEO Instructions ───────────────────────────────────────

    /// Register a VIDEO chunk — enforces wire format on-chain.
    /// Chunk 0 must begin with magic [0x56, 0x49, 0x44, 0x00] ("VID\0") followed by:
    ///   [format:1][version:1][width:2 LE][height:2 LE][fps:1][has_audio:1]
    ///   [video_codec_hint:1][audio_codec_hint:1][duration_ms:4 LE]
    ///
    /// V1 (raw): stamps container bytes as-is. Use for MP4/MOV/MKV/WEBM — already compressed.
    /// V2 (delta frames): inter-frame delta encoding for RAW uncompressed frame sequences.
    ///   Consecutive frames share ~95% of pixels — delta collapses to near-zero.
    ///   10x–50x compression on raw video. Chain blocks V2 on compressed containers.
    ///
    /// Large videos MUST use MULTIPART — this codec handles individual parts.
    pub fn register_video_chunk(
        ctx: Context<RegisterChunk>,
        stamp_id: [u8; STAMP_ID_LEN],
        chunk_index: u16,
        chunk_total: u16,
        chunk_hash: [u8; 32],
        chunk_crc: u32,
        chunk_data_len: u16,
        chunk_data_preview: Vec<u8>,
    ) -> Result<()> {
        require!(chunk_index < chunk_total, PermdataError::InvalidChunkIndex);
        require!(chunk_total > 0 && chunk_total <= MAX_CHUNKS as u16, PermdataError::InvalidChunkTotal);
        require!(chunk_data_len > 0 && chunk_data_len <= MAX_CHUNK_SIZE, PermdataError::InvalidChunkSize);
        require!(chunk_data_preview.len() >= VIDEO_HEADER_LEN, PermdataError::VideoMissingMagic);

        // Enforce magic header — VID\0
        require!(
            chunk_data_preview[0..4] == VIDEO_MAGIC,
            PermdataError::VideoMissingMagic
        );

        // Chunk 0: validate full metadata header
        if chunk_index == 0 && chunk_data_preview.len() >= VIDEO_META_LEN {
            let format           = chunk_data_preview[4];
            let version          = chunk_data_preview[5];
            let width            = u16::from_le_bytes([chunk_data_preview[6],  chunk_data_preview[7]]);
            let height           = u16::from_le_bytes([chunk_data_preview[8],  chunk_data_preview[9]]);
            let fps              = chunk_data_preview[10];
            let has_audio        = chunk_data_preview[11];
            let video_codec_hint = chunk_data_preview[12];
            let audio_codec_hint = chunk_data_preview[13];
            let duration_ms      = u32::from_le_bytes([
                chunk_data_preview[14], chunk_data_preview[15],
                chunk_data_preview[16], chunk_data_preview[17],
            ]);

            require!(video_format::is_valid(format),           PermdataError::VideoInvalidFormat);
            require!(video_version::is_valid(version),         PermdataError::VideoInvalidVersion);
            require!(video_codec_hint::is_valid(video_codec_hint), PermdataError::VideoInvalidCodecHint);
            require!(width > 0 && height > 0,                  PermdataError::VideoInvalidDimensions);
            require!(fps > 0 && fps <= 240,                    PermdataError::VideoInvalidFps);
            require!(has_audio <= 1,                           PermdataError::VideoInvalidHasAudio);

            // V2 delta frames only valid for raw/uncompressed video
            // All container formats (MP4/MOV/MKV/WEBM/AVI/TS/FLV) are already compressed
            if version == video_version::V2_DELTA_FRAMES {
                require!(
                    format == video_format::RAW_VID || format == video_format::GENERIC,
                    PermdataError::VideoV2CompressedNotSupported
                );
                require!(
                    video_codec_hint == video_codec_hint::RAW || video_codec_hint == video_codec_hint::UNKNOWN,
                    PermdataError::VideoV2CompressedNotSupported
                );
            }

            msg!(
                "PERMADATA_VIDEO_META stamp={} fmt=0x{:02x} ver=0x{:02x} w={} h={} fps={} audio={} vc=0x{:02x} dur_ms={}",
                hex::encode(stamp_id),
                format,
                version,
                width,
                height,
                fps,
                has_audio,
                video_codec_hint,
                duration_ms
            );
            let _ = audio_codec_hint; // stored in log context, no range enforcement needed
        }

        let rec = &mut ctx.accounts.chunk_record;
        rec.stamp_id = stamp_id;
        rec.chunk_index = chunk_index;
        rec.chunk_total = chunk_total;
        rec.chunk_hash = chunk_hash;
        rec.chunk_crc = chunk_crc;
        rec.data_len = chunk_data_len;
        rec.payer = ctx.accounts.payer.key();
        rec.slot = Clock::get()?.slot;

        msg!(
            "PERMADATA_VIDEO_CHUNK stamp={} idx={} total={} len={}",
            hex::encode(stamp_id),
            chunk_index,
            chunk_total,
            chunk_data_len
        );

        Ok(())
    }

    /// Verify a VIDEO stamp — read-only. Enforces codec=0x08, confirms finalized.
    pub fn verify_video_stamp(ctx: Context<VerifyVideo>) -> Result<()> {
        let s = &ctx.accounts.stamp_record;
        require!(s.finalized, PermdataError::StampNotFinalized);
        require!(s.codec_type == codec::VIDEO, PermdataError::InvalidCodecType);

        msg!(
            "PERMADATA_VIDEO_VERIFY stamp={} codec=0x{:02x} chunks={} bytes={} hash={} slot={} ok=true",
            hex::encode(s.stamp_id),
            s.codec_type,
            s.chunk_total,
            s.data_length,
            hex::encode(s.payload_hash),
            s.slot
        );

        Ok(())
    }

    // ─── AUDIO Instructions ───────────────────────────────────────

    /// Register an AUDIO chunk — enforces wire format on-chain.
    /// Chunk 0 must begin with magic [0x41, 0x55, 0x44, 0x00] ("AUD\0") followed by:
    ///   [format: u8][version: u8][channels: u8][bit_depth: u8][sample_rate: u32 LE][duration_ms: u32 LE]
    /// Subsequent chunks only require the 4-byte magic header.
    ///
    /// V1 (raw): stamps audio bytes as-is. Use for MP3/AAC/OGG (already compressed).
    /// V2 (delta PCM): consecutive sample deltas applied before chunking.
    ///   Best for WAV/AIFF/FLAC — 3x–6x compression on voice, 2x–4x on music.
    pub fn register_audio_chunk(
        ctx: Context<RegisterChunk>,
        stamp_id: [u8; STAMP_ID_LEN],
        chunk_index: u16,
        chunk_total: u16,
        chunk_hash: [u8; 32],
        chunk_crc: u32,
        chunk_data_len: u16,
        chunk_data_preview: Vec<u8>,
    ) -> Result<()> {
        require!(chunk_index < chunk_total, PermdataError::InvalidChunkIndex);
        require!(chunk_total > 0 && chunk_total <= MAX_CHUNKS as u16, PermdataError::InvalidChunkTotal);
        require!(chunk_data_len > 0 && chunk_data_len <= MAX_CHUNK_SIZE, PermdataError::InvalidChunkSize);
        require!(chunk_data_preview.len() >= AUDIO_HEADER_LEN, PermdataError::AudioMissingMagic);

        // Enforce magic header — AUD\0
        require!(
            chunk_data_preview[0..4] == AUDIO_MAGIC,
            PermdataError::AudioMissingMagic
        );

        // Chunk 0: validate full metadata header
        if chunk_index == 0 && chunk_data_preview.len() >= AUDIO_META_LEN {
            let format      = chunk_data_preview[4];
            let version     = chunk_data_preview[5];
            let channels    = chunk_data_preview[6];
            let bit_depth   = chunk_data_preview[7];
            let sample_rate = u32::from_le_bytes([
                chunk_data_preview[8], chunk_data_preview[9],
                chunk_data_preview[10], chunk_data_preview[11],
            ]);
            let duration_ms = u32::from_le_bytes([
                chunk_data_preview[12], chunk_data_preview[13],
                chunk_data_preview[14], chunk_data_preview[15],
            ]);

            require!(audio_format::is_valid(format), PermdataError::AudioInvalidFormat);
            require!(audio_version::is_valid(version), PermdataError::AudioInvalidVersion);
            require!(channels > 0 && channels <= 32, PermdataError::AudioInvalidChannels);
            require!(sample_rate > 0, PermdataError::AudioInvalidSampleRate);

            // V2 delta PCM only valid for uncompressed formats (WAV, AIFF)
            // MP3/AAC/OGG/OPUS/M4A are already compressed — V2 would expand them
            if version == audio_version::V2_DELTA_PCM {
                require!(
                    format == audio_format::WAV
                        || format == audio_format::AIFF
                        || format == audio_format::FLAC
                        || format == audio_format::GENERIC,
                    PermdataError::AudioV2CompressedNotSupported
                );
            }

            msg!(
                "PERMADATA_AUDIO_META stamp={} fmt=0x{:02x} ver=0x{:02x} ch={} bits={} rate={} dur_ms={}",
                hex::encode(stamp_id),
                format,
                version,
                channels,
                bit_depth,
                sample_rate,
                duration_ms
            );
        }

        let rec = &mut ctx.accounts.chunk_record;
        rec.stamp_id = stamp_id;
        rec.chunk_index = chunk_index;
        rec.chunk_total = chunk_total;
        rec.chunk_hash = chunk_hash;
        rec.chunk_crc = chunk_crc;
        rec.data_len = chunk_data_len;
        rec.payer = ctx.accounts.payer.key();
        rec.slot = Clock::get()?.slot;

        msg!(
            "PERMADATA_AUDIO_CHUNK stamp={} idx={} total={} len={}",
            hex::encode(stamp_id),
            chunk_index,
            chunk_total,
            chunk_data_len
        );

        Ok(())
    }

    /// Verify an AUDIO stamp — read-only. Enforces codec=0x07, confirms finalized.
    pub fn verify_audio_stamp(ctx: Context<VerifyAudio>) -> Result<()> {
        let s = &ctx.accounts.stamp_record;
        require!(s.finalized, PermdataError::StampNotFinalized);
        require!(s.codec_type == codec::AUDIO, PermdataError::InvalidCodecType);

        msg!(
            "PERMADATA_AUDIO_VERIFY stamp={} codec=0x{:02x} chunks={} bytes={} hash={} slot={} ok=true",
            hex::encode(s.stamp_id),
            s.codec_type,
            s.chunk_total,
            s.data_length,
            hex::encode(s.payload_hash),
            s.slot
        );

        Ok(())
    }

    // ─── MULTIPART Instructions ───────────────────────────────────

    /// Register the MULTIPART parent manifest chunk.
    /// The parent stamp (codec=0x0A) is the index — it maps ordered child stamp IDs
    /// to their sequence position. The actual data lives in child stamps.
    ///
    /// Chunk 0 layout:
    ///   [MPAR: 4][inner_codec: 1][part_count: 2 LE][total_bytes: 8 LE][child_ids: 6 * part_count]
    ///
    /// Enforces: magic, inner_codec is a known codec, part_count <= 256,
    ///           child IDs present and non-zero, total_bytes > 0.
    pub fn register_multipart_manifest(
        ctx: Context<RegisterChunk>,
        stamp_id: [u8; STAMP_ID_LEN],
        chunk_index: u16,
        chunk_total: u16,
        chunk_hash: [u8; 32],
        chunk_crc: u32,
        chunk_data_len: u16,
        chunk_data_preview: Vec<u8>,
    ) -> Result<()> {
        require!(chunk_index < chunk_total, PermdataError::InvalidChunkIndex);
        require!(chunk_total > 0 && chunk_total <= MAX_CHUNKS as u16, PermdataError::InvalidChunkTotal);
        require!(chunk_data_len > 0 && chunk_data_len <= MAX_CHUNK_SIZE, PermdataError::InvalidChunkSize);
        require!(chunk_data_preview.len() >= MULTIPART_HEADER_MIN, PermdataError::MultipartMissingMagic);

        // Enforce magic header — MPAR
        require!(
            chunk_data_preview[0..4] == MULTIPART_MAGIC,
            PermdataError::MultipartMissingMagic
        );

        if chunk_index == 0 {
            let inner_codec = chunk_data_preview[4];
            let part_count  = u16::from_le_bytes([chunk_data_preview[5], chunk_data_preview[6]]);
            let total_bytes = u64::from_le_bytes([
                chunk_data_preview[7],  chunk_data_preview[8],
                chunk_data_preview[9],  chunk_data_preview[10],
                chunk_data_preview[11], chunk_data_preview[12],
                chunk_data_preview[13], chunk_data_preview[14],
            ]);

            // inner_codec must be a known data codec (not MULTIPART itself)
            require!(
                inner_codec == codec::RAW
                    || inner_codec == codec::UTF8_TEXT
                    || inner_codec == codec::UTF8_EN
                    || inner_codec == codec::MATHSCI
                    || inner_codec == codec::CBOR
                    || inner_codec == codec::IMAGE
                    || inner_codec == codec::BINARY,
                PermdataError::MultipartInvalidInnerCodec
            );

            require!(part_count > 0 && part_count <= MULTIPART_MAX_PARTS, PermdataError::MultipartInvalidPartCount);
            require!(total_bytes > 0, PermdataError::MultipartInvalidTotalBytes);

            msg!(
                "PERMADATA_MULTIPART_MANIFEST stamp={} inner=0x{:02x} parts={} total_bytes={}",
                hex::encode(stamp_id),
                inner_codec,
                part_count,
                total_bytes
            );
        }

        let rec = &mut ctx.accounts.chunk_record;
        rec.stamp_id = stamp_id;
        rec.chunk_index = chunk_index;
        rec.chunk_total = chunk_total;
        rec.chunk_hash = chunk_hash;
        rec.chunk_crc = chunk_crc;
        rec.data_len = chunk_data_len;
        rec.payer = ctx.accounts.payer.key();
        rec.slot = Clock::get()?.slot;

        msg!(
            "PERMADATA_MULTIPART_CHUNK stamp={} idx={} total={} len={}",
            hex::encode(stamp_id),
            chunk_index,
            chunk_total,
            chunk_data_len
        );

        Ok(())
    }

    /// Verify a MULTIPART stamp — read-only. Enforces codec=0x0A, confirms finalized.
    /// Emits inner codec and part count from the manifest for on-chain discoverability.
    pub fn verify_multipart_stamp(ctx: Context<VerifyMultipart>) -> Result<()> {
        let s = &ctx.accounts.stamp_record;
        require!(s.finalized, PermdataError::StampNotFinalized);
        require!(s.codec_type == codec::MULTIPART, PermdataError::InvalidCodecType);

        msg!(
            "PERMADATA_MULTIPART_VERIFY stamp={} codec=0x{:02x} chunks={} bytes={} hash={} slot={} ok=true",
            hex::encode(s.stamp_id),
            s.codec_type,
            s.chunk_total,
            s.data_length,
            hex::encode(s.payload_hash),
            s.slot
        );

        Ok(())
    }

    // ─── BINARY Instructions ──────────────────────────────────────

    /// Register a BINARY chunk — enforces wire format on-chain.
    /// Chunk data must begin with magic [0x42, 0x49, 0x4E, 0x00] ("BIN\0").
    /// Byte 4 (chunk_index=0 only): file type hint from binary_type constants.
    /// Remaining bytes: raw binary payload, no transformation.
    /// Any language, any toolchain — if the magic is right, it stamps.
    pub fn register_binary_chunk(
        ctx: Context<RegisterChunk>,
        stamp_id: [u8; STAMP_ID_LEN],
        chunk_index: u16,
        chunk_total: u16,
        chunk_hash: [u8; 32],
        chunk_crc: u32,
        chunk_data_len: u16,
        chunk_data_preview: Vec<u8>,
    ) -> Result<()> {
        require!(chunk_index < chunk_total, PermdataError::InvalidChunkIndex);
        require!(chunk_total > 0 && chunk_total <= MAX_CHUNKS as u16, PermdataError::InvalidChunkTotal);
        require!(chunk_data_len > 0 && chunk_data_len <= MAX_CHUNK_SIZE, PermdataError::InvalidChunkSize);
        require!(chunk_data_preview.len() >= BINARY_HEADER_LEN, PermdataError::BinaryMissingMagic);

        require!(
            chunk_data_preview[0..4] == BINARY_MAGIC,
            PermdataError::BinaryMissingMagic
        );

        if chunk_index == 0 && chunk_data_preview.len() > 4 {
            let file_type = chunk_data_preview[4];
            require!(
                binary_type::is_valid(file_type),
                PermdataError::BinaryInvalidFileType
            );
        }

        let rec = &mut ctx.accounts.chunk_record;
        rec.stamp_id = stamp_id;
        rec.chunk_index = chunk_index;
        rec.chunk_total = chunk_total;
        rec.chunk_hash = chunk_hash;
        rec.chunk_crc = chunk_crc;
        rec.data_len = chunk_data_len;
        rec.payer = ctx.accounts.payer.key();
        rec.slot = Clock::get()?.slot;

        msg!(
            "PERMADATA_BINARY_CHUNK stamp={} idx={} total={} len={}",
            hex::encode(stamp_id),
            chunk_index,
            chunk_total,
            chunk_data_len
        );

        Ok(())
    }

    /// Verify a BINARY stamp — read-only. Enforces codec=0x09, confirms finalized.
    pub fn verify_binary_stamp(ctx: Context<VerifyBinary>) -> Result<()> {
        let s = &ctx.accounts.stamp_record;
        require!(s.finalized, PermdataError::StampNotFinalized);
        require!(s.codec_type == codec::BINARY, PermdataError::InvalidCodecType);

        msg!(
            "PERMADATA_BINARY_VERIFY stamp={} codec=0x{:02x} chunks={} bytes={} hash={} slot={} ok=true",
            hex::encode(s.stamp_id),
            s.codec_type,
            s.chunk_total,
            s.data_length,
            hex::encode(s.payload_hash),
            s.slot
        );

        Ok(())
    }

    /// Verify a MATHSCI stamp — validates codec byte and emits verification result.
    /// Read-only. Enforces codec=0x04 and confirms stamp is finalized.
    pub fn verify_mathsci_stamp(ctx: Context<VerifyMathsci>) -> Result<()> {
        let s = &ctx.accounts.stamp_record;
        require!(s.finalized, PermdataError::StampNotFinalized);
        require!(s.codec_type == codec::MATHSCI, PermdataError::InvalidCodecType);

        msg!(
            "PERMADATA_MATHSCI_VERIFY stamp={} codec=0x{:02x} chunks={} bytes={} hash={} slot={} ok=true",
            hex::encode(s.stamp_id),
            s.codec_type,
            s.chunk_total,
            s.data_length,
            hex::encode(s.payload_hash),
            s.slot
        );

        Ok(())
    }

    /// Register a chunk: store its hash on-chain.
    /// The raw chunk data travels in the transaction memo field.
    /// Anyone can call this — no SDK required.
    pub fn register_chunk(
        ctx: Context<RegisterChunk>,
        stamp_id: [u8; STAMP_ID_LEN],
        chunk_index: u16,
        chunk_total: u16,
        chunk_hash: [u8; 32],  // SHA256 of the chunk data
        chunk_crc: u32,
        chunk_data_len: u16,
    ) -> Result<()> {
        require!(chunk_index < chunk_total, PermdataError::InvalidChunkIndex);
        require!(chunk_total > 0 && chunk_total <= MAX_CHUNKS as u16, PermdataError::InvalidChunkTotal);
        require!(chunk_data_len > 0 && chunk_data_len <= MAX_CHUNK_SIZE, PermdataError::InvalidChunkSize);

        let rec = &mut ctx.accounts.chunk_record;
        rec.stamp_id = stamp_id;
        rec.chunk_index = chunk_index;
        rec.chunk_total = chunk_total;
        rec.chunk_hash = chunk_hash;
        rec.chunk_crc = chunk_crc;
        rec.data_len = chunk_data_len;
        rec.payer = ctx.accounts.payer.key();
        rec.slot = Clock::get()?.slot;

        msg!(
            "PERMADATA_CHUNK stamp={} idx={} total={} len={}",
            hex::encode(stamp_id),
            chunk_index,
            chunk_total,
            chunk_data_len
        );

        Ok(())
    }

    /// Finalize: seal the stamp record after all chunks are registered.
    /// Validates chunk count and codec metadata. Immutable after this.
    pub fn finalize_stamp(
        ctx: Context<FinalizeStamp>,
        stamp_id: [u8; STAMP_ID_LEN],
        chunk_total: u16,
        codec_type: u8,
        data_length: u32,
        checksum: u32,
        payload_hash: [u8; 32],  // SHA256 of full compressed payload
    ) -> Result<()> {
        require!(
            codec_type == codec::RAW
                || codec_type == codec::UTF8_TEXT
                || codec_type == codec::UTF8_EN
                || codec_type == codec::MATHSCI
                || codec_type == codec::CBOR
                || codec_type == codec::IMAGE
                || codec_type == codec::BINARY
                || codec_type == codec::AUDIO
                || codec_type == codec::VIDEO
                || codec_type == codec::MULTIPART,
            PermdataError::InvalidCodecType
        );
        require!(chunk_total > 0, PermdataError::InvalidChunkTotal);
        require!(
            ctx.remaining_accounts.len() == chunk_total as usize,
            PermdataError::MissingChunks
        );

        // Verify each chunk PDA exists and belongs to this stamp
        for (i, acct) in ctx.remaining_accounts.iter().enumerate() {
            let (expected, _) = Pubkey::find_program_address(
                &[b"perm_chunk", &stamp_id, &(i as u16).to_le_bytes()],
                ctx.program_id,
            );
            require!(acct.key() == expected, PermdataError::InvalidChunkPDA);
            require!(!acct.data_is_empty(), PermdataError::MissingChunks);
        }

        // Collect protocol fee — 0.0015 SOL per stamp
        // 90% to treasury, 10% burned (transferred to system program)
        // Treasury is hardcoded — caller cannot redirect fees
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to:   ctx.accounts.treasury.to_account_info(),
                },
            ),
            PROTOCOL_FEE_DEV,
        )?;

        msg!(
            "PERMADATA_FEE paid={} treasury={}",
            PROTOCOL_FEE_DEV,
            ctx.accounts.treasury.key()
        );

        let stamp = &mut ctx.accounts.stamp_record;
        stamp.stamp_id = stamp_id;
        stamp.codec_type = codec_type;
        stamp.chunk_total = chunk_total;
        stamp.data_length = data_length;
        stamp.checksum = checksum;
        stamp.payload_hash = payload_hash;
        stamp.payer = ctx.accounts.payer.key();
        stamp.slot = Clock::get()?.slot;
        stamp.finalized = true;

        msg!(
            "PERMADATA_STAMP stamp={} codec=0x{:02x} chunks={} bytes={} hash={}",
            hex::encode(stamp_id),
            codec_type,
            chunk_total,
            data_length,
            hex::encode(payload_hash)
        );

        // Self-describing retrieval instruction — anyone who sees this tx knows exactly how to get the data back
        msg!(
            "PERMADATA_RETRIEVE node retrieve-oneliner.mjs {} --rpc https://rpc.mainnet.x1.xyz",
            hex::encode(stamp_id)
        );

        Ok(())
    }

    /// Verify a stamp — emits metadata to logs. Read-only.
    pub fn verify_stamp(ctx: Context<VerifyStamp>) -> Result<()> {
        let s = &ctx.accounts.stamp_record;
        require!(s.finalized, PermdataError::StampNotFinalized);

        msg!(
            "PERMADATA_VERIFY stamp={} codec=0x{:02x} chunks={} bytes={} hash={} slot={} ok=true",
            hex::encode(s.stamp_id),
            s.codec_type,
            s.chunk_total,
            s.data_length,
            hex::encode(s.payload_hash),
            s.slot
        );

        Ok(())
    }
}

// ─── Account Contexts ───────────────────────────────────────

#[derive(Accounts)]
pub struct VerifyVideo<'info> {
    pub stamp_record: Account<'info, StampRecord>,
}

#[derive(Accounts)]
pub struct VerifyAudio<'info> {
    pub stamp_record: Account<'info, StampRecord>,
}

#[derive(Accounts)]
pub struct VerifyMultipart<'info> {
    pub stamp_record: Account<'info, StampRecord>,
}

#[derive(Accounts)]
pub struct VerifyImage<'info> {
    pub stamp_record: Account<'info, StampRecord>,
}

#[derive(Accounts)]
pub struct VerifyBinary<'info> {
    pub stamp_record: Account<'info, StampRecord>,
}

#[derive(Accounts)]
pub struct DecodeMathsci<'info> {
    pub stamp_record: Account<'info, StampRecord>,
}

#[derive(Accounts)]
pub struct VerifyMathsci<'info> {
    pub stamp_record: Account<'info, StampRecord>,
}


#[derive(Accounts)]
#[instruction(stamp_id: [u8; STAMP_ID_LEN], chunk_index: u16)]
pub struct RegisterChunk<'info> {
    #[account(
        init,
        payer = payer,
        space = ChunkRecord::SIZE,
        seeds = [b"perm_chunk", stamp_id.as_ref(), &chunk_index.to_le_bytes()],
        bump
    )]
    pub chunk_record: Account<'info, ChunkRecord>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(stamp_id: [u8; STAMP_ID_LEN])]
pub struct FinalizeStamp<'info> {
    #[account(
        init,
        payer = payer,
        space = StampRecord::SIZE,
        seeds = [b"perm_stamp", stamp_id.as_ref()],
        bump
    )]
    pub stamp_record: Account<'info, StampRecord>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// Permadata protocol treasury — hardcoded, non-configurable.
    /// Must be GmvrL1ymC9ENuQCUqymC9robGa9t9L59AbFiwhDDd4Ld.
    /// Cannot be overridden by caller. Chain enforces this.
    #[account(
        mut,
        constraint = treasury.key().to_bytes() == TREASURY_WALLET_BYTES @ PermdataError::InvalidTreasury
    )]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyStamp<'info> {
    pub stamp_record: Account<'info, StampRecord>,
}

// ─── Account Data ───────────────────────────────────────────

#[account]
pub struct ChunkRecord {
    pub stamp_id: [u8; STAMP_ID_LEN],  // 6
    pub chunk_index: u16,               // 2
    pub chunk_total: u16,               // 2
    pub chunk_hash: [u8; 32],           // 32 — SHA256 of chunk data
    pub chunk_crc: u32,                 // 4
    pub data_len: u16,                  // 2
    pub payer: Pubkey,                  // 32
    pub slot: u64,                      // 8
}

impl ChunkRecord {
    pub const SIZE: usize = 8 + 6 + 2 + 2 + 32 + 4 + 2 + 32 + 8; // = 96 bytes
}

#[account]
pub struct StampRecord {
    pub stamp_id: [u8; STAMP_ID_LEN],  // 6
    pub codec_type: u8,                 // 1
    pub chunk_total: u16,               // 2
    pub data_length: u32,               // 4
    pub checksum: u32,                  // 4
    pub payload_hash: [u8; 32],         // 32
    pub payer: Pubkey,                  // 32
    pub slot: u64,                      // 8
    pub finalized: bool,                // 1
}

impl StampRecord {
    pub const SIZE: usize = 8 + 6 + 1 + 2 + 4 + 4 + 32 + 32 + 8 + 1; // = 98 bytes
}

// ─── Errors ─────────────────────────────────────────────────

#[error_code]
pub enum PermdataError {
    #[msg("MATHSCI chunk missing magic header [MSCI]")]
    MathsciMissingMagic,
    #[msg("MATHSCI type tag not recognized (valid: 0x01-0x09)")]
    MathsciInvalidTypeTag,
    #[msg("BINARY chunk missing magic header [BIN\\0]")]
    BinaryMissingMagic,
    #[msg("BINARY file type hint not recognized (valid: 0x00-0x09)")]
    BinaryInvalidFileType,
    #[msg("IMAGE chunk missing magic header [IMG\\0]")]
    ImageMissingMagic,
    #[msg("IMAGE format tag not recognized (valid: 0x00-0x09)")]
    ImageInvalidFormat,
    #[msg("IMAGE color space not recognized (valid: 0x00-0x05)")]
    ImageInvalidColorSpace,
    #[msg("IMAGE encoding version not recognized (valid: 0x01=raw, 0x02=delta+YCbCr)")]
    ImageInvalidVersion,
    #[msg("IMAGE V2 delta+YCbCr encoding does not support CMYK color space")]
    ImageV2CmykNotSupported,
    #[msg("MULTIPART manifest missing magic header [MPAR]")]
    MultipartMissingMagic,
    #[msg("MULTIPART inner codec not recognized or is itself MULTIPART")]
    MultipartInvalidInnerCodec,
    #[msg("MULTIPART part count must be 1-256")]
    MultipartInvalidPartCount,
    #[msg("MULTIPART total_bytes must be greater than zero")]
    MultipartInvalidTotalBytes,
    #[msg("AUDIO chunk missing magic header [AUD\\0]")]
    AudioMissingMagic,
    #[msg("AUDIO format tag not recognized (valid: 0x00-0x08)")]
    AudioInvalidFormat,
    #[msg("AUDIO encoding version not recognized (valid: 0x01=raw, 0x02=delta_pcm)")]
    AudioInvalidVersion,
    #[msg("AUDIO channels must be 1-32")]
    AudioInvalidChannels,
    #[msg("AUDIO sample rate must be greater than zero")]
    AudioInvalidSampleRate,
    #[msg("AUDIO V2 delta PCM not supported for compressed formats (MP3/AAC/OGG/OPUS/M4A) — use V1")]
    AudioV2CompressedNotSupported,
    #[msg("VIDEO chunk missing magic header [VID\\0]")]
    VideoMissingMagic,
    #[msg("VIDEO container format not recognized (valid: 0x00-0x08)")]
    VideoInvalidFormat,
    #[msg("VIDEO encoding version not recognized (valid: 0x01=raw, 0x02=delta_frames)")]
    VideoInvalidVersion,
    #[msg("VIDEO codec hint not recognized (valid: 0x00-0x07)")]
    VideoInvalidCodecHint,
    #[msg("VIDEO width and height must both be greater than zero")]
    VideoInvalidDimensions,
    #[msg("VIDEO fps must be 1-240")]
    VideoInvalidFps,
    #[msg("VIDEO has_audio flag must be 0 or 1")]
    VideoInvalidHasAudio,
    #[msg("VIDEO V2 delta frames not supported for compressed containers — use V1")]
    VideoV2CompressedNotSupported,
    #[msg("Chunk index must be less than chunk total")]
    InvalidChunkIndex,
    #[msg("Chunk total must be 1-512")]
    InvalidChunkTotal,
    #[msg("Chunk data length must be 1-800 bytes")]
    InvalidChunkSize,
    #[msg("Codec type not recognized")]
    InvalidCodecType,
    #[msg("Not all chunk PDAs present for finalization")]
    MissingChunks,
    #[msg("Chunk PDA address mismatch")]
    InvalidChunkPDA,
    #[msg("Stamp not finalized")]
    StampNotFinalized,
    #[msg("Invalid treasury wallet — fees must go to Permadata treasury")]
    InvalidTreasury,
}
