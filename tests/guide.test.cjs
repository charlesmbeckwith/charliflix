'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideService, parseGuide, GUIDE_URL, MAX_RESPONSE_BYTES } = require('../lib/guide.cjs');

const NOW = Date.UTC(2026, 9, 19, 20);
const HOUR = 60 * 60 * 1000;
const cable = [
  ['339', 'Cartoon Network HD', '296'], ['310', 'Comedy Central East HD', '249'],
  ['317', 'FX East HD', '248'], ['298', 'FXX East HD', '259'], ['303', 'AMC East HD', '254'],
];
const channels = cable.map(([id, name]) => ({ id, name, enabled: true })).concat([
  { id: '51', name: 'ABC USA', enabled: true }, { id: '52', name: 'CBS USA', enabled: true },
  { id: '53', name: 'NBC USA', enabled: true }, { id: '54', name: 'FOX USA', enabled: true },
  { id: '300', name: 'CW USA', enabled: true }, { id: '210', name: 'PBS USA', enabled: false },
]);
function fixture(now = NOW) {
  const seconds = Math.floor(now / 1000);
  return { guide: 'US', updated: new Date(now - 30_000).toISOString(),
    from: new Date(now - HOUR).toISOString(), until: new Date(now + 10 * HOUR).toISOString(),
    channels: cable.map(([_id, name, number]) => ({ name, number, programmes: [
      { start: seconds - 600, stop: seconds + 1200, title: 'Current programme', subtitle: 'A familiar episode' },
      { start: seconds + 1200, stop: seconds + 3000, title: 'Next programme' },
    ] })),
  };
}
const options = extra => ({ verifyDns: false, now: () => NOW, channels, ...extra });

