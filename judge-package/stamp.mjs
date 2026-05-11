#!/usr/bin/env node
/**
 * Permadata Protocol — stamp.mjs
 * Stamps any file permanently on X1 mainnet.
 *
 * Usage:
 *   node stamp.mjs <path-to-your-file>
 *
 * Example:
 *   node stamp.mjs ~/mydocument.txt
 *   node stamp.mjs ~/photo.jpg
 *   node stamp.mjs ~/contract.pdf
 *
 * Wallet:
 *   Uses ~/.config/solana/id.json by default.
 *   Or set: export PERMADATA_KEY=/path/to/wallet.json
 *   Or pass: node stamp.mjs myfile.txt --key /path/to/wallet.json
 */

import {
  Connection, Keypair, Transaction, TransactionInstruction,
  PublicKey, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram
} from '@solana/web3.js';
import { readFileSync, existsSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename } from 'path';

// ── Config ─────────────────────────────────────────────────────
const RPC      = 'https://rpc.mainnet.x1.xyz';
const PROG     = new PublicKey('BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq');
const MEMO_PK  = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MAX_CHUNK = 500;
const MAX_SIZE  = MAX_CHUNK * 512; // ~256KB max single stamp

// ── Helpers ────────────────────────────────────────────────────
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; }
  return (~c) >>> 0;
}

function disc(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function loadWallet() {
  const args = process.argv;
  const keyIdx = args.indexOf('--key');
  const keyPath = keyIdx !== -1 ? args[keyIdx + 1]
    : process.env.PERMADATA_KEY
    || `${homedir()}/.config/solana/id.json`;

  if (!existsSync(keyPath)) {
    console.error(`\nNo wallet found at: ${keyPath}`);
    console.error(`\nOptions:`);
    console.error(`  1. Set env: export PERMADATA_KEY=/path/to/wallet.json`);
    console.error(`  2. Pass flag: node stamp.mjs myfile.txt --key /path/to/wallet.json`);
    console.error(`  3. Install Solana CLI and run: solana-keygen new\n`);
    process.exit(1);
  }

  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath))));
  } catch {
    console.error(`Invalid wallet file: ${keyPath}`);
    process.exit(1);
  }
}

// ── Main ───────────────────────────────────────────────────────
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const filePath = args[0];

if (!filePath) {
  console.log('\nUsage: node stamp.mjs <path-to-file>');
  console.log('Example: node stamp.mjs ~/mydocument.txt\n');
  process.exit(1);
}

const fullPath = filePath.replace(/^~/, homedir());
if (!existsSync(fullPath)) {
  console.error(`\nFile not found: ${fullPath}\n`);
  process.exit(1);
}

const stats = statSync(fullPath);
if (stats.size > MAX_SIZE) {
  console.error(`\nFile too large: ${(stats.size/1024).toFixed(1)}KB (max 256KB per stamp)`);
  console.error(`For larger files, use MULTIPART mode.\n`);
  process.exit(1);
}

const payload    = readFileSync(fullPath);
const stampIdBuf = createHash('sha256').update(payload).digest().slice(0, 6);
const stampHex   = stampIdBuf.toString('hex');
const pHash      = createHash('sha256').update(payload).digest();
const checksum   = crc32(payload);

// Split into chunks
const chunks = [];
for (let i = 0; i < payload.length; i += MAX_CHUNK) {
  chunks.push(payload.slice(i, i + MAX_CHUNK));
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Permadata Protocol — Stamp`);
console.log(`  Program: BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq`);
console.log(`${'═'.repeat(55)}`);
console.log(`  File:     ${basename(fullPath)} (${payload.length} bytes)`);
console.log(`  Stamp ID: ${stampHex}`);
console.log(`  Chunks:   ${chunks.length}`);
console.log(`  SHA256:   ${pHash.toString('hex').slice(0, 32)}...`);

const conn   = new Connection(RPC, 'confirmed');
const wallet = loadWallet();

const balance = await conn.getBalance(wallet.publicKey);
console.log(`  Wallet:   ${wallet.publicKey.toBase58()}`);
console.log(`  Balance:  ${(balance / 1e9).toFixed(6)} XNT`);

if (balance < 10000 * chunks.length) {
  console.error(`\nInsufficient balance. Need at least ${(chunks.length * 0.001).toFixed(4)} XNT.\n`);
  process.exit(1);
}

console.log(`\nStamping ${chunks.length} chunk(s) to X1 mainnet...\n`);

// Register each chunk
const chunkPdas = [];
for (let i = 0; i < chunks.length; i++) {
  const chunk     = chunks[i];
  const chunkHash = createHash('sha256').update(chunk).digest();
  const chunkCrc  = crc32(chunk);
  const preview   = chunk.slice(0, Math.min(32, chunk.length));

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('perm_chunk'), stampIdBuf, Buffer.from(new Uint16Array([i]).buffer)],
    PROG
  );
  chunkPdas.push(pda);

  // Build instruction data
  const ix = Buffer.alloc(8 + 6 + 2 + 2 + 32 + 4 + 2 + 4 + preview.length);
  disc('register_chunk').copy(ix, 0);
  stampIdBuf.copy(ix, 8);
  ix.writeUInt16LE(i, 14);
  ix.writeUInt16LE(chunks.length, 16);
  chunkHash.copy(ix, 18);
  ix.writeUInt32LE(chunkCrc, 50);
  ix.writeUInt16LE(chunk.length, 54);
  ix.writeUInt32LE(preview.length, 56);
  preview.copy(ix, 60);

  // Memo: PERM:<stampId>:<index>:<total>:<base64data>
  const memoData = Buffer.from(`PERM:${stampHex}:${i}:${chunks.length}:${chunk.toString('base64')}`);

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(new TransactionInstruction({
      programId: MEMO_PK,
      keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
      data: memoData,
    }))
    .add(new TransactionInstruction({
      programId: PROG,
      keys: [
        { pubkey: pda,                    isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey,       isSigner: true,  isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ix,
    }));

  process.stdout.write(`  Chunk ${i + 1}/${chunks.length}... `);
  await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
  console.log('✅');
}

// Finalize stamp
console.log(`\n  Finalizing...`);
const [stampPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('perm_stamp'), stampIdBuf], PROG
);

const fix = Buffer.alloc(8 + 6 + 2 + 1 + 4 + 4 + 32);
disc('finalize_stamp').copy(fix, 0);
stampIdBuf.copy(fix, 8);
fix.writeUInt16LE(chunks.length, 14);
fix[16] = 0x02; // UTF8_TEXT codec
fix.writeUInt32LE(payload.length, 17);
fix.writeUInt32LE(checksum, 21);
pHash.copy(fix, 25);

const ftx = new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
  .add(new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: stampPda,               isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey,       isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...chunkPdas.map(p => ({ pubkey: p, isSigner: false, isWritable: false })),
    ],
    data: fix,
  }));

const sig = await sendAndConfirmTransaction(conn, ftx, [wallet], { commitment: 'confirmed' });

console.log(`\n${'═'.repeat(55)}`);
console.log(`  STAMP COMPLETE — DATA IS NOW PERMANENT ON X1`);
console.log(`${'═'.repeat(55)}`);
console.log(`  Stamp ID:  ${stampHex}`);
console.log(`  File:      ${basename(fullPath)}`);
console.log(`  Tx:        ${sig}`);
console.log(`  Explorer:  https://explorer.x1.xyz/tx/${sig}`);
console.log(`\n  To retrieve: node retrieve.mjs ${stampHex}`);
console.log(`${'═'.repeat(55)}\n`);
