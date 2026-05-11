#!/usr/bin/env node
/**
 * Permadata Protocol — retrieve.mjs
 * Retrieves any stamped file from X1 mainnet.
 * No wallet needed. Read-only. Public RPC only.
 *
 * Usage:
 *   node retrieve.mjs <stamp-id>
 *
 * Example:
 *   node retrieve.mjs 1c3636f58a76
 *   node retrieve.mjs 1c3636f58a76 --out myfile_retrieved.txt
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { gunzipSync, inflateSync } from 'zlib';
import { writeFileSync } from 'fs';

const RPC  = 'https://rpc.mainnet.x1.xyz';
const PROG = new PublicKey('BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq');
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const conn = new Connection(RPC, 'confirmed');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(fn) {
  for (let a = 0; a < 8; a++) {
    try { return await fn(); }
    catch (e) {
      if (e.message?.includes('429')) { await sleep(600 * Math.pow(2, Math.min(a, 4))); }
      else throw e;
    }
  }
  throw new Error('RPC failed after retries');
}

const args      = process.argv.slice(2);
const stampHex  = args[0];
const outIdx    = args.indexOf('--out');
const outFile   = outIdx !== -1 ? args[outIdx + 1] : null;

if (!stampHex) {
  console.log('\nUsage: node retrieve.mjs <stamp-id> [--out filename]');
  console.log('Example: node retrieve.mjs 1c3636f58a76');
  console.log('         node retrieve.mjs 1c3636f58a76 --out myfile.txt\n');
  process.exit(1);
}

const sid    = Buffer.from(stampHex, 'hex');
const PREFIX = `PERM:${stampHex}:`;

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Permadata Protocol — Retrieve`);
console.log(`  Program: BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq`);
console.log(`${'═'.repeat(55)}`);
console.log(`  Stamp ID: ${stampHex}`);
console.log(`  Reading stamp record from chain...`);

// 1. Read StampRecord PDA
const [spda]    = PublicKey.findProgramAddressSync([Buffer.from('perm_stamp'), sid], PROG);
const stampInfo = await rpc(() => conn.getAccountInfo(spda));

if (!stampInfo) {
  console.error(`\n  Stamp not found: ${stampHex}`);
  console.error(`  Make sure you have the correct Stamp ID.\n`);
  process.exit(1);
}

// StampRecord layout: [disc:8][stamp_id:6][codec:1][chunk_total:2 LE][data_len:4 LE][checksum:4][hash:32][payer:32]
const codecType  = stampInfo.data[14];
const chunkTotal = stampInfo.data.readUInt16LE(15);
const dataLen    = stampInfo.data.readUInt32LE(17);
const payer      = new PublicKey(stampInfo.data.slice(57, 89));

const CODEC_NAMES = {
  1: 'RAW', 2: 'UTF8_TEXT', 3: 'UTF8_EN', 4: 'MATHSCI',
  5: 'CBOR', 6: 'IMAGE', 7: 'AUDIO', 8: 'VIDEO', 9: 'BINARY', 10: 'MULTIPART'
};

console.log(`  Codec:    0x${codecType.toString(16).padStart(2, '0')} (${CODEC_NAMES[codecType] || 'UNKNOWN'})`);
console.log(`  Chunks:   ${chunkTotal}`);
console.log(`  Size:     ${dataLen} bytes`);
console.log(`  Stamped by: ${payer.toBase58()}`);
console.log(`\n  Scanning chain for chunk data...\n`);

// 2. Scan payer history for PERM:<stampId>:* memos
const chunks = new Array(chunkTotal);
let found  = 0;
let before = undefined;
let pages  = 0;

while (found < chunkTotal) {
  const sigs = await rpc(() => conn.getSignaturesForAddress(payer, { limit: 50, before }));
  if (!sigs.length) break;
  before = sigs[sigs.length - 1].signature;
  pages++;
  await sleep(100);

  for (const s of sigs) {
    const tx = await rpc(() => conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed'
    }));
    if (!tx) continue;
    await sleep(60);

    const msg     = tx.transaction.message;
    const keys    = msg.staticAccountKeys || [];
    const memoIdx = keys.findIndex(k => k.toBase58() === MEMO);
    if (memoIdx === -1) continue;

    const ix = msg.compiledInstructions?.find(x => x.programIdIndex === memoIdx);
    if (!ix?.data) continue;

    let memo;
    try { memo = Buffer.from(ix.data).toString('utf8'); } catch { continue; }
    if (!memo.startsWith(PREFIX)) continue;

    const parts = memo.split(':');
    if (parts.length < 5) continue;
    const idx = parseInt(parts[2]);
    if (isNaN(idx) || idx < 0 || idx >= chunkTotal) continue;

    if (!chunks[idx]) {
      try {
        chunks[idx] = Buffer.from(parts.slice(4).join(':'), 'base64');
        found++;
        process.stdout.write(`\r  ${found}/${chunkTotal} chunks recovered`);
      } catch { continue; }
    }

    if (found >= chunkTotal) break;
  }

  if (sigs.length < 50) break;
}

console.log(`\n  Complete: ${found}/${chunkTotal} chunks\n`);

if (found === 0) {
  console.error(`  No chunks found. The public RPC may be rate-limiting.`);
  console.error(`  Wait a few minutes and try again.\n`);
  process.exit(1);
}

// 3. Reassemble + decompress
const payload = Buffer.concat(chunks.map(c => c || Buffer.alloc(0)));

let output;
try {
  const { decompress } = await import('@mongodb-js/zstd');
  output = await decompress(payload);
} catch {
  try { output = gunzipSync(payload); }
  catch { try { output = inflateSync(payload); }
  catch { output = payload; } }
}

const text = output.toString('utf8');

console.log(`${'═'.repeat(55)}`);
console.log(`  RETRIEVED FROM X1 CHAIN — ${stampHex}`);
console.log(`${'═'.repeat(55)}\n`);
console.log(text);
console.log(`\n${'═'.repeat(55)}`);
console.log(`  No server. No trust. Data lives on X1 forever.`);
console.log(`${'═'.repeat(55)}\n`);

if (outFile) {
  writeFileSync(outFile, output);
  console.log(`  Saved to: ${outFile}\n`);
}
