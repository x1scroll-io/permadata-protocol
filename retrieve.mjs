#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol — Retrieval Script v0.1.0
//  No SDK required. Reads directly from X1 chain.
//
//  Given a Stamp ID:
//  1. Fetches StampRecord PDA → gets metadata
//  2. Fetches all ChunkRecord PDAs → gets chunk hashes
//  3. Scans recent transactions for memo data matching stamp ID
//  4. Reconstructs compressed payload
//  5. Verifies SHA256 hash + CRC32 checksum
//  6. Decompresses → returns original data
//
//  Usage: node retrieve.mjs <stamp_id> [--out <file>]
// ─────────────────────────────────────────────────────────────────

import { writeFileSync } from 'fs';
import { createHash } from 'crypto';
import {
  Connection, PublicKey
} from '@solana/web3.js';
import zstd from '@mongodb-js/zstd';

const RPC_URL    = 'https://rpc.mainnet.x1.xyz';
const PROGRAM_ID = new PublicKey('BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq');

const CODEC_NAMES = {
  0x01: 'RAW',
  0x02: 'UTF8_TEXT',
  0x03: 'UTF8_EN',
  0x04: 'MATHSCI',
  0x05: 'CBOR',
};

// ── CRC32 ────────────────────────────────────────────────────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) { crc ^= b; for (let i=0;i<8;i++) crc=(crc&1)?(crc>>>1)^0xEDB88320:crc>>>1; }
  return (~crc)>>>0;
}

// ── Anchor account discriminator decode ──────────────────────────
// Skip first 8 bytes (discriminator), then decode fields per struct layout

function decodeStampRecord(data) {
  // Layout: disc(8) + stamp_id(6) + codec_type(1) + chunk_total(2) + data_length(4) + checksum(4) + payload_hash(32) + payer(32) + slot(8) + finalized(1)
  let offset = 8;
  const stamp_id      = data.slice(offset, offset+6); offset += 6;
  const codec_type    = data[offset]; offset += 1;
  const chunk_total   = data.readUInt16LE(offset); offset += 2;
  const data_length   = data.readUInt32LE(offset); offset += 4;
  const checksum      = data.readUInt32LE(offset); offset += 4;
  const payload_hash  = data.slice(offset, offset+32); offset += 32;
  const payer         = new PublicKey(data.slice(offset, offset+32)); offset += 32;
  const slot          = data.readBigUInt64LE(offset); offset += 8;
  const finalized     = data[offset] === 1;
  return { stamp_id, codec_type, chunk_total, data_length, checksum, payload_hash, payer, slot, finalized };
}

