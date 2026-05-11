/**
 * Permadata Protocol — Standalone Retrieval
 * Usage: node retrieve-oneliner.mjs <stamp_id>
 * No wallet needed. Read-only. Public RPC only.
 *
 * Memo format written by demo.mjs:
 *   PERM:<stampIdHex>:<chunkIndex>:<totalChunks>:<base64(chunkData)>
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { gunzipSync, inflateSync } from 'zlib';

const RPC  = 'https://rpc.mainnet.x1.xyz';
const PROG = new PublicKey('BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq');
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const conn = new Connection(RPC, 'confirmed');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(fn) {
  for (let a = 0; a < 6; a++) {
    try { return await fn(); }
    catch(e) {
      if (e.message?.includes('429')) { await sleep(800 * (a + 1)); }
      else throw e;
    }
  }
}

const stampHex = process.argv[2] || 'ce15dc1054be';
const sid      = Buffer.from(stampHex, 'hex');
const PREFIX   = `PERM:${stampHex}:`;

// 1. Read StampRecord
const [spda] = PublicKey.findProgramAddressSync([Buffer.from('perm_stamp'), sid], PROG);
const stampInfo = await rpc(() => conn.getAccountInfo(spda));
if (!stampInfo) { console.error('Stamp not found:', stampHex); process.exit(1); }

const codecType  = stampInfo.data[14];
const chunkTotal = stampInfo.data.readUInt16LE(15);
const dataLen    = stampInfo.data.readUInt32LE(17);
const payer      = new PublicKey(stampInfo.data.slice(57, 89));

const CODEC_NAMES = {1:'RAW',2:'UTF8_TEXT',3:'UTF8_EN',4:'MATHSCI',5:'CBOR',6:'IMAGE',7:'AUDIO',8:'VIDEO',9:'BINARY',10:'MULTIPART'};
console.log(`\nPermadata Protocol — Retrieve`);
console.log(`Stamp:    ${stampHex}`);
console.log(`Codec:    0x${codecType.toString(16).padStart(2,'0')} (${CODEC_NAMES[codecType]||'UNKNOWN'})`);
console.log(`Chunks:   ${chunkTotal}`);
console.log(`Size:     ${dataLen} bytes`);
console.log(`Fetching ${chunkTotal} memo transactions from chain...\n`);

// 2. Scan payer history — find all PERM:<stampId>:* memos
const chunks = new Array(chunkTotal);
let found  = 0;
let before = undefined;

while (found < chunkTotal) {
  const sigs = await rpc(() => conn.getSignaturesForAddress(payer, { limit: 50, before }));
  if (!sigs.length) break;
  before = sigs[sigs.length - 1].signature;
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

    // Decode memo text: PERM:<stampId>:<idx>:<total>:<base64data>
    let memoText;
    try { memoText = Buffer.from(ix.data).toString('utf8'); } catch { continue; }
    if (!memoText.startsWith(PREFIX)) continue;

    const parts = memoText.split(':');
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

console.log(`\n  Complete: ${found}/${chunkTotal}\n`);

// 3. Reassemble + decompress
const payload = Buffer.concat(chunks.map(c => c || Buffer.alloc(0)));

console.log(`${'═'.repeat(60)}`);
console.log(`  RETRIEVED FROM X1 CHAIN — ${stampHex}`);
console.log(`${'═'.repeat(60)}\n`);

let output;
try {
  const { decompress } = await import('@mongodb-js/zstd');
  output = (await decompress(payload)).toString('utf8');
} catch {
  try { output = gunzipSync(payload).toString('utf8'); }
  catch { try { output = inflateSync(payload).toString('utf8'); }
  catch { output = payload.toString('utf8'); } }
}

console.log(output);
console.log(`\n${'═'.repeat(60)}`);
console.log(`  No server. No trust. Data lives on X1 chain forever.`);
console.log(`${'═'.repeat(60)}\n`);
