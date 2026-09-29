// Render a clean, unambiguous vision test image:
//   - white card on a GREEN background
//   - large black digits "42" on the left
//   - a solid RED square on the right
// So a correct answer must mention: number 42, green background, red square.
import { writeFileSync } from "node:fs"
import zlib from "node:zlib"

const W = 480, H = 240
const box = (x, y, x0, y0, w, h) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h
const seg = (x, y, x0, y0, w, h) => box(x, y, x0, y0, w, h)

function pixel(x, y) {
  let r = 0, g = 128, b = 0            // GREEN background
  if (box(x, y, 20, 20, 440, 200)) { r = 255; g = 255; b = 255 }   // white card
  if (box(x, y, 300, 60, 130, 120)) { r = 220; g = 0; b = 0 }     // RED square

  // proper seven-segment "4": top-left vertical, middle bar, full-height right
  if (
    seg(x, y, 55, 60, 22, 52) ||     // top-left vertical
    seg(x, y, 55, 108, 68, 20) ||    // middle horizontal
    seg(x, y, 100, 60, 22, 100)      // full-height right vertical
  ) { r = 0; g = 0; b = 0 }
  // seven-segment style "2"
  if (
    seg(x, y, 160, 60, 85, 20) ||      // top
    seg(x, y, 223, 62, 22, 48) ||      // top-right
    seg(x, y, 160, 108, 85, 20) ||     // middle
    seg(x, y, 160, 110, 22, 50) ||     // bottom-left
    seg(x, y, 160, 160, 85, 20)        // bottom
  ) { r = 0; g = 0; b = 0 }
  return [r, g, b]
}

const raw = Buffer.alloc((W * 3 + 1) * H)
let o = 0
for (let y = 0; y < H; y++) {
  raw[o++] = 0                          // PNG filter byte: none
  for (let x = 0; x < W; x++) {
    const [r, g, b] = pixel(x, y)
    raw[o++] = r; raw[o++] = g; raw[o++] = b
  }
}

const table = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  table[n] = c >>> 0
}
const crc32 = (b) => {
  let c = 0xffffffff
  for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 2                // 8-bit, truecolour
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
])
writeFileSync("test-image.png", png)
console.log("wrote test-image.png", png.length, "bytes", `${W}x${H}`)
