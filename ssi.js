// SSI protocol for Zebra barcode scanners — pure JS, no I/O
//
// Packet layout:
//   [0]   length  (header + data, NOT including 2-byte checksum)
//   [1]   opcode
//   [2]   source  (0x00 = Decoder, 0x04 = Host)
//   [3]   status  (bit flags)
//   [4..] data
//   [-2]  checksum high byte
//   [-1]  checksum low  byte
//
// Status bits:
//   bit 0 (0x01) retransmission
//   bit 1 (0x02) 0 = last frame, 1 = intermediate multipacket frame
//   bit 3 (0x08) 0 = temporary change, 1 = permanent change
//
// Checksum is 2's complement 16-bit sum of all bytes in the message
// (excluding the checksum itself), transmitted high-byte first.

const SOURCES = {
  DECODER: 0x00,
  HOST: 0x04,
  ANY: 0xFF,
}

const NAK_REASONS = {
  0x01: 'Checksum failure (RESEND)',
  0x02: 'Unexpected or unknown message (BAD_CONTEXT)',
  0x06: 'Host directive denied (DENIED)',
  0x0A: 'Undesired message (CANCEL)',
}

const OPCODES = {
  BEEP: 0xE6,
  CMD_ACK: 0xD0,
  CMD_NAK: 0xD1,
  CAPABILITIES_REQUEST: 0xD3,
  CAPABILITIES_REPLY: 0xD4,
  DECODE_DATA: 0xF3,
  EVENT: 0xF6,
  FLUSH_QUEUE: 0xD2,
  ILLUMINATION_OFF: 0xC0,
  ILLUMINATION_ON: 0xC1,
  PARAM_DEFAULTS: 0xC8,
  PARAM_REQUEST: 0xC7,
  PARAM_SEND: 0xC6,
  SCAN_DISABLE: 0xEA,
  SCAN_ENABLE: 0xE9,
  SLEEP: 0xEB,
  START_SESSION: 0xE4,
  STOP_SESSION: 0xE5,
  WAKEUP: 0xEB,
}

const OPCODE_NAMES = Object.keys(OPCODES)
const OPCODE_VALUES = Object.values(OPCODES)

const DECODE_TYPES = {
  0x01: 'Code 39', 0x02: 'Codabar', 0x03: 'Code 128', 0x04: 'D25',
  0x05: 'IATA', 0x06: 'ITF', 0x07: 'Code 93', 0x0a: 'EAN-8',
  0x0b: 'EAN-13', 0x0c: 'Code 11', 0x0d: 'Code 49', 0x0e: 'MSI',
  0x0f: 'GS1-128', 0x11: 'PDF-417', 0x12: 'Code 16K', 0x13: 'Code 39 Full ASCII',
  0x16: 'Bookland', 0x17: 'Coupon Code', 0x18: 'NW7', 0x19: 'ISBT-128',
  0x1a: 'Micro PDF', 0x1b: 'Data Matrix', 0x1c: 'QR Code', 0x1d: 'Micro PDF CCA',
  0x1e: 'Postnet (US)', 0x1f: 'Planet (US)', 0x20: 'Code 32', 0x21: 'ISBT-128 Concat.',
  0x22: 'Postal (Japan)', 0x23: 'Postal (Australia)', 0x24: 'Postal (Dutch)',
  0x25: 'Maxicode', 0x26: 'Postbar (CA)', 0x27: 'Postal (UK)', 0x28: 'Macro PDF-417',
  0x29: 'Macro QR Code', 0x2c: 'Micro QR Code', 0x2d: 'Aztec Code', 0x2e: 'Aztec Rune Code',
  0x2f: 'French Lottery', 0x30: 'GS1 DataBar-14', 0x31: 'GS1 DataBar Limited',
  0x32: 'GS1 DataBar Expanded', 0x33: 'Parameter (FNC3)', 0x36: 'ISSN',
  0x37: 'Scanlet Webcode', 0x38: 'Cue CAT Code', 0x39: 'Matrix 2 of 5',
  0x4a: 'EAN-8 + 2', 0x4b: 'EAN-13 + 2',
  0x51: 'Composite (CC-A + GS1-128)', 0x52: 'Composite (CC-A + EAN-13)',
  0x53: 'Composite (CC-A + EAN-8)', 0x54: 'Composite (CC-A + GS1 DataBar Expanded)',
  0x55: 'Composite (CC-A + GS1 DataBar Limited)', 0x56: 'Composite (CC-A + GS1 DataBar-14)',
  0x57: 'Composite (CC-A + UPC-A)', 0x58: 'Composite (CC-A + UPC-E)',
  0x59: 'Composite (CC-C + GS1-128)',
  0x61: 'Composite (CC-B + GS1-128)', 0x62: 'Composite (CC-B + EAN-13)',
  0x63: 'Composite (CC-B + EAN-8)', 0x64: 'Composite (CC-B + GS1 DataBar Expanded)',
  0x65: 'Composite (CC-B + GS1 DataBar Limited)', 0x66: 'Composite (CC-B + GS1 DataBar-14)',
  0x67: 'Composite (CC-B + UPC-A)', 0x68: 'Composite (CC-B + UPC-E)',
  0x72: 'C 2 of 5', 0x73: 'Korean 2 of 5',
  0x8a: 'EAN-8 + 5', 0x8b: 'EAN-13 + 5',
  0x99: 'Multipacket Format', 0x9a: 'Macro Micro PDF',
  0xa0: 'OCRB', 0xb4: 'RSS (GS1 Databar) Expanded Coupon', 0xb7: 'Han Xin',
  0xc1: 'GS1 Datamatrix', 0xc2: 'GS1 QR',
  0xe0: 'RFID Raw', 0xe1: 'RFID URI',
}

