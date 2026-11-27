// png-squeeze-02: squeeze screenshots into the smallest PNG, losslessly.
//
// Pure TypeScript, Node built-ins only (node:fs, node:path, node:zlib).
// Node 22 runs `node /bot/main.ts` (type stripping, erasable syntax only).
//
// For every 1280x720 RGBA screenshot in /input/<id>/image.png it writes the
// same pixels as /output/<id>/image.png, trying every lossless form the PNG
// format allows and, inside each form, every per-row filter strategy:
//
//   forms   palette (<=256 colours, in count / luminance / RGB order),
//           grey / grey+alpha, RGB / RGBA, and a tRNS-key form when one
//           transparent value can stand in for an alpha channel
//   filters fixed 0..4, minimum-sum per row, fewest-distinct-pairs per row,
//           and true brute force: each row's five filters weighed by zlib
//           level 4 against the 32 KiB of filtered data before it
//
// Candidates are screened at zlib level 6; the best two per form are
// re-compressed at level 9, memLevel 6, default + filtered strategies
// (memLevel 6 beat 8 and 9 on the practice set). Smallest whole PNG wins.
//
// Fully deterministic: no clock reads, no environment reads, no randomness.
// One run answers all 8 instances of a set within the 60 s wall budget.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- PNG codec

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The Paeth predictor of PNG filter 4. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Filter one row: `cur` (stride samples) against `prev` (or null) into `out`. */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed (-128..127), absolute. */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Decode a bit-depth-8, non-interlaced PNG of colour type 0/2/3/4/6 to RGBA. */
function decodePng(bytes: Uint8Array): Decoded {
  if (bytes.length < 8) throw new Error('PNG too short');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type =
      String.fromCharCode(bytes[at + 4]) +
      String.fromCharCode(bytes[at + 5]) +
      String.fromCharCode(bytes[at + 6]) +
      String.fromCharCode(bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error(type + ' chunk fails its CRC');
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      colourType = data[9];
      if (!(colourType in CHANNELS)) throw new Error('colour type ' + colourType + ' not accepted');
      if (data[12] !== 0) throw new Error('interlaced');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error('unexpected chunk ' + type);
    }
  }
  if (!ended || idat.length === 0) throw new Error('no IEND or no IDAT');
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), {
    maxOutputLength: expected + 1,
  });
  if (raw.length !== expected) throw new Error('IDAT inflates to ' + raw.length + ', not ' + expected);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('row ' + y + ' has filter type ' + ft);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] =
          raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette image without PLTE');
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index ' + e + ' past the palette');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- image analysis

interface Analysis {
  distinct: number; // distinct RGBA colours, capped at 257 (257 means "more than 256")
  counts: Map<number, number> | null; // colour -> pixel count, only when distinct <= 256
  isGrey: boolean;
  allOpaque: boolean;
  // tRNS-key form: exactly one transparent RGB, every transparent pixel alpha 0,
  // and no opaque pixel shares that RGB. keyRgb -1 when impossible.
  keyRgb: number;
  keyGrey: number; // same, for grey images: the transparent grey value, -1 when impossible
}

function analyze(rgba: Uint8Array): Analysis {
  const n = rgba.length / 4;
  let isGrey = true;
  let allOpaque = true;
  const counts = new Map<number, number>();
  let tooMany = false;
  let transpRgb = -1;
  let transpRgbCount = 0;
  let hasPartial = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (r !== g || g !== b) isGrey = false;
    if (a !== 255) {
      allOpaque = false;
      if (a === 0) {
        const rgb = (r << 16) | (g << 8) | b;
        if (transpRgb === -1) {
          transpRgb = rgb;
          transpRgbCount = 1;
        } else if (rgb === transpRgb) {
          transpRgbCount++;
        } else {
          transpRgbCount = 2; // more than one transparent RGB: key form impossible
        }
      } else {
        hasPartial = true;
      }
    }
    if (!tooMany) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      const c = counts.get(key);
      if (c === undefined) {
        if (counts.size >= 256) {
          tooMany = true;
          counts.clear();
        } else {
          counts.set(key, 1);
        }
      } else {
        counts.set(key, c + 1);
      }
    }
  }
  let keyRgb = -1;
  let keyGrey = -1;
  if (transpRgb !== -1 && transpRgbCount === 1 && !hasPartial && !allOpaque) {
    // A tRNS key only works if no opaque pixel wears the same RGB.
    let clash = false;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      if (rgba[d + 3] === 255 && ((rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2]) === transpRgb) {
        clash = true;
        break;
      }
    }
    if (!clash) {
      keyRgb = transpRgb;
      if (isGrey) keyGrey = (transpRgb >> 16) & 0xff;
    }
  }
  return {
    distinct: tooMany ? 257 : counts.size,
    counts: tooMany ? null : counts,
    isGrey,
    allOpaque,
    keyRgb,
    keyGrey,
  };
}

