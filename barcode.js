#!/usr/bin/env node
// Entry point for the barcode tool.
//   default   → web UI (opens browser)
//   --cli     → interactive CLI (readline)
//   --no-open → web mode but don't auto-open browser
//   --port=N  → force web server port (default: random free)
//   --host=H  → bind host (default: 127.0.0.1)

const args = process.argv.slice(2)
const flags = {
  cli: args.includes('--cli'),
  noOpen: args.includes('--no-open'),
  port: 0,
  host: '127.0.0.1',
}
for (const a of args) {
  if (a.startsWith('--port=')) flags.port = parseInt(a.slice(7), 10) || 0
  else if (a.startsWith('--host=')) flags.host = a.slice(7)
  else if (a === '--help' || a === '-h') {
    console.log('Usage: barcode [--cli] [--no-open] [--port=N] [--host=H]')
    process.exit(0)
  }
}

if (flags.cli) {
  require('./cli')
} else {
  const { startServer } = require('./server')
  startServer({ host: flags.host, port: flags.port, openBrowser: !flags.noOpen }).catch(err => {
    console.error('Failed to start server:', err.message)
    process.exit(1)
  })
  // keep alive on SIGINT
  process.on('SIGINT', () => { console.log('\nShutting down…'); process.exit(0) })
}