const EVENT_TYPES = {
  0x01: 'Trigger Pulled', 0x02: 'Trigger Released', 0x03: 'Timeout',
  0x04: 'Motion Detected', 0x05: 'Motion Not Detected', 0x06: 'Frame Start',
  0x07: 'Frame End', 0x08: 'Decode Success', 0x09: 'Decode Failure',
  0x0A: 'Out of Range', 0x0B: 'In Range', 0x0C: 'Good Read LED On',
  0x0D: 'Good Read LED Off', 0x0E: 'Scanner Overheated', 0x0F: 'Scanner Cooled',
  0x10: 'Parameter Change', 0x11: 'Error Code', 0x12: 'Buffer Full',
  0x13: 'Buffer Cleared', 0x14: 'Over Exposure', 0x15: 'Under Exposure',
  0x16: 'Good Read Beep', 0x17: 'Good Read Flash', 0x18: 'Image Capture Start',
  0x19: 'Image Capture End', 0x1A: 'Video Capture Start', 0x1B: 'Video Capture End',
  0x1C: 'Illumination On', 0x1D: 'Illumination Off', 0x1E: 'Aimer On',
  0x1F: 'Aimer Off', 0x20: 'Sleep Mode', 0x21: 'Wakeup',
  0x40: 'GPI Change', 0x41: 'GPO Change', 0x42: 'Battery Level Change',
  0x43: 'Battery Level Low', 0x44: 'Battery Charging', 0x45: 'Battery Charged',
  0x46: 'Battery Not Charging', 0x47: 'External Power Connected',
  0x48: 'External Power Disconnected', 0x49: 'Battery Replacement Needed',
  0x4A: 'Battery Replacement Successful', 0x4B: 'Power Cycle',
  0x4C: 'Reboot', 0x4D: 'Shutdown',
  0x4E: 'Software Update Start', 0x4F: 'Software Update End',
}

// 2's complement 16-bit sum of message bytes.
function calculateChecksum(buf) {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i]
  return (~sum + 1) & 0xFFFF
}

function verifyChecksum(packet) {
  if (packet.length < 6) return false
  const message = packet.subarray(0, packet.length - 2)
  const received = (packet[packet.length - 2] << 8) | packet[packet.length - 1]
  return received === calculateChecksum(message)
}

// Build a packet from the host → decoder.
//   opcode : number
//   data   : Buffer (optional)
// Returns a Buffer ready to write to the serial port.
function buildPacket(opcode, data = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data)
  const length = 4 + data.length
  const header = Buffer.alloc(4)
  header[0] = length
  header[1] = opcode
  header[2] = SOURCES.HOST
  header[3] = 0
  const message = Buffer.concat([header, data])
  const sum = calculateChecksum(message)
  const tail = Buffer.from([(sum >> 8) & 0xFF, sum & 0xFF])
  return Buffer.concat([message, tail])
}

