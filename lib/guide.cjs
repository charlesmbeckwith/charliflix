'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const catalog = require('../config/channels.json');
const { version } = require('../package.json');
const { isPublicAddress } = require('./provider.cjs');

const GUIDE_URL = 'https://epgtalk.com/api/now/us.json';
const GUIDE_SOURCE = Object.freeze({ name: 'EPGTalk', url: 'https://epgtalk.com/api.html' });
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_CHANNELS = 2000;
const MAX_CHANNEL_PROGRAMMES = 512;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAPPINGS = Object.freeze({
  '339': Object.freeze({ name: 'Cartoon Network HD', number: '296' }),
  '310': Object.freeze({ name: 'Comedy Central East HD', number: '249' }),
  '317': Object.freeze({ name: 'FX East HD', number: '248' }),
  '298': Object.freeze({ name: 'FXX East HD', number: '259' }),
  '303': Object.freeze({ name: 'AMC East HD', number: '254' }),
});

class GuideError extends Error {
  constructor(reason) {
    super('The programme guide is unavailable.');
    this.name = 'GuideError';
    this.reason = reason;
  }
}

function plainText(value, maximum = 200) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function utcTime(value) {
  const match = typeof value === 'string' && value.length <= 40 &&
    value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) {
    throw new GuideError('invalid-response');
  }
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = match.slice(1).map(part => Number(part || 0));
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
      zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) {
    throw new GuideError('invalid-response');
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new GuideError('invalid-response');
  return parsed;
}

function emptyChannels(channels) {
  return channels.map(channel => {
    const mapping = MAPPINGS[channel.id];
    return mapping
      ? { id: channel.id, name: channel.name, status: 'empty', listingName: mapping.name,
        scheduleNote: 'U.S. Eastern reference schedule', programmes: [] }
      : { id: channel.id, name: channel.name, status: 'unmapped',
        scheduleNote: 'No verified affiliate schedule',
        reason: 'This feed does not identify an affiliate, so its schedule cannot be matched reliably.', programmes: [] };
  });
}

function parseGuide(data, channels) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.guide !== 'US' ||
      !Array.isArray(data.channels) || data.channels.length > MAX_SOURCE_CHANNELS) {
    throw new GuideError('invalid-response');
  }
  const from = utcTime(data.from);
  const until = utcTime(data.until);
  const updatedAt = utcTime(data.updated);
  if (until <= from || until - from > 3 * DAY_MS) throw new GuideError('invalid-response');

  const rows = emptyChannels(channels);
  for (const row of rows) {
    const mapping = MAPPINGS[row.id];
    if (!mapping) continue;
    const matches = data.channels.filter(channel => channel && channel.name === mapping.name &&
      String(channel.number) === mapping.number);
    // A missing or ambiguous station must not silently select another feed.
    if (matches.length !== 1) continue;
    const sourceProgrammes = matches[0].programmes;
    if (!Array.isArray(sourceProgrammes) || sourceProgrammes.length > MAX_CHANNEL_PROGRAMMES) {
      throw new GuideError('invalid-response');
    }
    const programmes = new Map();
    let invalid = 0;
    for (const item of sourceProgrammes) {
      const start = item?.start * 1000;
      const end = item?.stop * 1000;
      const title = plainText(item?.title);
      if (!Number.isSafeInteger(item?.start) || !Number.isSafeInteger(item?.stop) ||
          !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start ||
          end - start > DAY_MS || !title) {
        invalid++;
        continue;
      }
      if (end <= from || start >= until || programmes.has(start)) continue;
      const id = crypto.createHash('sha256').update(`${row.id}\n${start}\n${end}\n${title}`).digest('hex').slice(0, 24);
      const programme = { id, channelId: row.id, start, end, title };
      const subtitle = plainText(item.subtitle, 300);
      if (subtitle) programme.subtitle = subtitle;
      programmes.set(start, programme);
    }
    if (invalid && invalid === sourceProgrammes.length) throw new GuideError('invalid-response');
    row.programmes = [...programmes.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    row.status = row.programmes.length ? 'ready' : 'empty';
  }
  return { updatedAt, from, until, channels: rows };
}

