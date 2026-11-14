/**
 * A small streaming FLAC encoder for 16-bit stereo 44.1 kHz audio.
 *
 * FLAC is lossless: decoding gives back exactly the encoded samples. Each
 * block of 4096 frames is coded independently. For each channel the encoder
 * picks the cheapest of a constant value, a fixed polynomial predictor (order
 * 0–4) with Rice-coded residuals, or the raw samples; for each block it picks
 * the cheapest stereo coding (left/right, left/side, side/right or mid/side).
 *
 * Format reference: https://www.rfc-editor.org/rfc/rfc9639 (FLAC).
 */

export const FLAC_BLOCK_SIZE = 4096;
const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const MAX_RICE_PARAMETER = 14;
const MAX_PARTITION_ORDER = 8;
const MAX_FIXED_ORDER = 4;
const OUTPUT_CHUNK_BYTES = 1 << 20;
/** Upper bound of one frame: raw samples (side uses 17 bits) plus headers. */
const MAX_FRAME_BYTES = 32 * 1024;

const CRC8_TABLE = makeCrcTable(0x07, 8);
const CRC16_TABLE = makeCrcTable(0x8005, 16);

function makeCrcTable(polynomial: number, width: 8 | 16): Uint16Array {
  const top = 1 << (width - 1);
  const mask = (1 << width) - 1;
  const table = new Uint16Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let crc = byte << (width - 8);
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & top ? ((crc << 1) ^ polynomial) & mask : (crc << 1) & mask;
    }
    table[byte] = crc;
  }
  return table;
}

export function crc8(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) crc = CRC8_TABLE[crc ^ bytes[i]];
  return crc;
}

export function crc16(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[(crc >> 8) ^ bytes[i]];
  }
  return crc;
}

/** Writes big-endian bit fields into a byte buffer. */
export class BitWriter {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private position = 0;
  private accumulator = 0;
  private pending = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  /** Bytes completely written so far. */
  get byteLength(): number {
    return this.position;
  }

  reset(): void {
    this.position = 0;
    this.accumulator = 0;
    this.pending = 0;
  }

  /** Writes the low `count` bits of a non-negative `value` (count ≤ 32). */
  write(value: number, count: number): void {
    while (count > 24) {
      count -= 24;
      this.writeShort(Math.floor(value / 2 ** count) & 0xffffff, 24);
      value %= 2 ** count;
    }
    this.writeShort(value, count);
  }

  private writeShort(value: number, count: number): void {
    if (count === 0) return;
    this.accumulator = (this.accumulator << count) |
      (value & ((1 << count) - 1));
    this.pending += count;
    while (this.pending >= 8) {
      this.pending -= 8;
      this.bytes[this.position++] = (this.accumulator >>> this.pending) & 0xff;
    }
    this.accumulator &= (1 << this.pending) - 1;
  }

  /** Writes a two's-complement signed value in `count` bits (count ≤ 24). */
  writeSigned(value: number, count: number): void {
    this.writeShort(value & ((1 << count) - 1), count);
  }

  /** Writes `zeros` zero bits followed by a one bit. */
  writeUnary(zeros: number): void {
    while (zeros >= 24) {
      this.writeShort(0, 24);
      zeros -= 24;
    }
    this.writeShort(1, zeros + 1);
  }

  /** Writes a signed residual with Rice parameter `k`. */
  writeRice(value: number, k: number): void {
    const folded = value >= 0 ? value * 2 : -value * 2 - 1;
    this.writeUnary(folded >>> k);
    if (k > 0) this.writeShort(folded & ((1 << k) - 1), k);
  }

  /** Pads with zero bits to the next byte boundary. */
  alignToByte(): void {
    if (this.pending > 0) this.writeShort(0, 8 - this.pending);
  }
}