// Parse a single complete packet (including its 2-byte checksum).
// Returns an object or null if invalid.
function extractPacket(packet) {
  if (packet.length < 6) return { ok: false, reason: 'packet too short', raw: packet }
  const valid = verifyChecksum(packet)
  const message = packet.subarray(0, packet.length - 2)
  const length = message[0]
  const opcode = message[1]
  const source = message[2]
  const status = message[3]
  const data = message.subarray(4)
  const opcodeIdx = OPCODE_VALUES.indexOf(opcode)
  const opcode_name = opcodeIdx >= 0 ? OPCODE_NAMES[opcodeIdx] : `UNKNOWN_0x${opcode.toString(16)}`

  const received_cs = (packet[packet.length - 2] << 8) | packet[packet.length - 1]
  const calculated_cs = calculateChecksum(message)

  return {
    ok: valid,
    length,
    opcode,
    opcode_name,
    source,
    source_name: source === SOURCES.HOST ? 'HOST' : source === SOURCES.DECODER ? 'DECODER' : `0x${source.toString(16)}`,
    status,
    isRetransmission: (status & 0x01) !== 0,
    isIntermediatePacket: (status & 0x02) !== 0,
    isLastPacket: (status & 0x02) === 0,
    isParamChange: (status & 0x08) !== 0,
    data,
    received_checksum: received_cs,
    calculated_checksum: calculated_cs,
    raw: packet,
  }
}

// Pull complete packets out of a stream buffer based on the length byte.
// Returns { packets: [Buffer, ...], remainder: Buffer }.
// Uses length + 2 framing (length byte excludes checksum).
function frameStream(buffer) {
  const packets = []
  let remainder = buffer
  while (remainder.length >= 6) {
    const length = remainder[0]
    const total = length + 2
    if (total < 6) {
      // garbage length byte, drop 1 byte and retry to resync
      remainder = remainder.subarray(1)
      continue
    }
    if (remainder.length < total) break
    packets.push(remainder.subarray(0, total))
    remainder = remainder.subarray(total)
  }
  return { packets, remainder }
}

// Parse the CAPABILITIES_REPLY data payload.
//   bytes 0-1 : supported baud rates (big-endian bitmask)
//   byte  2   : misc serial parameters (parity/stop bits bitmask)
//   byte  3   : multipacket options
//   bytes 4+  : list of supported opcodes
function parseCapabilities(data) {
  if (data.length < 4) return null
  const baudRateTable = [
    300, 600, 1200, 2400, 4800, 9600,
    19200, 28800, 38400, 57600, 115200, 230400,
    460800, 921600, 'Reserved14', 'Reserved15',
  ]
  const paramTable = [
    'Odd Parity', 'Even Parity', 'No Parity',
    'Check Parity', 'Do Not Check Parity',
    'One Stop Bit', 'Two Stop Bits',
  ]
  const baudRaw = (data[0] << 8) | data[1]
  const parRaw = data[2]
  const mpRaw = data[3]
  const cmdBytes = data.subarray(4)

  const baud_rates = []
  for (let i = 0; i < 16; i++) if (baudRaw & (1 << i)) baud_rates.push(baudRateTable[i])

  const serial_params = []
  for (let i = 0; i < 7; i++) if (parRaw & (1 << i)) serial_params.push(paramTable[i])

  const multipacket = []
  for (let i = 0; i < 3; i++) if (mpRaw & (1 << i)) multipacket.push(`Option ${i + 1}`)

  const commands = []
  for (const b of cmdBytes) {
    const idx = OPCODE_VALUES.indexOf(b)
    commands.push(idx >= 0 ? OPCODE_NAMES[idx] : `0x${b.toString(16)}`)
  }

  return { baud_rates, serial_params, multipacket, commands }
}

function hex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ')
}

module.exports = {
  OPCODES,
  OPCODE_NAMES,
  OPCODE_VALUES,
  SOURCES,
  NAK_REASONS,
  DECODE_TYPES,
  EVENT_TYPES,
  calculateChecksum,
  verifyChecksum,
  buildPacket,
  extractPacket,
  frameStream,
  parseCapabilities,
  hex,
}
