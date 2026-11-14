(function () {
  'use strict';
  const MINUTE = 60_000;
  const WINDOW = 180 * MINUTE;
  const REFRESH = 30 * MINUTE;

  function create(options) {
    const $ = id => document.getElementById(id);
    const dialog = $('guide-dialog');
    const channels = options.channels.map(channel => ({ id: String(channel.id), name: options.channelName(channel) }));
    const channelMap = new Map(channels.map(channel => [channel.id, channel]));
    const model = window.CharliflixGuideModel;
    const history = options.history || window.CharliflixHistory;
    const locks = window.navigator?.locks;
    let storage;
    try { storage = window.localStorage; } catch { /* Scheduling reports unavailable below. */ }
    const schedulingAvailable = Boolean(model && locks?.request && storage);
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value || 'local time';
    $('guide-timezone').textContent = `Times in ${zone} · G opens the guide · M toggles mute`;
    if (!schedulingAvailable) $('schedule-help').textContent = 'Automatic channel changes need storage and a current desktop app or browser with Web Locks support.';

    let data = null, loading = null, fetchedAt = 0, disposed = false;
    let windowStart = Math.floor(Date.now() / (30 * MINUTE)) * 30 * MINUTE;
    let pending = null, opener = null;
    let scheduleTimer, refreshTimer, clockTimer, toastTimer;
    const pressTimers = new Set();
    const controller = new AbortController();

    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const when = value => `${date.format(value)} · ${time.format(value)}`;
    const range = programme => `${time.format(programme.start)}–${time.format(programme.end)}`;
    const rowFor = id => data?.channels?.find(row => String(row.id) === id);
    const currentFor = id => rowFor(id)?.programmes?.find(programme => programme.start <= Date.now() && programme.end > Date.now());
    const episodeLabel = programme => [programme?.subtitle, programme?.episode].filter(Boolean).join(' · ');
    const watched = programme => Boolean(programme && history?.isWatched(programme));
    const details = node('dialog', 'episode-dialog');
    details.id = 'episode-dialog'; details.setAttribute('aria-labelledby', 'episode-title');
    const detailsHeader = node('div', 'episode-header');
    const detailsTitle = node('h2', 'episode-title'); detailsTitle.id = 'episode-title';
    const detailsClose = node('button', 'icon-button episode-close', '✕');
    detailsClose.id = 'close-episode'; detailsClose.type = 'button'; detailsClose.setAttribute('aria-label', 'Close episode details');
    detailsHeader.append(detailsTitle, detailsClose);
    const detailsEpisode = node('p', 'episode-subtitle'); detailsEpisode.id = 'episode-subtitle';
    const detailsTime = node('p', 'episode-time');
    const detailsDescription = node('p', 'episode-description'); detailsDescription.id = 'episode-description';
    const detailsNote = node('p', 'episode-note');
    const detailsActions = node('div', 'episode-actions');
    const detailsWatched = node('button', 'secondary-button'); detailsWatched.id = 'episode-watched'; detailsWatched.type = 'button';
    const detailsFeedback = node('p', 'episode-feedback'); detailsFeedback.id = 'episode-feedback'; detailsFeedback.setAttribute('role', 'status');
    detailsActions.append(detailsWatched); details.append(detailsHeader, detailsEpisode, detailsTime, detailsDescription, detailsNote, detailsActions, detailsFeedback);
    document.body.append(details);
    let detailsProgramme = null, detailsKey = null;

    function updateDetails() {
      if (!detailsProgramme) return;
      detailsTitle.textContent = detailsProgramme.title;
      detailsEpisode.textContent = episodeLabel(detailsProgramme) || 'Episode information unavailable';
      detailsTime.textContent = `${channelMap.get(detailsProgramme.channelId)?.name || ''} · ${when(detailsProgramme.start)}–${time.format(detailsProgramme.end)}`;
      detailsDescription.textContent = detailsProgramme.description || 'No description is available from this guide.';
      const trackable = Boolean(history?.canTrack(detailsProgramme));
      detailsWatched.hidden = !trackable;
      detailsWatched.textContent = watched(detailsProgramme) ? '✓ Watched · Mark unwatched' : 'Mark as watched';
      detailsWatched.setAttribute('aria-pressed', String(watched(detailsProgramme)));
      const note = rowFor(detailsProgramme.channelId)?.scheduleNote || 'Eastern reference listings may differ from the actual feed.';
      detailsNote.textContent = `${note}${trackable ? '' : ' · Watched history needs an identified episode.'}`;
    }

    function openDetails(programme) {
      if (disposed) return;
      cancelPresses();
      detailsProgramme = { ...programme };
      detailsKey = `${programme.channelId}:${programme.start}`;
      detailsFeedback.textContent = '';
      updateDetails();
      if (!details.open) details.showModal();
      detailsClose.focus();
    }

    function closeDetails() {
      if (!details.open) return;
      details.close();
      if (dialog.open && detailsKey) Array.from($('guide-grid').querySelectorAll('[data-programme-key]')).find(button => button.dataset.programmeKey === detailsKey)?.focus({ preventScroll: true });
      detailsProgramme = null; detailsKey = null;
    }
    detailsClose.addEventListener('click', closeDetails);
    details.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); closeDetails(); });
    details.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDetails(); } });
    details.addEventListener('click', event => { if (event.target === details) { const box = details.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDetails(); } });
    detailsWatched.addEventListener('click', () => {
      if (!detailsProgramme || !history?.canTrack(detailsProgramme)) return;
      const result = history.setWatched(detailsProgramme, !watched(detailsProgramme));
      detailsFeedback.textContent = result === false || result?.ok === false ? 'The watched status could not be saved. Check that app storage is available.' : '';
      updateDetails();
    });

    function cancelPresses() { for (const timer of pressTimers) clearTimeout(timer); pressTimers.clear(); }
    function programmeInteractions(button, programme) {
      let timer = null, origin = null, suppressClickUntil = 0;
      const cancel = () => { clearTimeout(timer); pressTimers.delete(timer); timer = null; origin = null; };
      button.addEventListener('pointerdown', event => {
        cancel();
        if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
        suppressClickUntil = 0;
        origin = { x: event.clientX, y: event.clientY };
        timer = setTimeout(() => {
          pressTimers.delete(timer); timer = null;
          suppressClickUntil = Date.now() + 1500;
          openDetails(programme);
        }, 600);
        pressTimers.add(timer);
      });
      button.addEventListener('pointermove', event => { if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel(); });
      button.addEventListener('pointerup', () => { if (suppressClickUntil) suppressClickUntil = Date.now() + 1500; cancel(); });
      for (const name of ['pointercancel', 'pointerleave', 'lostpointercapture']) button.addEventListener(name, cancel);
      button.addEventListener('contextmenu', event => { event.preventDefault(); suppressClickUntil = Date.now() + 1500; openDetails(programme); });
      button.addEventListener('keydown', event => {
        if ((!event.altKey && !event.ctrlKey && !event.metaKey && event.key?.toLowerCase() === 'i') || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); event.stopPropagation(); openDetails(programme);
        }
      });
      button.addEventListener('click', event => {
        cancel();
        if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
        void choose(programme);
      });
    }
    $('guide-scroll').addEventListener('scroll', cancelPresses);

    function notify(message) {
      clearTimeout(toastTimer);
      const output = dialog.open ? $('guide-feedback') : $('guide-toast');
      output.textContent = message;
      output.hidden = false;
      toastTimer = setTimeout(() => { $('guide-feedback').hidden = true; $('guide-toast').hidden = true; }, 6500);
    }

    const scheduler = model.createScheduler({
      channelIds: channels.map(channel => channel.id), storage,
      onTune(item) {
        close(true);
        options.onTune(item.channelId);
        notify(`Scheduled switch: ${channelMap.get(item.channelId)?.name} · ${item.title}`);
      },
      onMissed(items) { if (items.length) notify(`${items.length === 1 ? 'A missed scheduled switch was' : `${items.length} missed scheduled switches were`} skipped.`); },
      onChange() { renderScheduled(); if (dialog.open) renderGrid(); armSchedule(); },
    });

    // All queue reads/writes that can lead to a tune share a browser-wide lock.
    // Refresh inside the lock so another same-origin player cannot replay a tune.
    async function transact(operation) {
      if (!schedulingAvailable || disposed) return { ok: false, code: 'unsupported' };
      let result;
      try {
        result = await locks.request('charliflix:scheduled-tunes', () => {
          if (disposed) return { ok: false, code: 'closed' };
          const refreshed = scheduler.refresh();
          return refreshed.ok ? operation() : refreshed;
        });
        if (result?.code === 'storage') notify('The scheduled switch could not be saved. Check that app storage is available.');
      } catch { result = { ok: false, code: 'storage' }; notify('Scheduled switches could not be saved right now.'); }
      armSchedule(result?.code === 'storage' ? 30_000 : 0);
      return result;
    }

    function armSchedule(backoff = 0) {
      clearTimeout(scheduleTimer);
      if (!schedulingAvailable || disposed) return;
      const next = scheduler.next();
      if (!next) return;
      // One deadline timer avoids an intensive repeating background timer.
      scheduleTimer = setTimeout(() => { void transact(() => scheduler.tick()); }, Math.min(2_147_483_647, Math.max(backoff, 1, next.start - Date.now())));
    }

    function updateNowLabels() {
      const current = Object.create(null);
      for (const channel of channels) {
        const label = $(`channel-now-${channel.id}`);
        if (!label) continue;
        const programme = currentFor(channel.id);
        current[channel.id] = programme || null;
        const row = rowFor(channel.id);
        const text = programme?.title || (!data ? 'Loading guide…' : row?.status === 'unmapped' ? 'Guide not matched' : 'Listings unavailable');
        if (label.textContent !== text) label.textContent = text;
        label.title = programme ? `${programme.title} · ${range(programme)} · ${row?.scheduleNote || 'Eastern reference schedule'}` : row?.reason || text;
        const episode = $(`channel-episode-${channel.id}`), badge = $(`channel-watched-${channel.id}`);
        if (episode) { const text = episodeLabel(programme); if(episode.textContent !== text) episode.textContent = text; episode.hidden = !text; }
        if (badge) { badge.hidden = !watched(programme); badge.title = 'This episode has already been watched'; }
      }
      options.onCurrentProgrammes?.(current);
    }

    function renderScheduled() {
      const items = scheduler.list();
      $('schedule-count').textContent = String(items.length);
      $('guide-scheduled-badge').textContent = String(items.length);
      $('guide-scheduled-badge').hidden = !items.length;
      const container = $('scheduled-shows');
      container.replaceChildren();
      if (!items.length) container.append(node('p', 'guide-empty-schedules', 'Nothing scheduled yet. Pick an upcoming show in the guide.'));
      for (const item of items) {
        const card = node('div', 'scheduled-show');
        card.append(node('p', 'scheduled-time', when(item.start)), node('strong', '', item.title), node('p', 'scheduled-channel', channelMap.get(item.channelId)?.name || item.channelId));
        const cancel = node('button', 'guide-text-button', 'Cancel switch');
        cancel.type = 'button';
        cancel.setAttribute('aria-label', `Cancel ${item.title} on ${channelMap.get(item.channelId)?.name}`);
        cancel.addEventListener('click', () => { void transact(() => scheduler.cancel(item.channelId, item.start)); });
        card.append(cancel); container.append(card);
      }
    }

    function setConflict(item, conflict) {
      const previous = pending;
      const restoreFocus = $('guide-conflict').contains(document.activeElement);
      pending = item;
      $('guide-conflict').hidden = !item;
      if (item) {
        $('guide-conflict-message').textContent = `${conflict.title} on ${channelMap.get(conflict.channelId)?.name} is already scheduled for ${when(conflict.start)}. Replace it with ${item.title}?`;
        $('guide-replace').focus();
      } else if (restoreFocus && previous) {
        Array.from($('guide-grid').querySelectorAll('[data-programme-key]')).find(button => button.dataset.programmeKey === `${previous.channelId}:${previous.start}`)?.focus({ preventScroll: true });
      }
    }

    async function choose(programme) {
      const now = Date.now();
      if (programme.start <= now && programme.end > now) {
        close(true); options.onTune(programme.channelId); return;
      }
      if (programme.end <= now) return;
      if (!schedulingAvailable) { notify('Scheduling is unavailable in this browser. Use the desktop app or a current browser.'); return; }
      const result = await transact(() => {
        const existed = scheduler.has(programme.channelId, programme.start);
        return { ...scheduler.toggle(programme), existed };
      });
      if (result?.code === 'conflict') setConflict(programme, result.conflict);
      else if (result?.ok) {
        setConflict(null);
        notify(result.existed ? 'Scheduled switch removed.' : `Will switch to ${channelMap.get(programme.channelId)?.name} at ${time.format(programme.start)}.`);
      } else if (result?.code !== 'storage') notify('That show can no longer be scheduled. Refresh the listings and try again.');
    }

    function renderGrid() {
      cancelPresses();
      const grid = $('guide-grid');
      const focusKey = document.activeElement?.dataset?.programmeKey;
      const focusChannel = document.activeElement?.dataset?.guideChannel;
      const header = node('div', 'guide-axis');
      header.append(node('div', 'guide-channel-cell guide-corner', 'Channel'));
      const axis = node('div', 'guide-track guide-time-track');
      for (let offset = 0; offset < 180; offset += 30) {
        const tick = node('span', 'guide-time', time.format(windowStart + offset * MINUTE));
        tick.style.gridColumn = `${offset + 1} / span 30`;
        axis.append(tick);
      }
      header.append(axis); grid.replaceChildren(header);
      const now = Date.now();
      for (const channel of channels) {
        const row = rowFor(channel.id);
        const element = node('div', 'guide-row');
        const channelCell = node('div', 'guide-channel-cell');
        const tune = node('button', 'guide-channel-button', channel.name);
        tune.dataset.guideChannel = channel.id;
        tune.type = 'button'; tune.setAttribute('aria-label', `Watch ${channel.name}`);
        tune.addEventListener('click', () => { close(true); options.onTune(channel.id); });
        const note = node('span', 'guide-channel-note', row?.id === '1054' ? 'Archive rotation' : row?.status === 'unmapped' ? 'Affiliate unknown' : 'Eastern guide');
        note.title = row?.scheduleNote || '';
        channelCell.append(tune, note);
        const track = node('div', 'guide-track');
        const programmes = (row?.programmes || []).filter(item => item.end > windowStart && item.start < windowStart + WINDOW);
        if (!programmes.length) {
          const empty = node('p', 'guide-empty-track', !data ? 'Loading listings…' : row?.id === '1054' && row.status !== 'ready' ? 'Archive rotation unavailable' : row?.status === 'unmapped' ? 'Guide unavailable · affiliate not identified' : 'No listings for this time');
          track.append(empty);
        }
        for (const programme of programmes) {
          const scheduled = scheduler.has(channel.id, programme.start);
          const live = programme.start <= now && programme.end > now;
          const past = programme.end <= now;
          const key = `${channel.id}:${programme.start}`;
          const programmeData = { ...programme, channelId: channel.id };
          const seen = watched(programmeData);
          const button = node('button', `guide-programme${live ? ' is-live' : ''}${scheduled ? ' is-scheduled' : ''}${seen ? ' is-watched' : ''}`);
          button.type = 'button'; button.dataset.programmeKey = key;
          button.style.gridColumn = `${Math.max(1, Math.floor((programme.start - windowStart) / MINUTE) + 1)} / ${Math.min(181, Math.ceil((programme.end - windowStart) / MINUTE) + 1)}`;
          const action = past ? 'Ended' : live ? 'Watch now' : scheduled ? 'Scheduled ✓' : 'Schedule';
          button.setAttribute('aria-label', `${programme.title}${episodeLabel(programme) ? ', ' + episodeLabel(programme) : ''}, ${when(programme.start)} to ${time.format(programme.end)}, ${channel.name}, ${action}${seen ? ', Already watched' : ''}. Hold or press I for episode details.`);
          button.setAttribute('aria-pressed', String(scheduled));
          button.title = `${programme.title}${episodeLabel(programme) ? '\n' + episodeLabel(programme) : ''}\n${when(programme.start)}–${time.format(programme.end)} · ${action}${row?.id === '1054' ? '\n' + row.scheduleNote : ''}\nHold or press I for details`;
          button.append(node('strong', 'guide-programme-title', programme.title));
          if (episodeLabel(programme)) button.append(node('span', 'guide-programme-episode', episodeLabel(programme)));
          if (seen) { const badge = node('span', 'watched-badge', '✓ Watched'); badge.setAttribute('aria-label', 'Episode watched'); button.append(badge); }
          button.append(node('span', 'guide-programme-time', range(programme)), node('span', 'guide-programme-action', action));
          programmeInteractions(button, programmeData);
          track.append(button);
        }
        if (now >= windowStart && now < windowStart + WINDOW) {
          const cursor = node('span', 'guide-live-line');
          cursor.setAttribute('aria-hidden', 'true');
          cursor.style.left = `${(now - windowStart) / WINDOW * 100}%`; track.append(cursor);
        }
        element.append(channelCell, track); grid.append(element);
      }
      const coverage = Number.isSafeInteger(data?.from) && Number.isSafeInteger(data?.until) && data.until > data.from;
      const min = coverage ? Math.floor(data.from / (30 * MINUTE)) * 30 * MINUTE : windowStart;
      $('guide-previous').disabled = !coverage || windowStart <= min;
      $('guide-next').disabled = !coverage || windowStart + WINDOW >= data.until;
      $('guide-range').textContent = `${date.format(windowStart)} · ${time.format(windowStart)}–${time.format(windowStart + WINDOW)}`;
      if (focusKey) Array.from(grid.querySelectorAll('[data-programme-key]')).find(button => button.dataset.programmeKey === focusKey)?.focus({ preventScroll: true });
      else if (focusChannel) Array.from(grid.querySelectorAll('[data-guide-channel]')).find(button => button.dataset.guideChannel === focusChannel)?.focus({ preventScroll: true });
    }

    function render() {
      updateNowLabels(); renderScheduled();
      $('guide-message').textContent = !data ? 'Loading listings…' : data.status === 'unavailable' ? 'Listings couldn’t be loaded. You can still tune using a channel name.' : `${data.partial ? 'Some channel listings are unavailable. ' : ''}${data.status === 'stale' ? 'Using cached listings. ' : ''}Listings available through ${when(data.until)}. Click an airing show to watch, or an upcoming show to schedule.`;
      if (dialog.open) renderGrid();
    }

    async function refresh(force = false) {
      if (loading || disposed) return loading;
      const cacheTime = !data || data.status !== 'ready' || data.partial ? MINUTE : REFRESH;
      if (!force && fetchedAt && Date.now() - fetchedAt < cacheTime) return;
      $('guide-refresh').disabled = true;
      loading = (async () => {
        try {
          const response = await fetch('/api/guide', { signal: controller.signal });
          if (!response.ok) throw new Error('Guide unavailable');
          const result = await response.json();
          if (!Array.isArray(result.channels) || !['ready', 'stale', 'unavailable'].includes(result.status)) throw new Error('Guide unavailable');
          data = result; fetchedAt = Date.now();
        } catch {
          if (disposed) return;
          if (data && data.until > Date.now()) data = { ...data, status: 'stale' };
          else data = { status: 'unavailable', channels: [] };
        } finally { fetchedAt = Date.now(); loading = null; $('guide-refresh').disabled = false; if (!disposed) render(); }
      })();
      return loading;
    }

    async function open() {
      if (dialog.open || disposed) return;
      if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { return; } }
      opener = document.activeElement;
      windowStart = Math.floor(Date.now() / (30 * MINUTE)) * 30 * MINUTE;
      dialog.showModal(); render();
      void transact(() => ({ ok: true })); void refresh();
    }
    function close(all = false) { cancelPresses(); if (details.open) { closeDetails(); if (!all) return; } if (dialog.open) { dialog.close(); opener?.focus?.({ preventScroll: true }); } }

    for (const button of document.querySelectorAll('[data-open-guide]')) { button.disabled = false; button.addEventListener('click', () => { void open(); }); }
    $('close-guide').addEventListener('click', () => close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } });
    $('guide-now').addEventListener('click', () => { windowStart = Math.floor(Date.now() / (30 * MINUTE)) * 30 * MINUTE; renderGrid(); });
    $('guide-previous').addEventListener('click', () => {
      if (!Number.isSafeInteger(data?.from)) return;
      windowStart = Math.max(Math.floor(data.from / (30 * MINUTE)) * 30 * MINUTE, windowStart - WINDOW); renderGrid();
    });
    $('guide-next').addEventListener('click', () => {
      if (!Number.isSafeInteger(data?.from) || !Number.isSafeInteger(data?.until)) return;
      const earliest = Math.floor(data.from / (30 * MINUTE)) * 30 * MINUTE;
      const latest = Math.max(earliest, Math.ceil(data.until / (30 * MINUTE)) * 30 * MINUTE - WINDOW);
      windowStart = Math.min(windowStart + WINDOW, latest); renderGrid();
    });
    $('guide-refresh').addEventListener('click', () => { void refresh(true); });
    $('guide-keep').addEventListener('click', () => setConflict(null));
    $('guide-replace').addEventListener('click', async () => {
      if (!pending) return;
      const candidate = pending;
      const result = await transact(() => scheduler.add(candidate, { replace: true }));
      if (result?.ok) { setConflict(null); notify(`Will switch to ${channelMap.get(candidate.channelId)?.name} at ${time.format(candidate.start)}.`); }
      else if (result?.code !== 'storage') { setConflict(null); notify('That show can no longer be scheduled. Refresh the listings and try again.'); }
    });
    const wake = () => { void transact(() => scheduler.tick()); updateNowLabels(); if (dialog.open) renderGrid(); if (!document.hidden) void refresh(); };
    const unsubscribeHistory = history?.subscribe(() => { if (!disposed) { updateNowLabels(); if (dialog.open) renderGrid(); updateDetails(); } });
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('storage', event => { if (event.key === model.STORAGE_KEY || event.key === null) void transact(() => ({ ok: true })); });
    refreshTimer = setInterval(() => { void refresh(); }, REFRESH);
    clockTimer = setInterval(() => { updateNowLabels(); if (dialog.open) renderGrid(); if ((data?.status !== 'ready' || data?.partial) && !document.hidden) void refresh(); }, 30_000);
    render(); void refresh(); void transact(() => scheduler.tick()); armSchedule();
    return { open, close, isOpen: () => dialog.open || details.open, toggle: () => dialog.open ? close() : void open(), destroy() {
      disposed = true; controller.abort(); clearTimeout(scheduleTimer); clearTimeout(toastTimer); clearInterval(refreshTimer); clearInterval(clockTimer); cancelPresses(); unsubscribeHistory?.(); details.close(); details.remove?.();
    } };
  }
  window.CharliflixGuide = { create };
})();