/** Frame number as an extended UTF-8 sequence, as FLAC frame headers use. */
function writeUtf8Number(writer: BitWriter, value: number): void {
  if (value < 0x80) {
    writer.write(value, 8);
    return;
  }
  let bytes = 2;
  while (value >= 2 ** (5 * bytes + 1)) bytes++;
  const leading = (0xff00 >> bytes) & 0xff;
  writer.write(leading | Math.floor(value / 2 ** (6 * (bytes - 1))), 8);
  for (let i = bytes - 2; i >= 0; i--) {
    writer.write(0x80 | (Math.floor(value / 2 ** (6 * i)) & 0x3f), 8);
  }
}

const SubframeType = { Constant: 0, Verbatim: 1, Fixed: 2 } as const;
type SubframeType = (typeof SubframeType)[keyof typeof SubframeType];

interface SubframePlan {
  type: SubframeType;
  bits: number;
  order: number;
  partitionOrder: number;
  parameters: Uint8Array;
}

/**
 * Plans and writes subframes. Buffers are reused across blocks to avoid
 * allocating in the encoding loop.
 */
class SubframeCoder {
  private readonly residual = new Int32Array(FLAC_BLOCK_SIZE);
  private readonly partitionSums = new Float64Array(1 << MAX_PARTITION_ORDER);
  private readonly parameters = new Uint8Array(1 << MAX_PARTITION_ORDER);

  /** Chooses the cheapest coding for `samples[0..n)` at `bps` bits. */
  plan(samples: Int32Array, n: number, bps: number): SubframePlan {
    const verbatim: SubframePlan = {
      type: SubframeType.Verbatim,
      bits: 8 + n * bps,
      order: 0,
      partitionOrder: 0,
      parameters: new Uint8Array(0),
    };
    let constant = true;
    for (let i = 1; i < n; i++) {
      if (samples[i] !== samples[0]) {
        constant = false;
        break;
      }
    }
    if (constant) {
      return { ...verbatim, type: SubframeType.Constant, bits: 8 + bps };
    }

    // Pick the fixed predictor order with the smallest residual magnitude.
    const order = bestFixedOrder(samples, n);
    if (order >= n) return verbatim;
    computeFixedResidual(samples, n, order, this.residual);
    const coding = this.planResidual(n, order);
    const bits = 8 + order * bps + coding.bits;
    if (bits >= verbatim.bits) return verbatim;
    return {
      type: SubframeType.Fixed,
      bits,
      order,
      partitionOrder: coding.partitionOrder,
      parameters: this.parameters.slice(0, 1 << coding.partitionOrder),
    };
  }

  /** Writes the subframe planned for `samples` (the residual must be current). */
  write(
    writer: BitWriter,
    samples: Int32Array,
    n: number,
    bps: number,
    plan: SubframePlan,
  ): void {
    if (plan.type === SubframeType.Constant) {
      writer.write(0b00000000, 8);
      writer.writeSigned(samples[0], bps);
      return;
    }
    if (plan.type === SubframeType.Verbatim) {
      writer.write(0b00000010, 8);
      for (let i = 0; i < n; i++) writer.writeSigned(samples[i], bps);
      return;
    }
    const { order, partitionOrder, parameters } = plan;
    computeFixedResidual(samples, n, order, this.residual);
    writer.write(0b00010000 | (order << 1), 8);
    for (let i = 0; i < order; i++) writer.writeSigned(samples[i], bps);
    writer.write(0b00, 2); // Rice coding, 4-bit parameters
    writer.write(partitionOrder, 4);
    const partitionSize = n >> partitionOrder;
    let index = order;
    for (let p = 0; p < 1 << partitionOrder; p++) {
      const k = parameters[p];
      writer.write(k, 4);
      const end = (p + 1) * partitionSize;
      for (; index < end; index++) writer.writeRice(this.residual[index], k);
    }
  }

