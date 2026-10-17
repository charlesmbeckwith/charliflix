'use strict';

const { version } = require('../package.json');

const REPOSITORY = 'charlesmbeckwith/charliflix';
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const LATEST_RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases/latest`;
const MAX_RESPONSE_BYTES = 256 * 1024;

function stableVersion(value) {
  return typeof value === 'string' && value.length <= 64 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) ? value : null;
}

function compareVersions(left, right) {
  if (!stableVersion(left) || !stableVersion(right)) throw new TypeError('Expected stable semantic versions.');
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < a.length; index++) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function isReleasePageUrl(value) {
  if (typeof value !== 'string') return false;
  if (value === LATEST_RELEASE_PAGE) return true;
  const prefix = `https://github.com/${REPOSITORY}/releases/tag/v`;
  return value.startsWith(prefix) && stableVersion(value.slice(prefix.length)) !== null;
}

function versionMetadata() {
  return { version, repository: REPOSITORY, latestReleasePage: LATEST_RELEASE_PAGE };
}

async function readReleaseJson(response) {
  const advertised = response.headers.get('content-length');
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error('Release metadata exceeded its size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Release metadata was empty.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('Release metadata exceeded its size limit.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

class UpdateChecker {
  constructor(options = {}) {
    this.currentVersion = options.currentVersion || version;
    if (!stableVersion(this.currentVersion)) throw new TypeError('The application version must be a stable semantic version.');
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || Date.now;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.cacheMs = options.cacheMs ?? 5 * 60 * 1000;
    this.cache = null;
    this.pending = null;
    this.controller = null;
  }

  async check() {
    if (this.cache && this.cache.expires > this.now()) return { ...this.cache.result };
    if (this.pending) return { ...await this.pending };
    this.pending = this.lookup();
    try {
      const result = await this.pending;
      this.cache = { result, expires: this.now() + (result.status === 'unavailable' ? Math.min(this.cacheMs, 30_000) : this.cacheMs) };
      return { ...result };
    } finally {
      this.pending = null;
    }
  }

  async lookup() {
    const base = { currentVersion: this.currentVersion };
    const unavailable = reason => ({ ...base, status: 'unavailable', reason });
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(RELEASE_API, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `Charliflix/${this.currentVersion}` },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 404) return { ...base, status: 'no-release' };
        if (response.status === 403 || response.status === 429) return unavailable('rate-limit');
        return unavailable('network');
      }
      let release;
      try { release = await readReleaseJson(response); }
      catch (error) { if (controller.signal.aborted) throw error; return unavailable('invalid-response'); }
      const latestVersion = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? stableVersion(release.tag_name.slice(1)) : null;
      const releaseUrl = latestVersion ? `https://github.com/${REPOSITORY}/releases/tag/v${latestVersion}` : null;
      if (!latestVersion || release.draft !== false || release.prerelease !== false || release.html_url !== releaseUrl || !isReleasePageUrl(release.html_url)) {
        return unavailable('invalid-response');
      }
      return { ...base, status: compareVersions(latestVersion, this.currentVersion) > 0 ? 'available' : 'current', latestVersion, releaseUrl };
    } catch {
      return unavailable(timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }

  close() { this.controller?.abort(); }
}

module.exports = { UpdateChecker, versionMetadata, isReleasePageUrl, compareVersions };
