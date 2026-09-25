import { mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { CHAPTER_WINDOWS } from '../studio/storyboard.js';

export const goodStoryboard = () => [
  '---', 'title: The P(doom) Bake-Off', 'logline: Clawd and the Researcher bake a superintelligence.', '---', '',
  '# Storyboard', '',
  ...CHAPTER_WINDOWS.flatMap(([a, b], i) => [`## ${i + 1} · Chapter ${i + 1} (${a}–${b})`, `Walkthrough: What happens in chapter ${i + 1}.`, '', '| shot | ... |', '']),
].join('\n');

export const tempDir = (prefix = 'studio-data-') => mkdtempSync(join(tmpdir(), prefix));

// A private copy of the repo's studio/default.db. Tests that need the examples database (for the Original, or as a
// target for promoteVersion) make one of these once per file and reuse it, instead of touching the repo's own copy.
export const tempDefaultDb = () => {
  const p = join(tempDir('default-db-'), 'default.db');
  cpSync(join(process.cwd(), 'studio/default.db'), p);
  return p;
};

// Tests never touch the repo's user.db, studio.db, studio/default.db, .studio/ or library/ (a studio may be running
// on them): spawned servers and render.mjs runs get a throwaway data root, a user database inside it, and a copy of
// the examples database, all pinned here so that a USER_DB, STUDIO_DB or DEFAULT_DB set in the shell can never
// point a test at real files. (USER_DB wins over STUDIO_DB, its alias, so pinning it is enough.) The examples copy
// is shared by every isolatedEnv in the process: read-only by convention — a test that promotes passes its own.
let sharedDefaultDb = null;
export const isolatedEnv = (data = tempDir(), extra = {}) =>
  ({ ...process.env, STUDIO_DATA: data, USER_DB: join(data, 'user.db'), DEFAULT_DB: sharedDefaultDb ??= tempDefaultDb(), ...extra });

// Stand-ins for outside hosts, one per name: a raw TCP listener each (plus one UDP socket, `udp`) on 127.0.0.1 that
// records every connection or datagram, whether or not a request ever follows — a bare preconnect or a TURN allocation
// is a leak too. One listener per name, so a hit says which attempt got through. Loopback, but on ports other than the
// studio's, which the render browser treats like any outside host (see studio/browser.js). (Not 127.0.0.2: macOS
// doesn't alias the whole of 127.0.0.0/8 the way Linux does.)
export async function captureHosts(names) {
  const hits = {}, listeners = {};
  const record = (name, what) => ((hits[name] ??= []).push(what), hits[name].length - 1);
  for (const name of names) {
    listeners[name] = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
      // Counted as soon as it connects; the first line it sends, if any, replaces the placeholder.
      open(s) { s.data = { i: record(name, '(connection, no data)'), first: true }; },
      data(s, d) {
        if (s.data.first) { s.data.first = false; hits[name][s.data.i] = Buffer.from(d).toString('latin1').split('\r\n')[0].slice(0, 80); }
        s.end();
      },
      close() {}, error() {},
    } });
  }
  const udp = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0, socket: { data(s, buf) { record('udp', `(datagram, ${buf.length} bytes)`); } } });
  return {
    hits,
    port: name => name === 'udp' ? udp.port : listeners[name].port,
    url: name => `http://127.0.0.1:${listeners[name].port}`,
    stop() { for (const l of Object.values(listeners)) l.stop(true); udp.close(); },
  };
}

