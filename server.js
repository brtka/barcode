// HTTP + WebSocket server for the barcode web UI.
// Wraps the same ssi.js protocol module used by the CLI.

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { exec } = require('node:child_process')
const { WebSocketServer } = require('ws')
const { SerialPort } = require('serialport')
const ssi = require('./ssi')

const { OPCODES, NAK_REASONS, DECODE_TYPES, EVENT_TYPES, hex } = ssi

// ---------- Asset loading: SEA vs. dev ----------
let INDEX_HTML
function loadIndexHtml() {
  try {
    const sea = require('node:sea')
    if (sea.isSea()) {
      INDEX_HTML = sea.getAsset('index.html', 'utf8')
      return
    }
  } catch { /* node:sea not available pre-20, fall through */ }
  INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
}

// ---------- Per-connection state ----------
function makeState() {
  return {
    port: null,
    portPath: null,
    baudRate: 9600,
    buffer: Buffer.alloc(0),
    stats: { bytesIn: 0, bytesOut: 0, packetsOk: 0, packetsBad: 0, lastError: null },
  }
}

// ---------- WebSocket event bus ----------
// Messages from client → server:
//   { type: 'listPorts' }
//   { type: 'connect', path, baud }
//   { type: 'disconnect' }
//   { type: 'send', opcode, data }           // opcode: number, data: hex string (optional)
//   { type: 'sendRaw', hex }                 // hex string, no framing
//   { type: 'sequence', name }               // 'probe' | 'scan'
//   { type: 'clearBuffer' }
//   { type: 'getStatus' }
//
// Messages from server → client:
//   { type: 'ports', ports }
//   { type: 'status', connected, path, baud, error? }
//   { type: 'tx', hex, opcode, opcode_name, length, t }
//   { type: 'rx', hex, length, t }
//   { type: 'packet', parsed, t }
//   { type: 'scan', barcode_type, data, hex_data, t }
//   { type: 'stats', ...counters }
//   { type: 'log', level, message, t }

function parseHex(s) {
  if (!s) return Buffer.alloc(0)
  const cleaned = String(s).replace(/0x/gi, '').replace(/[\s,]+/g, '')
  if (!/^[0-9a-fA-F]*$/.test(cleaned) || cleaned.length % 2 !== 0) return null
  return Buffer.from(cleaned, 'hex')
}

