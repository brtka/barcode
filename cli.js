#!/usr/bin/env node
// Standalone Zebra SSI barcode scanner test tool.
// No Mosy, no listeners, just a serialport + readline CLI.

const readline = require('readline')
const { SerialPort } = require('serialport')
const ssi = require('./ssi')
const { OPCODES, NAK_REASONS, DECODE_TYPES, EVENT_TYPES, hex } = ssi

const TTY = process.stdout.isTTY
const c = {
  reset: TTY ? '\x1b[0m' : '',
  dim:   TTY ? '\x1b[2m' : '',
  red:   TTY ? '\x1b[31m' : '',
  green: TTY ? '\x1b[32m' : '',
  yellow:TTY ? '\x1b[33m' : '',
  blue:  TTY ? '\x1b[34m' : '',
  cyan:  TTY ? '\x1b[36m' : '',
  bold:  TTY ? '\x1b[1m' : '',
}

const state = {
  port: null,
  portPath: null,
  baudRate: 9600,
  buffer: Buffer.alloc(0),
  stats: {
    bytesIn: 0,
    bytesOut: 0,
    packetsOk: 0,
    packetsBad: 0,
    lastError: null,
  },
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(q) {
  return new Promise(resolve => rl.question(q, a => resolve(a.trim())))
}

function log(msg) { process.stdout.write(msg + '\n') }
function ts() { return new Date().toISOString().substring(11, 23) }

async function listPorts() {
  const ports = await SerialPort.list()
  if (!ports.length) {
    log(`${c.yellow}No serial ports detected.${c.reset}`)
    return []
  }
  log(`${c.bold}Available ports:${c.reset}`)
  ports.forEach((p, i) => {
    const extra = [
      p.manufacturer && `mfr=${p.manufacturer}`,
      p.vendorId && `vid=${p.vendorId}`,
      p.productId && `pid=${p.productId}`,
      p.serialNumber && `sn=${p.serialNumber}`,
    ].filter(Boolean).join(' ')
    log(`  [${i}] ${c.cyan}${p.path}${c.reset}  ${c.dim}${extra}${c.reset}`)
  })
  return ports
}

async function pickPort() {
  const ports = await listPorts()
  const answer = await ask(`Select port (number or full path, default 0): `)
  let path = answer
  if (answer === '') path = ports[0]?.path
  else if (/^\d+$/.test(answer)) path = ports[parseInt(answer, 10)]?.path
  if (!path) {
    log(`${c.red}No port selected.${c.reset}`)
    return null
  }
  const baudStr = await ask(`Baud rate (default 9600): `)
  const baud = baudStr === '' ? 9600 : parseInt(baudStr, 10)
  if (!baud || isNaN(baud)) {
    log(`${c.red}Invalid baud rate.${c.reset}`)
    return null
  }
  return { path, baud }
}

function openPort(path, baud) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path,
      baudRate: baud,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
    })
    port.open(err => {
      if (err) return reject(err)
      resolve(port)
    })
  })
}

function attachPort(port) {
  state.port = port
  port.on('data', onData)
  port.on('error', err => {
    state.stats.lastError = err.message
    log(`${c.red}[${ts()}] PORT ERROR: ${err.message}${c.reset}`)
  })
  port.on('close', () => {
    log(`${c.yellow}[${ts()}] Port closed.${c.reset}`)
    state.port = null
  })
}

function onData(chunk) {
  state.stats.bytesIn += chunk.length
  log(`${c.dim}[${ts()}] <<${c.reset} ${c.blue}${hex(chunk)}${c.reset} ${c.dim}(${chunk.length} bytes)${c.reset}`)
  state.buffer = Buffer.concat([state.buffer, chunk])
  const { packets, remainder } = ssi.frameStream(state.buffer)
  state.buffer = remainder
  for (const pkt of packets) handlePacket(pkt)
}

