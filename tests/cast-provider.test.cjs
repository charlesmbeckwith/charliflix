'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelProvider } = require('../lib/provider.cjs');

const currentEmbed = 'https://tossequip.net/e/jme63v4qo6czg';
const castOrigin = 'https://edge.7odxv0l067ka.net:8443';

function playerFixture(source) {
  const encoded = Buffer.from(JSON.stringify({ stream_url: source })).toString('base64');
  const pieces = Array.from({ length: 4 }, (_, index) =>
    Buffer.from(encoded.slice(index * encoded.length / 4, (index + 1) * encoded.length / 4)).toString('base64'));
  const envelope = [2, 0, 3, 1].map(index => pieces[index].slice(0, 3) + 'X' + pieces[index].slice(3)).join('');
  return `window._econfig = '${Buffer.from(envelope).toString('base64')}';`;
}

test('an unconfigured alternate follows the current wrapper embed and uses its fixed media context', async t => {
  const source = `${castOrigin}/hls/example.m3u8?s=fixture&e=123`;
  const requests = [];
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (url === 'https://dlive.sx/cast/stream-339.php') return new Response(`<iframe src="${currentEmbed}"></iframe>`);
    if (url === currentEmbed) return new Response(playerFixture(source));
    if (url === source) return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
    throw new Error('Unexpected request');
  } });
  t.after(() => provider.close());

  const playlist = await provider.getPlaylist('339', 'cast');
  assert.match(playlist.body.toString(), /\/media\/[A-Za-z0-9_-]{32}/);
  assert.deepEqual(requests.map(item => item.url), ['https://dlive.sx/cast/stream-339.php', currentEmbed, source]);
  assert.deepEqual(requests.map(item => item.headers.Referer), ['https://dlive.sx/', 'https://dlive.sx/', 'https://tossequip.net/']);
  for (const { headers } of requests) assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Referer']);
});

test('a configured alternate rejects redirects outside its exact current embed', async t => {
  let requests = 0;
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async url => {
    requests++;
    assert.equal(url, 'https://tossequip.net/e/d2695mac448xt');
    return new Response('', { status: 302, headers: { location: 'https://tossequip.net/e/anotherembed123' } });
  } });
  t.after(() => provider.close());

  await assert.rejects(provider.sourceFor('310', false, 'cast'), error => error.code === 'BLOCKED_SOURCE');
  assert.equal(requests, 1);
});

test('the current alternate still rejects private media DNS before any media request', async t => {
  let mediaRequests = 0;
  const source = `${castOrigin}/hls/example.m3u8?s=fixture&e=123`;
  const provider = new ChannelProvider({
    resolveHost: async hostname => [{ address: hostname === 'tossequip.net' ? '8.8.8.8' : '127.0.0.1' }],
    fetchImpl: async url => {
      if (url === 'https://tossequip.net/e/d2695mac448xt') return new Response(playerFixture(source));
      mediaRequests++;
      throw new Error('Private media must not be requested');
    },
  });
  t.after(() => provider.close());

  await assert.rejects(provider.getPlaylist('310', 'cast'), error => error.code === 'BLOCKED_SOURCE');
  assert.equal(mediaRequests, 0);
});