function decodeChunkRecord(data) {
  // Layout: disc(8) + stamp_id(6) + chunk_index(2) + chunk_total(2) + chunk_hash(32) + chunk_crc(4) + data_len(2) + payer(32) + slot(8)
  let offset = 8;
  const stamp_id     = data.slice(offset, offset+6); offset += 6;
  const chunk_index  = data.readUInt16LE(offset); offset += 2;
  const chunk_total  = data.readUInt16LE(offset); offset += 2;
  const chunk_hash   = data.slice(offset, offset+32); offset += 32;
  const chunk_crc    = data.readUInt32LE(offset); offset += 4;
  const data_len     = data.readUInt16LE(offset); offset += 2;
  return { stamp_id, chunk_index, chunk_total, chunk_hash, chunk_crc, data_len };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error('Usage: node retrieve.mjs <stamp_id_hex> [--out <file>]');
    console.error('Example: node retrieve.mjs 60812828cde4');
    process.exit(1);
  }

  const stampIdHex = args[0].toLowerCase();
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx+1] : null;

  if (stampIdHex.length !== 12) {
    console.error('Stamp ID must be 12 hex characters (6 bytes)');
    process.exit(1);
  }

  const stampId = Buffer.from(stampIdHex, 'hex');
  const conn = new Connection(RPC_URL, 'confirmed');

  console.log(`\n🔍 Permadata Protocol — Retrieve`);
  console.log(`═══════════════════════════════════════`);
  console.log(`  Stamp ID: ${stampIdHex}`);
  console.log(`  Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`  RPC:      ${RPC_URL}\n`);

  // ── Step 1: Fetch StampRecord PDA ───────────────────────────
  console.log(`📋 Step 1: Fetching stamp record...`);
  const [stampPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('perm_stamp'), stampId], PROGRAM_ID
  );

  const stampAcct = await conn.getAccountInfo(stampPda);
  if (!stampAcct) {
    console.error(`❌ Stamp not found on chain. Stamp ID: ${stampIdHex}`);
    console.error(`   PDA: ${stampPda.toBase58()}`);
    process.exit(1);
  }

  const stamp = decodeStampRecord(Buffer.from(stampAcct.data));

  if (!stamp.finalized) {
    console.error(`❌ Stamp exists but is not finalized yet.`);
    process.exit(1);
  }

  console.log(`  ✅ Stamp record found`);
  console.log(`     Codec:        0x${stamp.codec_type.toString(16).padStart(2,'0')} (${CODEC_NAMES[stamp.codec_type] || 'unknown'})`);
  console.log(`     Chunks:       ${stamp.chunk_total}`);
  console.log(`     Data length:  ${stamp.data_length} bytes`);
  console.log(`     CRC32:        0x${stamp.checksum.toString(16).padStart(8,'0')}`);
  console.log(`     Payload hash: ${stamp.payload_hash.toString('hex')}`);
  console.log(`     Stamped slot: ${stamp.slot}`);
  console.log(`     Payer:        ${stamp.payer.toBase58()}\n`);

  // ── Step 2: Fetch all ChunkRecord PDAs ───────────────────────
  console.log(`📦 Step 2: Fetching ${stamp.chunk_total} chunk record(s)...`);
  const chunkMeta = [];
  for (let i = 0; i < stamp.chunk_total; i++) {
    const idxBuf = Buffer.alloc(2); idxBuf.writeUInt16LE(i);
    const [chunkPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('perm_chunk'), stampId, idxBuf], PROGRAM_ID
    );
    const chunkAcct = await conn.getAccountInfo(chunkPda);
    if (!chunkAcct) {
      console.error(`❌ Chunk ${i} PDA not found: ${chunkPda.toBase58()}`);
      process.exit(1);
    }
    const meta = decodeChunkRecord(Buffer.from(chunkAcct.data));
    chunkMeta.push(meta);
    console.log(`  ✅ Chunk ${i+1}/${stamp.chunk_total} — hash: ${meta.chunk_hash.toString('hex').slice(0,16)}... len: ${meta.data_len}b`);
  }

  // ── Step 3: Scan transactions for memo data ───────────────────
  console.log(`\n🔗 Step 3: Scanning chain for chunk data...`);
  console.log(`   Searching transactions from payer: ${stamp.payer.toBase58()}`);

  // Get recent transaction signatures from payer
  const sigs = await conn.getSignaturesForAddress(stamp.payer, { limit: 1000 });
  console.log(`   Found ${sigs.length} recent transactions to scan\n`);

  const chunkData = new Array(stamp.chunk_total).fill(null);
  let found = 0;

  // Process in batches of 10 using getParsedTransactions (reads from logMessages)
  const batchSize = 10;
  for (let i = 0; i < sigs.length && found < stamp.chunk_total; i += batchSize) {
    const batch = sigs.slice(i, i + batchSize).map(s => s.signature);
    const txs = await conn.getParsedTransactions(batch, { maxSupportedTransactionVersion: 0 });

    for (const tx of txs) {
      if (!tx) continue;
      // Memo data appears in logMessages as:
      // 'Program log: Memo (len N): "PERM:<stampId>:<idx>:<total>:<base64>"'
      for (const log of (tx.meta?.logMessages || [])) {
        if (!log.includes(`PERM:${stampIdHex}:`)) continue;
        try {
          // Extract the memo content from the log line
          const memoMatch = log.match(/Memo \(len \d+\): "(.+)"$/);
          if (!memoMatch) continue;
          const memoStr = memoMatch[1];

          // Format: PERM:<stampId>:<chunkIndex>:<chunkTotal>:<base64data>
          const colonIdx = memoStr.indexOf(':');
          const rest = memoStr.slice(colonIdx + 1); // strip 'PERM'
          const parts = rest.split(':');
          if (parts.length < 4) continue;

          const chunkIdx = parseInt(parts[1]);
          const b64data = parts.slice(3).join(':');
          const rawChunk = Buffer.from(b64data, 'base64');

          if (chunkIdx >= 0 && chunkIdx < stamp.chunk_total && !chunkData[chunkIdx]) {
            const computedHash = createHash('sha256').update(rawChunk).digest();
            const expectedHash = chunkMeta[chunkIdx].chunk_hash;

            if (computedHash.equals(expectedHash)) {
              chunkData[chunkIdx] = rawChunk;
              found++;
              process.stdout.write(`  ✅ Chunk ${chunkIdx+1}/${stamp.chunk_total} recovered (hash verified)\n`);
            } else {
              console.warn(`  ⚠️  Chunk ${chunkIdx} hash mismatch — skipping`);
            }
          }
        } catch {}
      }
    }
    if (found < stamp.chunk_total) process.stdout.write(`  Scanned ${Math.min(i+batchSize, sigs.length)}/${sigs.length} txs, found ${found}/${stamp.chunk_total} chunks...\r`);
  }

  console.log('');

  if (found < stamp.chunk_total) {
    console.error(`\n❌ Only found ${found}/${stamp.chunk_total} chunks.`);
    console.error(`   Some chunk data may be outside the scan window.`);
    process.exit(1);
  }

  // ── Step 4: Reconstruct compressed payload ────────────────────
  console.log(`\n🔧 Step 4: Reconstructing payload...`);
  const compressed = Buffer.concat(chunkData);
  console.log(`  Compressed payload: ${compressed.length} bytes`);

  // Verify payload hash
  const computedPayloadHash = createHash('sha256').update(compressed).digest();
  if (!computedPayloadHash.equals(stamp.payload_hash)) {
    console.error(`❌ Payload hash mismatch!`);
    console.error(`   Expected: ${stamp.payload_hash.toString('hex')}`);
    console.error(`   Got:      ${computedPayloadHash.toString('hex')}`);
    process.exit(1);
  }
  console.log(`  ✅ Payload hash verified`);

  // ── Step 5: Decompress ───────────────────────────────────────
  console.log(`\n📂 Step 5: Decompressing...`);
  const decompressed = Buffer.from(await zstd.decompress(compressed));
  console.log(`  Decompressed: ${decompressed.length} bytes`);

  // ── Step 6: Verify header + checksum ─────────────────────────
  const MAGIC = Buffer.from([0x50, 0x45, 0x52, 0x44]);
  if (!decompressed.slice(0,4).equals(MAGIC)) {
    console.error(`❌ Invalid Permadata magic bytes`);
    process.exit(1);
  }

  const headerDataLen = decompressed.readUInt32LE(8);
  const headerChecksum = decompressed.readUInt32LE(12);
  const data = decompressed.slice(16); // strip 16-byte header

  if (data.length !== headerDataLen) {
    console.error(`❌ Data length mismatch: header says ${headerDataLen}, got ${data.length}`);
    process.exit(1);
  }

  const computedCrc = crc32(data);
  if (computedCrc !== headerChecksum) {
    console.error(`❌ CRC32 mismatch: expected 0x${headerChecksum.toString(16)}, got 0x${computedCrc.toString(16)}`);
    process.exit(1);
  }

  // ── Result ───────────────────────────────────────────────────
  const ratio = (data.length / compressed.length).toFixed(2);
  console.log(`\n✅ RETRIEVAL COMPLETE`);
  console.log(`═══════════════════════════════════════`);
  console.log(`  Stamp ID:     ${stampIdHex}`);
  console.log(`  Codec:        0x${stamp.codec_type.toString(16).padStart(2,'0')} (${CODEC_NAMES[stamp.codec_type] || 'unknown'})`);
  console.log(`  Data:         ${data.length} bytes (was ${compressed.length}b compressed, ${ratio}x ratio)`);
  console.log(`  CRC32:        ✅ 0x${computedCrc.toString(16).padStart(8,'0')}`);
  console.log(`  Hash:         ✅ verified`);
  console.log(`  Integrity:    ✅ PERFECT`);
  console.log(`═══════════════════════════════════════`);
  console.log(`\n🔗 Data retrieved from X1 chain. No server. No trust required.\n`);

  if (outFile) {
    writeFileSync(outFile, data);
    console.log(`  Written to: ${outFile}`);
  } else {
    console.log(`  Data preview (first 500 chars):`);
    console.log(`  ─────────────────────────────`);
    console.log('  ' + data.toString('utf8').slice(0, 500));
    console.log(`  ─────────────────────────────`);
    console.log(`\n  (use --out <file> to save full data)\n`);
  }
}

main().catch(console.error);