function handlePacket(raw) {
  const p = ssi.extractPacket(raw)
  if (!p.ok) {
    state.stats.packetsBad++
    log(`${c.red}[${ts()}] [PKT BAD] opcode=0x${p.opcode?.toString(16)} (${p.opcode_name}) len=${p.length} status=0x${p.status?.toString(16)} received_cs=0x${p.received_checksum?.toString(16)} calculated_cs=0x${p.calculated_checksum?.toString(16)}${c.reset}`)
    log(`${c.red}           raw: ${hex(raw)}${c.reset}`)
    return
  }
  state.stats.packetsOk++
  log(`${c.green}[${ts()}] [PKT OK ] opcode=0x${p.opcode.toString(16).padStart(2, '0')} (${p.opcode_name}) len=${p.length} src=${p.source_name} status=0x${p.status.toString(16).padStart(2, '0')}${p.isIntermediatePacket ? ' INTERMEDIATE' : ''}${p.isRetransmission ? ' RETRANS' : ''}${c.reset}`)
  if (p.data.length > 0) {
    log(`${c.dim}           data: ${hex(p.data)}${c.reset}`)
  }

  switch (p.opcode) {
    case OPCODES.CAPABILITIES_REPLY: {
      const caps = ssi.parseCapabilities(p.data)
      if (caps) {
        log(`${c.cyan}           baud_rates: [${caps.baud_rates.join(', ')}]${c.reset}`)
        log(`${c.cyan}           serial_params: [${caps.serial_params.join(', ')}]${c.reset}`)
        log(`${c.cyan}           multipacket: [${caps.multipacket.join(', ')}]${c.reset}`)
        log(`${c.cyan}           commands: [${caps.commands.join(', ')}]${c.reset}`)
      }
      break
    }
    case OPCODES.CMD_ACK:
      log(`${c.green}           ACK received${c.reset}`)
      break
    case OPCODES.CMD_NAK: {
      const reason = NAK_REASONS[p.data[0]] || `unknown (0x${p.data[0]?.toString(16)})`
      log(`${c.red}           NAK: ${reason}${c.reset}`)
      break
    }
    case OPCODES.EVENT: {
      const evt = EVENT_TYPES[p.data[0]] || `unknown event 0x${p.data[0]?.toString(16)}`
      log(`${c.yellow}           EVENT: ${evt}${c.reset}`)
      break
    }
    case OPCODES.DECODE_DATA: {
      const typeByte = p.data[0]
      const typeName = DECODE_TYPES[typeByte] || `unknown (0x${typeByte?.toString(16)})`
      const raw = p.data.subarray(1)
      const text = raw.toString('utf8')
      log(`${c.bold}${c.green}           [SCAN] type=${typeName} data="${text}"${c.reset}`)
      log(`${c.dim}                  hex=${hex(raw)}${c.reset}`)
      // auto-ACK so the scanner stops retransmitting
      send(OPCODES.CMD_ACK, Buffer.alloc(0), { quiet: true })
      break
    }
  }
}

function send(opcode, data = Buffer.alloc(0), opts = {}) {
  if (!state.port) {
    log(`${c.red}Not connected.${c.reset}`)
    return
  }
  const pkt = ssi.buildPacket(opcode, data)
  if (!opts.quiet) {
    const name = ssi.OPCODE_NAMES[ssi.OPCODE_VALUES.indexOf(opcode)] || '?'
    log(`${c.dim}[${ts()}] >>${c.reset} ${c.yellow}${hex(pkt)}${c.reset} ${c.dim}(${name}, ${pkt.length} bytes)${c.reset}`)
  }
  state.stats.bytesOut += pkt.length
  state.port.write(pkt, err => {
    if (err) {
      state.stats.lastError = err.message
      log(`${c.red}Write error: ${err.message}${c.reset}`)
    }
  })
}

function sendRaw(buf) {
  if (!state.port) {
    log(`${c.red}Not connected.${c.reset}`)
    return
  }
  log(`${c.dim}[${ts()}] >> (raw)${c.reset} ${c.yellow}${hex(buf)}${c.reset} ${c.dim}(${buf.length} bytes)${c.reset}`)
  state.stats.bytesOut += buf.length
  state.port.write(buf, err => {
    if (err) {
      state.stats.lastError = err.message
      log(`${c.red}Write error: ${err.message}${c.reset}`)
    }
  })
}

function parseHexArg(s) {
  if (!s) return Buffer.alloc(0)
  const cleaned = s.replace(/0x/gi, '').replace(/[\s,]+/g, '')
  if (!/^[0-9a-fA-F]*$/.test(cleaned) || cleaned.length % 2 !== 0) return null
  return Buffer.from(cleaned, 'hex')
}

function showStats() {
  log('')
  log(`${c.bold}Stats:${c.reset}`)
  log(`  port:         ${state.portPath || '(none)'} @ ${state.baudRate}`)
  log(`  bytes in:     ${state.stats.bytesIn}`)
  log(`  bytes out:    ${state.stats.bytesOut}`)
  log(`  packets ok:   ${state.stats.packetsOk}`)
  log(`  packets bad:  ${state.stats.packetsBad}`)
  log(`  buffer size:  ${state.buffer.length} bytes`)
  log(`  buffer hex:   ${hex(state.buffer)}`)
  log(`  last error:   ${state.stats.lastError || '(none)'}`)
}

