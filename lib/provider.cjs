'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const channels = require('../config/channels.json');
const { parseCastSource, CDN_HOST: CAST_CDN_HOST } = require('./cast-source.cjs');

const HTML_LIMIT = 2 * 1024 * 1024;
const PLAYLIST_LIMIT = 1024 * 1024;
const MEDIA_LIMIT = 16 * 1024 * 1024;
const SOURCE_ORIGIN = 'https://dembed.st';
const DEFAULT_FEED = 'stream';
const FEEDS = Object.freeze([
  Object.freeze({ id: 'stream', label: 'Player 1', enabled: true, detail: 'The main Dlive feed. Players 3 and 7 use this same source.' }),
  Object.freeze({ id: 'cast', label: 'Player 2', enabled: true, detail: 'An independent alternate feed. Availability can differ from Player 1.' }),
]);

class ProviderError extends Error {
  constructor(message, code = 'UPSTREAM_ERROR', status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

function parseHttpsUrl(value, allowCastPort = false) {
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('The stream supplied an invalid address.', 'INVALID_SOURCE'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443' && !(allowCastPort && url.port === '8443' && CAST_CDN_HOST.test(url.hostname)))) {
    throw new ProviderError('The stream address is outside the permitted provider.', 'BLOCKED_SOURCE');
  }
  url.hash = '';
  return url;
}

function isEdgeHost(host) {
  return /^edge[0-9-]*\.[a-z0-9-]+\.sbs$/i.test(host);
}

function assertAllowedMediaUrl(value, edgeOrigin, feedId = DEFAULT_FEED) {
  const url = parseHttpsUrl(value, feedId === 'cast');
  const matchesOrigin = url.origin === edgeOrigin;
  const matchesCarrier = feedId === DEFAULT_FEED && /^(?:[a-z0-9-]+\.)+tiktokcdn-us\.com$/i.test(url.hostname);
  if ((!matchesOrigin && !matchesCarrier) || (feedId === 'cast' && !CAST_CDN_HOST.test(url.hostname))) {
    throw new ProviderError('The playlist referenced an unrecognized media host.', 'BLOCKED_SOURCE');
  }
  return url;
}

function parseCastEmbedUrl(html) {
  const frames = [...html.matchAll(/<iframe\b[^>]*\s+src\s*=\s*(["'])(https:\/\/missflight\.net\/e\/[a-z0-9]{8,64})\1[^>]*>/gi)];
  if (frames.length !== 1) throw new ProviderError('The alternate feed player could not be found.', 'SOURCE_CHANGED');
  return frames[0][2];
}

// Only the literal string value is read. No provider script is run or evaluated.
function parseSourceUrl(html) {
  const match = html.match(/\bconst\s+SRC\s*=\s*(["'])([^"'\r\n]+)\1\s*;/);
  if (!match) throw new ProviderError('The provider changed its player page. The channel could not be resolved.', 'SOURCE_CHANGED');
  const url = parseHttpsUrl(match[2]);
  if (!isEdgeHost(url.hostname) || !url.pathname.endsWith('.m3u8')) {
    throw new ProviderError('The provider returned an unrecognized stream address.', 'BLOCKED_SOURCE');
  }
  return url.href;
}

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return /^[23]/.test(normalized) && !normalized.startsWith('2001:db8:');
  }
  return false;
}

async function readBounded(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new ProviderError('The provider response exceeded the size limit.', 'RESPONSE_TOO_LARGE');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ProviderError('The provider response exceeded the size limit.', 'RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function resourceKind(tag) {
  if (/^#EXT-X-(?:SESSION-)?KEY:/.test(tag)) return 'key';
  if (/^#EXT-X-MAP:/.test(tag) || (/^#EXT-X-PRELOAD-HINT:/.test(tag) && /\bTYPE=MAP\b/.test(tag))) return 'map';
  if (/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|RENDITION-REPORT):/.test(tag)) return 'playlist';
  return 'segment';
}

function rewritePlaylist(text, baseUrl, register) {
  if (!text.replace(/^\uFEFF/, '').startsWith('#EXTM3U')) {
    throw new ProviderError('The channel did not return an HLS playlist.', 'INVALID_PLAYLIST');
  }
  let variantNext = false;
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      variantNext = /^#EXT-X-STREAM-INF:/.test(trimmed) || variantNext;
      return line.replace(/\bURI\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/g, (_all, double, single, bare) => {
        const remote = new URL(double ?? single ?? bare, baseUrl);
        return `URI="${register(remote.href, resourceKind(trimmed))}"`;
      });
    }
    const remote = new URL(trimmed, baseUrl);
    const kind = variantNext || /\.m3u8(?:$|[?#])/i.test(remote.href) ? 'playlist' : 'segment';
    variantNext = false;
    return register(remote.href, kind);
  }).join('\n');
}

class ChannelProvider {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.resolveHost = options.resolveHost || (hostname => dns.lookup(hostname, { all: true, verbatim: true }));
    this.verifyDns = options.verifyDns !== false;
    this.now = options.now || Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sourceTtlMs = options.sourceTtlMs ?? 5 * 60_000;
    this.tokenTtlMs = options.tokenTtlMs ?? 10 * 60_000;
    this.maxResources = options.maxResources ?? 4096;
    this.maxCacheBytes = options.maxCacheBytes ?? 32 * 1024 * 1024;
    this.sourceCache = new Map();
    this.sourceLoads = new Map();
    this.resources = new Map();
    this.resourceKeys = new Map();
    this.byteCache = new Map();
    this.cachedBytes = 0;
    this.pending = new Map();
    this.controllers = new Set();
  }

  listChannels() {
    return channels.map(({ castEmbedId: _privateEmbedId, ...channel }) => ({ ...channel, defaultFeed: DEFAULT_FEED, feeds: FEEDS.map(feed => ({ ...feed })) }));
  }

  channel(id) {
    const found = channels.find(channel => channel.id === String(id) && channel.enabled);
    if (!found) throw new ProviderError('That channel is not configured.', 'UNKNOWN_CHANNEL', 404);
    return found;
  }

  feed(id, feedId = DEFAULT_FEED) {
    this.channel(id);
    const found = FEEDS.find(feed => feed.id === feedId);
    if (!found) throw new ProviderError('That feed is not configured for this channel.', 'UNKNOWN_FEED', 404);
    if (!found.enabled) throw new ProviderError(found.reason, 'UNSUPPORTED_FEED', 503);
    return found;
  }

  async request(url, maximum, allow, profile = 'default') {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const allowCastPort = profile === 'cast-media';
      const referer = profile === 'cast-page' ? 'https://dlive.sx/' : profile === 'cast-media' ? 'https://missflight.net/' : undefined;
      let current = parseHttpsUrl(url, allowCastPort);
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        allow(current);
        if (this.verifyDns) {
          const addresses = await Promise.race([
            this.resolveHost(current.hostname),
            new Promise((_resolve, reject) => {
              if (controller.signal.aborted) reject(new Error('Request timeout'));
              else controller.signal.addEventListener('abort', () => reject(new Error('Request timeout')), { once: true });
            }),
          ]);
          if (!addresses.length || addresses.some(entry => !isPublicAddress(typeof entry === 'string' ? entry : entry.address))) {
            throw new ProviderError('The stream address resolved outside the public Internet.', 'BLOCKED_SOURCE');
          }
        }
        if (controller.signal.aborted) throw new ProviderError('The channel provider took too long to respond.', 'UPSTREAM_TIMEOUT', 504);
        const response = await this.fetchImpl(current.href, {
          redirect: 'manual', signal: controller.signal,
          headers: { Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
          // Only adapter-fixed public embed context is sent. No user or page-supplied headers, cookies, or credentials are forwarded.
        });
        if (response.status >= 300 && response.status < 400) {
          const destination = response.headers.get('location');
          await response.body?.cancel();
          if (!destination || redirects === 3) throw new ProviderError('The provider redirected too many times.', 'UPSTREAM_REDIRECT');
          current = parseHttpsUrl(new URL(destination, current).href, allowCastPort);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          const error = new ProviderError(`The channel provider returned HTTP ${response.status}. Try the channel again.`, 'UPSTREAM_UNAVAILABLE');
          error.upstreamStatus = response.status;
          throw error;
        }
        return { body: await readBounded(response, maximum), contentType: response.headers.get('content-type') || '', url: current.href };
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) throw new ProviderError('The channel provider took too long to respond.', 'UPSTREAM_TIMEOUT', 504);
      throw new ProviderError('The channel provider could not be reached. Check the connection and try again.', 'UPSTREAM_NETWORK');
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  async sourceFor(id, refresh = false, feedId = DEFAULT_FEED) {
    id = String(id);
    this.feed(id, feedId);
    const sourceKey = `${id}\n${feedId}`;
    const cached = this.sourceCache.get(sourceKey);
    if (!refresh && cached && cached.expires > this.now()) return cached.url;
    if (this.sourceLoads.has(sourceKey)) return this.sourceLoads.get(sourceKey);
    const load = (async () => {
      let source;
      if (feedId === 'cast') {
        const configured = this.channel(id).castEmbedId;
        let embed;
        if (configured !== undefined) {
          if (!/^[a-z0-9]{8,64}$/i.test(configured)) throw new ProviderError('The alternate feed configuration is invalid.', 'INVALID_SOURCE');
          embed = `https://missflight.net/e/${configured}`;
        } else {
          const wrapper = await this.request(`https://dlive.sx/cast/stream-${id}.php`, HTML_LIMIT, url => {
            if (url.origin !== 'https://dlive.sx' || url.pathname !== `/cast/stream-${id}.php` || url.search) {
              throw new ProviderError('The alternate feed redirected outside its player page.', 'BLOCKED_SOURCE');
            }
          }, 'cast-page');
          embed = parseCastEmbedUrl(wrapper.body.toString('utf8'));
        }
        const result = await this.request(embed, HTML_LIMIT, url => {
          if (url.href !== embed) throw new ProviderError('The alternate player redirected outside its configured embed.', 'BLOCKED_SOURCE');
        }, 'cast-page');
        try { source = parseCastSource(result.body.toString('utf8')); }
        catch (error) { throw new ProviderError(error.message, 'SOURCE_CHANGED'); }
      } else {
        const result = await this.request(`${SOURCE_ORIGIN}/premiumtv/daddy.php?id=${id}`, HTML_LIMIT, url => {
          if (url.origin !== SOURCE_ORIGIN || url.pathname !== '/premiumtv/daddy.php' || url.searchParams.get('id') !== id) {
            throw new ProviderError('The provider redirected outside its player page.', 'BLOCKED_SOURCE');
          }
        });
        source = parseSourceUrl(result.body.toString('utf8'));
      }
      this.sourceCache.set(sourceKey, { url: source, expires: this.now() + this.sourceTtlMs });
      return source;
    })();
    this.sourceLoads.set(sourceKey, load);
    try { return await load; } finally { this.sourceLoads.delete(sourceKey); }
  }

  close() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  removeResource(token) {
    const resource = this.resources.get(token);
    if (!resource) return;
    this.resources.delete(token);
    this.resourceKeys.delete(resource.key);
    const cached = this.byteCache.get(token);
    if (cached) { this.cachedBytes -= cached.body.length; this.byteCache.delete(token); }
  }

  prune() {
    const now = this.now();
    for (const [token, entry] of this.resources) if (entry.expires <= now) this.removeResource(token);
    for (const [token, entry] of this.byteCache) {
      if (entry.expires <= now) { this.cachedBytes -= entry.body.length; this.byteCache.delete(token); }
    }
    while (this.resources.size > this.maxResources) this.removeResource(this.resources.keys().next().value);
    while (this.cachedBytes > this.maxCacheBytes && this.byteCache.size) {
      const [token, entry] = this.byteCache.entries().next().value;
      this.cachedBytes -= entry.body.length;
      this.byteCache.delete(token);
    }
  }

  register(url, kind, edgeOrigin, channelId, feedId = DEFAULT_FEED) {
    const remote = assertAllowedMediaUrl(url, edgeOrigin, feedId);
    const key = `${channelId}\n${feedId}\n${kind}\n${remote.href}\n${edgeOrigin}`;
    const existing = this.resourceKeys.get(key);
    const token = existing && this.resources.has(existing) ? existing : crypto.randomBytes(24).toString('base64url');
    this.resources.delete(token);
    this.resources.set(token, { key, url: remote.href, kind, edgeOrigin, channelId, feedId, expires: this.now() + this.tokenTtlMs });
    this.resourceKeys.set(key, token);
    this.prune();
    return `/media/${token}`;
  }

  rewrite(body, baseUrl, edgeOrigin, channelId, feedId = DEFAULT_FEED) {
    return rewritePlaylist(body.toString('utf8'), baseUrl, (url, kind) => this.register(url, kind, edgeOrigin, channelId, feedId));
  }

  async getPlaylist(id, feedId = DEFAULT_FEED) {
    id = String(id);
    this.feed(id, feedId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const source = await this.sourceFor(id, attempt > 0, feedId);
      const edgeOrigin = new URL(source).origin;
      try {
        const response = await this.request(source, PLAYLIST_LIMIT, url => assertAllowedMediaUrl(url.href, edgeOrigin, feedId), feedId === 'cast' ? 'cast-media' : 'default');
        return { body: Buffer.from(this.rewrite(response.body, response.url, edgeOrigin, id, feedId)), contentType: 'application/vnd.apple.mpegurl' };
      } catch (error) {
        // A short-lived source URL may have expired before its cache entry.
        if (attempt > 0 || ![401, 403, 404, 410].includes(error.upstreamStatus)) throw error;
        this.sourceCache.delete(`${id}\n${feedId}`);
      }
    }
  }

  async getMedia(token) {
    this.prune();
    const entry = this.resources.get(token);
    if (!entry) throw new ProviderError('This stream link expired. Select the channel again.', 'EXPIRED_RESOURCE', 410);
    const cached = this.byteCache.get(token);
    if (cached && cached.expires > this.now()) return cached;
    if (this.pending.has(token)) return this.pending.get(token);
    const load = (async () => {
      const result = await this.request(entry.url, entry.kind === 'playlist' ? PLAYLIST_LIMIT : MEDIA_LIMIT,
        url => assertAllowedMediaUrl(url.href, entry.edgeOrigin, entry.feedId), entry.feedId === 'cast' ? 'cast-media' : 'default');
      const looksLikePlaylist = result.body.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').startsWith('#EXTM3U');
      if (entry.kind === 'playlist' || looksLikePlaylist) {
        if (result.body.length > PLAYLIST_LIMIT) throw new ProviderError('The playlist exceeded the size limit.', 'RESPONSE_TOO_LARGE');
        return { body: Buffer.from(this.rewrite(result.body, result.url, entry.edgeOrigin, entry.channelId, entry.feedId)), contentType: 'application/vnd.apple.mpegurl' };
      }
      let body = result.body;
      let contentType = 'application/octet-stream';
      if (entry.kind === 'segment') {
        const { unwrapSegment } = require('./unwrap.cjs');
        try { body = unwrapSegment(body); }
        catch { throw new ProviderError('The provider returned an unsupported video segment. Try the channel again.', 'INVALID_SEGMENT'); }
        contentType = body.length > 0 && body[0] === 0x47 ? 'video/mp2t' : 'video/mp4';
      }
      const output = { body, contentType, expires: this.now() + 30_000 };
      if (this.resources.has(token) && body.length <= this.maxCacheBytes) {
        const previous = this.byteCache.get(token);
        if (previous) this.cachedBytes -= previous.body.length;
        this.byteCache.set(token, output);
        this.cachedBytes += body.length;
        this.prune();
      }
      return output;
    })();
    this.pending.set(token, load);
    try { return await load; } finally { this.pending.delete(token); }
  }
}

module.exports = { ChannelProvider, ProviderError, parseSourceUrl, parseCastEmbedUrl, rewritePlaylist, assertAllowedMediaUrl, isPublicAddress, readBounded, channels, HTML_LIMIT, PLAYLIST_LIMIT, MEDIA_LIMIT };
