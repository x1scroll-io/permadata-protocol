#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol Demo v0.1.0
//  No SDK required — raw transaction construction only.
//
//  Architecture:
//  - Chunk DATA → transaction memo fields (permanent on-chain storage)
//  - Chunk HASHES → registered in PDAs via on-chain program
//  - Stamp RECORD → sealed on-chain after all chunks registered
//
//  Usage: node demo.mjs <file> [--codec text|mathsci|raw]
// ─────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import {
  Connection, Keypair, Transaction, TransactionInstruction,
  PublicKey, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram
} from '@solana/web3.js';
import zstd from '@mongodb-js/zstd';

// ── Config ──────────────────────────────────────────────────────
const RPC_URL   = 'https://rpc.mainnet.x1.xyz';
const PROGRAM_ID = new PublicKey('BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq');
const WALLET_PATH = process.env.PERMADATA_KEY
  || '/root/.openclaw/workspace/memory/A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK.json';
const MAX_CHUNK  = 500; // protocol spec: 500 bytes per chunk
const MEMO_PROG  = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// ── Codec IDs ────────────────────────────────────────────────────
const CODEC = { raw: 0x01, text: 0x02, en: 0x03, mathsci: 0x04, cbor: 0x05 };
const MAGIC  = Buffer.from([0x50, 0x45, 0x52, 0x44]); // "PERD"

// ── CRC32 ────────────────────────────────────────────────────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) { crc ^= b; for (let i=0;i<8;i++) crc=(crc&1)?(crc>>>1)^0xEDB88320:crc>>>1; }
  return (~crc)>>>0;
}

// ── Anchor discriminator ─────────────────────────────────────────
function disc(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0,8);
}

