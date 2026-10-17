'use strict';

const MAX_CONFIG = 384 * 1024;
const CDN_HOST = /^(?:[a-z0-9-]+\.)+7odxv0l067ka\.net$/i;

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > MAX_CONFIG || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('The alternate feed supplied an invalid configuration.');
  }
  return Buffer.from(value, 'base64').toString('latin1');
}

function parseCastSource(html) {
  if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) throw new Error('The alternate player page is too large.');
  const matches = [...html.matchAll(/\bwindow\._econfig\s*=\s*(['"])([A-Za-z0-9+/=]+)\1\s*(?:;|<\/script\s*>)/gi)];
  if (matches.length !== 1) throw new Error('The alternate player configuration is unavailable.');
  // Decode only the observed data envelope. No provider JavaScript is evaluated.
  const envelope = decodeBase64(matches[0][2]);
  if (envelope.length % 4 !== 0 || envelope.length < 32) throw new Error('The alternate feed configuration changed.');
  const size = envelope.length / 4;
  const parts = [];
  const order = [2, 0, 3, 1];
  for (let index = 0; index < 4; index++) {
    const piece = envelope.slice(index * size, (index + 1) * size);
    parts[order[index]] = decodeBase64(piece.slice(0, 3) + piece.slice(4));
  }
  let config;
  try { config = JSON.parse(decodeBase64(parts.join(''))); }
  catch { throw new Error('The alternate feed supplied an invalid configuration.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('The alternate feed supplied an invalid configuration.');
  const value = config.stream_url_nop2p || config.stream_url;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('The alternate feed has no stream address.');
  let url;
  try { url = new URL(value); } catch { throw new Error('The alternate feed supplied an invalid stream address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !CDN_HOST.test(url.hostname) ||
      !['', '443', '8443'].includes(url.port) || !/^\/hls\/[a-z0-9_-]+\.m3u8$/i.test(url.pathname) || url.hash) {
    throw new Error('The alternate feed stream address is outside the permitted provider.');
  }
  return url.href;
}

module.exports = { parseCastSource, CDN_HOST };