// ---------------------------------------------------------------- forms

interface Form {
  name: string;
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function buildForms(rgba: Uint8Array, width: number, height: number, an: Analysis): Form[] {
  const n = width * height;
  const forms: Form[] = [];
  // RGBA always applies.
  forms.push({ name: 'rgba', colourType: 6, bpp: 4, samples: rgba, plte: null, trns: null });
  if (an.allOpaque) {
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgb[s] = rgba[d];
      rgb[s + 1] = rgba[d + 1];
      rgb[s + 2] = rgba[d + 2];
    }
    forms.push({ name: 'rgb', colourType: 2, bpp: 3, samples: rgb, plte: null, trns: null });
  } else if (an.keyRgb !== -1) {
    // One transparent value can stand in for the alpha channel: RGB + tRNS key.
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgb[s] = rgba[d];
      rgb[s + 1] = rgba[d + 1];
      rgb[s + 2] = rgba[d + 2];
    }
    const trns = new Uint8Array(6);
    trns[1] = (an.keyRgb >> 16) & 0xff;
    trns[3] = (an.keyRgb >> 8) & 0xff;
    trns[5] = an.keyRgb & 0xff;
    forms.push({ name: 'rgb-key', colourType: 2, bpp: 3, samples: rgb, plte: null, trns });
  }
  if (an.isGrey) {
    const grey = new Uint8Array(n);
    for (let i = 0, d = 0; i < n; i++, d += 4) grey[i] = rgba[d];
    if (an.allOpaque) {
      forms.push({ name: 'grey', colourType: 0, bpp: 1, samples: grey, plte: null, trns: null });
    } else if (an.keyGrey !== -1) {
      const trns = new Uint8Array(2);
      trns[1] = an.keyGrey;
      forms.push({ name: 'grey-key', colourType: 0, bpp: 1, samples: grey, plte: null, trns });
    } else {
      const ga = new Uint8Array(n * 2);
      for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
        ga[s] = rgba[d];
        ga[s + 1] = rgba[d + 3];
      }
      forms.push({ name: 'grey-alpha', colourType: 4, bpp: 2, samples: ga, plte: null, trns: null });
    }
  }
  if (an.counts !== null) {
    // Palette, in three orders: by count, by luminance, by RGB value.
    const entries = [...an.counts.entries()];
    const orders: [string, (a: [number, number], b: [number, number]) => number][] = [
      ['pal-count', (a, b) => b[1] - a[1] || a[0] - b[0]],
      [
        'pal-lum',
        (a, b) =>
          luminance((a[0] >>> 24) & 0xff, (a[0] >>> 16) & 0xff, (a[0] >>> 8) & 0xff) -
            luminance((b[0] >>> 24) & 0xff, (b[0] >>> 16) & 0xff, (b[0] >>> 8) & 0xff) || a[0] - b[0],
      ],
      ['pal-rgb', (a, b) => a[0] - b[0]],
    ];
    for (const [name, cmp] of orders) {
      const sorted = [...entries].sort(cmp);
      const index = new Map<number, number>();
      const plte = new Uint8Array(sorted.length * 3);
      const alphas = new Uint8Array(sorted.length);
      let anyTransp = false;
      sorted.forEach(([key,], e) => {
        index.set(key, e);
        plte[e * 3] = (key >>> 24) & 0xff;
        plte[e * 3 + 1] = (key >>> 16) & 0xff;
        plte[e * 3 + 2] = (key >>> 8) & 0xff;
        const a = key & 0xff;
        alphas[e] = a;
        if (a !== 255) anyTransp = true;
      });
      const samples = new Uint8Array(n);
      for (let i = 0, d = 0; i < n; i++, d += 4) {
        const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
        samples[i] = index.get(key) as number;
      }
      let trns: Uint8Array | null = null;
      if (anyTransp) {
        // Entries past tRNS are opaque: trim trailing 255s.
        let len = sorted.length;
        while (len > 0 && alphas[len - 1] === 255) len--;
        trns = alphas.subarray(0, len);
      }
      forms.push({ name, colourType: 3, bpp: 1, samples, plte, trns });
    }
  }
  return forms;
}

