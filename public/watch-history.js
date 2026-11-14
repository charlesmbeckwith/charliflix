(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    let storage;
    try { storage = root.localStorage; } catch { /* Report unavailable when saving. */ }
    const store = api.createStore({ storage });
    root.CharliflixHistory = store;
    root.addEventListener('storage', event => { if (event.key === api.STORAGE_KEY || event.key === null) store.refresh(); });
    root.addEventListener('pagehide', () => store.flush());
  }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const STORAGE_KEY = 'charliflix:watch-history:v1';
  const MAX_ITEMS = 2000, MAX_BYTES = 2 * 1024 * 1024, UNITS = 1000000;
  const text = (value, maximum) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
  const normalize = value => value.normalize('NFKC').toLowerCase();

  function metadata(programme) {
    if (!programme || typeof programme !== 'object' || Array.isArray(programme)) return null;
    const title = text(programme.title, 200), subtitle = text(programme.subtitle, 300);
    let episode = text(programme.episode, 30).toUpperCase();
    const match = episode.match(/^S(\d{1,3})E(\d{1,4})(?:-E?(\d{1,4}))?$/);
    if (match) episode = `S${Number(match[1])}E${Number(match[2])}${match[3] ? `-E${Number(match[3])}` : ''}`;
    else if (Number.isInteger(programme.seasonNumber) && programme.seasonNumber >= 0 && programme.seasonNumber <= 999 && Number.isInteger(programme.episodeNumber) && programme.episodeNumber >= 0 && programme.episodeNumber <= 9999) episode = `S${programme.seasonNumber}E${programme.episodeNumber}`;
    else episode = '';
    if (!title || (!episode && (!subtitle || normalize(subtitle) === normalize(title)))) return null;
    return { title, ...(subtitle ? { subtitle } : {}), ...(episode ? { episode } : {}) };
  }
  function episodeKey(programme) {
    const item = metadata(programme);
    return item ? JSON.stringify([normalize(item.title), item.episode ? `episode:${item.episode}` : `title:${normalize(item.subtitle)}`]) : null;
  }
  function mergeRanges(ranges) {
    const sorted = ranges.filter(range => Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) && range[0] >= 0 && range[1] <= UNITS && range[1] > range[0]).sort((a, b) => a[0] - b[0]);
    const result = [];
    for (const range of sorted) {
      const last = result.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else result.push([...range]);
    }
    return result.slice(0, 128);
  }
  const covered = ranges => ranges.reduce((sum, [start, end]) => sum + end - start, 0);

  function createStore(options = {}) {
    const storage = options.storage, now = options.now || Date.now;
    const listeners = new Set();
    let items = new Map(), dirty = false, lastSavedAt = now();
    const clone = item => ({ ...item, coverage: item.coverage.map(range => [...range]) });
    function notify() { for (const listener of listeners) { try { listener(); } catch { /* UI callbacks cannot prevent saving. */ } } }
    function read() {
      const result = new Map();
      if (!storage) return result;
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw || raw.length > MAX_BYTES) return result;
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || !Array.isArray(data.items)) return result;
      for (const value of data.items.slice(0, MAX_ITEMS)) {
        const info = metadata(value), key = episodeKey(value);
        if (!info || !key || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || !Array.isArray(value.coverage) || value.coverage.length > 128) continue;
        const coverage = mergeRanges(value.coverage);
        const watchedAt = Number.isSafeInteger(value.watchedAt) && value.watchedAt >= 0 ? value.watchedAt : null;
        result.set(key, { ...info, coverage, watchedAt, updatedAt: value.updatedAt });
      }
      return result;
    }
    try { items = read(); } catch { /* A damaged or unavailable store starts empty. */ }
    function save(next = items) {
      if (!storage) return { ok: false, code: 'storage' };
      const entries = [...next].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_ITEMS);
      const serialized = JSON.stringify({ version: 1, items: entries.map(([, value]) => value) });
      if (serialized.length > MAX_BYTES) return { ok: false, code: 'limit' };
      try { storage.setItem(STORAGE_KEY, serialized); }
      catch { return { ok: false, code: 'storage' }; }
      items = new Map(entries); dirty = false; lastSavedAt = now();
      return { ok: true };
    }
    function isWatched(programme) { return items.get(episodeKey(programme))?.watchedAt != null; }
    function setWatched(programme, watched = true) {
      const info = metadata(programme), key = episodeKey(programme);
      if (!key) return { ok: false, code: 'episode-unidentified' };
      const next = new Map(items);
      if (watched) next.set(key, { ...info, coverage: [[0, UNITS]], updatedAt: now(), watchedAt: now() });
      else next.delete(key);
      const result = save(next);
      if (result.ok) notify();
      return result;
    }
    function recordCoverage(programme, from, to) {
      const key = episodeKey(programme), duration = programme?.end - programme?.start;
      if (!key || !Number.isSafeInteger(programme.start) || !Number.isSafeInteger(programme.end) || duration <= 0 || duration > 86400000 || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 5000) return { ok: false, code: 'invalid-progress' };
      if (isWatched(programme)) return { ok: true, watched: true };
      const start = Math.max(programme.start, from), end = Math.min(programme.end, to);
      if (end <= start) return { ok: true, watched: false };
      const coverage = mergeRanges([...(items.get(key)?.coverage || []), [Math.round((start - programme.start) / duration * UNITS), Math.round((end - programme.start) / duration * UNITS)]]);
      const item = { ...metadata(programme), coverage, updatedAt: now(), watchedAt: null };
      const next = new Map(items); next.set(key, item);
      if (covered(coverage) >= UNITS * 0.8) {
        item.watchedAt = now();
        const result = save(next);
        if (result.ok) notify();
        return { ...result, watched: result.ok };
      }
      items = next; dirty = true;
      return now() - lastSavedAt >= 15000 ? save() : { ok: true, watched: false };
    }
    function flush() { return dirty ? save() : { ok: true }; }
    function refresh() {
      try { items = read(); dirty = false; notify(); return { ok: true }; }
      catch { return { ok: false, code: 'storage' }; }
    }
    function clear() { const result = save(new Map()); if (result.ok) notify(); return result; }
    return {
      episodeKey, canTrack: programme => Boolean(episodeKey(programme)), isWatched, setWatched, recordCoverage, flush, refresh, clear,
      getEntries: () => [...items.values()].filter(item => item.watchedAt != null).sort((a, b) => b.watchedAt - a.watchedAt).map(clone),
      subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    };
  }
  return { STORAGE_KEY, createStore, episodeKey };
});