function printMenu() {
  log('')
  log(`${c.bold}=== Zebra SSI Test Tool ===${c.reset}  ${c.dim}port: ${state.portPath} @ ${state.baudRate}${c.reset}`)
  log(`  [1]  CAPABILITIES_REQUEST (0xD3)`)
  log(`  [2]  FLUSH_QUEUE          (0xD2)`)
  log(`  [3]  WAKEUP                (0xEB)`)
  log(`  [4]  SLEEP                 (0xEB)`)
  log(`  [5]  SCAN_ENABLE           (0xE9)`)
  log(`  [6]  SCAN_DISABLE          (0xEA)`)
  log(`  [7]  START_SESSION (scan)  (0xE4)`)
  log(`  [8]  STOP_SESSION          (0xE5)`)
  log(`  [9]  BEEP                  (0xE6)   — prompts for beep code`)
  log(` [10]  ILLUMINATION_ON       (0xC1)`)
  log(` [11]  ILLUMINATION_OFF      (0xC0)`)
  log(` [12]  PARAM_DEFAULTS        (0xC8)`)
  log(` [13]  Custom command        (opcode hex + optional data hex)`)
  log(` [14]  Raw bytes             (no framing, no checksum)`)
  log(` [15]  Stats`)
  log(` [16]  Reset stream buffer`)
  log(` [17]  Probe sequence        (CAPABILITIES_REQUEST + FLUSH_QUEUE)`)
  log(` [18]  Scan sequence         (WAKEUP + FLUSH_QUEUE + START_SESSION)`)
  log(`  [q]  Quit`)
}

async function menuLoop() {
  while (state.port) {
    printMenu()
    const choice = await ask('> ')
    switch (choice) {
      case '1':  send(OPCODES.CAPABILITIES_REQUEST); break
      case '2':  send(OPCODES.FLUSH_QUEUE); break
      case '3':  send(OPCODES.WAKEUP); break
      case '4':  send(OPCODES.SLEEP); break
      case '5':  send(OPCODES.SCAN_ENABLE); break
      case '6':  send(OPCODES.SCAN_DISABLE); break
      case '7':  send(OPCODES.START_SESSION); break
      case '8':  send(OPCODES.STOP_SESSION); break
      case '9': {
        const v = await ask('Beep code hex (e.g. 00 = Short High 1): ')
        const data = parseHexArg(v)
        if (!data) { log(`${c.red}Invalid hex.${c.reset}`); break }
        send(OPCODES.BEEP, data)
        break
      }
      case '10': send(OPCODES.ILLUMINATION_ON); break
      case '11': send(OPCODES.ILLUMINATION_OFF); break
      case '12': send(OPCODES.PARAM_DEFAULTS); break
      case '13': {
        const op = await ask('Opcode hex (e.g. D3): ')
        const opB = parseHexArg(op)
        if (!opB || opB.length !== 1) { log(`${c.red}Invalid opcode.${c.reset}`); break }
        const d = await ask('Data hex (empty for none): ')
        const data = parseHexArg(d)
        if (!data) { log(`${c.red}Invalid data hex.${c.reset}`); break }
        send(opB[0], data)
        break
      }
      case '14': {
        const d = await ask('Raw hex to send: ')
        const data = parseHexArg(d)
        if (!data || data.length === 0) { log(`${c.red}Invalid hex.${c.reset}`); break }
        sendRaw(data)
        break
      }
      case '15': showStats(); break
      case '16':
        state.buffer = Buffer.alloc(0)
        log(`${c.yellow}Buffer cleared.${c.reset}`)
        break
      case '17':
        send(OPCODES.CAPABILITIES_REQUEST)
        await new Promise(r => setTimeout(r, 300))
        send(OPCODES.FLUSH_QUEUE)
        break
      case '18':
        send(OPCODES.WAKEUP)
        await new Promise(r => setTimeout(r, 500))
        send(OPCODES.FLUSH_QUEUE)
        await new Promise(r => setTimeout(r, 100))
        send(OPCODES.START_SESSION)
        break
      case 'q': case 'Q': case 'quit': case 'exit':
        return
      case '':
        break
      default:
        log(`${c.red}Unknown option.${c.reset}`)
    }
  }
}

async function main() {
  log(`${c.bold}Zebra SSI Test Tool${c.reset}  (serialport ${require('serialport/package.json').version})`)
  log(`${c.dim}Platform: ${process.platform} ${process.arch} | Node ${process.version}${c.reset}`)
  log('')

  const sel = await pickPort()
  if (!sel) { rl.close(); return }
  state.portPath = sel.path
  state.baudRate = sel.baud

  try {
    const port = await openPort(sel.path, sel.baud)
    log(`${c.green}Opened ${sel.path} @ ${sel.baud} (8N1, no flow control)${c.reset}`)
    attachPort(port)
  } catch (err) {
    log(`${c.red}Failed to open: ${err.message}${c.reset}`)
    rl.close()
    return
  }

  await menuLoop()

  if (state.port) {
    await new Promise(resolve => state.port.close(() => resolve()))
  }
  rl.close()
  log(`${c.dim}Goodbye.${c.reset}`)
}

process.on('SIGINT', () => {
  if (state.port) state.port.close(() => process.exit(0))
  else process.exit(0)
})

main().catch(err => {
  log(`${c.red}Fatal: ${err.stack || err.message}${c.reset}`)
  process.exit(1)
})
