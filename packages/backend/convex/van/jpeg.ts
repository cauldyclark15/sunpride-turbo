/**
 * VAN-020: a damage photo must be a real, bounded picture, not bytes that merely start with
 * a JPEG signature. This decodes a baseline (sequential Huffman) JPEG far enough to prove
 * every 8x8 block of every component is present and well formed: frame, quantization and
 * Huffman tables, the full entropy-coded scan with its restart markers, and the final EOI.
 * It does not run the inverse DCT; pixel values are not needed to know the picture exists.
 *
 * The van app only produces baseline JPEGs (Android Bitmap.compress). Progressive,
 * arithmetic-coded, lossless and 12-bit files are refused. Mirrored in native
 * `com.sunpride.van.evidence.BaselineJpeg`.
 */

export type JpegInfo = { width: number; height: number };

export const JPEG_MIN_SIDE = 16;
export const JPEG_MAX_SIDE = 4096;

type Huffman = {
  maxCode: Int32Array;
  valPtr: Int32Array;
  minCode: Int32Array;
  values: Uint8Array;
};
type Component = { id: number; h: number; v: number; tq: number };

class Invalid extends Error {}
function fail(): never {
  throw new Invalid();
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxCode = new Int32Array(18).fill(-1);
  const valPtr = new Int32Array(17);
  const minCode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1]!;
    if (n > 0) {
      valPtr[length] = k;
      minCode[length] = code;
      code += n;
      k += n;
      // A code space overflow means the table is not a prefix code.
      if (code > 1 << length) fail();
      maxCode[length] = code - 1;
    }
    code <<= 1;
  }
  return { maxCode, valPtr, minCode, values };
}

class Bits {
  private bit = 0;
  private byte = 0;
  private readonly data: Uint8Array;
  pos: number;
  constructor(data: Uint8Array, pos: number) {
    this.data = data;
    this.pos = pos;
  }
  read(): number {
    if (this.bit === 0) {
      if (this.pos >= this.data.length) fail();
      const b = this.data[this.pos]!;
      if (b === 0xff) {
        // Inside a scan 0xFF is always followed by a stuffed 0x00; anything else is a
        // marker, and a well-formed stream never needs bits past its last byte.
        if (this.data[this.pos + 1] !== 0x00) fail();
        this.pos += 2;
      } else this.pos += 1;
      this.byte = b;
      this.bit = 8;
    }
    this.bit -= 1;
    return (this.byte >> this.bit) & 1;
  }
  receive(count: number): void {
    for (let i = 0; i < count; i++) this.read();
  }
  decode(table: Huffman): number {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | this.read();
      if (code <= table.maxCode[length]!)
        return table.values[
          table.valPtr[length]! + code - table.minCode[length]!
        ]!;
    }
    return fail();
  }
  /** Drops padding bits; the next byte must start a marker. */
  align(): void {
    this.bit = 0;
  }
}

function decodeBlock(bits: Bits, dc: Huffman, ac: Huffman) {
  const size = bits.decode(dc);
  if (size > 11) fail();
  bits.receive(size);
  let k = 1;
  while (k < 64) {
    const rs = bits.decode(ac);
    const run = rs >> 4;
    const size = rs & 15;
    if (size === 0) {
      if (run !== 15) return; // end of block
      k += 16;
      if (k > 64) fail();
      continue;
    }
    if (size > 10) fail();
    k += run;
    if (k > 63) fail();
    bits.receive(size);
    k += 1;
  }
}

/** The decoded size, or null when the bytes are not a complete baseline JPEG within bounds. */
export function verifyBaselineJpeg(
  data: Uint8Array,
  bounds: { minSide: number; maxSide: number } = {
    minSide: JPEG_MIN_SIDE,
    maxSide: JPEG_MAX_SIDE,
  },
): JpegInfo | null {
  try {
    return parse(data, bounds);
  } catch (error) {
    if (error instanceof Invalid || error instanceof RangeError) return null;
    throw error;
  }
}

