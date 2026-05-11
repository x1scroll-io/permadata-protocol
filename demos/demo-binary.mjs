#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol — BINARY Demo (codec 0x09)
//  Stamps executables, firmware, archives permanently on X1 mainnet.
//  Wire format: [BIN\0 magic][file_type_hint][binary bytes]
//
//  Usage:
//    node demo-binary.mjs ./program.so
//    node demo-binary.mjs ./firmware.bin --type firmware
//    node demo-binary.mjs ./archive.zip  --type zip
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { Connection } from '@solana/web3.js';
import {
  RPC_URL, PROGRAM_ID, CODEC, loadWallet, crc32, stampId,
  payloadHash, chunkData, registerChunk, finalizeStamp,
  getChunkPdas, printBanner
} from './shared.mjs';

const BINARY_MAGIC = Buffer.from([0x42, 0x49, 0x4E, 0x00]); // "BIN\0"

const BINARY_TYPE = {
  GENERIC: 0x00, ELF: 0x01, WASM: 0x02, MACHO: 0x03,
  PE: 0x04, FIRMWARE: 0x05, SO: 0x06, AR: 0x07, ZIP: 0x08, TAR: 0x09
};

function detectBinaryType(buf, filePath, hint) {
  if (hint) return BINARY_TYPE[hint.toUpperCase()] ?? BINARY_TYPE.GENERIC;
  if (buf[0] === 0x7F && buf[1] === 0x45 && buf[2] === 0x4C && buf[3] === 0x46) return BINARY_TYPE.ELF;
  if (buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6D) return BINARY_TYPE.WASM;
  if (buf[0] === 0xCF && buf[1] === 0xFA) return BINARY_TYPE.MACHO;
  if (buf[0] === 0x4D && buf[1] === 0x5A) return BINARY_TYPE.PE;
  if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03) return BINARY_TYPE.ZIP;
  if (filePath && filePath.endsWith('.so')) return BINARY_TYPE.SO;
  if (filePath && filePath.endsWith('.tar')) return BINARY_TYPE.TAR;
  if (filePath && filePath.endsWith('.bin')) return BINARY_TYPE.FIRMWARE;
  return BINARY_TYPE.GENERIC;
}

async function main() {
  printBanner('BINARY Demo (codec 0x09)');

  const args     = process.argv.slice(2);
  const filePath = args.find(a => !a.startsWith('--'));
  const typeHint = args.includes('--type') ? args[args.indexOf('--type') + 1] : null;

  if (!filePath) {
    console.error('Usage: node demo-binary.mjs <file> [--type elf|wasm|firmware|zip|tar|so|ar|pe|macho|generic]');
    process.exit(1);
  }

  const binBytes  = readFileSync(filePath);
  const fileType  = detectBinaryType(binBytes, filePath, typeHint);
  const typeName  = Object.keys(BINARY_TYPE).find(k => BINARY_TYPE[k] === fileType);

  // Build all chunks — chunk 0: [BIN\0][file_type][data...], rest: [BIN\0][data...]
  const allChunks = [];
  const firstData = binBytes.slice(0, 495); // 500 - 5 (magic + type byte)
  allChunks.push(Buffer.concat([BINARY_MAGIC, Buffer.from([fileType]), firstData]));
  for (let i = 495; i < binBytes.length; i += 496) {
    allChunks.push(Buffer.concat([BINARY_MAGIC, binBytes.slice(i, i + 496)]));
  }

  const payload  = binBytes;
  const sid      = stampId(payload);
  const pHash    = payloadHash(payload);
  const checksum = crc32(payload);

  console.log(`File:         ${filePath}`);
  console.log(`Type:         ${typeName} (0x${fileType.toString(16).padStart(2,'0')})`);
  console.log(`File size:    ${binBytes.length} bytes`);
  console.log(`Stamp ID:     ${sid.toString('hex')}`);
  console.log(`Chunks:       ${allChunks.length}`);
  console.log(`SHA256:       ${pHash.toString('hex')}\n`);

  if (allChunks.length > 512) {
    console.error(`File too large for single stamp. Use demo-multipart.mjs for files > 256KB.`);
    process.exit(1);
  }

  const conn   = new Connection(RPC_URL, 'confirmed');
  const wallet = loadWallet();
  console.log(`Wallet: ${wallet.publicKey.toBase58()}\n`);

  for (let i = 0; i < allChunks.length; i++) {
    process.stdout.write(`  Chunk ${i+1}/${allChunks.length}... `);
    const sig = await registerChunk(conn, wallet, 'register_binary_chunk', sid, i, allChunks.length, allChunks[i], PROGRAM_ID);
    console.log(`✅ ${sig.slice(0,20)}...`);
  }

  console.log('\n  Finalizing stamp...');
  const chunkPdas = getChunkPdas(sid, allChunks.length, PROGRAM_ID);
  const finSig = await finalizeStamp(conn, wallet, sid, allChunks.length, CODEC.BINARY, binBytes.length, checksum, pHash, chunkPdas, PROGRAM_ID);

  console.log(`\n✅ BINARY STAMP COMPLETE`);
  console.log(`   Stamp ID:  ${sid.toString('hex')}`);
  console.log(`   Type:      ${typeName}`);
  console.log(`   Finalize:  ${finSig}`);
  console.log(`   Explorer:  https://explorer.x1.xyz/tx/${finSig}`);
  console.log(`\n   Binary stamped on X1. Immutable proof of this exact file.\n`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
