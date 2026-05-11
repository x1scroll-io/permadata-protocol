// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol — Shared Utilities for Demo Scripts
//  Program ID: BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq
// ─────────────────────────────────────────────────────────────────

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import {
  Connection, Keypair, Transaction, TransactionInstruction,
  PublicKey, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram
} from '@solana/web3.js';

export const RPC_URL    = 'https://rpc.mainnet.x1.xyz';
export const PROGRAM_ID = new PublicKey('BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq');
export const MEMO_PROG  = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const MAX_CHUNK  = 500;
export const STAMP_ID_LEN = 6;

export const CODEC = {
  RAW:       0x01,
  UTF8_TEXT: 0x02,
  UTF8_EN:   0x03,
  MATHSCI:   0x04,
  CBOR:      0x05,
  IMAGE:     0x06,
  AUDIO:     0x07,
  VIDEO:     0x08,
  BINARY:    0x09,
  MULTIPART: 0x0A,
};

export function loadWallet(path) {
  // Priority: explicit path arg → --key flag → PERMADATA_KEY env → solana default ~/.config/solana/id.json
  const args = process.argv;
  const keyFlagIdx = args.indexOf('--key');
  const keyFromFlag = keyFlagIdx !== -1 ? args[keyFlagIdx + 1] : null;

  const keyPath = path
    || keyFromFlag
    || process.env.PERMADATA_KEY
    || (process.env.HOME + '/.config/solana/id.json');

  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath))));
  } catch (e) {
    console.error(`\n❌ Wallet not found at: ${keyPath}`);
    console.error(`\nProvide your wallet one of these ways:`);
    console.error(`  1. --key /path/to/wallet.json`);
    console.error(`  2. export PERMADATA_KEY=/path/to/wallet.json`);
    console.error(`  3. Place keypair at ~/.config/solana/id.json (Solana CLI default)`);
    console.error(`\nGenerate a new wallet: solana-keygen new --outfile ~/my-wallet.json\n`);
    process.exit(1);
  }
}

export function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) { crc ^= b; for (let i=0;i<8;i++) crc=(crc&1)?(crc>>>1)^0xEDB88320:crc>>>1; }
  return (~crc)>>>0;
}

export function disc(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

export function stampId(data) {
  return createHash('sha256').update(data).digest().slice(0, STAMP_ID_LEN);
}

export function payloadHash(data) {
  return createHash('sha256').update(data).digest();
}

export function chunkData(payload) {
  const chunks = [];
  for (let i = 0; i < payload.length; i += MAX_CHUNK) {
    chunks.push(payload.slice(i, i + MAX_CHUNK));
  }
  return chunks;
}

export async function registerChunk(conn, wallet, instructionName, stampIdBuf, chunkIdx, chunkTotal, chunkBuf, programId) {
  const chunkHash = createHash('sha256').update(chunkBuf).digest();
  const chunkCrc  = crc32(chunkBuf);
  const preview   = chunkBuf.slice(0, Math.min(32, chunkBuf.length));

  const [chunkPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('perm_chunk'), stampIdBuf, Buffer.from(new Uint16Array([chunkIdx]).buffer)],
    programId
  );

  // Anchor instruction data
  const data = Buffer.alloc(8 + 6 + 2 + 2 + 32 + 4 + 2 + 4 + preview.length);
  disc(instructionName).copy(data, 0);
  stampIdBuf.copy(data, 8);
  data.writeUInt16LE(chunkIdx, 14);
  data.writeUInt16LE(chunkTotal, 16);
  chunkHash.copy(data, 18);
  data.writeUInt32LE(chunkCrc, 50);
  data.writeUInt16LE(chunkBuf.length, 54);
  data.writeUInt32LE(preview.length, 56);
  preview.copy(data, 60);

  const memoData = Buffer.from(chunkBuf).toString('base64');

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(new TransactionInstruction({
      programId: MEMO_PROG,
      keys: [],
      data: Buffer.from(memoData),
    }))
    .add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: chunkPda,             isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey,     isSigner: true,  isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }));

  return sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
}

export async function finalizeStamp(conn, wallet, stampIdBuf, chunkTotal, codecType, dataLength, checksum, payloadHashBuf, chunkPdas, programId) {
  const [stampPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('perm_stamp'), stampIdBuf],
    programId
  );

  const data = Buffer.alloc(8 + 6 + 2 + 1 + 4 + 4 + 32);
  disc('finalize_stamp').copy(data, 0);
  stampIdBuf.copy(data, 8);
  data.writeUInt16LE(chunkTotal, 14);
  data[16] = codecType;
  data.writeUInt32LE(dataLength, 17);
  data.writeUInt32LE(checksum, 21);
  payloadHashBuf.copy(data, 25);

  const keys = [
    { pubkey: stampPda,             isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey,     isSigner: true,  isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...chunkPdas.map(p => ({ pubkey: p, isSigner: false, isWritable: false })),
  ];

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(new TransactionInstruction({ programId, keys, data }));

  return sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
}

export function getChunkPdas(stampIdBuf, chunkTotal, programId) {
  return Array.from({ length: chunkTotal }, (_, i) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('perm_chunk'), stampIdBuf, Buffer.from(new Uint16Array([i]).buffer)],
      programId
    )[0]
  );
}

export function printBanner(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Permadata Protocol — ${title}`);
  console.log(`  Program: BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq`);
  console.log(`${'─'.repeat(60)}\n`);
}
