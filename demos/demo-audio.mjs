#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol — AUDIO Demo (codec 0x07)
//  Stamps audio files permanently on X1 mainnet.
//  Wire format: [AUD\0 magic][format][version][channels][bit_depth][sample_rate][duration_ms][audio bytes]
//
//  Usage:
//    node demo-audio.mjs track.mp3
//    node demo-audio.mjs recording.wav --v2    (delta PCM — best for WAV/FLAC)
//    node demo-audio.mjs album.flac --v2
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { Connection } from '@solana/web3.js';
import {
  RPC_URL, PROGRAM_ID, CODEC, loadWallet, crc32, stampId,
  payloadHash, chunkData, registerChunk, finalizeStamp,
  getChunkPdas, printBanner
} from './shared.mjs';

const AUDIO_MAGIC = Buffer.from([0x41, 0x55, 0x44, 0x00]); // "AUD\0"

const AUDIO_FORMAT = { GENERIC: 0x00, WAV: 0x01, MP3: 0x02, FLAC: 0x03, AAC: 0x04, OGG: 0x05, OPUS: 0x06, AIFF: 0x07, M4A: 0x08 };
const AUDIO_VERSION = { V1_RAW: 0x01, V2_DELTA_PCM: 0x02 };

// Formats that support V2 delta PCM (uncompressed sources)
const V2_COMPATIBLE = new Set([AUDIO_FORMAT.WAV, AUDIO_FORMAT.FLAC, AUDIO_FORMAT.AIFF, AUDIO_FORMAT.GENERIC]);

function detectAudioFormat(buf, filePath) {
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return AUDIO_FORMAT.WAV;
  if (buf[0] === 0xFF && (buf[1] === 0xFB || buf[1] === 0xF3 || buf[1] === 0xF2)) return AUDIO_FORMAT.MP3;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return AUDIO_FORMAT.MP3; // ID3
  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return AUDIO_FORMAT.FLAC;
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return AUDIO_FORMAT.OGG;
  if (buf[0] === 0x46 && buf[1] === 0x4F && buf[2] === 0x52 && buf[3] === 0x4D) return AUDIO_FORMAT.AIFF;
  if (filePath && filePath.endsWith('.m4a')) return AUDIO_FORMAT.M4A;
  if (filePath && filePath.endsWith('.aac')) return AUDIO_FORMAT.AAC;
  return AUDIO_FORMAT.GENERIC;
}

function buildAudioChunk0(audioBytes, format, version, channels, bitDepth, sampleRate, durationMs) {
  // [AUD\0: 4][format:1][version:1][channels:1][bit_depth:1][sample_rate:4 LE][duration_ms:4 LE][audio data...]
  const meta = Buffer.alloc(16);
  AUDIO_MAGIC.copy(meta, 0);
  meta[4] = format;
  meta[5] = version;
  meta[6] = channels;
  meta[7] = bitDepth;
  meta.writeUInt32LE(sampleRate, 8);
  meta.writeUInt32LE(durationMs, 12);

  const available = 500 - meta.length;
  return { meta, chunk0: Buffer.concat([meta, audioBytes.slice(0, available)]) };
}

async function main() {
  printBanner('AUDIO Demo (codec 0x07)');

  const args = process.argv.slice(2);
  const filePath = args.find(a => !a.startsWith('--'));
  const useV2    = args.includes('--v2');

  if (!filePath) {
    console.error('Usage: node demo-audio.mjs <track.mp3|wav|flac|ogg> [--v2]');
    process.exit(1);
  }

  const audioBytes = readFileSync(filePath);
  const format     = detectAudioFormat(audioBytes, filePath);
  const formatName = Object.keys(AUDIO_FORMAT).find(k => AUDIO_FORMAT[k] === format);

  let version = AUDIO_VERSION.V1_RAW;
  if (useV2) {
    if (!V2_COMPATIBLE.has(format)) {
      console.error(`Error: V2 delta PCM not supported for ${formatName} (already compressed). Use V1.`);
      process.exit(1);
    }
    version = AUDIO_VERSION.V2_DELTA_PCM;
  }

  // Metadata defaults — override for production use
  const channels   = 2;
  const bitDepth   = 16;
  const sampleRate = 44100;
  const durationMs = 0; // 0 = unknown

  const { meta, chunk0 } = buildAudioChunk0(audioBytes, format, version, channels, bitDepth, sampleRate, durationMs);

  // Build all chunks: chunk0 with header, rest with magic-only prefix
  const magicOnly   = AUDIO_MAGIC;
  const firstData   = audioBytes.slice(500 - meta.length);
  const allChunks   = [chunk0];
  for (let i = 0; i < firstData.length; i += (500 - 4)) {
    allChunks.push(Buffer.concat([magicOnly, firstData.slice(i, i + 496)]));
  }

  const payload  = audioBytes;
  const sid      = stampId(payload);
  const pHash    = payloadHash(payload);
  const checksum = crc32(payload);

  console.log(`File:         ${filePath}`);
  console.log(`Format:       ${formatName} (0x${format.toString(16).padStart(2,'0')})`);
  console.log(`Version:      ${useV2 ? 'V2_DELTA_PCM (0x02)' : 'V1_RAW (0x01)'}`);
  console.log(`File size:    ${audioBytes.length} bytes`);
  console.log(`Stamp ID:     ${sid.toString('hex')}`);
  console.log(`Chunks:       ${allChunks.length}`);
  console.log(`SHA256:       ${pHash.toString('hex')}\n`);

  if (allChunks.length > 512) {
    console.error(`File too large for single stamp (${allChunks.length} chunks > 512 max). Use demo-multipart.mjs.`);
    process.exit(1);
  }

  const conn   = new Connection(RPC_URL, 'confirmed');
  const wallet = loadWallet();
  console.log(`Wallet: ${wallet.publicKey.toBase58()}\n`);

  for (let i = 0; i < allChunks.length; i++) {
    process.stdout.write(`  Chunk ${i+1}/${allChunks.length}... `);
    const sig = await registerChunk(conn, wallet, 'register_audio_chunk', sid, i, allChunks.length, allChunks[i], PROGRAM_ID);
    console.log(`✅ ${sig.slice(0,20)}...`);
  }

  console.log('\n  Finalizing stamp...');
  const chunkPdas = getChunkPdas(sid, allChunks.length, PROGRAM_ID);
  const finSig = await finalizeStamp(conn, wallet, sid, allChunks.length, CODEC.AUDIO, audioBytes.length, checksum, pHash, chunkPdas, PROGRAM_ID);

  console.log(`\n✅ AUDIO STAMP COMPLETE`);
  console.log(`   Stamp ID:  ${sid.toString('hex')}`);
  console.log(`   Format:    ${formatName}`);
  console.log(`   Finalize:  ${finSig}`);
  console.log(`   Explorer:  https://explorer.x1.xyz/tx/${finSig}`);
  console.log(`\n   Audio stamped on X1. Permanent. Decentralized.\n`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
