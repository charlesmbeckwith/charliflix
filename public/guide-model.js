(function (root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.CharliflixGuideModel = model;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'charliflix:scheduled-tunes';
  const STORAGE_VERSION = 1;
  const MAX_ITEMS = 50;
  const MAX_TITLE = 200;
  const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
  const GRACE_MS = 5 * 60 * 1000;
  const copy = item => ({ ...item });
  const sort = items => items.sort((a, b) => a.start - b.start || a.channelId.localeCompare(b.channelId));

  // This model owns no timers or background service. The open player's UI calls
  // tick(), including after a visibility change or a wake from sleep.
  // Callers sharing storage must serialize add/cancel/toggle/tick/refresh with
  // the same cross-context lock (Web Locks in the UI). localStorage alone cannot
  // make a read-modify-write atomic across multiple browser tabs.
  function createScheduler(options = {}) {
    const channelIds = new Set(Array.from(options.channelIds || []).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 64));
    const storage = options.storage || null;
    const clock = typeof options.now === 'function' ? options.now : Date.now;
    let items = [];
    let ticking = false;

    function now() {
      const value = clock();
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('The scheduler requires a valid epoch time in milliseconds.');
      return value;
    }

    function normalize(event, time, restoring = false) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return { code: 'invalid-event' };
      const { channelId, start, end } = event;
      if (typeof channelId !== 'string' || !channelIds.has(channelId)) return { code: 'unknown-channel' };
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > HORIZON_MS) return { code: 'invalid-event' };
      if (start > time + HORIZON_MS || end > time + HORIZON_MS) return { code: 'too-far' };
      if (start < time - (restoring ? HORIZON_MS : 0)) return { code: 'past' };
      if (typeof event.title !== 'string') return { code: 'invalid-event' };
      const title = event.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
      if (!title) return { code: 'invalid-event' };
      const value = { channelId, start, end, title };
      if (typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 256) value.id = event.id;
      return { value };
    }

    function report(error, item) {
      try { if (typeof options.onError === 'function') options.onError(error, item && copy(item)); } catch { /* Callbacks cannot alter committed scheduling state. */ }
    }

    function notify(change) {
      try { if (typeof options.onChange === 'function') options.onChange(list(), change); } catch (error) { report(error); }
    }

    function save(next) {
      if (!storage) return true;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, items: next }));
        return true;
      } catch (error) { report(error); return false; }
    }

    // localStorage is untrusted: no executable values, arbitrary channel IDs,
    // unbounded input, unsupported versions or conflicting starts are restored.
    function readStored(time) {
      if (!storage) return { ok: true, items };
      let raw;
      try { raw = storage.getItem(STORAGE_KEY); }
      catch (error) { return { ok: false, code: 'storage', error }; }
      const restored = [];
      try {
        if (typeof raw === 'string' && raw.length <= 64 * 1024) {
          const decoded = JSON.parse(raw);
          if (decoded && decoded.version === STORAGE_VERSION && Array.isArray(decoded.items)) {
            const starts = new Set();
            for (const event of decoded.items.slice(0, MAX_ITEMS * 4)) {
              const normalized = normalize(event, time, true).value;
              if (!normalized || starts.has(normalized.start)) continue;
              starts.add(normalized.start);
              restored.push(normalized);
              if (restored.length === MAX_ITEMS) break;
            }
          }
        }
      } catch { /* An unreadable or corrupt store starts with an empty schedule. */ }
      return { ok: true, items: sort(restored) };
    }

    if (storage) {
      const initial = readStored(now());
      if (initial.ok) items = initial.items;
    }

    function list() { return items.map(copy); }
    function next() { return items.length ? copy(items[0]) : null; }
    function has(channelId, start) { return items.some(item => item.channelId === channelId && item.start === start); }

    function refresh() {
      const loaded = readStored(now());
      if (!loaded.ok) { report(loaded.error); return { ok: false, code: loaded.code }; }
      const changed = JSON.stringify(items) !== JSON.stringify(loaded.items);
      items = loaded.items;
      if (changed) notify({ reason: 'refresh' });
      return { ok: true, changed };
    }

    function add(event, settings = {}) {
      const synced = refresh();
      if (!synced.ok) return synced;
      const normalized = normalize(event, now());
      if (!normalized.value) return { ok: false, code: normalized.code };
      const item = normalized.value;
      const existing = items.find(other => other.start === item.start);
      if (existing?.channelId === item.channelId) return { ok: true, duplicate: true, item: copy(existing) };
      if (existing && settings.replace !== true) return { ok: false, code: 'conflict', conflict: copy(existing) };
      if (!existing && items.length >= MAX_ITEMS) return { ok: false, code: 'limit' };
      const updated = sort([...items.filter(other => other !== existing), item]);
      if (!save(updated)) return { ok: false, code: 'storage' };
      items = updated;
      notify({ reason: existing ? 'replace' : 'add', item: copy(item), ...(existing ? { replaced: copy(existing) } : {}) });
      return { ok: true, item: copy(item), ...(existing ? { replaced: copy(existing) } : {}) };
    }

    function cancel(channelId, start) {
      const synced = refresh();
      if (!synced.ok) return synced;
      const existing = items.find(item => item.channelId === channelId && item.start === start);
      if (!existing) return { ok: false, code: 'not-found' };
      const updated = items.filter(item => item !== existing);
      if (!save(updated)) return { ok: false, code: 'storage' };
      items = updated;
      notify({ reason: 'cancel', item: copy(existing) });
      return { ok: true, item: copy(existing) };
    }

    function toggle(event, settings = {}) {
      const synced = refresh();
      if (!synced.ok) return synced;
      if (event && has(event.channelId, event.start)) return cancel(event.channelId, event.start);
      return add(event, settings);
    }

    function tick() {
      if (ticking) return { ok: true, tuned: [], missed: [] };
      ticking = true;
      try {
        const synced = refresh();
        if (!synced.ok) return { ...synced, tuned: [], missed: [] };
        const time = now();
        const due = items.filter(item => item.start <= time);
        if (!due.length) return { ok: true, tuned: [], missed: [] };
        const eligible = due.filter(item => item.end > time && time - item.start <= GRACE_MS);
        const chosen = eligible.length ? eligible[eligible.length - 1] : null;
        const missed = due.filter(item => item !== chosen).map(item => ({ ...item, reason: item.end <= time ? 'ended' : time - item.start > GRACE_MS ? 'late' : 'superseded' }));
        const remaining = items.filter(item => item.start > time);
        // Commit removal before any callback. A failed tune, reentrant tick or
        // app restart must not repeatedly switch the viewer to the same show.
        if (!save(remaining)) return { ok: false, code: 'storage', tuned: [], missed: [] };
        items = remaining;
        const tuned = chosen ? [copy(chosen)] : [];
        if (chosen && typeof options.onTune === 'function') {
          try {
            const pending = options.onTune(copy(chosen));
            if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(error => report(error, chosen));
          } catch (error) { report(error, chosen); }
        }
        if (missed.length && typeof options.onMissed === 'function') {
          try { options.onMissed(missed.map(copy)); } catch (error) { report(error); }
        }
        notify({ reason: 'tick', tuned: tuned.map(copy), missed: missed.map(copy) });
        return { ok: true, tuned, missed };
      } finally { ticking = false; }
    }

    return Object.freeze({ list, next, has, add, cancel, toggle, tick, refresh });
  }

  return Object.freeze({ createScheduler, STORAGE_KEY, STORAGE_VERSION, MAX_ITEMS, MAX_TITLE, HORIZON_MS, GRACE_MS });
});