// ── Build Permadata Header ────────────────────────────────────────
function buildHeader(codecType, dataLength, checksum) {
  const h = Buffer.alloc(16);
  MAGIC.copy(h,0); h[4]=0x01; h[5]=codecType;
  h.writeUInt16LE(0,6); h.writeUInt32LE(dataLength,8); h.writeUInt32LE(checksum,12);
  return h;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (!args[0]) { console.error('Usage: node demo.mjs <file> [--codec text|mathsci|raw]'); process.exit(1); }

  const filePath   = args[0];
  const codecIdx   = args.indexOf('--codec');
  const codecName  = codecIdx >= 0 ? args[codecIdx+1] : 'text';
  const codecType  = CODEC[codecName] ?? CODEC.text;

  if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

  const rawData  = readFileSync(filePath);
  const checksum = crc32(rawData);
  const header   = buildHeader(codecType, rawData.length, checksum);
  const payload  = Buffer.concat([header, rawData]);

  // Compress
  const compressed = Buffer.from(await zstd.compress(payload, 3));
  const ratio = (rawData.length / compressed.length).toFixed(2);

  // Stamp ID = first 6 bytes of SHA256(compressed)
  const payloadHash = createHash('sha256').update(compressed).digest();
  const stampId     = payloadHash.slice(0, 6);
  const stampIdHex  = stampId.toString('hex');

  // Chunk
  const chunks = [];
  for (let i=0; i<compressed.length; i+=MAX_CHUNK) chunks.push(compressed.slice(i, i+MAX_CHUNK));

  console.log(`\n🔐 Permadata Protocol v0.1.0`);
  console.log(`═══════════════════════════════════════`);
  console.log(`  File:         ${filePath}`);
  console.log(`  Codec:        0x${codecType.toString(16).padStart(2,'0')} (${codecName})`);
  console.log(`  Raw size:     ${rawData.length} bytes`);
  console.log(`  Compressed:   ${compressed.length} bytes (${ratio}x)`);
  console.log(`  CRC32:        0x${checksum.toString(16).padStart(8,'0')}`);
  console.log(`  Payload hash: ${payloadHash.toString('hex')}`);
  console.log(`  Stamp ID:     ${stampIdHex}`);
  console.log(`  Chunks:       ${chunks.length}`);
  console.log(`  Program:      ${PROGRAM_ID.toBase58()}`);
  console.log(`═══════════════════════════════════════\n`);

  const keyData = JSON.parse(readFileSync(WALLET_PATH));
  const payer   = Keypair.fromSecretKey(Uint8Array.from(keyData));
  const conn    = new Connection(RPC_URL, 'confirmed');

  console.log(`  Payer: ${payer.publicKey.toBase58()}`);
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`  Balance: ${(bal/1e9).toFixed(6)} XNT\n`);

  // ── Phase 1: Register chunks (hash on-chain + data in memo) ──
  console.log(`📦 Phase 1: Registering ${chunks.length} chunk(s)...\n`);

  for (let i=0; i<chunks.length; i++) {
    const chunk    = chunks[i];
    const chunkSha = createHash('sha256').update(chunk).digest();
    const chunkCrc = crc32(chunk);
    const idxBuf   = Buffer.alloc(2); idxBuf.writeUInt16LE(i);

    // PDA for this chunk
    const [chunkPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('perm_chunk'), stampId, idxBuf], PROGRAM_ID
    );

    // Instruction data: disc + stamp_id(6) + chunk_index(2) + chunk_total(2) + chunk_hash(32) + chunk_crc(4) + data_len(2)
    const idata = Buffer.alloc(6+2+2+32+4+2);
    stampId.copy(idata, 0);
    idata.writeUInt16LE(i, 6);
    idata.writeUInt16LE(chunks.length, 8);
    chunkSha.copy(idata, 10);
    idata.writeUInt32LE(chunkCrc, 42);
    idata.writeUInt16LE(chunk.length, 46);

    const fullData = Buffer.concat([disc('register_chunk'), idata]);

    // Memo = base64(chunk) — data lives here permanently
    const memoData = chunk.toString('base64');

    // Tx 1: Store raw data in memo (permanent transaction log)
    const memoTx = new Transaction();
    memoTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    memoTx.add(new TransactionInstruction({
      programId: MEMO_PROG,
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(`PERM:${stampIdHex}:${i}:${chunks.length}:${memoData}`),
    }));

    // Tx 2: Register chunk hash on-chain via program
    const hashTx = new Transaction();
    hashTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    hashTx.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: chunkPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: fullData,
    }));

    try {
      const memoSig = await sendAndConfirmTransaction(conn, memoTx, [payer], { commitment: 'confirmed' });
      const hashSig = await sendAndConfirmTransaction(conn, hashTx, [payer], { commitment: 'confirmed' });
      console.log(`  ✅ Chunk ${i+1}/${chunks.length} registered`);
      console.log(`     Hash: ${chunkSha.toString('hex').slice(0,16)}...`);
      console.log(`     Memo tx:  ${memoSig.slice(0,20)}...`);
      console.log(`     Hash tx:  ${hashSig.slice(0,20)}...`);
    } catch (err) {
      console.error(`  ❌ Chunk ${i+1} failed:`, err.message);
      if (err.logs) console.error('  Logs:', err.logs);
      process.exit(1);
    }
  }

  // ── Phase 2: Finalize stamp ──────────────────────────────────
  console.log(`\n🔒 Phase 2: Finalizing stamp...\n`);

  const [stampPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('perm_stamp'), stampId], PROGRAM_ID
  );

  // Build finalize instruction data
  const fdata = Buffer.alloc(6+2+1+4+4+32);
  stampId.copy(fdata, 0);
  fdata.writeUInt16LE(chunks.length, 6);
  fdata[8] = codecType;
  fdata.writeUInt32LE(rawData.length, 9);
  fdata.writeUInt32LE(checksum, 13);
  payloadHash.copy(fdata, 17);

  const finalizeFullData = Buffer.concat([disc('finalize_stamp'), fdata]);

  // Remaining accounts = all chunk PDAs
  const remainingAccounts = [];
  for (let i=0; i<chunks.length; i++) {
    const idxBuf = Buffer.alloc(2); idxBuf.writeUInt16LE(i);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('perm_chunk'), stampId, idxBuf], PROGRAM_ID
    );
    remainingAccounts.push({ pubkey: pda, isSigner: false, isWritable: false });
  }

  const ftx = new Transaction();
  ftx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  ftx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: stampPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    data: finalizeFullData,
  }));

  try {
    const sig = await sendAndConfirmTransaction(conn, ftx, [payer], { commitment: 'confirmed' });
    const costXnt = ((chunks.length + 1) * 0.000058).toFixed(6);
    console.log(`\n✅ STAMP COMPLETE`);
    console.log(`═══════════════════════════════════════`);
    console.log(`  Stamp ID:     ${stampIdHex}`);
    console.log(`  Program:      ${PROGRAM_ID.toBase58()}`);
    console.log(`  Codec:        0x${codecType.toString(16).padStart(2,'0')} (${codecName})`);
    console.log(`  Chunks:       ${chunks.length}`);
    console.log(`  Data:         ${rawData.length} → ${compressed.length} bytes (${ratio}x)`);
    console.log(`  Payload hash: ${payloadHash.toString('hex')}`);
    console.log(`  Cost:         ~${costXnt} XNT`);
    console.log(`  Finalize tx:  ${sig}`);
    console.log(`═══════════════════════════════════════`);
    console.log(`\n🔗 Permanent. Immutable. On-chain. No server required.\n`);
  } catch (err) {
    console.error('❌ Finalize failed:', err.message);
    if (err.logs) console.error('Logs:', err.logs);
    process.exit(1);
  }
}

main().catch(console.error);
