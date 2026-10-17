'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCastSource } = require('../lib/cast-source.cjs');

const source = 'https://node.7odxv0l067ka.net:8443/hls/channel.m3u8?s=signed&e=9999999999';
function page(config) {
  let json = JSON.stringify(config);
  while (Buffer.from(json).toString('base64').length % 16) json += ' ';
  const encoded = Buffer.from(json).toString('base64');
  const size = encoded.length / 4;
  const parts = [2, 0, 3, 1].map(index => {
    const part = Buffer.from(encoded.slice(index * size, (index + 1) * size)).toString('base64');
    return part.slice(0, 3) + 'X' + part.slice(3);
  });
  return `<script id="config">window._econfig='${Buffer.from(parts.join('')).toString('base64')}'</script>`;
}

test('decodes only the literal data envelope and chooses the direct HTTP stream', () => {
  assert.equal(parseCastSource(page({ stream_url: 'https://unrelated.example/p2p', stream_url_nop2p: source, pops: ['ignore'], hframes: ['ignore'] })), source);
  assert.equal(parseCastSource(page({ stream_url: source })), source);
  assert.equal(parseCastSource(page({ stream_url_nop2p: source.replace(':8443', '') })), source.replace(':8443', ''));
});

test('rejects malformed, oversized, duplicate or executable configuration without evaluating scripts', () => {
  for (const html of ['', '<script>window._econfig=makeConfig()</script>', page({ stream_url: source }) + page({ stream_url: source }), '<script>window._econfig="AAAA"</script>', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => parseCastSource(html));
  }
  assert.throws(() => parseCastSource('<script>window._econfig="' + 'A'.repeat(400000) + '"</script>'), /invalid configuration/);
});

test('rejects alternate configuration URLs outside the exact observed CDN, protocol, ports and source path', () => {
  for (const url of [
    'https://127.0.0.1:8443/hls/channel.m3u8',
    'http://node.7odxv0l067ka.net:8443/hls/channel.m3u8',
    'https://node.7odxv0l067ka.net.attacker.example:8443/hls/channel.m3u8',
    'https://node.7odxv0l067ka.net:8444/hls/channel.m3u8',
    'https://user:pass@node.7odxv0l067ka.net:8443/hls/channel.m3u8',
    'https://node.7odxv0l067ka.net:8443/private/config',
    source + '#fragment',
  ]) assert.throws(() => parseCastSource(page({ stream_url_nop2p: url })), /outside the permitted provider/);
  assert.throws(() => parseCastSource(page({ stream_url: {} })), /no stream address/);
});
