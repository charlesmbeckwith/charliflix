'use strict';
const { UpdateChecker } = require('../lib/updates.cjs');

// Ad-hoc Mac builds can check automatically. Installation remains manual until
// a stable Developer ID identity and notarized distribution are configured.
function createUpdateNotifications(options) {
  const checker = options.checker || new UpdateChecker();
  const later = options.setTimeout || setTimeout;
  const repeat = options.setInterval || setInterval;
  const cancelLater = options.clearTimeout || clearTimeout;
  const cancelRepeat = options.clearInterval || clearInterval;
  let closed = false, pending, startup, interval;
  let state = { type: 'charliflix-updater', status: 'idle', installMode: 'manual' };
  const send = () => { if (!closed) options.send({ ...state }); };
  async function check(automatic = false) {
    if (closed) return;
    if (pending) return pending;
    state = { ...state, status: 'checking', automatic }; send();
    pending = (async () => {
      try {
        const result = await checker.check();
        if (closed) return;
        state = { type: 'charliflix-updater', status: result.status === 'available' ? 'available-manual' : result.status === 'unavailable' ? 'error' : result.status, installMode: 'manual', automatic, currentVersion: result.currentVersion };
        if (result.status === 'available') { state.latestVersion = result.latestVersion; state.releaseUrl = result.releaseUrl; }
        send();
      } catch { if (!closed) { state = { type: 'charliflix-updater', status: 'error', installMode: 'manual', automatic }; send(); } }
      finally { pending = null; }
    })();
    return pending;
  }
  return {
    start() {
      if (closed || startup !== undefined) return;
      startup = later(() => { void check(true); }, 10_000);
      interval = repeat(() => { void check(true); }, 4 * 60 * 60 * 1000);
      startup.unref?.(); interval.unref?.();
    },
    request(message) {
      if (closed || message?.type !== 'charliflix-updater') return;
      if (message.action === 'status') send();
      else if (message.action === 'check') return check(false);
    },
    close() { closed = true; cancelLater(startup); cancelRepeat(interval); checker.close(); },
  };
}
module.exports = { createUpdateNotifications };
