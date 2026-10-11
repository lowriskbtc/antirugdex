/**
 * Generates site/token/ard.png — a 512x512 token logo, no image libraries.
 *
 * Wallets render this at 32-64px, so the mark is a single high-contrast
 * silhouette: a shield with a keyhole. Detail that survives downscaling is
 * the only detail worth drawing.
 *
 * Replace it with real branding whenever you have some; nothing depends on
 * this file beyond the URI in metadata.json.
 */
import zlib from "zlib";
import fs from "fs";
import path from "path";

const SIZE = 512;
const SS = 4; // supersample factor for anti-aliasing

const BG: [number, number, number] = [0x0a, 0x0d, 0x12];
const TOP: [number, number, number] = [0x2b, 0xe0, 0x8c];
const BOT: [number, number, number] = [0x14, 0xb8, 0xc4];

/** Shield half-width at normalized y in [-1, 1]. 0 outside the shape. */
function shieldHalfWidth(y: number): number {
  if (y < -1 || y > 1) return 0;
  const SHOULDER = 0.25;
  if (y <= SHOULDER) {
    // Straight sides, rounded top corners.
    const r = 0.28;
    const topY = -1 + r;
    if (y < topY) {
      const d = (topY - y) / r;
      return Math.sqrt(Math.max(0, 1 - d * d));
    }
    return 1;
  }
  // Elliptical taper to a point at the bottom.
  const t = (y - SHOULDER) / (1 - SHOULDER);
  return Math.sqrt(Math.max(0, 1 - t * t));
}

/** Keyhole: circle over a tapered stem, cut out of the shield. */
function inKeyhole(x: number, y: number): boolean {
  const cx = 0, cy = -0.12, r = 0.23;
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  const top = -0.12, bot = 0.46;
  if (y < top || y > bot) return false;
  const t = (y - top) / (bot - top);
  return Math.abs(x) <= 0.095 + 0.075 * t;
}

const px = Buffer.alloc(SIZE * SIZE * 3);

for (let py = 0; py < SIZE; py++) {
  for (let pxi = 0; pxi < SIZE; pxi++) {
    let r = 0, g = 0, b = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        // Normalized coords; shield occupies ~78% of the canvas.
        const fx = ((pxi + (sx + 0.5) / SS) / SIZE) * 2 - 1;
        const fy = ((py + (sy + 0.5) / SS) / SIZE) * 2 - 1;
        const nx = fx / 0.78;
        const ny = fy / 0.78;

        const inShield = Math.abs(nx) <= shieldHalfWidth(ny);
        const lit = inShield && !inKeyhole(nx, ny);

        if (lit) {
          const t = Math.min(1, Math.max(0, (ny + 1) / 2));
          r += TOP[0] + (BOT[0] - TOP[0]) * t;
          g += TOP[1] + (BOT[1] - TOP[1]) * t;
          b += TOP[2] + (BOT[2] - TOP[2]) * t;
        } else {
          r += BG[0]; g += BG[1]; b += BG[2];
        }
      }
    }

    const n = SS * SS;
    const o = (py * SIZE + pxi) * 3;
    px[o] = Math.round(r / n);
    px[o + 1] = Math.round(g / n);
    px[o + 2] = Math.round(b / n);
  }
}

// ---- PNG container -------------------------------------------------------
// Each scanline is prefixed with filter type 0 (None).
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 3 + 1)] = 0;
  px.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // colour type: truecolour RGB
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(process.cwd(), "site", "token", "ard.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`${out}  ${SIZE}x${SIZE}  ${(png.length / 1024).toFixed(1)} KB`);
