# Permadata Protocol — Demo Scripts

**Program ID:** `BYRRLvZyzxLnfoaqea3pL9zY24S6Xd2uvoDHXFiw7LMq`  
**Chain:** X1 Mainnet  
**RPC:** https://rpc.mainnet.x1.xyz

---

## Setup (anyone, any machine)

**Requirements:** Node.js 18+ ([nodejs.org](https://nodejs.org))

```bash
# 1. Clone the repo
git clone https://github.com/x1scroll-io/permadata-protocol
cd permadata-protocol

# 2. Install the one dependency
npm install

# 3. Run setup — handles wallet creation or import automatically
node demos/setup.mjs
```

Setup will ask:
- Do you have a wallet? **Yes** → import by file path, paste keypair, or use Solana CLI default
- Do you have a wallet? **No** → generates a new keypair, shows public + private key, saves to `~/.permadata/wallet.json`

After setup, source your env and start stamping:
```bash
source .env.permadata
node demos/demo-text.mjs "My first permanent stamp"
```

---

## Demo Scripts

### Text / Documents / Legal (codec 0x02 / 0x03)
```bash
# Stamp a string
node demos/demo-text.mjs "My document content here"

# Stamp a file
node demos/demo-text.mjs --file ./contract.txt

# English-optimized compression (better ratio for prose)
node demos/demo-text.mjs --file ./contract.txt --codec en
```

### Scientific Data (codec 0x04)
```bash
# Built-in demo: 24h temperature readings
node demos/demo-mathsci.mjs

# Stamp a float64 array
node demos/demo-mathsci.mjs --type f64 23.5 23.8 24.1 23.9

# Stamp an int32 array
node demos/demo-mathsci.mjs --type i32 100 200 300 400
```

### Images / Photos / NFTs (codec 0x06)
```bash
# Stamp a JPEG (auto-detects format)
node demos/demo-image.mjs photo.jpg

# PNG with V2 delta+YCbCr compression
node demos/demo-image.mjs screenshot.png --v2

# Camera RAW
node demos/demo-image.mjs photo.cr2
```

### Audio / Music (codec 0x07)
```bash
# MP3 — stamps as-is (already compressed)
node demos/demo-audio.mjs track.mp3

# WAV with V2 delta PCM (3x-6x compression on voice/music)
node demos/demo-audio.mjs recording.wav --v2

# FLAC with V2
node demos/demo-audio.mjs album.flac --v2
```

### Binary / Executables / Firmware (codec 0x09)
```bash
# Auto-detects ELF, WASM, PE, ZIP, etc.
node demos/demo-binary.mjs program.so

# Firmware with explicit type
node demos/demo-binary.mjs firmware.bin --type firmware

# Archive
node demos/demo-binary.mjs release.zip --type zip
```

---

## What Each Demo Does

1. Reads the input data
2. Builds the codec wire format (magic header + metadata + data)
3. Splits into 500-byte chunks
4. Registers each chunk on-chain via `register_*_chunk` instruction
5. Finalizes the stamp via `finalize_stamp`
6. Prints the Stamp ID + Explorer link

---

## Notes

- Files > 256KB need `demo-multipart.mjs` (large file support via MULTIPART codec 0x0A)
- All stamps are **permanent and immutable** — test with small files first
- Cost: ~$0.001 per chunk at current XNT prices
- The chain enforces the wire format — invalid magic or type tags = rejected transaction

---

## Retrieving Stamped Data

```bash
node /root/.openclaw/workspace/projects/permadata-protocol/retrieve.mjs <stamp_id>
```
