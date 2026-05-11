================================================================
  PERMADATA PROTOCOL — Judge Test Package
  Program ID: BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq
  Chain: X1 Mainnet (Solana-Compatible)
  Website: permadata.io
================================================================

REQUIREMENTS
  - Node.js 18 or higher (nodejs.org)
  - A funded X1 wallet (for stamping only — retrieval is free)

SETUP (run once)
  npm install

================================================================
STEP 1 — WRITE YOUR DOCUMENT
  Create any text file. Write whatever you want in it.
  Example:
    echo "My name is [your name]. Today is [date]." > mydoc.txt

================================================================
STEP 2 — STAMP IT TO X1 CHAIN

  You need a wallet with XNT to pay transaction fees.

  If you have a Solana CLI wallet (~/.config/solana/id.json):
    node stamp.mjs mydoc.txt

  If your wallet is elsewhere:
    node stamp.mjs mydoc.txt --key /path/to/wallet.json

  The script will print your STAMP ID. Copy it.
  Cost: ~0.001 XNT per stamp (fraction of a cent)

================================================================
STEP 3 — DELETE THE FILE
  rm mydoc.txt
  (or delete it however you like — it's gone from your machine)

================================================================
STEP 4 — RETRIEVE FROM CHAIN
  node retrieve.mjs <YOUR-STAMP-ID>

  Example:
    node retrieve.mjs 1c3636f58a76

  Your document prints back — from the X1 blockchain.
  No server. No cloud. No trust required.

  To save to a file:
    node retrieve.mjs 1c3636f58a76 --out recovered.txt

================================================================
HOW IT WORKS

  stamp.mjs:
    - Reads your file
    - Splits it into 500-byte chunks
    - Each chunk is stored in two places:
      1. Transaction memo field (raw data, permanent in tx history)
      2. ChunkRecord PDA on-chain (cryptographic hash for integrity)
    - A StampRecord PDA seals everything with a SHA256 hash
    - Returns your Stamp ID (first 6 bytes of SHA256)

  retrieve.mjs:
    - Reads the StampRecord PDA to get chunk count and metadata
    - Scans payer transaction history for PERM:<id>:<index> memos
    - Reassembles chunks in order
    - Decompresses and outputs your original document
    - Verifies integrity against the on-chain hash

  Note on speed:
    Retrieval scans the public RPC node. If it's slow or gets
    rate-limited (429 errors), wait a few minutes and try again.
    The protocol works — it's just a shared public resource.

================================================================
WHAT THIS PROVES

  If your document comes back after deletion, the Permadata
  Protocol has proven:

  1. Data can be permanently stored on a blockchain
  2. No external server, API, or database was used
  3. The data is cryptographically verified (SHA256 match)
  4. Anyone in the world with Node.js can retrieve it forever
  5. No recurring fees — stamped once, exists permanently

================================================================
CONTACT
  Builder: Arnett Esters | ArnettX1 | Detroit, Michigan
  Website: permadata.io
  X1 Explorer: https://explorer.x1.xyz
================================================================
