#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol — UTF8_TEXT Demo (codec 0x02)
//  Stamps any text file or string permanently on X1 mainnet.
//
//  Usage:
//    node demo-text.mjs "Hello, world"
//    node demo-text.mjs --file ./contract.txt
//    node demo-text.mjs --file ./contract.txt --codec en   (UTF8_EN 0x03)
// ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { Connection } from '@solana/web3.js';
import {
  RPC_URL, PROGRAM_ID, CODEC, loadWallet, crc32, stampId,
  payloadHash, chunkData, registerChunk, finalizeStamp,
  getChunkPdas, printBanner
} from './shared.mjs';

async function main() {
  printBanner('UTF8_TEXT Demo');

  const args = process.argv.slice(2);
  let text;
  let codecType = CODEC.UTF8_TEXT;

  if (args.includes('--file')) {
    text = readFileSync(args[args.indexOf('--file') + 1], 'utf8');
  } else if (args[0] && !args[0].startsWith('--')) {
    text = args[0];
  } else {
    // Default demo text
    text = `Permadata Protocol Demo — UTF8_TEXT
Timestamp: ${new Date().toISOString()}
This text is being stamped permanently on X1 mainnet.
Program ID: BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq
No server. No subscription. Forever.`;
  }

  if (args.includes('--codec') && args[args.indexOf('--codec') + 1] === 'en') {
    codecType = CODEC.UTF8_EN;
    console.log('Codec: UTF8_EN (0x03) — English optimized');
  } else {
    console.log('Codec: UTF8_TEXT (0x02)');
  }

  const payload   = Buffer.from(text, 'utf8');
  const sid       = stampId(payload);
  const pHash     = payloadHash(payload);
  const checksum  = crc32(payload);
  const chunks    = chunkData(payload);

  console.log(`Text length:  ${payload.length} bytes`);
  console.log(`Stamp ID:     ${sid.toString('hex')}`);
  console.log(`Chunks:       ${chunks.length}`);
  console.log(`SHA256:       ${pHash.toString('hex')}\n`);

  const conn   = new Connection(RPC_URL, 'confirmed');
  const wallet = loadWallet();
  console.log(`Wallet: ${wallet.publicKey.toBase58()}\n`);

  // Register all chunks
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  Chunk ${i+1}/${chunks.length}... `);
    const sig = await registerChunk(conn, wallet, 'register_chunk', sid, i, chunks.length, chunks[i], PROGRAM_ID);
    console.log(`✅ ${sig.slice(0,20)}...`);
  }

  // Finalize
  console.log('\n  Finalizing stamp...');
  const chunkPdas = getChunkPdas(sid, chunks.length, PROGRAM_ID);
  const finSig = await finalizeStamp(conn, wallet, sid, chunks.length, codecType, payload.length, checksum, pHash, chunkPdas, PROGRAM_ID);

  console.log(`\n✅ STAMP COMPLETE`);
  console.log(`   Stamp ID:  ${sid.toString('hex')}`);
  console.log(`   Finalize:  ${finSig}`);
  console.log(`   Explorer:  https://explorer.x1.xyz/tx/${finSig}`);
  console.log(`\n   This text is now permanent on X1. Forever.\n`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
