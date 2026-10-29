'use strict';

const CDNLIVE_ORIGIN = 'https://cdnlivetv.tv';
const MAX_HTML = 2 * 1024 * 1024;
const MAX_PART = 4096;
const MAX_PARTS = 32;
const MAX_URL = 8192;
const CHANNELS = Object.freeze({ '51': 'ABC US', '52': 'CBS US', '53': 'NBC US', '54': 'FOX US' });
const CHANNEL_SOURCE_IDS = Object.freeze({
  '51': '6add40af2d4a99e07363cf6a', '52': '6add40af2d4a99e07363cf91',
  '53': '6add40af2d4a99e07363cff6', '54': '6add40af2d4a99e07363cfae',
});
const SOURCE_IDS = new Set(Object.values(CHANNEL_SOURCE_IDS));

function fail(message) { throw new Error(message); }
function isCdnLiveChannel(id) { return Object.hasOwn(CHANNELS, String(id)); }
function cdnLivePlayerUrl(id) {
  if (!isCdnLiveChannel(id)) fail('This channel has no verified public CDN Live TV entry.');
  const url = new URL('/api/v1/channels/player/', CDNLIVE_ORIGIN);
  url.searchParams.set('name', CHANNELS[String(id)]);
  url.searchParams.set('code', '');
  url.searchParams.set('user', 'cdnlivetv');
  url.searchParams.set('plan', 'free');
  return url.href;
}
function mediaUrl(value, edgeOrigin = CDNLIVE_ORIGIN) {
  if (typeof value !== 'string' || value.length > MAX_URL || /[\u0000-\u0020\u007f]/.test(value) || edgeOrigin !== CDNLIVE_ORIGIN) fail('The CDN Live TV address is outside its verified provider.');
  let url;
  try { url = new URL(value); } catch { fail('The CDN Live TV address is invalid.'); }
  if (url.origin !== CDNLIVE_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('The CDN Live TV address is outside its verified provider.');
  return url;
}
function assertCdnLiveMediaUrl(value, edgeOrigin = CDNLIVE_ORIGIN) {
  const url = mediaUrl(value, edgeOrigin);
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || !url.searchParams.get('token') || url.searchParams.get('token').length > 4096 || /[\u0000-\u0020\u007f]/.test(url.searchParams.get('token'))) fail('The CDN Live TV media request has an invalid configuration.');
  const playlist = url.pathname.match(/^\/secure\/api\/v1\/([a-f0-9]{24})\/playlist\.m3u8$/);
  const segment = url.pathname.match(/^\/stream-segment\/([a-f0-9]{24})$/);
  if (playlist) {
    if (!SOURCE_IDS.has(playlist[1]) || keys.length !== 1 || keys[0] !== 'token') fail('The CDN Live TV playlist is outside its verified routes.');
  } else if (!segment || !SOURCE_IDS.has(segment[1]) || keys.length !== 2 || !keys.includes('d') || !keys.includes('token') || !url.searchParams.get('d') || url.searchParams.get('d').length > 4096 || /[\u0000-\u0020\u007f]/.test(url.searchParams.get('d'))) {
    fail('The CDN Live TV media request is outside its verified routes.');
  }
  return url;
}
function decodePart(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PART || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('The CDN Live TV data envelope is invalid.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || bytes.some(byte => byte < 0x21 || byte > 0x7e)) fail('The CDN Live TV data envelope is invalid.');
  return bytes.toString('ascii');
}

function parseCdnLiveSource(html, channelId) {
  if (typeof html !== 'string' || html.length > MAX_HTML) fail('The CDN Live TV player page is too large.');
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const candidates = [];
  for (const block of clean.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const script = block[1];
    const decoders = [...script.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*s\s*\)\s*\{\s*s\s*=\s*s\.replace\(\s*\/-\/g\s*,\s*(["'])\+\2\s*\)\s*\.replace\(\s*\/_\/g\s*,\s*(["'])\/\3\s*\)/g)];
    if (!decoders.length) continue;
    if (decoders.length !== 1) fail('The CDN Live TV data decoder is ambiguous.');
    const literals = new Map();
    for (const match of script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])([A-Za-z0-9_-]{1,4096})\2\s*;/g)) {
      if (literals.has(match[1])) fail('The CDN Live TV data envelope is ambiguous.');
      literals.set(match[1], match[3]);
      if (literals.size > 128) fail('The CDN Live TV data envelope is too large.');
    }
    for (const decoder of decoders) {
      const name = decoder[1].replace(/[$]/g, '\\$&');
      const term = name + '\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)';
      const chain = term + '(?:\\s*\\+\\s*' + term + '){1,' + (MAX_PARTS - 1) + '}';
      const expression = new RegExp('\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*(' + chain + ')\\s*;', 'g');
      for (const match of script.matchAll(expression)) {
        const parts = [...match[1].matchAll(new RegExp(term, 'g'))].map(part => decodePart(literals.get(part[1])));
        const decoded = parts.join('');
        const url = assertCdnLiveMediaUrl(decoded);
        if (!url.pathname.endsWith('.m3u8')) fail('The CDN Live TV player did not return a playlist.');
        if (channelId !== undefined && (!isCdnLiveChannel(channelId) || !url.pathname.includes('/' + CHANNEL_SOURCE_IDS[String(channelId)] + '/'))) fail('The CDN Live TV source does not match the configured channel.');
        candidates.push(url.href);
      }
    }
  }
  if (candidates.length !== 1) fail('The CDN Live TV player did not expose one supported data envelope.');
  return candidates[0];
}

module.exports = { CDNLIVE_ORIGIN, CHANNELS, CHANNEL_SOURCE_IDS, isCdnLiveChannel, cdnLivePlayerUrl, parseCdnLiveSource, assertCdnLiveMediaUrl };
