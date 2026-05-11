#!/usr/bin/env node
// Permadata Protocol - Interactive Stamp CLI
// Usage: node demos/stamp.mjs [--key ~/wallet.json]

import { createInterface } from 'readline';
import { readFileSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { extname, basename } from 'path';
import { Connection } from '@solana/web3.js';
import {
  RPC_URL, PROGRAM_ID, CODEC, loadWallet, crc32, stampId,
  payloadHash, chunkData, registerChunk, finalizeStamp,
  getChunkPdas, printBanner
} from './shared.mjs';

const MAX_SINGLE_STAMP = 512 * 500;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

// Extension map
const EXT_MAP = {
  '.txt':'text','.md':'text','.pdf':'text','.doc':'text','.docx':'text',
  '.csv':'text','.json':'text','.xml':'text','.html':'text',
  '.jpg':'image','.jpeg':'image','.png':'image','.webp':'image',
  '.gif':'image','.bmp':'image','.tiff':'image','.tif':'image',
  '.svg':'image','.cr2':'image','.nef':'image','.arw':'image','.dng':'image','.avif':'image',
  '.mp3':'audio','.wav':'audio','.flac':'audio','.aac':'audio',
  '.ogg':'audio','.opus':'audio','.aiff':'audio','.m4a':'audio',
  '.mp4':'video','.mov':'video','.mkv':'video','.webm':'video',
  '.avi':'video','.ts':'video','.flv':'video',
  '.so':'binary','.exe':'binary','.dll':'binary','.wasm':'binary',
  '.bin':'binary','.zip':'binary','.tar':'binary','.gz':'binary','.elf':'binary',
};

function detectType(buf, filePath) {
  // Magic bytes are ground truth
  if (buf[0]===0xFF && buf[1]===0xD8) return 'image';                          // JPEG
  if (buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47) return 'image'; // PNG
  if (buf[0]===0x47 && buf[1]===0x49 && buf[2]===0x46) return 'image';         // GIF
  if (buf[0]===0x42 && buf[1]===0x4D) return 'image';                          // BMP
  if (buf[0]===0x52 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x46) {
    if (buf[8]===0x57 && buf[9]===0x41 && buf[10]===0x56 && buf[11]===0x45) return 'audio'; // WAV
    if (buf[8]===0x57 && buf[9]===0x45 && buf[10]===0x42 && buf[11]===0x50) return 'image'; // WEBP
  }
  if (buf[0]===0xFF && (buf[1]===0xFB||buf[1]===0xF3||buf[1]===0xF2)) return 'audio'; // MP3
  if (buf[0]===0x49 && buf[1]===0x44 && buf[2]===0x33) return 'audio';         // ID3/MP3
  if (buf[0]===0x66 && buf[1]===0x4C && buf[2]===0x61 && buf[3]===0x43) return 'audio'; // FLAC
  if (buf[0]===0x4F && buf[1]===0x67 && buf[2]===0x67 && buf[3]===0x53) return 'audio'; // OGG
  if (buf[0]===0x46 && buf[1]===0x4F && buf[2]===0x52 && buf[3]===0x4D) return 'audio'; // AIFF
  if (buf[0]===0x7F && buf[1]===0x45 && buf[2]===0x4C && buf[3]===0x46) return 'binary'; // ELF
  if (buf[0]===0x00 && buf[1]===0x61 && buf[2]===0x73 && buf[3]===0x6D) return 'binary'; // WASM
  if (buf[0]===0x4D && buf[1]===0x5A) return 'binary';                         // PE
  if (buf[0]===0x50 && buf[1]===0x4B && buf[2]===0x03) return 'binary';        // ZIP
  // Fall back to extension
  const ext = EXT_MAP[extname(filePath).toLowerCase()];
  if (ext) return ext;
  // Last resort: printable = text, else binary
  const nonPrint = [...buf.slice(0,512)].filter(b=>b<9||(b>13&&b<32)).length;
  return nonPrint < 5 ? 'text' : 'binary';
}

const TYPE_LABELS = {
  text:'Text / Document', image:'Image', audio:'Audio file',
  video:'Video', binary:'Binary / Executable', mathsci:'Scientific Data'
};

// Wire format builders
function textChunks(p) { return chunkData(p); }

function imageChunks(p) {
  const magic = Buffer.from([0x49,0x4D,0x47,0x00]);
  const meta  = Buffer.alloc(12); magic.copy(meta,0); meta[4]=0x00; meta[5]=0x01; meta[10]=0x01;
  const c0 = Buffer.concat([meta, p.slice(0, 488)]);
  const rest = [];
  for (let i=488; i<p.length; i+=496) rest.push(Buffer.concat([magic, p.slice(i,i+496)]));
  return [c0, ...rest];
}

function audioChunks(p) {
  const magic = Buffer.from([0x41,0x55,0x44,0x00]);
  const meta  = Buffer.alloc(16); magic.copy(meta,0); meta[4]=0x00; meta[5]=0x01; meta[6]=2; meta[7]=16; meta.writeUInt32LE(44100,8);
  const c0 = Buffer.concat([meta, p.slice(0, 484)]);
  const rest = [];
  for (let i=484; i<p.length; i+=496) rest.push(Buffer.concat([magic, p.slice(i,i+496)]));
  return [c0, ...rest];
}

function videoChunks(p) {
  const magic = Buffer.from([0x56,0x49,0x44,0x00]);
  const meta  = Buffer.alloc(18); magic.copy(meta,0); meta[4]=0x00; meta[5]=0x01; meta[10]=30; meta[11]=1;
  const c0 = Buffer.concat([meta, p.slice(0, 482)]);
  const rest = [];
  for (let i=482; i<p.length; i+=496) rest.push(Buffer.concat([magic, p.slice(i,i+496)]));
  return [c0, ...rest];
}

function binaryChunks(p) {
  const magic = Buffer.from([0x42,0x49,0x4E,0x00]);
  const c0 = Buffer.concat([magic, Buffer.from([0x00]), p.slice(0,495)]);
  const rest = [];
  for (let i=495; i<p.length; i+=496) rest.push(Buffer.concat([magic, p.slice(i,i+496)]));
  return [c0, ...rest];
}

function getCodecInfo(type) {
  return {
    text:    { codec: CODEC.UTF8_TEXT, instr: 'register_chunk',        name: 'UTF8_TEXT', chunks: textChunks },
    image:   { codec: CODEC.IMAGE,     instr: 'register_image_chunk',  name: 'IMAGE',     chunks: imageChunks },
    audio:   { codec: CODEC.AUDIO,     instr: 'register_audio_chunk',  name: 'AUDIO',     chunks: audioChunks },
    video:   { codec: CODEC.VIDEO,     instr: 'register_video_chunk',  name: 'VIDEO',     chunks: videoChunks },
    binary:  { codec: CODEC.BINARY,    instr: 'register_binary_chunk', name: 'BINARY',    chunks: binaryChunks },
    mathsci: { codec: CODEC.MATHSCI,   instr: 'register_mathsci_chunk',name: 'MATHSCI',   chunks: (p) => chunkData(Buffer.concat([Buffer.from([0x4D,0x53,0x43,0x49]), p])) },
  }[type] || { codec: CODEC.RAW, instr: 'register_chunk', name: 'RAW', chunks: chunkData };
}

async function main() {
  printBanner('Interactive Stamp');

  let wallet;
  try { wallet = loadWallet(); } catch {
    console.log('No wallet configured. Run: node demos/setup.mjs\n');
    process.exit(1);
  }

  const conn = new Connection(RPC_URL, 'confirmed');
  const bal  = await conn.getBalance(wallet.publicKey).catch(() => null);
  const balXNT = bal !== null ? (bal/1e9).toFixed(6) : 'unknown';
  console.log(`Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${balXNT} XNT\n`);

  if (bal !== null && bal < 10000) {
    console.log('Low balance. Each stamp costs ~0.001 XNT. Get XNT at https://xdex.xyz\n');
  }

  // Simple 2-option menu
  console.log('What do you want to stamp?');
  console.log('  1. A file  (image, audio, video, document, binary...)');
  console.log('  2. A message  (type text directly)\n');
  const choice = (await ask('Choose (1/2): ')).trim();

  let payload, codecInfo, allChunks;

  if (choice === '2') {
    const text = await ask('\nType your message: ');
    payload    = Buffer.from(text.trim(), 'utf8');
    codecInfo  = getCodecInfo('text');
    allChunks  = codecInfo.chunks(payload);

  } else {
    // File path - strip quotes that terminals sometimes add on drag-drop
    const rawPath = (await ask('\nDrag your file here or type the full path: '))
      .trim()
      .replace(/^['"""'']|['"""'']$/g, '')
      .replace(/\\ /g, ' ')
      .replace(/^~/, homedir());

    if (!existsSync(rawPath)) {
      console.error(`\nFile not found: ${rawPath}`);
      console.error('Tip: drag the file directly into this terminal window and press Enter.');
      process.exit(1);
    }

    const stats = statSync(rawPath);
    if (stats.size > MAX_SINGLE_STAMP) {
      console.error(`\nFile too large (${(stats.size/1024).toFixed(1)}KB). Max 256KB per stamp.`);
      console.error('Large file support via MULTIPART coming soon.');
      process.exit(1);
    }

    payload = readFileSync(rawPath);

    // Auto-detect - no confirmation, just tell them what we found and proceed
    const detectedType = detectType(payload, rawPath);
    const label = TYPE_LABELS[detectedType] || detectedType;

    console.log(`\nFile:     ${basename(rawPath)}  (${(payload.length/1024).toFixed(1)}KB)`);
    console.log(`Detected: ${label}`);
    console.log(`Codec:    ${detectedType.toUpperCase()} - proceeding...\n`);

    codecInfo = getCodecInfo(detectedType);
    allChunks = codecInfo.chunks(payload);
  }

  const sid      = stampId(payload);
  const pHash    = payloadHash(payload);
  const checksum = crc32(payload);


  console.log('─'.repeat(50));
  console.log('  STAMP PREVIEW');
  console.log('─'.repeat(50));
  console.log(`  Codec:     ${codecInfo.name}`);
  console.log(`  Size:      ${payload.length} bytes`);
  console.log(`  Chunks:    ${allChunks.length}`);
  console.log(`  Stamp ID:  ${sid.toString('hex')}`);
  console.log(`  Tx fees:   ${allChunks.length} transactions (check current XNT price at xdex.xyz)`);
  console.log('─'.repeat(50));
  console.log('\nStamps are PERMANENT and cannot be deleted.');
  const go = await ask('Stamp it? (yes/no): ');
  if (!go.trim().toLowerCase().startsWith('y')) { console.log('\nCancelled.\n'); process.exit(0); }

  console.log(`\nStamping ${allChunks.length} chunks to X1 mainnet...\n`);

  for (let i=0; i<allChunks.length; i++) {
    process.stdout.write(`  Chunk ${i+1}/${allChunks.length}... `);
    const sig = await registerChunk(conn, wallet, codecInfo.instr, sid, i, allChunks.length, allChunks[i], PROGRAM_ID);
    console.log(`done  ${sig.slice(0,20)}...`);
  }

  console.log('\n  Finalizing...');
  const chunkPdas = getChunkPdas(sid, allChunks.length, PROGRAM_ID);
  const finSig    = await finalizeStamp(conn, wallet, sid, allChunks.length, codecInfo.codec, payload.length, checksum, pHash, chunkPdas, PROGRAM_ID);

  console.log('\n' + '='.repeat(60));
  console.log('  STAMP COMPLETE - DATA IS NOW PERMANENT ON X1');
  console.log('='.repeat(60));
  console.log(`  Stamp ID:  ${sid.toString('hex')}`);
  console.log(`  Codec:     ${codecInfo.name}`);
  console.log(`  Tx:        ${finSig}`);
  console.log(`  Explorer:  https://explorer.x1.xyz/tx/${finSig}`);
  console.log('='.repeat(60));
  console.log('\n  Save your Stamp ID - it is your permanent reference.\n');

  rl.close();
}

main().catch(e => { console.error('\nError:', e.message); rl.close(); process.exit(1); });
