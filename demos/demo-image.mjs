#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol — IMAGE Demo (codec 0x06)
//  Stamps image files permanently on X1 mainnet.
//  Wire format: [IMG\0 magic][format][version][width][height][color_space][reserved][image bytes]
//
//  Usage:
//    node demo-image.mjs photo.jpg
//    node demo-image.mjs photo.png --v2        (delta+YCbCr compression)
//    node demo-image.mjs artwork.webp
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { Connection } from '@solana/web3.js';
import {
  RPC_URL, PROGRAM_ID, CODEC, loadWallet, crc32, stampId,
  payloadHash, chunkData, registerChunk, finalizeStamp,
  getChunkPdas, printBanner
} from './shared.mjs';

const IMAGE_MAGIC = Buffer.from([0x49, 0x4D, 0x47, 0x00]); // "IMG\0"

const IMAGE_FORMAT = { GENERIC: 0x00, JPEG: 0x01, PNG: 0x02, WEBP: 0x03, GIF: 0x04, BMP: 0x05, TIFF: 0x06, AVIF: 0x07, SVG: 0x08, RAW_IMG: 0x09 };
const IMAGE_VERSION = { V1_RAW: 0x01, V2_DELTA_YCBCR: 0x02 };
const IMAGE_COLOR_SPACE = { UNKNOWN: 0x00, SRGB: 0x01, ADOBE_RGB: 0x02, GRAYSCALE: 0x03, CMYK: 0x04, HDR: 0x05 };

function detectFormat(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return IMAGE_FORMAT.JPEG;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return IMAGE_FORMAT.PNG;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return IMAGE_FORMAT.GIF;
  if (buf[0] === 0x42 && buf[1] === 0x4D) return IMAGE_FORMAT.BMP;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return IMAGE_FORMAT.WEBP;
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A) return IMAGE_FORMAT.TIFF;
  if (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A) return IMAGE_FORMAT.TIFF;
  return IMAGE_FORMAT.GENERIC;
}

function buildImagePayload(imageBytes, format, version, width, height, colorSpace) {
  // Chunk 0: [IMG\0][format:1][version:1][width:2 LE][height:2 LE][color_space:1][reserved:1][image data...]
  const meta = Buffer.alloc(12);
  IMAGE_MAGIC.copy(meta, 0);
  meta[4] = format;
  meta[5] = version;
  meta.writeUInt16LE(width, 6);
  meta.writeUInt16LE(height, 8);
  meta[10] = colorSpace;
  meta[11] = 0x00; // reserved

  // For subsequent chunks, prepend magic only
  return { meta, imageBytes };
}

function buildChunk0(meta, imageBytes, maxChunk) {
  // First chunk: meta header + as much image data as fits
  const available = maxChunk - meta.length;
  return Buffer.concat([meta, imageBytes.slice(0, available)]);
}

function buildSubsequentChunks(meta, imageBytes, maxChunk) {
  const magicOnly = IMAGE_MAGIC; // only 4 bytes on subsequent chunks
  const offset = maxChunk - meta.length; // where chunk 0 left off
  const remaining = imageBytes.slice(offset);
  const chunks = [];
  for (let i = 0; i < remaining.length; i += (maxChunk - 4)) {
    chunks.push(Buffer.concat([magicOnly, remaining.slice(i, i + maxChunk - 4)]));
  }
  return chunks;
}

async function main() {
  printBanner('IMAGE Demo (codec 0x06)');

  const args = process.argv.slice(2);
  const filePath = args.find(a => !a.startsWith('--'));
  const useV2    = args.includes('--v2');

  if (!filePath) {
    console.error('Usage: node demo-image.mjs <image.jpg|png|webp> [--v2]');
    process.exit(1);
  }

  const imageBytes = readFileSync(filePath);
  const format     = detectFormat(imageBytes);
  const version    = useV2 ? IMAGE_VERSION.V2_DELTA_YCBCR : IMAGE_VERSION.V1_RAW;
  const formatName = Object.keys(IMAGE_FORMAT).find(k => IMAGE_FORMAT[k] === format);

  // Width/height: 0 means unknown — provide real values if you have them
  const width = 0, height = 0, colorSpace = IMAGE_COLOR_SPACE.SRGB;

  const { meta } = buildImagePayload(imageBytes, format, version, width, height, colorSpace);
  const chunk0   = buildChunk0(meta, imageBytes, 500);
  const restChunks = buildSubsequentChunks(meta, imageBytes, 500);
  const allChunks  = [chunk0, ...restChunks];

  const payload  = imageBytes; // hash/checksum over original image bytes
  const sid      = stampId(payload);
  const pHash    = payloadHash(payload);
  const checksum = crc32(payload);

  console.log(`File:         ${filePath}`);
  console.log(`Format:       ${formatName} (0x${format.toString(16).padStart(2,'0')})`);
  console.log(`Version:      ${useV2 ? 'V2_DELTA_YCBCR (0x02)' : 'V1_RAW (0x01)'}`);
  console.log(`File size:    ${imageBytes.length} bytes`);
  console.log(`Stamp ID:     ${sid.toString('hex')}`);
  console.log(`Chunks:       ${allChunks.length}`);
  console.log(`SHA256:       ${pHash.toString('hex')}\n`);

  const conn   = new Connection(RPC_URL, 'confirmed');
  const wallet = loadWallet();
  console.log(`Wallet: ${wallet.publicKey.toBase58()}\n`);

  for (let i = 0; i < allChunks.length; i++) {
    process.stdout.write(`  Chunk ${i+1}/${allChunks.length}... `);
    const sig = await registerChunk(conn, wallet, 'register_image_chunk', sid, i, allChunks.length, allChunks[i], PROGRAM_ID);
    console.log(`✅ ${sig.slice(0,20)}...`);
  }

  console.log('\n  Finalizing stamp...');
  const chunkPdas = getChunkPdas(sid, allChunks.length, PROGRAM_ID);
  const finSig = await finalizeStamp(conn, wallet, sid, allChunks.length, CODEC.IMAGE, imageBytes.length, checksum, pHash, chunkPdas, PROGRAM_ID);

  console.log(`\n✅ IMAGE STAMP COMPLETE`);
  console.log(`   Stamp ID:  ${sid.toString('hex')}`);
  console.log(`   Format:    ${formatName}`);
  console.log(`   Finalize:  ${finSig}`);
  console.log(`   Explorer:  https://explorer.x1.xyz/tx/${finSig}`);
  console.log(`\n   Image stamped on X1. Permanent proof of existence.\n`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