test('guide requests are lazy, anonymous, fixed to the documented JSON endpoint, coalesced and cached', async t => {
  const requests = [];
  const service = new GuideService(options({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    await new Promise(resolve => setImmediate(resolve));
    return Response.json(fixture());
  } }));
  t.after(() => service.close());
  assert.equal(requests.length, 0);
  const [first, second] = await Promise.all([service.check(), service.check()]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, GUIDE_URL);
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.deepEqual(Object.keys(requests[0].init.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(requests[0].init.headers.Accept, 'application/json');
  assert.equal(first.status, 'ready');
  assert.equal(first.fetchedAt, NOW);
  assert.equal(first.source.name, 'EPGTalk');
  assert.equal(first.channels.length, 10, 'disabled channels are excluded');
  assert.equal(first.channels.filter(channel => channel.status === 'ready').length, 5);
  assert.equal(first.channels.filter(channel => channel.status === 'unmapped').length, 5);
  assert.match(first.channels.find(channel => channel.id === '53').reason, /affiliate/);
  first.channels[0].programmes[0].title = 'Mutated by a caller';
  first.source.name = 'Mutated';
  assert.equal(second.channels[0].programmes[0].title, 'Current programme');
  assert.equal((await service.check()).source.name, 'EPGTalk');
  assert.equal(requests.length, 1);
});

test('guide normalization keeps UTC instants distinct across the fall DST transition', () => {
  const data = fixture();
  data.updated = '2026-11-01T01:30:00-04:00';
  data.from = '2026-11-01T05:00:00Z';
  data.until = '2026-11-01T08:00:00Z';
  data.channels[0].programmes = [
    { start: Date.parse('2026-11-01T01:30:00-04:00') / 1000, stop: Date.parse('2026-11-01T01:00:00-05:00') / 1000, title: 'Before the clock change' },
    { start: Date.parse('2026-11-01T01:30:00-05:00') / 1000, stop: Date.parse('2026-11-01T02:00:00-05:00') / 1000, title: 'After the clock change' },
  ];
  const normalized = parseGuide(data, channels.filter(channel => channel.enabled));
  assert.equal(normalized.updatedAt, Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(normalized.channels[0].programmes[1].start - normalized.channels[0].programmes[0].start, HOUR);
  assert.equal(normalized.channels[0].programmes[0].end, Date.parse('2026-11-01T06:00:00Z'));
});

test('listing identity requires the exact station name and number instead of guessing another feed', () => {
  const data = fixture();
  data.channels[0].number = '297';
  data.channels[1].name = 'Comedy Central West HD';
  data.channels.push({ name: 'CBS', number: '2', programmes: data.channels[2].programmes });
  const normalized = parseGuide(data, channels.filter(channel => channel.enabled));
  assert.equal(normalized.channels[0].status, 'empty');
  assert.equal(normalized.channels[1].status, 'empty');
  assert.equal(normalized.channels.find(channel => channel.id === '52').status, 'unmapped');
  assert.equal(normalized.channels[2].status, 'ready');
  data.channels.push({ ...data.channels[2] });
  assert.equal(parseGuide(data, channels).channels[2].status, 'empty', 'ambiguous duplicate listings are not selected arbitrarily');
});

test('programmes are bounded, sorted and deduplicated while provider image and episode data are omitted', () => {
  const data = fixture();
  const first = data.channels[0].programmes[0];
  data.channels[0].programmes = [data.channels[0].programmes[1],
    { ...first, title: '  A\nprogramme  ', image: 'https://attacker.example/image', episode: '<script>ignored</script>' },
    { ...first, title: 'Duplicate slot' }, { ...first, stop: first.start },
    { ...first, start: first.start - 10 * 86400, stop: first.stop - 10 * 86400 },
  ];
  const normalized = parseGuide(data, channels);
  const events = normalized.channels[0].programmes;
  assert.equal(events.length, 2);
  assert.equal(events[0].title, 'A programme');
  assert.equal(events[0].channelId, '339');
  assert.equal(events[0].start, first.start * 1000);
  assert.equal(events[0].image, undefined);
  assert.equal(events[0].episode, undefined);
  assert.equal(events[0].id, parseGuide(data, channels).channels[0].programmes[0].id);
  data.channels[0].programmes = [{ ...first, title: 'x'.repeat(1000), subtitle: 'y'.repeat(1000) }];
  const long = parseGuide(data, channels).channels[0].programmes[0];
  assert.equal(long.title.length, 200);
  assert.equal(long.subtitle.length, 300);
});

test('an actual empty schedule is distinct from an invalid response or unverified affiliate', async t => {
  const data = fixture();
  data.channels[0].programmes = [];
  const service = new GuideService(options({ fetchImpl: async () => Response.json(data) }));
  t.after(() => service.close());
  const result = await service.check();
  assert.equal(result.status, 'ready');
  assert.equal(result.channels[0].status, 'empty');
  assert.equal(result.channels.find(channel => channel.id === '53').status, 'unmapped');
  data.channels[0].programmes = [{ start: 5, stop: 4, title: 'Invalid interval' }];
  assert.throws(() => parseGuide(data, channels), error => error.reason === 'invalid-response');
});

test('source failures use bounded backoff, preserve covered last-good data and recover on a later refresh', async t => {
  let now = NOW;
  let requests = 0;
  let fail = false;
  const service = new GuideService(options({ now: () => now, cacheMs: 1000, retryMs: 100,
    fetchImpl: async () => { requests++; if (fail) throw new Error('private upstream detail'); return Response.json(fixture(now)); } }));
  t.after(() => service.close());
  const original = await service.check();
  now += 1001;
  fail = true;
  const stale = await service.check();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reason, 'network');
  assert.equal(stale.fetchedAt, original.fetchedAt);
  assert.deepEqual(stale.channels[0].programmes, original.channels[0].programmes);
  assert.doesNotMatch(JSON.stringify(stale), /private upstream/);
  now += 50;
  await service.check();
  assert.equal(requests, 2);
  now += 51;
  fail = false;
  const recovered = await service.check();
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.fetchedAt, now);
  assert.equal(recovered.reason, undefined);
  assert.equal(requests, 3);
});

