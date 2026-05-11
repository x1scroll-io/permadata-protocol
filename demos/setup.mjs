#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  Permadata Protocol — Wallet Setup
//  Run this once before using any demo script.
//
//  Usage: node demos/setup.mjs
// ─────────────────────────────────────────────────────────────────

import { createInterface } from 'readline';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const RPC_URL      = 'https://rpc.mainnet.x1.xyz';
const WALLET_DIR   = join(homedir(), '.permadata');
const WALLET_PATH  = join(WALLET_DIR, 'wallet.json');
const ENV_FILE     = join(process.cwd(), '.env.permadata');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

function printBanner() {
  console.log('\n' + '═'.repeat(60));
  console.log('  Permadata Protocol — Wallet Setup');
  console.log('  Program: BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq');
  console.log('  Chain:   X1 Mainnet');
  console.log('═'.repeat(60) + '\n');
}

async function checkBalance(pubkey) {
  try {
    const conn = new Connection(RPC_URL, 'confirmed');
    const bal  = await conn.getBalance(new PublicKey(pubkey));
    return (bal / LAMPORTS_PER_SOL).toFixed(6);
  } catch {
    return null;
  }
}

function saveWallet(keypair) {
  mkdirSync(WALLET_DIR, { recursive: true });
  writeFileSync(WALLET_PATH, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  // Also write env file for easy sourcing
  writeFileSync(ENV_FILE, `PERMADATA_KEY=${WALLET_PATH}\n`);
}

function loadExistingWallet(path) {
  try {
    const raw = JSON.parse(readFileSync(path));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch (e) {
    return null;
  }
}

async function main() {
  printBanner();
  console.log('This setup will configure your wallet for Permadata.\n');

  // ── Step 1: Do you have a wallet? ───────────────────────────────
  const hasWallet = await ask('Do you already have a Solana/X1 wallet keypair? (yes/no): ');

  let keypair;

  if (hasWallet.trim().toLowerCase().startsWith('y')) {
    // ── Existing wallet ──────────────────────────────────────────
    console.log('\nGreat. You can provide your wallet one of these ways:');
    console.log('  1. Path to a keypair JSON file (e.g. ~/my-wallet.json)');
    console.log('  2. Paste the raw keypair array (from Phantom export or solana-keygen)');
    console.log('  3. Use Solana CLI default (~/.config/solana/id.json)\n');

    const method = await ask('Choose (1/2/3): ');

    if (method.trim() === '1') {
      const rawPath = (await ask('Path to wallet JSON file: ')).trim().replace(/^~/, homedir());
      keypair = loadExistingWallet(rawPath);
      if (!keypair) {
        console.error('\n❌ Could not load wallet from that path. Check the file exists and is valid JSON.');
        process.exit(1);
      }
      // Copy to permadata wallet dir
      saveWallet(keypair);
      console.log(`\n✅ Wallet loaded from ${rawPath}`);

    } else if (method.trim() === '2') {
      console.log('\nPaste your keypair array (format: [1,2,3,...,64 numbers]) then press Enter:');
      const raw = (await ask('')).trim();
      try {
        keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
        saveWallet(keypair);
        console.log(`\n✅ Wallet loaded from pasted keypair`);
      } catch {
        console.error('\n❌ Invalid keypair format. Should be a JSON array of 64 numbers.');
        process.exit(1);
      }

    } else {
      // Solana CLI default
      const defaultPath = join(homedir(), '.config', 'solana', 'id.json');
      keypair = loadExistingWallet(defaultPath);
      if (!keypair) {
        console.error(`\n❌ No wallet found at ${defaultPath}`);
        console.error('Run: solana-keygen new --outfile ~/.config/solana/id.json');
        process.exit(1);
      }
      saveWallet(keypair);
      console.log(`\n✅ Wallet loaded from Solana CLI default`);
    }

  } else {
    // ── Generate new wallet ──────────────────────────────────────
    console.log('\nGenerating a new wallet for you...\n');
    keypair = Keypair.generate();
    saveWallet(keypair);

    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║  NEW WALLET CREATED — SAVE THIS INFORMATION             ║');
    console.log('╠' + '═'.repeat(58) + '╣');
    console.log(`║  Public Key (address):                                   ║`);
    console.log(`║  ${keypair.publicKey.toBase58().padEnd(56)} ║`);
    console.log('╠' + '═'.repeat(58) + '╣');
    console.log('║  Private Key (keep this SECRET — never share it):       ║');
    console.log(`║  ${JSON.stringify(Array.from(keypair.secretKey)).slice(0,56)}  ║`);
    console.log('║  (full key saved to ~/.permadata/wallet.json)            ║');
    console.log('╚' + '═'.repeat(58) + '╝');

    console.log('\n⚠️  IMPORTANT:');
    console.log('   • Back up ~/.permadata/wallet.json somewhere safe');
    console.log('   • Anyone with your private key controls your wallet');
    console.log('   • If you lose it, you cannot recover it\n');
  }

  // ── Step 2: Check balance ────────────────────────────────────────
  const pubkey = keypair.publicKey.toBase58();
  console.log(`\n📍 Your wallet address: ${pubkey}`);
  console.log('   Checking balance on X1 mainnet...');

  const balance = await checkBalance(pubkey);
  if (balance !== null) {
    console.log(`   Balance: ${balance} XNT`);
    if (parseFloat(balance) < 0.01) {
      console.log('\n💡 Your wallet needs XNT to pay for stamps.');
      console.log('   Each stamp costs ~0.001 XNT (~$0.0004 at current prices).');
      console.log('   Get XNT from: https://xdex.xyz or transfer from another wallet.');
    } else {
      console.log(`\n✅ Balance looks good — ready to stamp!`);
    }
  } else {
    console.log('   (Could not reach RPC — check your connection)');
  }

  // ── Step 3: Save config ──────────────────────────────────────────
  console.log(`\n📁 Wallet saved to: ${WALLET_PATH}`);
  console.log(`📄 Env config saved to: ${ENV_FILE}`);
  console.log('\nTo use in any demo script, run one of these:');
  console.log(`  export PERMADATA_KEY=${WALLET_PATH}`);
  console.log(`  source ${ENV_FILE}`);
  console.log('\nOr pass --key directly:');
  console.log(`  node demos/demo-text.mjs "Hello" --key ${WALLET_PATH}`);

  console.log('\n' + '─'.repeat(60));
  console.log('  Setup complete. You can now run any Permadata demo.');
  console.log('  Try: node demos/demo-text.mjs "My first permanent stamp"');
  console.log('─'.repeat(60) + '\n');

  rl.close();
}

main().catch(e => { console.error('Error:', e.message); rl.close(); process.exit(1); });
