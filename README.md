# barcode — Zebra SSI test tool

Standalone tool for exercising Zebra barcode scanners over serial (SSI protocol).

## Running

Single-file executable, no install, no `node_modules`.

**Windows** — copy `barcode.exe` to the tablet and double-click it, or run from `cmd`:

```
barcode.exe
```

**macOS** — copy `barcode` anywhere and run:

```
./barcode
```

A browser tab opens at `http://127.0.0.1:<port>/` with the full UI:
port dropdown, baud rate, buttons for every SSI command, live hex log,
packet framing + checksum verification, big display when a barcode is decoded.

### Flags

| Flag | Effect |
|---|---|
| `--cli` | Interactive terminal mode (no browser) |
| `--no-open` | Start server but don't auto-open browser |
| `--port=N` | Force server port (default: random free) |
| `--host=H` | Bind host (default: `127.0.0.1`) |
| `--help` | Show usage |

### Tablet tips (10")

- The UI is responsive; portrait works but landscape gives more log space.
- If the browser doesn't open automatically, look at the console for the `http://127.0.0.1:…` URL and open it manually.
- To reach it from another device on the same network: `barcode.exe --host=0.0.0.0`.

## Building from source

Builds run from **macOS** and produce binaries for either target (the bundler
and blob injector are cross-platform; only a prebuilt target-OS `node` binary
is needed).

```bash
npm install
./build.sh mac       # → dist/mac/barcode
./build.sh win       # → dist/win/barcode.exe
```

`build.sh win` expects a Windows `node.exe` at
`/Users/brle/code/mosy/webpack/scripts/sea/node-win-22.11.0.exe`. Override with:

```bash
NODE_WIN=/path/to/node.exe ./build.sh win
```

Running the source directly (no build):

```bash
npm install
npm start            # or: node barcode.js
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| No ports listed | Check USB cable / driver; refresh the UI |
| Port opens, no data | Wrong baud, scanner not in SSI mode, or bad wiring |
| `[PKT BAD]` checksum mismatch | Wrong data bits / parity / stop bits |
| exe exits immediately on Windows | Run from `cmd` to see the error |