  /**
   * Chooses the partition order and Rice parameters for the current residual
   * and returns the exact number of bits the residual coding takes.
   */
  private planResidual(
    n: number,
    order: number,
  ): { bits: number; partitionOrder: number } {
    const residual = this.residual;
    let maxOrder = 0;
    while (
      maxOrder < MAX_PARTITION_ORDER &&
      n % (1 << (maxOrder + 1)) === 0 &&
      (n >> (maxOrder + 1)) > order
    ) maxOrder++;

    // Sums of folded residuals over the finest partitions, merged upwards.
    const finest = 1 << maxOrder;
    const finestSize = n >> maxOrder;
    const sums = this.partitionSums;
    for (let p = 0; p < finest; p++) {
      let sum = 0;
      const start = p === 0 ? order : p * finestSize;
      const end = (p + 1) * finestSize;
      for (let i = start; i < end; i++) {
        const value = residual[i];
        sum += value >= 0 ? value * 2 : -value * 2 - 1;
      }
      sums[p] = sum;
    }

    let bestOrder = 0;
    let bestEstimate = Infinity;
    const levelSums = Float64Array.from(sums.subarray(0, finest));
    for (let level = maxOrder; level >= 0; level--) {
      const count = 1 << level;
      const size = n >> level;
      let estimate = 0;
      for (let p = 0; p < count; p++) {
        const samplesInPartition = p === 0 ? size - order : size;
        estimate += 4 +
          estimateRiceBits(levelSums[p], samplesInPartition);
      }
      if (estimate < bestEstimate) {
        bestEstimate = estimate;
        bestOrder = level;
      }
      // Merge pairs for the next coarser level.
      for (let p = 0; p < count / 2; p++) {
        levelSums[p] = levelSums[2 * p] + levelSums[2 * p + 1];
      }
    }

    // Exact size with the chosen parameters.
    const count = 1 << bestOrder;
    const size = n >> bestOrder;
    let bits = 2 + 4;
    let index = order;
    for (let p = 0; p < count; p++) {
      const end = (p + 1) * size;
      const samplesInPartition = end - index;
      let sum = 0;
      for (let i = index; i < end; i++) {
        const value = residual[i];
        sum += value >= 0 ? value * 2 : -value * 2 - 1;
      }
      const k = riceParameter(sum, samplesInPartition);
      this.parameters[p] = k;
      bits += 4 + samplesInPartition * (k + 1);
      for (; index < end; index++) {
        const value = residual[index];
        bits += (value >= 0 ? value * 2 : -value * 2 - 1) >>> k;
      }
    }
    return { bits, partitionOrder: bestOrder };
  }
}

function riceParameter(sum: number, count: number): number {
  if (count <= 0 || sum <= count) return 0;
  const k = Math.floor(Math.log2(sum / count));
  return Math.max(0, Math.min(MAX_RICE_PARAMETER, k));
}

function estimateRiceBits(sum: number, count: number): number {
  if (count <= 0) return 0;
  const k = riceParameter(sum, count);
  return count * (k + 1) + Math.floor(sum / 2 ** k);
}

/** The fixed predictor order (0–4) with the smallest sum of |residual|. */
function bestFixedOrder(samples: Int32Array, n: number): number {
  if (n <= MAX_FIXED_ORDER) return 0;
  let e0 = 0, e1 = 0, e2 = 0, e3 = 0, e4 = 0;
  let last0 = samples[3];
  let last1 = samples[3] - samples[2];
  let last2 = last1 - (samples[2] - samples[1]);
  let last3 = last2 - (samples[2] - 2 * samples[1] + samples[0]);
  for (let i = 4; i < n; i++) {
    const r0 = samples[i];
    const r1 = r0 - last0;
    const r2 = r1 - last1;
    const r3 = r2 - last2;
    const r4 = r3 - last3;
    e0 += Math.abs(r0);
    e1 += Math.abs(r1);
    e2 += Math.abs(r2);
    e3 += Math.abs(r3);
    e4 += Math.abs(r4);
    last0 = r0;
    last1 = r1;
    last2 = r2;
    last3 = r3;
  }
  const errors = [e0, e1, e2, e3, e4];
  let best = 0;
  for (let order = 1; order <= MAX_FIXED_ORDER; order++) {
    if (errors[order] < errors[best]) best = order;
  }
  return best;
}

