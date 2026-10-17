'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ChannelProvider, ProviderError } = require('./lib/provider.cjs');
const { UpdateChecker, versionMetadata } = require('./lib/updates.cjs');
const { version } = require('./package.json');

const STATIC_FILES = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/node_modules/hls.js/dist/hls.min.js', ['node_modules/hls.js/dist/hls.min.js', 'text/javascript; charset=utf-8']],
]);

function createServer(options = {}) {
  const provider = options.provider || new ChannelProvider();
  const updates = options.updates || new UpdateChecker();
  const root = path.resolve(options.root || __dirname);
  const allowedHost = options.host || process.env.CHANNEL_ROOM_HOST || '127.0.0.1';
  const server = http.createServer(async (request, response) => {
    const finish = (status, body, contentType = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    try {
      let authority;
      try { authority = new URL(`http://${request.headers.host || ''}`); } catch { throw new ProviderError('Invalid request host.', 'INVALID_HOST', 403); }
      const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', allowedHost.toLowerCase()]);
      if (!localHosts.has(authority.hostname.toLowerCase()) || authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) {
        throw new ProviderError('This server only accepts its configured local host.', 'INVALID_HOST', 403);
      }
      const origin = request.headers.origin;
      if (origin && origin !== authority.origin) throw new ProviderError('Requests from another website are blocked.', 'INVALID_ORIGIN', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new ProviderError('Requests from another website are blocked.', 'INVALID_ORIGIN', 403);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        throw new ProviderError('Only read requests are supported.', 'METHOD_NOT_ALLOWED', 405);
      }
      const url = new URL(request.url, authority.origin);
      if (url.origin !== authority.origin) throw new ProviderError('Invalid request address.', 'INVALID_REQUEST', 400);
      if (url.search) throw new ProviderError('Unexpected request parameters.', 'INVALID_REQUEST', 400);
      if (url.pathname === '/api/health') {
        return finish(200, JSON.stringify({ application: 'channel-room', version, directory: root, pid: process.pid, host: allowedHost, port: server.address()?.port }));
      }
      if (url.pathname === '/api/version') return finish(200, JSON.stringify(versionMetadata()));
      if (url.pathname === '/api/updates') {
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          throw new ProviderError('Checking for updates requires a GET request.', 'METHOD_NOT_ALLOWED', 405);
        }
        return finish(200, JSON.stringify(await updates.check()));
      }
      if (url.pathname === '/api/channels') {
        return finish(200, JSON.stringify({ channels: provider.listChannels() }));
      }
      const playlist = url.pathname.match(/^\/api\/channels\/([0-9]+)\/playlist\.m3u8$/);
      if (playlist) {
        const media = await provider.getPlaylist(playlist[1]);
        return finish(200, media.body, media.contentType);
      }
      const feedPlaylist = url.pathname.match(/^\/api\/channels\/([0-9]+)\/feeds\/([a-z][a-z0-9-]{0,31})\/playlist\.m3u8$/);
      if (feedPlaylist) {
        const media = await provider.getPlaylist(feedPlaylist[1], feedPlaylist[2]);
        return finish(200, media.body, media.contentType);
      }
      const resource = url.pathname.match(/^\/media\/([A-Za-z0-9_-]{32})$/);
      if (resource) {
        const media = await provider.getMedia(resource[1]);
        return finish(200, media.body, media.contentType);
      }
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const file = STATIC_FILES.get(url.pathname);
      if (!file) throw new ProviderError('That page does not exist.', 'NOT_FOUND', 404);
      try { return finish(200, await fs.readFile(path.join(root, file[0])), file[1]); }
      catch (error) {
        if (error.code === 'ENOENT') throw new ProviderError('A player file is missing. Run npm install in the application folder.', 'MISSING_FILE', 404);
        throw error;
      }
    } catch (error) {
      const known = error instanceof ProviderError;
      if (!known) console.error('Request failed:', error.message);
      return finish(known ? error.status : 500, JSON.stringify({ error: {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : 'The player encountered a server error. Try the channel again.',
      } }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.once('close', () => { provider.close?.(); updates.close?.(); });
  return server;
}

if (require.main === module) {
  const host = process.env.CHANNEL_ROOM_HOST || '127.0.0.1';
  const port = Number(process.env.CHANNEL_ROOM_PORT || 8767);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('CHANNEL_ROOM_PORT must be a port between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createServer({ host });
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Close the other player or set CHANNEL_ROOM_PORT.` : `Could not start the player: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, host, () => console.log(`Charliflix is ready at http://${host.includes(':') ? `[${host}]` : host}:${port}`));
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      server.close();
      server.closeAllConnections();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

module.exports = { createServer };
