'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelProvider } = require('../lib/provider.cjs');

test('an authorized edge rejection clears source resolution so the next tune can follow a relocated feed', async t => {
  const oldEdge = 'https://edge.old.sbs';
  const newEdge = 'https://edge.new.sbs';
  let relocated = false;
  let pages = 0;
  const requests = [];
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async value => {
    const url = new URL(value);
    requests.push(url);
    if (url.hostname === 'dembed.st') {
      pages++;
      const edge = relocated ? newEdge : oldEdge;
      return new Response(`const SRC = '${edge}/premium339/index.m3u8';
        const CHANNEL = 'premium339'; const EDGE = '${edge}';
        fetch(EDGE + '/api/playlist-token?slug=' + encodeURIComponent(CHANNEL));`);
    }
    if (relocated && url.origin === oldEdge) return new Response('unavailable', { status: 403 });
    if (url.pathname === '/api/playlist-token') return Response.json({ token: 'fixture-token', ttl: 120 });
    return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
  } });
  t.after(() => provider.close());

  await provider.getPlaylist('339');
  relocated = true;
  await assert.rejects(provider.getPlaylist('339'), error => error.upstreamStatus === 403);
  assert.equal(pages, 1, 'the failed tune does not multiply token recovery with source reloads');
  assert.equal(requests.filter(url => url.origin === oldEdge && url.pathname === '/api/playlist-token').length, 2);
  assert.equal(requests.filter(url => url.origin === oldEdge && url.pathname.endsWith('.m3u8')).length, 2);
  assert.equal(provider.sourceCache.has('339\nstream'), false, 'a rejected edge must not remain cached for five minutes');

  const recovered = await provider.getPlaylist('339');
  assert.equal(pages, 2);
  assert.equal(provider.sourceCache.get('339\nstream').url, `${newEdge}/premium339/index.m3u8`);
  assert.equal(requests.filter(url => url.origin === newEdge && url.pathname === '/api/playlist-token').length, 1);
  assert.equal(requests.filter(url => url.origin === newEdge && url.pathname.endsWith('.m3u8')).length, 1);
  assert.match(recovered.body.toString(), /\/media\/[A-Za-z0-9_-]{32}/);
});