// Minimal PNG decoder for the one kind of PNG this codebase ever compares pixel-for-pixel: 8-bit RGBA
// (colorType 6), non-interlaced, exactly what Chrome's canvas.toDataURL('image/png') always emits (window.renderAt
// in src/core.js, and render.mjs's --stills). Not a general-purpose PNG decoder — deliberately throws on anything
// else instead of guessing.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width, height; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const bitDepth = data[8], colorType = data[9], interlace = data[12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 8 + len + 4;
  }
  const raw = inflateSync(Buffer.concat(idat)), bpp = 4, stride = width * bpp;
  const pixels = new Uint8Array(width * height * bpp);
  let prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1), filterType = raw[rowStart], row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const filt = raw[rowStart + 1 + x];
      const a = x >= bpp ? row[x - bpp] : 0, b = prevRow[x], c = x >= bpp ? prevRow[x - bpp] : 0;
      let recon;
      // PNG per-scanline filters (spec section 9.2): each reconstructs the true byte from the filtered byte plus
      // already-reconstructed neighbors (left/above/above-left), wrapping mod 256.
      switch (filterType) {
        case 0: recon = filt; break;                              // None
        case 1: recon = filt + a; break;                          // Sub
        case 2: recon = filt + b; break;                          // Up
        case 3: recon = filt + ((a + b) >> 1); break;              // Average
        case 4: {                                                  // Paeth
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          recon = filt + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
        }
        default: throw new Error('bad PNG filter type ' + filterType);
      }
      row[x] = recon & 0xff;
    }
    pixels.set(row, y * stride);
    prevRow = row;
  }
  return { width, height, pixels };
}

// Decodes both PNGs and compares every pixel's channels, returning how many pixels differ at all, the largest
// single-channel delta seen, a delta histogram, and the bounding box of the differing region (or null if none).
export function pixelDiffStats(bufA, bufB) {
  const a = decodePng(bufA), b = decodePng(bufB);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let diffPixels = 0, maxDelta = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const hist = {};
  for (let i = 0; i < a.pixels.length; i += 4) {
    let d = 0, anyDiff = false;
    for (let c = 0; c < 4; c++) { const delta = Math.abs(a.pixels[i + c] - b.pixels[i + c]); if (delta) anyDiff = true; d = Math.max(d, delta); }
    if (anyDiff) {
      const px = (i / 4) % a.width, py = Math.floor((i / 4) / a.width);
      diffPixels++; maxDelta = Math.max(maxDelta, d); hist[d] = (hist[d] || 0) + 1;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
  }
  return { width: a.width, height: a.height, totalPixels: a.width * a.height, diffPixels, maxDelta, hist, bbox: diffPixels ? [minX, minY, maxX, maxY] : null };
}

// GPU rasterization is not guaranteed bit-exact across separate renders of the same deterministic scene: repeated
// runs of the Original's stills, byte-for-byte, under both a locked-down render.mjs browser and a plain one (see
// "the network lockdown leaves the picture as it was" in test/render.test.js) showed occasional mismatches — always
// only at t=150 (the finale's confetti/curtain, by far the busiest frame for overlapping translucent paint strokes),
// never at t=5, 40 or 90 — and always tiny: at most 1069 of 2,073,600 pixels (0.05%), max per-channel delta 2 of
// 255. This tolerance (0.1% of pixels, delta <= 8) comfortably covers what was observed with real margin, while
// still catching an actual content difference (a wrong frame, a missing font, a broken chapter), which changes far
// more than a sliver of pixels by far more than a couple of levels.
export const PIXEL_TOLERANCE = { maxDiffFraction: .001, maxDelta: 8 };

// Asserts two PNG buffers are the same picture within PIXEL_TOLERANCE (see above); throws with the actual numbers
// on failure, which is more useful for this than a byte-diff.
export function expectPixelsMatch(bufA, bufB, label, tolerance = PIXEL_TOLERANCE) {
  const stats = pixelDiffStats(bufA, bufB);
  const fraction = stats.totalPixels ? stats.diffPixels / stats.totalPixels : 0;
  if (fraction > tolerance.maxDiffFraction || stats.maxDelta > tolerance.maxDelta) {
    throw new Error(`${label}: ${stats.diffPixels}/${stats.totalPixels} pixels differ (${(fraction * 100).toFixed(4)}%), ` +
      `max per-channel delta ${stats.maxDelta}, bbox ${JSON.stringify(stats.bbox)} — ` +
      `tolerance is ${(tolerance.maxDiffFraction * 100).toFixed(2)}% / delta ${tolerance.maxDelta}`);
  }
}
