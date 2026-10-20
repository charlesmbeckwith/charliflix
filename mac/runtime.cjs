'use strict';

const { isReleasePageUrl } = require('../lib/updates.cjs');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8767;

function isExternalPageUrl(value) {
  return isReleasePageUrl(value) || value === 'https://epgtalk.com/api.html';
}

function isAppDocumentUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password &&
      (url.pathname === '/' || url.pathname === '/index.html') &&
      !url.search && !url.hash;
  } catch { return false; }
}

function isAppResourceUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password &&
      (url.protocol === 'http:' || url.protocol === 'blob:');
  } catch { return false; }
}

function allowsPermission(permission, requestingUrl, origin, isMainFrame) {
  // Ordinary, user-initiated video fullscreen is the only document permission.
  // Automatic fullscreen, capture, notifications, and device access stay denied.
  return permission === 'fullscreen' && isMainFrame !== false &&
    isAppDocumentUrl(requestingUrl, origin);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: HOST, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
    // A live request must not keep the app and its provider running after quit.
    server.closeAllConnections?.();
  });
}

async function startOwnedServer({ createServer, root, preferredPort = DEFAULT_PORT }) {
  if (typeof createServer !== 'function') throw new TypeError('A server factory is required.');
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
    throw new RangeError('The local player port is invalid.');
  }
  // Always own the server we display. An occupied port is never trusted or stopped.
  const server = createServer({ root, host: HOST });
  let usedFallbackPort = false;
  try {
    try { await listen(server, preferredPort); }
    catch (error) {
      if (preferredPort === 0 || error.code !== 'EADDRINUSE') throw error;
      usedFallbackPort = true;
      await listen(server, 0);
    }
  } catch (error) {
    await closeServer(server).catch(() => {});
    throw error;
  }
  const origin = `http://${HOST}:${server.address().port}`;
  let closing;
  return {
    server,
    origin,
    usedFallbackPort,
    close() {
      if (!closing) closing = closeServer(server);
      return closing;
    },
  };
}

module.exports = {
  HOST, DEFAULT_PORT, isAppDocumentUrl, isAppResourceUrl, isExternalPageUrl, allowsPermission, startOwnedServer,
};