function attachSession(ws) {
  const state = makeState()

  function emit(msg) {
    if (ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify({ ...msg, t: msg.t ?? Date.now() }))
  }
  function log(level, message) { emit({ type: 'log', level, message }) }
  function emitStats() { emit({ type: 'stats', ...state.stats }) }

  function onSerialData(chunk) {
    state.stats.bytesIn += chunk.length
    emit({ type: 'rx', hex: hex(chunk), length: chunk.length })
    state.buffer = Buffer.concat([state.buffer, chunk])
    const { packets, remainder } = ssi.frameStream(state.buffer)
    state.buffer = remainder
    for (const pkt of packets) handlePacket(pkt)
    emitStats()
  }

  function handlePacket(raw) {
    const p = ssi.extractPacket(raw)
    if (!p.ok) {
      state.stats.packetsBad++
      emit({
        type: 'packet',
        parsed: {
          ok: false,
          opcode: p.opcode,
          opcode_name: p.opcode_name,
          length: p.length,
          status: p.status,
          received_checksum: p.received_checksum,
          calculated_checksum: p.calculated_checksum,
          raw_hex: hex(raw),
        },
      })
      return
    }
    state.stats.packetsOk++
    const parsed = {
      ok: true,
      opcode: p.opcode,
      opcode_name: p.opcode_name,
      length: p.length,
      source_name: p.source_name,
      status: p.status,
      isIntermediatePacket: p.isIntermediatePacket,
      isLastPacket: p.isLastPacket,
      isRetransmission: p.isRetransmission,
      data_hex: hex(p.data),
    }

    switch (p.opcode) {
      case OPCODES.CAPABILITIES_REPLY: {
        parsed.capabilities = ssi.parseCapabilities(p.data)
        break
      }
      case OPCODES.CMD_NAK: {
        parsed.nak_reason = NAK_REASONS[p.data[0]] || `unknown (0x${p.data[0]?.toString(16)})`
        break
      }
      case OPCODES.EVENT: {
        parsed.event = EVENT_TYPES[p.data[0]] || `unknown (0x${p.data[0]?.toString(16)})`
        break
      }
      case OPCODES.DECODE_DATA: {
        const typeByte = p.data[0]
        const typeName = DECODE_TYPES[typeByte] || `unknown (0x${typeByte?.toString(16)})`
        const raw = p.data.subarray(1)
        const text = raw.toString('utf8')
        parsed.scan = { barcode_type: typeName, data: text, hex_data: hex(raw) }
        emit({ type: 'scan', barcode_type: typeName, data: text, hex_data: hex(raw) })
        // auto-ACK
        sendOp(OPCODES.CMD_ACK, Buffer.alloc(0), { silent: true })
        break
      }
    }
    emit({ type: 'packet', parsed })
  }

  function sendOp(opcode, data = Buffer.alloc(0), opts = {}) {
    if (!state.port || !state.port.isOpen) {
      if (!opts.silent) log('error', 'Not connected')
      return
    }
    const pkt = ssi.buildPacket(opcode, data)
    const name = ssi.OPCODE_NAMES[ssi.OPCODE_VALUES.indexOf(opcode)] || `0x${opcode.toString(16)}`
    state.stats.bytesOut += pkt.length
    if (!opts.silent) emit({ type: 'tx', hex: hex(pkt), opcode, opcode_name: name, length: pkt.length })
    state.port.write(pkt, err => {
      if (err) {
        state.stats.lastError = err.message
        log('error', `Write error: ${err.message}`)
        emitStats()
      }
    })
    if (!opts.silent) emitStats()
  }

  function sendRaw(buf) {
    if (!state.port || !state.port.isOpen) { log('error', 'Not connected'); return }
    state.stats.bytesOut += buf.length
    emit({ type: 'tx', hex: hex(buf), opcode: null, opcode_name: 'RAW', length: buf.length })
    state.port.write(buf, err => {
      if (err) { state.stats.lastError = err.message; log('error', `Write error: ${err.message}`) }
    })
    emitStats()
  }

  async function doListPorts() {
    try {
      const ports = await SerialPort.list()
      emit({
        type: 'ports',
        ports: ports.map(p => ({
          path: p.path,
          manufacturer: p.manufacturer || '',
          vendorId: p.vendorId || '',
          productId: p.productId || '',
          serialNumber: p.serialNumber || '',
        })),
      })
    } catch (e) {
      log('error', `listPorts failed: ${e.message}`)
    }
  }

  function doConnect(portPath, baud) {
    if (state.port && state.port.isOpen) {
      log('warn', 'Already connected; disconnecting first')
      try { state.port.close() } catch { /* ignore */ }
    }
    state.buffer = Buffer.alloc(0)
    state.portPath = portPath
    state.baudRate = baud
    log('info', `Opening ${portPath} @ ${baud} (8N1, no flow control)`)
    try {
      state.port = new SerialPort({
        path: portPath, baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false,
      })
    } catch (e) {
      state.stats.lastError = e.message
      log('error', `Failed to create port: ${e.message}`)
      emit({ type: 'status', connected: false, path: portPath, baud, error: e.message })
      return
    }
    state.port.open(err => {
      if (err) {
        state.stats.lastError = err.message
        log('error', `open failed: ${err.message}`)
        emit({ type: 'status', connected: false, path: portPath, baud, error: err.message })
        return
      }
      log('info', `Connected to ${portPath}`)
      emit({ type: 'status', connected: true, path: portPath, baud })
      state.port.on('data', onSerialData)
      state.port.on('error', e => {
        state.stats.lastError = e.message
        log('error', `port error: ${e.message}`)
      })
      state.port.on('close', () => {
        log('info', `${portPath} closed`)
        emit({ type: 'status', connected: false, path: null, baud })
      })
    })
  }

  function doDisconnect() {
    if (state.port && state.port.isOpen) state.port.close()
    else emit({ type: 'status', connected: false, path: null, baud: state.baudRate })
  }

  async function doSequence(name) {
    if (name === 'probe') {
      sendOp(OPCODES.CAPABILITIES_REQUEST)
      await new Promise(r => setTimeout(r, 300))
      sendOp(OPCODES.FLUSH_QUEUE)
    } else if (name === 'scan') {
      sendOp(OPCODES.WAKEUP)
      await new Promise(r => setTimeout(r, 500))
      sendOp(OPCODES.FLUSH_QUEUE)
      await new Promise(r => setTimeout(r, 100))
      sendOp(OPCODES.START_SESSION)
    } else {
      log('warn', `unknown sequence: ${name}`)
    }
  }

  ws.on('message', async raw => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    switch (msg.type) {
      case 'listPorts':    doListPorts(); break
      case 'connect':      doConnect(String(msg.path), Number(msg.baud) || 9600); break
      case 'disconnect':   doDisconnect(); break
      case 'send': {
        const opcode = Number(msg.opcode)
        const data = parseHex(msg.data)
        if (data === null) { log('error', 'Invalid data hex'); break }
        sendOp(opcode, data)
        break
      }
      case 'sendRaw': {
        const buf = parseHex(msg.hex)
        if (!buf || buf.length === 0) { log('error', 'Invalid raw hex'); break }
        sendRaw(buf)
        break
      }
      case 'sequence':     await doSequence(msg.name); break
      case 'clearBuffer':  state.buffer = Buffer.alloc(0); log('info', 'Stream buffer cleared'); break
      case 'getStatus':
        emit({ type: 'status', connected: !!(state.port && state.port.isOpen), path: state.portPath, baud: state.baudRate })
        emitStats()
        break
    }
  })

  ws.on('close', () => {
    if (state.port && state.port.isOpen) { try { state.port.close() } catch { /* ignore */ } }
  })

  // initial push
  doListPorts()
  emit({ type: 'status', connected: false, path: null, baud: 9600 })
  emitStats()
}

// ---------- HTTP server ----------
function startServer({ host = '127.0.0.1', port = 0, openBrowser = true } = {}) {
  loadIndexHtml()

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(INDEX_HTML)
      return
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', attachSession)

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const url = `http://${host}:${addr.port}/`
      // eslint-disable-next-line no-console
      console.log(`\n  barcode web UI ready → ${url}\n  (press Ctrl+C to quit)\n`)
      if (openBrowser) openInBrowser(url)
      resolve({ server, wss, url })
    })
  })
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`
  exec(cmd, err => {
    if (err) console.log(`(could not auto-open browser: ${err.message}) — visit ${url}`)
  })
}

module.exports = { startServer }