test('expired source coverage never masquerades as a usable stale schedule', async t => {
  let now = NOW;
  let fail = false;
  const service = new GuideService(options({ now: () => now,
    fetchImpl: async () => { if (fail) throw new Error('Offline'); return Response.json(fixture()); } }));
  t.after(() => service.close());
  await service.check();
  now += 10 * HOUR + 1;
  fail = true;
  const result = await service.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.channels[0].status, 'empty');
  assert.equal(result.channels[0].programmes.length, 0);
  assert.equal(result.channels.find(channel => channel.id === '51').status, 'unmapped');
});

test('malformed, oversized and implausible guide responses report failure rather than an empty successful guide', async t => {
  const wrongGuide = { ...fixture(), guide: 'CA' };
  const noTimezone = { ...fixture(), updated: '2026-10-19T20:00:00' };
  const impossibleDate = { ...fixture(), updated: '2026-02-30T20:00:00Z' };
  const backwards = { ...fixture(), until: fixture().from };
  const excessive = { ...fixture(), channels: Array.from({ length: 2001 }, () => ({})) };
  const programmes = fixture(); programmes.channels[0].programmes = Array.from({ length: 513 }, () => ({}));
  const cases = [
    () => new Response('{broken'), () => Response.json(wrongGuide), () => Response.json(noTimezone), () => Response.json(impossibleDate),
    () => Response.json(backwards), () => Response.json(excessive), () => Response.json(programmes),
    () => new Response('small', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
    () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1)),
  ];
  for (const response of cases) {
    const service = new GuideService(options({ fetchImpl: async () => response() }));
    t.after(() => service.close());
    const result = await service.check();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'invalid-response');
    assert.equal(result.fetchedAt, null);
  }
});

test('an expired but otherwise valid initial source response is explicitly unavailable', async t => {
  const service = new GuideService(options({ now: () => NOW + 11 * HOUR, fetchImpl: async () => Response.json(fixture()) }));
  t.after(() => service.close());
  assert.equal((await service.check()).reason, 'expired');
});

test('redirects are not followed and rate limits are reported without upstream response bodies', async t => {
  for (const status of [302, 403, 429, 503]) {
    let requests = 0;
    const service = new GuideService(options({ fetchImpl: async () => {
      requests++;
      return new Response('untrusted private diagnostics', { status, headers: { location: 'https://attacker.example/guide.json' } });
    } }));
    t.after(() => service.close());
    const result = await service.check();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, status === 403 || status === 429 ? 'rate-limit' : 'network');
    assert.doesNotMatch(JSON.stringify(result), /attacker|private diagnostics/);
    await service.check();
    assert.equal(requests, 1);
  }
});

test('private and mixed DNS answers are rejected before any upstream request', async t => {
  for (const addresses of [['127.0.0.1'], ['8.8.8.8', '192.168.1.1'], ['::1']]) {
    let requests = 0;
    const service = new GuideService(options({ verifyDns: true, resolveHost: async hostname => {
      assert.equal(hostname, 'epgtalk.com'); return addresses.map(address => ({ address }));
    }, fetchImpl: async () => { requests++; throw new Error('Must not fetch'); } }));
    t.after(() => service.close());
    assert.equal((await service.check()).reason, 'blocked-source');
    assert.equal(requests, 0);
  }
});

test('guide timeout bounds both stalled fetches and stalled DNS resolution', async t => {
  const fetchTimeout = new GuideService(options({ timeoutMs: 10, fetchImpl: async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })) }));
  const dnsTimeout = new GuideService(options({ timeoutMs: 10, verifyDns: true, resolveHost: async () => new Promise(() => {}),
    fetchImpl: async () => { throw new Error('Must not fetch'); } }));
  t.after(() => { fetchTimeout.close(); dnsTimeout.close(); });
  assert.equal((await fetchTimeout.check()).reason, 'timeout');
  assert.equal((await dnsTimeout.check()).reason, 'timeout');
});

test('closing the guide aborts an active request and prevents later network activity', async () => {
  let requests = 0;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const service = new GuideService(options({ fetchImpl: async (_url, { signal }) => {
    requests++; began();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } }));
  const pending = service.check();
  await started;
  service.close();
  assert.equal((await pending).reason, 'closed');
  assert.equal((await service.check()).reason, 'closed');
  assert.equal(requests, 1);
});
