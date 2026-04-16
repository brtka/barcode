# barcode — Zebra SSI test tool

Standalone tool for exercising Zebra barcode scanners over serial (SSI protocol).

## Usage

Copy `barcode.exe` to the tablet and double-click it, or run from a terminal:

```
barcode.exe
```

A browser tab opens at `http://127.0.0.1:<port>/` with the full UI:

- Port dropdown (auto-populated) + baud rate
- Buttons for every SSI command
- Live hex log (in/out) with packet framing + checksum verification
- Prominent display when a barcode is decoded

That's it — no install, no `node_modules`, single file.

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

## Troubleshooting

| Symptom | Fix |
|---|---|
| No ports listed | Check USB cable / driver; refresh the UI |
| Port opens, no data | Wrong baud, scanner not in SSI mode, or bad wiring |
| `[PKT BAD]` checksum mismatch | Wrong data bits / parity / stop bits |
| exe exits immediately on Windows | Run from `cmd` to see the error |