/** Residual of the fixed polynomial predictor of `order`, from index `order`. */
export function computeFixedResidual(
  x: Int32Array,
  n: number,
  order: number,
  out: Int32Array,
): void {
  switch (order) {
    case 0:
      for (let i = 0; i < n; i++) out[i] = x[i];
      break;
    case 1:
      for (let i = 1; i < n; i++) out[i] = x[i] - x[i - 1];
      break;
    case 2:
      for (let i = 2; i < n; i++) out[i] = x[i] - 2 * x[i - 1] + x[i - 2];
      break;
    case 3:
      for (let i = 3; i < n; i++) {
        out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
      }
      break;
    case 4:
      for (let i = 4; i < n; i++) {
        out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
      }
      break;
  }
}

/** Frame header channel assignment codes. */
const ChannelAssignment = {
  Independent: 0b0001,
  LeftSide: 0b1000,
  SideRight: 0b1001,
  MidSide: 0b1010,
} as const;
type ChannelAssignment = (typeof ChannelAssignment)[keyof typeof ChannelAssignment];

/** Streaming encoder: push interleaved 16-bit stereo, then finish(). */
export class FlacEncoder {
  private readonly left = new Int32Array(FLAC_BLOCK_SIZE);
  private readonly right = new Int32Array(FLAC_BLOCK_SIZE);
  private readonly mid = new Int32Array(FLAC_BLOCK_SIZE);
  private readonly side = new Int32Array(FLAC_BLOCK_SIZE);
  private readonly coder = new SubframeCoder();
  private readonly writer = new BitWriter(MAX_FRAME_BYTES);
  private readonly chunks: Uint8Array<ArrayBuffer>[] = [];
  private chunk = new Uint8Array(OUTPUT_CHUNK_BYTES);
  private chunkUsed = 0;
  private filled = 0;
  private frameNumber = 0;
  private totalFrames = 0;
  private minFrameBytes = Infinity;
  private maxFrameBytes = 0;
  private finished = false;

  /** Adds interleaved stereo 16-bit samples (left, right, left, …). */
  push(interleaved: Int16Array): void {
    if (this.finished) throw new Error("The FLAC stream is already finished.");
    if (interleaved.length % CHANNELS !== 0) {
      throw new Error("Stereo samples must come in left/right pairs.");
    }
    for (let i = 0; i < interleaved.length; i += 2) {
      this.left[this.filled] = interleaved[i];
      this.right[this.filled] = interleaved[i + 1];
      if (++this.filled === FLAC_BLOCK_SIZE) this.encodeBlock();
    }
  }

  /** Encodes the remaining samples and returns the complete FLAC file. */
  finish(): Blob {
    if (this.finished) throw new Error("The FLAC stream is already finished.");
    if (this.filled > 0) this.encodeBlock();
    this.finished = true;
    if (this.chunkUsed > 0) this.chunks.push(this.chunk.slice(0, this.chunkUsed));
    this.chunk = new Uint8Array(0);
    const blob = new Blob([this.streamHeader(), ...this.chunks], {
      type: "audio/flac",
    });
    this.chunks.length = 0;
    return blob;
  }

