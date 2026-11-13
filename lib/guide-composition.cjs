'use strict';

const { CHANNEL_ID, SOURCE, SCHEDULE_NOTE } = require('./spelunkr-source.cjs');

// Keep source failures independent: an archive outage cannot erase the normal
// EPG, and a failed EPG request cannot erase the archive's own verified rotation.
function mergeArchiveGuide(base, archiveGuide) {
  const result = structuredClone(base);
  const rows = Array.isArray(result.channels) ? result.channels : [];
  const archiveRow = archiveGuide?.channels?.find(row => row.id === CHANNEL_ID);
  const row = archiveRow ? structuredClone(archiveRow) : {
    id: CHANNEL_ID, name: 'Adult Swim Archive', status: 'unavailable', programmes: [],
    scheduleNote: SCHEDULE_NOTE, source: { ...SOURCE }, reason: 'The archive rotation could not be loaded. Try refreshing the guide.',
  };
  result.channels = rows.filter(item => item.id !== CHANNEL_ID);
  const originalIndex = rows.findIndex(item => item.id === CHANNEL_ID);
  result.channels.splice(originalIndex < 0 ? result.channels.length : originalIndex, 0, row);
  result.partial = result.status !== 'ready' || !archiveRow;
  if (archiveRow) {
    for (const key of ['from', 'until', 'fetchedAt', 'updatedAt']) {
      const value = archiveGuide[key];
      if (Number.isSafeInteger(value)) result[key] = Number.isSafeInteger(result[key])
        ? (key === 'from' ? Math.min(result[key], value) : Math.max(result[key], value)) : value;
    }
    if (result.status === 'unavailable') result.status = 'ready';
  }
  result.sources = [result.source, { ...SOURCE }].filter(Boolean);
  return result;
}

module.exports = { mergeArchiveGuide };