function parse(
  data: Uint8Array,
  bounds: { minSide: number; maxSide: number },
): JpegInfo {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) fail();
  const u16 = (at: number) => {
    if (at + 1 >= data.length) fail();
    return (data[at]! << 8) | data[at + 1]!;
  };
  const quant = new Set<number>();
  const dcTables: (Huffman | undefined)[] = [];
  const acTables: (Huffman | undefined)[] = [];
  let frame: { width: number; height: number; components: Component[] } | null =
    null;
  const scanned = new Set<number>();
  let restartInterval = 0;
  let pos = 2;
  for (;;) {
    if (pos >= data.length || data[pos] !== 0xff) fail();
    while (data[pos] === 0xff) pos += 1;
    if (pos >= data.length) fail();
    const marker = data[pos]!;
    pos += 1;
    if (marker === 0xd9) {
      if (
        pos !== data.length ||
        !frame ||
        scanned.size !== frame.components.length
      )
        fail();
      return { width: frame!.width, height: frame!.height };
    }
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd8)
    )
      fail();
    const length = u16(pos);
    if (length < 2 || pos + length > data.length) fail();
    const start = pos + 2;
    const end = pos + length;
    pos = end;
    if (marker === 0xc0 || marker === 0xc1) {
      if (frame || length < 8) fail();
      if (data[start] !== 8) fail(); // 8-bit samples only
      const height = u16(start + 1);
      const width = u16(start + 3);
      const count = data[start + 5]!;
      if (count !== 1 && count !== 3) fail();
      if (length !== 8 + count * 3) fail();
      if (
        width < bounds.minSide ||
        height < bounds.minSide ||
        width > bounds.maxSide ||
        height > bounds.maxSide
      )
        fail();
      const components: Component[] = [];
      for (let i = 0; i < count; i++) {
        const at = start + 6 + i * 3;
        const h = data[at + 1]! >> 4;
        const v = data[at + 1]! & 15;
        const tq = data[at + 2]!;
        if (h < 1 || h > 4 || v < 1 || v > 4 || tq > 3) fail();
        if (components.some((c) => c.id === data[at])) fail();
        components.push({ id: data[at]!, h, v, tq });
      }
      frame = { width, height, components };
    } else if (
      marker >= 0xc2 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      fail(); // progressive, lossless, hierarchical or arithmetic: never produced by the app
    } else if (marker === 0xc4) {
      let at = start;
      while (at < end) {
        const tc = data[at]! >> 4;
        const th = data[at]! & 15;
        if (tc > 1 || th > 3 || at + 17 > end) fail();
        const counts = data.subarray(at + 1, at + 17);
        const total = counts.reduce((sum, n) => sum + n, 0);
        if (total === 0 || total > 256 || at + 17 + total > end) fail();
        const table = buildHuffman(
          counts,
          data.subarray(at + 17, at + 17 + total),
        );
        (tc === 0 ? dcTables : acTables)[th] = table;
        at += 17 + total;
      }
    } else if (marker === 0xdb) {
      let at = start;
      while (at < end) {
        const precision = data[at]! >> 4;
        const tq = data[at]! & 15;
        const size = precision === 0 ? 64 : precision === 1 ? 128 : fail();
        if (tq > 3 || at + 1 + size > end) fail();
        quant.add(tq);
        at += 1 + size;
      }
    } else if (marker === 0xdd) {
      if (length !== 4) fail();
      restartInterval = u16(start);
    } else if (marker === 0xda) {
      if (!frame) fail();
      const f = frame!;
      const count = data[start]!;
      if (count < 1 || count > f.components.length || length !== 6 + count * 2)
        fail();
      const scan: { c: Component; dc: Huffman; ac: Huffman }[] = [];
      for (let i = 0; i < count; i++) {
        const at = start + 1 + i * 2;
        const c = f.components.find((x) => x.id === data[at]);
        if (!c || scanned.has(c.id) || !quant.has(c.tq)) fail();
        const dc = dcTables[data[at + 1]! >> 4];
        const ac = acTables[data[at + 1]! & 15];
        if (!dc || !ac) fail();
        scan.push({ c: c!, dc: dc!, ac: ac! });
        scanned.add(c!.id);
      }
      const tail = start + 1 + count * 2;
      // Baseline: spectral selection 0..63 and no successive approximation.
      if (data[tail] !== 0 || data[tail + 1] !== 63 || data[tail + 2] !== 0)
        fail();
      pos = decodeScan(data, end, f, scan, restartInterval);
    }
    // APPn, COM and other skippable segments are ignored.
  }
}

function decodeScan(
  data: Uint8Array,
  from: number,
  frame: { width: number; height: number; components: Component[] },
  scan: { c: Component; dc: Huffman; ac: Huffman }[],
  restartInterval: number,
): number {
  const hMax = Math.max(...frame.components.map((c) => c.h));
  const vMax = Math.max(...frame.components.map((c) => c.v));
  let units: number;
  let blocksPerUnit: { entry: (typeof scan)[number]; count: number }[];
  if (scan.length === 1) {
    // Non-interleaved: one block per unit over the component's own dimensions.
    const c = scan[0]!.c;
    const w = Math.ceil(Math.ceil((frame.width * c.h) / hMax) / 8);
    const h = Math.ceil(Math.ceil((frame.height * c.v) / vMax) / 8);
    units = w * h;
    blocksPerUnit = [{ entry: scan[0]!, count: 1 }];
  } else {
    units =
      Math.ceil(frame.width / (8 * hMax)) *
      Math.ceil(frame.height / (8 * vMax));
    blocksPerUnit = scan.map((entry) => ({
      entry,
      count: entry.c.h * entry.c.v,
    }));
    if (blocksPerUnit.reduce((sum, b) => sum + b.count, 0) > 10) fail();
  }
  const bits = new Bits(data, from);
  let expectedRestart = 0;
  for (let unit = 0; unit < units; unit++) {
    if (restartInterval > 0 && unit > 0 && unit % restartInterval === 0) {
      bits.align();
      if (
        data[bits.pos] !== 0xff ||
        data[bits.pos + 1] !== 0xd0 + expectedRestart
      )
        fail();
      bits.pos += 2;
      expectedRestart = (expectedRestart + 1) & 7;
    }
    for (const { entry, count } of blocksPerUnit)
      for (let i = 0; i < count; i++) decodeBlock(bits, entry.dc, entry.ac);
  }
  bits.align();
  if (data[bits.pos] !== 0xff) fail();
  return bits.pos;
}