  private encodeBlock(): void {
    const n = this.filled;
    const { left, right, mid, side, coder, writer } = this;
    for (let i = 0; i < n; i++) {
      mid[i] = (left[i] + right[i]) >> 1;
      side[i] = left[i] - right[i];
    }
    const leftPlan = coder.plan(left, n, BITS_PER_SAMPLE);
    const rightPlan = coder.plan(right, n, BITS_PER_SAMPLE);
    const midPlan = coder.plan(mid, n, BITS_PER_SAMPLE);
    const sidePlan = coder.plan(side, n, BITS_PER_SAMPLE + 1);
    const options: [ChannelAssignment, number][] = [
      [ChannelAssignment.Independent, leftPlan.bits + rightPlan.bits],
      [ChannelAssignment.LeftSide, leftPlan.bits + sidePlan.bits],
      [ChannelAssignment.SideRight, sidePlan.bits + rightPlan.bits],
      [ChannelAssignment.MidSide, midPlan.bits + sidePlan.bits],
    ];
    const [assignment] = options.reduce((best, option) =>
      option[1] < best[1] ? option : best
    );

    writer.reset();
    this.writeFrameHeader(n, assignment);
    const side17 = BITS_PER_SAMPLE + 1;
    switch (assignment) {
      case ChannelAssignment.Independent:
        coder.write(writer, left, n, BITS_PER_SAMPLE, leftPlan);
        coder.write(writer, right, n, BITS_PER_SAMPLE, rightPlan);
        break;
      case ChannelAssignment.LeftSide:
        coder.write(writer, left, n, BITS_PER_SAMPLE, leftPlan);
        coder.write(writer, side, n, side17, sidePlan);
        break;
      case ChannelAssignment.SideRight:
        coder.write(writer, side, n, side17, sidePlan);
        coder.write(writer, right, n, BITS_PER_SAMPLE, rightPlan);
        break;
      case ChannelAssignment.MidSide:
        coder.write(writer, mid, n, BITS_PER_SAMPLE, midPlan);
        coder.write(writer, side, n, side17, sidePlan);
        break;
    }
    writer.alignToByte();
    writer.write(crc16(writer.bytes, 0, writer.byteLength), 16);

    this.appendOutput(writer.bytes.subarray(0, writer.byteLength));
    this.minFrameBytes = Math.min(this.minFrameBytes, writer.byteLength);
    this.maxFrameBytes = Math.max(this.maxFrameBytes, writer.byteLength);
    this.totalFrames += n;
    this.frameNumber++;
    this.filled = 0;
  }

  private writeFrameHeader(n: number, assignment: ChannelAssignment): void {
    const writer = this.writer;
    writer.write(0b11111111111110, 14); // sync code
    writer.write(0, 1); // reserved
    writer.write(0, 1); // fixed block size
    const fullBlock = n === FLAC_BLOCK_SIZE;
    writer.write(fullBlock ? 0b1100 : n <= 256 ? 0b0110 : 0b0111, 4);
    writer.write(0b1001, 4); // 44.1 kHz
    writer.write(assignment, 4);
    writer.write(0b100, 3); // 16 bits per sample
    writer.write(0, 1); // reserved
    writeUtf8Number(writer, this.frameNumber);
    if (!fullBlock) writer.write(n - 1, n <= 256 ? 8 : 16);
    writer.write(crc8(writer.bytes, 0, writer.byteLength), 8);
  }

  private appendOutput(bytes: Uint8Array): void {
    if (this.chunkUsed + bytes.length > this.chunk.length) {
      this.chunks.push(this.chunk.slice(0, this.chunkUsed));
      this.chunk = new Uint8Array(OUTPUT_CHUNK_BYTES);
      this.chunkUsed = 0;
    }
    this.chunk.set(bytes, this.chunkUsed);
    this.chunkUsed += bytes.length;
  }

  /** "fLaC" plus the STREAMINFO block, written once totals are known. */
  private streamHeader(): Uint8Array<ArrayBuffer> {
    const writer = new BitWriter(4 + 4 + 34);
    for (const char of "fLaC") writer.write(char.charCodeAt(0), 8);
    writer.write(1, 1); // last metadata block
    writer.write(0, 7); // STREAMINFO
    writer.write(34, 24);
    writer.write(FLAC_BLOCK_SIZE, 16);
    writer.write(FLAC_BLOCK_SIZE, 16);
    writer.write(Number.isFinite(this.minFrameBytes) ? this.minFrameBytes : 0, 24);
    writer.write(this.maxFrameBytes, 24);
    writer.write(SAMPLE_RATE, 20);
    writer.write(CHANNELS - 1, 3);
    writer.write(BITS_PER_SAMPLE - 1, 5);
    writer.write(this.totalFrames, 36);
    for (let i = 0; i < 16; i++) writer.write(0, 8); // MD5 not computed
    return writer.bytes.slice(0, writer.byteLength);
  }
}

/** Encodes a whole interleaved 16-bit stereo signal to FLAC. */
export function encodeFlac(interleaved: Int16Array): Blob {
  const encoder = new FlacEncoder();
  encoder.push(interleaved);
  return encoder.finish();
}
