'use strict';

const zlib = require('node:zlib');

const DEFAULT_LIMIT = 12 * 1024 * 1024;
const INPUT_LIMIT = 12 * 1024 * 1024;
const IMAGE_LIMIT = 64 * 1024 * 1024;
const PACKET_BYTES = 188;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RAW_MARKER = Buffer.from('TIKTIKRAW');
const COMPRESSED_MARKER = Buffer.from('TIKTIKTSGZ');
const PIXEL_MARKER = Buffer.from('TIKTIKPX');

const crcTable = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  crcTable[value] = crc >>> 0;
}

function fail(message) {
  throw new Error(`Invalid segment: ${message}`);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function transportStream(bytes, limit) {
  if (bytes.length > limit) fail('decoded output exceeds the size limit');
  if (bytes.length < PACKET_BYTES || bytes.length % PACKET_BYTES !== 0) {
    fail('transport stream has a partial or missing packet');
  }
  for (let offset = 0; offset < bytes.length; offset += PACKET_BYTES) {
    if (bytes[offset] !== 0x47) fail('transport stream packet sync is missing');
    const adaptation = (bytes[offset + 3] >>> 4) & 3;
    if (adaptation === 0) fail('transport stream has a reserved packet header');
    if (adaptation >= 2 && bytes[offset + 4] > 183) fail('invalid adaptation field length');
  }
  // Return owned bytes: a caller may release or reuse the downloaded carrier.
  return Buffer.from(bytes);
}

function decompress(bytes, limit) {
  const gzip = bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8;
  const deflate = bytes.length >= 2 && (bytes[0] & 15) === 8 && (bytes[0] >>> 4) <= 7 &&
    ((bytes[0] << 8) | bytes[1]) % 31 === 0 && (bytes[1] & 32) === 0;
  if (!gzip && !deflate) fail('compressed payload is neither gzip nor zlib');
  let decoded;
  try {
    decoded = zlib.unzipSync(bytes, { maxOutputLength: limit });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') fail('decoded output exceeds the size limit');
    fail('compressed payload is damaged or exceeds the size limit');
  }
  return transportStream(decoded, limit);
}

function webpPayload(bytes, limit) {
  if (bytes.length < 12 || bytes.toString('ascii', 8, 12) !== 'WEBP') fail('invalid WebP signature');
  const end = bytes.readUInt32LE(4) + 8;
  if (end !== bytes.length) fail('WebP RIFF size does not match its payload');
  let offset = 12;
  let found = null;
  while (offset < end) {
    if (end - offset < 8) fail('truncated WebP chunk header');
    const tag = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const next = dataStart + size + (size & 1);
    if (next > end) fail('WebP chunk extends beyond its container');
    if (tag === 'EXIF') {
      if (found) fail('multiple WebP EXIF payloads');
      found = bytes.subarray(dataStart, dataStart + size);
    }
    offset = next;
  }
  if (!found) fail('WebP has no transport stream EXIF payload');
  return transportStream(found, limit);
}

function pngPayload(bytes, limit) {
  let offset = PNG_SIGNATURE.length;
  let header = null;
  let hadImageData = false;
  let imageEnd = -1;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) fail('truncated PNG chunk header');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const next = crcOffset + 4;
    if (next > bytes.length) fail('PNG chunk extends beyond its container');
    if (!/^[A-Za-z]{4}$/.test(type)) fail('invalid PNG chunk type');
    if (crc32(bytes.subarray(offset + 4, crcOffset)) !== bytes.readUInt32BE(crcOffset)) {
      fail('PNG chunk checksum does not match');
    }
    if (!header && type !== 'IHDR') fail('PNG must begin with IHDR');
    if (type === 'IHDR') {
      if (header || length !== 13) fail('invalid PNG IHDR');
      header = {
        width: bytes.readUInt32BE(dataStart), height: bytes.readUInt32BE(dataStart + 4),
        depth: bytes[dataStart + 8], color: bytes[dataStart + 9],
        compression: bytes[dataStart + 10], filter: bytes[dataStart + 11], interlace: bytes[dataStart + 12]
      };
      const imageBytes = header.width * header.height * 4;
      const budget = Math.min(IMAGE_LIMIT, Math.max(65536, limit * 4));
      if (!header.width || !header.height || !Number.isSafeInteger(imageBytes) || imageBytes > budget) {
        fail('decoded PNG image exceeds the size limit');
      }
    } else if (type === 'IDAT') {
      hadImageData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !hadImageData) fail('invalid PNG image end');
      imageEnd = next;
      break;
    } else if (type[0] === type[0].toUpperCase() && type !== 'PLTE') {
      fail('unsupported critical PNG chunk');
    }
    offset = next;
  }
  if (imageEnd === -1) fail('PNG image end is missing');
  if (imageEnd < bytes.length) return transportStream(bytes.subarray(imageEnd), limit);

  if (header.depth !== 8 || ![2, 6].includes(header.color) || header.compression !== 0 ||
      header.filter !== 0 || header.interlace !== 0) fail('unsupported PNG pixel layout');

  let image;
  try {
    // Decode only validated, bounded RGB/RGBA carriers; never execute player code.
    image = require('pngjs').PNG.sync.read(bytes, { checkCRC: true });
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') throw error;
    fail('PNG pixels could not be decoded');
  }
  const rgb = Buffer.allocUnsafe(header.width * header.height * 3);
  for (let from = 0, to = 0; from < image.data.length; from += 4) {
    rgb[to++] = image.data[from];
    rgb[to++] = image.data[from + 1];
    rgb[to++] = image.data[from + 2];
  }
  if (rgb.length < 12 || !rgb.subarray(0, 8).equals(PIXEL_MARKER)) fail('PNG has no recognized pixel payload');
  const size = rgb.readUInt32BE(8);
  if (size === 0 || size > rgb.length - 12) fail('PNG pixel payload length is invalid');
  return decompress(rgb.subarray(12, 12 + size), limit);
}

function unwrapSegment(input, options = {}) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new TypeError('Segment must be a Buffer or Uint8Array');
  const limit = options.maxOutputBytes ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < PACKET_BYTES || limit > IMAGE_LIMIT) {
    throw new RangeError('maxOutputBytes must be an integer between 188 and 67108864');
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.length || bytes.length > INPUT_LIMIT) fail('input is empty or exceeds the size limit');
  if (bytes[0] === 0x47) return transportStream(bytes, limit);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return pngPayload(bytes, limit);
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'RIFF') return webpPayload(bytes, limit);

  const rawOffset = bytes.indexOf(RAW_MARKER);
  if (rawOffset !== -1) return transportStream(bytes.subarray(rawOffset + RAW_MARKER.length), limit);
  const compressedOffset = bytes.indexOf(COMPRESSED_MARKER);
  if (compressedOffset !== -1) return decompress(bytes.subarray(compressedOffset + COMPRESSED_MARKER.length), limit);
  fail('unrecognized carrier signature');
}

module.exports = { unwrapSegment };