// ---------------------------------------------------------------- filter search

interface Candidate {
  label: string;
  raw: Uint8Array;
}

// Count distinct adjacent byte pairs in a filtered row, with a stamp table.
const PAIR_SEEN = new Uint32Array(65536);
let pairGen = 0;

function distinctPairs(row: Uint8Array): number {
  pairGen++;
  const gen = pairGen;
  let count = 0;
  let prev = 0;
  for (let i = 0; i < row.length; i++) {
    const pair = (prev << 8) | row[i];
    if (PAIR_SEEN[pair] !== gen) {
      PAIR_SEEN[pair] = gen;
      count++;
    }
    prev = row[i];
  }
  return count;
}

const PREFIX_WINDOW = 32768;

/**
 * The five filtered rows of one row, into `trial` (each `stride` bytes).
 * Shared by the cheap pass (fixed / minimum-sum / distinct-pairs) and the
 * brute-force pass, so both see identical filtered rows.
 */
function trialRows(
  form: Form,
  width: number,
  y: number,
  trial: Uint8Array[],
): { cur: Uint8Array; prev: Uint8Array | null } {
  const stride = width * form.bpp;
  const cur = form.samples.subarray(y * stride, (y + 1) * stride);
  const prev = y === 0 ? null : form.samples.subarray((y - 1) * stride, y * stride);
  for (let t = 0; t < 5; t++) filterRow(t, cur, prev, form.bpp, trial[t]);
  return { cur, prev };
}

/**
 * Cheap filter pass: fixed 0..4, minimum-sum per row and fewest-distinct-
 * pairs per row. No zlib calls, so it runs first and ranks the forms.
 */
function filterCheap(form: Form, width: number, height: number): Candidate[] {
  const stride = width * form.bpp;
  const rowLen = stride + 1;
  const rawLen = height * rowLen;
  const fixed: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) fixed.push(new Uint8Array(rawLen));
  const minsumRaw = new Uint8Array(rawLen);
  const distinctRaw = new Uint8Array(rawLen);
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    trialRows(form, width, y, trial);
    let bestMin = 0;
    let bestMinSum = Infinity;
    for (let t = 0; t < 5; t++) {
      const s = signedSum(trial[t]);
      if (s < bestMinSum) {
        bestMinSum = s;
        bestMin = t;
      }
    }
    let bestDist = 0;
    let bestDistCount = Infinity;
    for (let t = 0; t < 5; t++) {
      const c = distinctPairs(trial[t]);
      if (c < bestDistCount) {
        bestDistCount = c;
        bestDist = t;
      }
    }
    const rowAt = y * rowLen;
    for (let t = 0; t < 5; t++) {
      fixed[t][rowAt] = t;
      fixed[t].set(trial[t], rowAt + 1);
    }
    minsumRaw[rowAt] = bestMin;
    minsumRaw.set(trial[bestMin], rowAt + 1);
    distinctRaw[rowAt] = bestDist;
    distinctRaw.set(trial[bestDist], rowAt + 1);
  }
  const out: Candidate[] = [];
  for (let t = 0; t < 5; t++) out.push({ label: 'fixed' + t, raw: fixed[t] });
  out.push({ label: 'minsum', raw: minsumRaw });
  out.push({ label: 'distinct', raw: distinctRaw });
  return out;
}

/**
 * True brute force: each row's five filters weighed by zlib level 4 against
 * the 32 KiB of filtered data before it, keeping the smallest compressed
 * size (lowest filter type on a tie). Runs only for the forms that can win,
 * after the cheap pass ranks them.
 */
