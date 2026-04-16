// SEA-only replacement for node-gyp-build.
//
// When the app is packed as a Node SEA, the native addon
// (@serialport/bindings-cpp prebuilds/*/node.napi.node) is embedded as a SEA
// asset under the key "napi". This shim extracts it to a temp file on first
// use and returns the loaded native module — ignoring the directory argument
// that node-gyp-build normally uses to scan prebuilds/ on disk.
//
// Wired in via `esbuild --alias:node-gyp-build=./shims/node-gyp-build.js`
// in build.sh. Dev (`npm start`) uses the real node-gyp-build from node_modules.

const sea = require('node:sea')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

let cachedExports = null

function load() {
  if (cachedExports) return cachedExports

  const buf = Buffer.from(sea.getAsset('napi'))
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)

  const dir = path.join(os.tmpdir(), 'barcode-sea')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `napi-${hash}.node`)

  if (!fs.existsSync(file) || fs.statSync(file).size !== buf.length) {
    fs.writeFileSync(file, buf)
  }

  const m = { exports: {} }
  process.dlopen(m, file)
  cachedExports = m.exports
  return cachedExports
}

function nodeGypBuild(_dir) { return load() }
nodeGypBuild.path = () => null
nodeGypBuild.parseInput = () => ({})

module.exports = nodeGypBuild
