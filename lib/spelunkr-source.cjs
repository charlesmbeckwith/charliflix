'use strict';

const crypto = require('node:crypto');

// Spelunkr publishes a rotation of archive recordings, not an HLS broadcast.
// We consume only its bounded JSON data; no remote JavaScript is evaluated.
const CHANNEL_ID = '1054';
const CHANNEL_SLUG = 'late-nite-swimclub';
const ORIGIN = 'https://spelunkr.tv';
const LINEUP_URL = `${ORIGIN}/broadcast/lineup.json`;
const SOURCE = Object.freeze({ name: 'Spelunkr · Late Nite Swimclub (54)', url: `${ORIGIN}/` });
const SCHEDULE_NOTE = 'Archive recordings from Spelunkr channel 54. Charliflix uses its own rotation; timing differs from Spelunkr.';
const MAX_ITEMS = 512;
const MAX_DURATION = 48 * 60 * 60;

function invalid() { throw new Error('The archive channel supplied an unsupported schedule.'); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function time(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000; }
function text(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function parseLineup(data, now) {
  if (!object(data) || data.engine !== 5 || !Array.isArray(data.channels) || data.channels.length > 256 || !time(now)) invalid();
  const matches = data.channels.filter(channel => channel?.id === CHANNEL_SLUG);
  if (matches.length !== 1 || matches[0].dial !== 54 || !Array.isArray(matches[0].versions) ||
      !matches[0].versions.length || matches[0].versions.length > 16) invalid();
  const versions = matches[0].versions;
  const seen = new Set();
  for (const version of versions) {
    if (!object(version) || !Number.isSafeInteger(version.v) || version.v < 1 || version.v > 999999 || seen.has(version.v) ||
        !time(version.epochMs) || !time(version.effectiveAtMs) || !Number.isSafeInteger(version.startIndex ?? 0) ||
        (version.startIndex ?? 0) < 0 || (version.startIndex ?? 0) >= MAX_ITEMS ||
        version.manifest !== `manifests/${CHANNEL_SLUG}/v${version.v}.json`) invalid();
    seen.add(version.v);
  }
  const active = versions.filter(version => version.effectiveAtMs <= now && version.epochMs <= now)
    .sort((a, b) => b.effectiveAtMs - a.effectiveAtMs || b.v - a.v)[0];
  if (!active) invalid();
  return { version: active.v, epochMs: active.epochMs, startIndex: active.startIndex ?? 0,
    manifestUrl: `${ORIGIN}/broadcast/${active.manifest}` };
}

function archiveUrl(identifier, filename) {
  if (typeof identifier !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(identifier) ||
      typeof filename !== 'string' || !filename || filename.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(filename) ||
      !/\.mp4$/i.test(filename)) invalid();
  const parts = filename.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) invalid();
  return `https://archive.org/download/${identifier}/${parts.map(encodeURIComponent).join('/')}`;
}

function parseManifest(data, selection) {
  if (!object(data) || data.engine !== 5 || data.channel !== CHANNEL_SLUG || data.version !== selection.version ||
      !Array.isArray(data.items) || !data.items.length || data.items.length > MAX_ITEMS || selection.startIndex >= data.items.length) invalid();
  const items = data.items.map(item => {
    if (!object(item) || !Number.isSafeInteger(item.duration) || item.duration < 1 || item.duration > MAX_DURATION ||
        !Number.isSafeInteger(item.inS ?? 0) || (item.inS ?? 0) < 0 || (item.inS ?? 0) > MAX_DURATION ||
        (item.outS !== undefined && (!Number.isSafeInteger(item.outS) || item.outS !== (item.inS ?? 0) + item.duration))) invalid();
    const title = text(item.title);
    if (!title) invalid();
    return { url: archiveUrl(item.id, item.file || item.mp4), title, inS: item.inS ?? 0, duration: item.duration };
  });
  return { ...selection, items };
}

function programmeAt(schedule, now) {
  if (!time(now) || now < schedule.epochMs || !Array.isArray(schedule.items) || !schedule.items.length) invalid();
  const durations = schedule.items.map(item => item.duration * 1000);
  const fullLength = durations.reduce((total, duration) => total + duration, 0);
  const firstLength = durations.slice(schedule.startIndex).reduce((total, duration) => total + duration, 0);
  const elapsed = now - schedule.epochMs;
  let index = schedule.startIndex;
  let start = schedule.epochMs;
  let offset = elapsed;
  if (elapsed >= firstLength) {
    const cycles = Math.floor((elapsed - firstLength) / fullLength);
    start += firstLength + cycles * fullLength;
    offset = (elapsed - firstLength) % fullLength;
    index = 0;
  }
  for (; index < schedule.items.length; index++) {
    if (offset < durations[index]) break;
    offset -= durations[index]; start += durations[index];
  }
  const item = schedule.items[index];
  const end = start + durations[index];
  return { item, index, start, end, offset: offset / 1000 };
}

function playbackAt(schedule, now) {
  const current = programmeAt(schedule, now);
  const next = programmeAt(schedule, current.end);
  return { type: 'file', url: current.item.url, startTime: current.item.inS + current.offset,
    trimStart: current.item.inS, trimEnd: current.item.inS + current.item.duration,
    startsAt: current.start, endsAt: current.end, serverTime: now,
    programTitle: current.item.title, nextProgramTitle: next.item.title,
    source: { ...SOURCE }, scheduleNote: SCHEDULE_NOTE };
}

function guideAt(schedule, now) {
  const first = programmeAt(schedule, now);
  const until = now + 24 * 60 * 60 * 1000;
  const programmes = [];
  let cursor = now;
  while (cursor < until && programmes.length < 128) {
    const current = programmeAt(schedule, cursor);
    const id = crypto.createHash('sha256').update(`${CHANNEL_ID}\n${current.start}\n${current.end}\n${current.item.title}`).digest('hex').slice(0, 24);
    programmes.push({ id, channelId: CHANNEL_ID, start: current.start, end: current.end, title: current.item.title });
    cursor = current.end;
  }
  return { status: 'ready', from: first.start, until: Math.min(until, cursor), fetchedAt: now, updatedAt: schedule.epochMs,
    source: { ...SOURCE }, channels: [{ id: CHANNEL_ID, name: 'Adult Swim Archive', status: 'ready',
      listingName: 'Spelunkr 54 archive rotation', scheduleNote: SCHEDULE_NOTE, source: { ...SOURCE }, programmes }] };
}

module.exports = { CHANNEL_ID, CHANNEL_SLUG, ORIGIN, LINEUP_URL, SOURCE, SCHEDULE_NOTE,
  parseLineup, parseManifest, archiveUrl, programmeAt, playbackAt, guideAt };
