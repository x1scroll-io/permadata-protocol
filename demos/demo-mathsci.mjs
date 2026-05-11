#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol — MATHSCI Demo (codec 0x04)
//  Stamps scientific/numerical data permanently on X1 mainnet.
//  Wire format: [MSCI magic][type_tag][count u16 LE][values...]
//
//  Usage:
//    node demo-mathsci.mjs                          (built-in demo: temperature readings)
//    node demo-mathsci.mjs --type f64 1.1 2.2 3.3  (stamp float64 array)
//    node demo-mathsci.mjs --type i32 100 200 300   (stamp int32 array)
// ─────────────────────────────────────────────────────────────────

import { Connection } from '@solana/web3.js';
import {
  RPC_URL, PROGRAM_ID, CODEC, loadWallet, crc32, stampId,
  payloadHash, chunkData, registerChunk, finalizeStamp,
  getChunkPdas, printBanner
} from './shared.mjs';

// MATHSCI type tags
const MATHSCI_TYPE = { f64: 0x01, f32: 0x02, i64: 0x03, i32: 0x04, u64: 0x05, u8: 0x06, complex64: 0x07, bool_array: 0x08, timestamp: 0x09 };
const MATHSCI_MAGIC = Buffer.from([0x4D, 0x53, 0x43, 0x49]); // "MSCI"

function buildMathsciPayload(typeTag, values) {
  let valueBuf;
  switch (typeTag) {
    case MATHSCI_TYPE.f64: {
      valueBuf = Buffer.alloc(values.length * 8);
      values.forEach((v, i) => valueBuf.writeDoubleBE(v, i * 8)); break;
    }
    case MATHSCI_TYPE.f32: {
      valueBuf = Buffer.alloc(values.length * 4);
      values.forEach((v, i) => valueBuf.writeFloatBE(v, i * 4)); break;
    }
    case MATHSCI_TYPE.i32: {
      valueBuf = Buffer.alloc(values.length * 4);
      values.forEach((v, i) => valueBuf.writeInt32LE(v, i * 4)); break;
    }
    case MATHSCI_TYPE.i64:
    case MATHSCI_TYPE.u64:
    case MATHSCI_TYPE.timestamp: {
      valueBuf = Buffer.alloc(values.length * 8);
      values.forEach((v, i) => valueBuf.writeBigInt64LE(BigInt(v), i * 8)); break;
    }
    default: {
      valueBuf = Buffer.from(values.map(Number)); break;
    }
  }

  const countBuf = Buffer.alloc(2);
  countBuf.writeUInt16LE(values.length, 0);

  return Buffer.concat([MATHSCI_MAGIC, Buffer.from([typeTag]), countBuf, valueBuf]);
}

async function main() {
  printBanner('MATHSCI Demo (codec 0x04)');

  const args = process.argv.slice(2);
  let typeTag = MATHSCI_TYPE.f64;
  let values;
  let label;

  if (args.includes('--type')) {
    const typeStr = args[args.indexOf('--type') + 1];
    typeTag = MATHSCI_TYPE[typeStr] || MATHSCI_TYPE.f64;
    values  = args.slice(args.indexOf('--type') + 2).map(Number);
    label   = `${typeStr} array (${values.length} values)`;
  } else {
    // Default: Detroit hourly temperature readings (°C) — last 24 hours
    values = [
      18.2, 17.8, 17.1, 16.5, 16.0, 15.8, 15.6, 15.9,
      16.8, 18.1, 19.5, 21.2, 22.8, 23.9, 24.5, 24.8,
      24.2, 23.5, 22.1, 20.8, 19.9, 19.2, 18.8, 18.5
    ];
    label = 'Detroit hourly temperatures °C (24h)';
    console.log(`Demo dataset: ${label}`);
  }

  const payload  = buildMathsciPayload(typeTag, values);
  const sid      = stampId(payload);
  const pHash    = payloadHash(payload);
  const checksum = crc32(payload);
  const chunks   = chunkData(payload);

  console.log(`Type:         0x${typeTag.toString(16).padStart(2,'0')} (${Object.keys(MATHSCI_TYPE).find(k => MATHSCI_TYPE[k] === typeTag)})`);
  console.log(`Values:       ${values.length}`);
  console.log(`Payload:      ${payload.length} bytes`);
  console.log(`Stamp ID:     ${sid.toString('hex')}`);
  console.log(`Chunks:       ${chunks.length}`);
  console.log(`SHA256:       ${pHash.toString('hex')}\n`);
  console.log(`Sample values: [${values.slice(0, 5).join(', ')}${values.length > 5 ? '...' : ''}]\n`);

  const conn   = new Connection(RPC_URL, 'confirmed');
  const wallet = loadWallet();
  console.log(`Wallet: ${wallet.publicKey.toBase58()}\n`);

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  Chunk ${i+1}/${chunks.length}... `);
    const sig = await registerChunk(conn, wallet, 'register_mathsci_chunk', sid, i, chunks.length, chunks[i], PROGRAM_ID);
    console.log(`✅ ${sig.slice(0,20)}...`);
  }

  console.log('\n  Finalizing stamp...');
  const chunkPdas = getChunkPdas(sid, chunks.length, PROGRAM_ID);
  const finSig = await finalizeStamp(conn, wallet, sid, chunks.length, CODEC.MATHSCI, payload.length, checksum, pHash, chunkPdas, PROGRAM_ID);

  console.log(`\n✅ MATHSCI STAMP COMPLETE`);
  console.log(`   Stamp ID:  ${sid.toString('hex')}`);
  console.log(`   Finalize:  ${finSig}`);
  console.log(`   Explorer:  https://explorer.x1.xyz/tx/${finSig}`);
  console.log(`\n   ${values.length} scientific values stamped on X1. Permanent.\n`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