function filterBrute(form: Form, width: number, height: number): Candidate {
  const stride = width * form.bpp;
  const rowLen = stride + 1;
  const rawLen = height * rowLen;
  const bruteRaw = new Uint8Array(rawLen);
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  const scratch = new Uint8Array(PREFIX_WINDOW + rowLen);
  for (let y = 0; y < height; y++) {
    trialRows(form, width, y, trial);
    const rowAt = y * rowLen;
    const preFrom = Math.max(0, rowAt - PREFIX_WINDOW);
    const prefix = bruteRaw.subarray(preFrom, rowAt);
    let bestBrute = 0;
    let bestBruteLen = Infinity;
    for (let t = 0; t < 5; t++) {
      scratch.set(prefix, 0);
      scratch[prefix.length] = t;
      scratch.set(trial[t], prefix.length + 1);
      const len = deflateSync(scratch.subarray(0, prefix.length + rowLen), { level: 4 }).length;
      if (len < bestBruteLen) {
        bestBruteLen = len;
        bestBrute = t;
      }
    }
    bruteRaw[rowAt] = bestBrute;
    bruteRaw.set(trial[bestBrute], rowAt + 1);
  }
  return { label: 'brute', raw: bruteRaw };
}

// ---------------------------------------------------------------- PNG writing

function writePng(form: Form, width: number, height: number, compressed: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = form.colourType;
  const parts: Uint8Array[] = [Uint8Array.from(SIGNATURE), chunk('IHDR', ihdr)];
  if (form.plte !== null) parts.push(chunk('PLTE', form.plte));
  if (form.trns !== null) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', compressed));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

/**
 * Encode one image: try every form, screen its cheap filter candidates at
 * zlib level 6, run true brute force only for the forms that can win, then
 * re-compress the best two per form at level 9 / memLevel 6 with the
 * default and filtered strategies, and keep the smallest whole PNG.
 * The level-9 round is skipped for forms far behind the best: level 9 gains
 * ~1-2% and cannot close an 8% gap, and level 9 on hard data is the slowest
 * step. All cut-offs are by computed sizes, never by the clock, so two runs
 * write identical bytes.
 */
function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const an = analyze(rgba);
  const forms = buildForms(rgba, width, height, an);
  // Cheap pass for every form, screened at level 6.
  const screened: { form: Form; label: string; raw: Uint8Array; size6: number }[] = [];
  const formBest6 = new Map<Form, number>();
  for (const form of forms) {
    let best = Infinity;
    for (const cand of filterCheap(form, width, height)) {
      const size6 = deflateSync(cand.raw, { level: 6 }).length;
      screened.push({ form, label: cand.label, raw: cand.raw, size6 });
      if (size6 < best) best = size6;
    }
    formBest6.set(form, best);
  }
  let bestSize6 = Infinity;
  for (const b of formBest6.values()) if (b < bestSize6) bestSize6 = b;
  // Brute force only for forms within 10% of the best cheap size.
  for (const form of forms) {
    if ((formBest6.get(form) as number) <= bestSize6 * 1.1) {
      const cand = filterBrute(form, width, height);
      const size6 = deflateSync(cand.raw, { level: 6 }).length;
      screened.push({ form, label: cand.label, raw: cand.raw, size6 });
      if (size6 < (formBest6.get(form) as number)) formBest6.set(form, size6);
      if (size6 < bestSize6) bestSize6 = size6;
    }
  }
  // Best two candidates per form.
  const byForm = new Map<Form, { label: string; raw: Uint8Array; size6: number }[]>();
  for (const s of screened) {
    const list = byForm.get(s.form) ?? [];
    list.push({ label: s.label, raw: s.raw, size6: s.size6 });
    byForm.set(s.form, list);
  }
  let best: Uint8Array | null = null;
  for (const [form, list] of byForm) {
    list.sort((a, b) => a.size6 - b.size6);
    const top = list.slice(0, 2);
    const nearBest = (formBest6.get(form) as number) <= bestSize6 * 1.08;
    const finalists: { raw: Uint8Array; compressed: Uint8Array }[] = [];
    for (const cand of top) {
      if (nearBest) {
        for (const strategy of [0, 1]) {
          finalists.push({
            raw: cand.raw,
            compressed: deflateSync(cand.raw, { level: 9, memLevel: 6, strategy }),
          });
        }
      } else {
        finalists.push({ raw: cand.raw, compressed: deflateSync(cand.raw, { level: 6 }) });
      }
    }
    for (const f of finalists) {
      const png = writePng(form, width, height, f.compressed);
      if (best === null || png.length < best.length) best = png;
    }
  }
  if (best === null) throw new Error('no candidate encoded');
  return best;
}

// ---------------------------------------------------------------- main

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const png = encodeImage(image.rgba, image.width, image.height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
