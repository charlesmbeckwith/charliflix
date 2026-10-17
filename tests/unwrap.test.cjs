'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { PNG } = require('pngjs');
const { unwrapSegment } = require('../lib/unwrap.cjs');

function packets(count = 3) {
  const bytes = Buffer.alloc(count * 188, 0xff);
  for (let packet = 0; packet < count; packet++) {
    const offset = packet * 188;
    bytes[offset] = 0x47;
    bytes[offset + 1] = 0x01;
    bytes[offset + 2] = 0x00;
    bytes[offset + 3] = 0x10 | (packet & 15);
  }
  return bytes;
}

function png(rgb, colorType = 2) {
  const width = 8;
  const height = Math.max(1, Math.ceil(rgb.length / (width * 3)));
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < rgb.length; i++) rgba[Math.floor(i / 3) * 4 + (i % 3)] = rgb[i];
  return PNG.sync.write({ width, height, data: rgba }, { colorType, inputColorType: 6, bitDepth: 8 });
}

function pixelCarrier(ts, colorType = 2, lengthOverride) {
  const compressed = zlib.gzipSync(ts);
  const header = Buffer.alloc(12);
  header.write('TIKTIKPX');
  header.writeUInt32BE(lengthOverride ?? compressed.length, 8);
  return png(Buffer.concat([header, compressed]), colorType);
}

function webp(ts) {
  const chunk = Buffer.alloc(8);
  chunk.write('EXIF');
  chunk.writeUInt32LE(ts.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk, ts, Buffer.alloc(ts.length & 1)]);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('accepts raw TS and owns its output, including offset Uint8Array views', () => {
  const ts = packets();
  const padded = Buffer.concat([Buffer.from('prefix'), ts, Buffer.from('suffix')]);
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 6, ts.length);
  const result = unwrapSegment(view);
  assert.deepEqual(result, ts);
  result[0] = 0;
  assert.equal(view[0], 0x47);
});

test('extracts the explicit raw marker payload', () => {
  const ts = packets();
  assert.deepEqual(unwrapSegment(Buffer.concat([Buffer.from('carrier:TIKTIKRAW'), ts])), ts);
});

for (const [name, compress] of [['gzip', zlib.gzipSync], ['zlib', zlib.deflateSync]]) {
  test(`extracts a ${name} marker payload`, () => {
    const ts = packets();
    assert.deepEqual(unwrapSegment(Buffer.concat([Buffer.from('carrier:TIKTIKTSGZ'), compress(ts)])), ts);
  });
}

test('extracts TS immediately following a valid PNG IEND', () => {
  const ts = packets();
  assert.deepEqual(unwrapSegment(Buffer.concat([png(Buffer.from([1, 2, 3])), ts])), ts);
});

test('extracts TS in a WebP EXIF chunk', () => {
  const ts = packets();
  assert.deepEqual(unwrapSegment(webp(ts)), ts);
});

for (const color of [2, 6]) {
  test(`extracts the compressed legacy PNG pixels with color type ${color}`, () => {
    const ts = packets();
    assert.deepEqual(unwrapSegment(pixelCarrier(ts, color)), ts);
  });
}

test('rejects incomplete TS, missing packet sync, and reserved headers', () => {
  assert.throws(() => unwrapSegment(packets().subarray(0, 400)), /partial|missing packet/);
  const broken = packets();
  broken[188] = 0;
  assert.throws(() => unwrapSegment(broken), /packet sync/);
  const reserved = packets();
  reserved[3] = 0;
  assert.throws(() => unwrapSegment(reserved), /reserved packet header/);
  const adaptation = packets();
  adaptation[3] = 0x30;
  adaptation[4] = 184;
  assert.throws(() => unwrapSegment(adaptation), /adaptation field/);
});

test('limits both direct output and compressed expansion', () => {
  const ts = packets(100);
  const options = { maxOutputBytes: 188 * 3 };
  assert.throws(() => unwrapSegment(ts, options), /size limit/);
  assert.throws(() => unwrapSegment(Buffer.concat([Buffer.from('TIKTIKTSGZ'), zlib.gzipSync(ts)]), options), /size limit/);
  assert.throws(() => unwrapSegment(pixelCarrier(ts), options), /size limit/);
});

test('rejects truncated and damaged compressed payloads', () => {
  const compressed = zlib.gzipSync(packets());
  assert.throws(() => unwrapSegment(Buffer.concat([Buffer.from('TIKTIKTSGZ'), compressed.subarray(0, -4)])), /damaged/);
  compressed[compressed.length - 8] ^= 1;
  assert.throws(() => unwrapSegment(Buffer.concat([Buffer.from('TIKTIKTSGZ'), compressed])), /damaged/);
  assert.throws(() => unwrapSegment(Buffer.from('TIKTIKTSGZnot-gzip')), /neither gzip nor zlib/);
});

test('rejects PNG checksums, truncated chunks, missing IEND, and non-payload pixels', () => {
  const image = png(Buffer.from([1, 2, 3]));
  const damaged = Buffer.from(image);
  damaged[29] ^= 1;
  assert.throws(() => unwrapSegment(damaged), /checksum/);
  assert.throws(() => unwrapSegment(image.subarray(0, -1)), /chunk|end/);
  assert.throws(() => unwrapSegment(image.subarray(0, -12)), /image end/);
  assert.throws(() => unwrapSegment(image), /recognized pixel payload/);
  const hugeChunk = Buffer.from(image);
  hugeChunk.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => unwrapSegment(hugeChunk), /beyond its container/);
});

test('rejects an impossible legacy pixel payload length', () => {
  assert.throws(() => unwrapSegment(pixelCarrier(packets(), 2, 0xffffffff)), /payload length/);
});

test('rejects truncated WebP containers and invalid EXIF transport streams', () => {
  const image = webp(packets());
  assert.throws(() => unwrapSegment(image.subarray(0, -1)), /RIFF size/);
  const wrongChunk = Buffer.from(image);
  wrongChunk.writeUInt32LE(0xffffffff, 16);
  assert.throws(() => unwrapSegment(wrongChunk), /beyond its container/);
  const wrongPayload = Buffer.from(image);
  wrongPayload[20 + 188] = 0;
  assert.throws(() => unwrapSegment(wrongPayload), /packet sync/);
});

test('validates input types, hard input bounds, and output-limit settings', () => {
  assert.throws(() => unwrapSegment('segment'), TypeError);
  assert.throws(() => unwrapSegment(Buffer.alloc(0)), /input is empty/);
  assert.throws(() => unwrapSegment(Buffer.alloc(12 * 1024 * 1024 + 1)), /size limit/);
  for (const value of [0, 187, -1, 1.5, Infinity, 64 * 1024 * 1024 + 1]) {
    assert.throws(() => unwrapSegment(packets(), { maxOutputBytes: value }), RangeError);
  }
  assert.throws(() => unwrapSegment(Buffer.from('not a stream')), /unrecognized/);
});