async function readGuideJson(response) {
  const advertised = response.headers.get('content-length');
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new GuideError('invalid-response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GuideError('invalid-response');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new GuideError('invalid-response');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new GuideError('invalid-response'); }
}

class GuideService {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.resolveHost = options.resolveHost || (hostname => dns.lookup(hostname, { all: true, verbatim: true }));
    this.verifyDns = options.verifyDns !== false;
    this.now = options.now || Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheMs = options.cacheMs ?? 30 * 60 * 1000;
    this.retryMs = options.retryMs ?? 60_000;
    this.channels = (options.channels || catalog).filter(channel => channel.enabled !== false)
      .map(channel => ({ id: String(channel.id), name: plainText(channel.name) }));
    this.cache = null;
    this.pending = null;
    this.controller = null;
    this.retryAt = 0;
    this.lastFailure = null;
    this.closed = false;
  }

  snapshot() {
    const now = this.now();
    const covered = this.cache && this.cache.from <= now && this.cache.until > now;
    const status = covered ? (this.lastFailure ? 'stale' : 'ready') : 'unavailable';
    const result = {
      status,
      fetchedAt: this.cache?.fetchedAt ?? null,
      updatedAt: this.cache?.updatedAt ?? null,
      from: this.cache?.from ?? null,
      until: this.cache?.until ?? null,
      source: GUIDE_SOURCE,
      channels: covered ? this.cache.channels : emptyChannels(this.channels),
    };
    if (status !== 'ready') result.reason = this.closed ? 'closed' : this.lastFailure || 'expired';
    return structuredClone(result);
  }

  async check() {
    if (this.closed) return this.snapshot();
    const now = this.now();
    if (this.cache && this.cache.refreshAt > now && this.cache.from <= now && this.cache.until > now) return this.snapshot();
    if (this.pending) { await this.pending; return this.snapshot(); }
    if (this.retryAt > now) return this.snapshot();
    const load = this.refresh();
    this.pending = load;
    try { await load; return this.snapshot(); }
    finally { if (this.pending === load) this.pending = null; }
  }

  async refresh() {
    try {
      const data = await this.lookup();
      if (this.closed) return;
      const parsed = parseGuide(data, this.channels);
      const now = this.now();
      if (parsed.from > now || parsed.until <= now) throw new GuideError('expired');
      this.cache = { ...parsed, fetchedAt: now, refreshAt: now + this.cacheMs };
      this.lastFailure = null;
      this.retryAt = 0;
    } catch (error) {
      this.lastFailure = error instanceof GuideError ? error.reason : 'network';
      this.retryAt = this.now() + this.retryMs;
    }
  }

  async lookup() {
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      if (this.verifyDns) {
        const addresses = await Promise.race([
          this.resolveHost('epgtalk.com'),
          new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new GuideError(timedOut ? 'timeout' : 'closed')), { once: true })),
        ]);
        if (!addresses.length || addresses.some(entry => !isPublicAddress(typeof entry === 'string' ? entry : entry.address))) {
          throw new GuideError('blocked-source');
        }
      }
      if (controller.signal.aborted) throw new GuideError(timedOut ? 'timeout' : 'closed');
      const response = await this.fetchImpl(GUIDE_URL, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': `Charliflix/${version}` },
      });
      if (response.status !== 200 || (response.url && response.url !== GUIDE_URL)) {
        await response.body?.cancel();
        throw new GuideError(response.status === 403 || response.status === 429 ? 'rate-limit' : 'network');
      }
      return await readGuideJson(response);
    } catch (error) {
      if (timedOut) throw new GuideError('timeout');
      if (controller.signal.aborted) throw new GuideError('closed');
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }

  close() {
    this.closed = true;
    this.controller?.abort();
  }
}

module.exports = { GuideService, parseGuide, GUIDE_URL, GUIDE_SOURCE, MAX_RESPONSE_BYTES };
