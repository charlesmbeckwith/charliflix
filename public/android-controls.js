(() => {
  'use strict';
  // The native shell only supplies normal keys. No privileged JavaScript bridge
  // is exposed to the player or to third-party content.
  if (!/CharliflixAndroid\//.test(window.navigator?.userAgent || '')) return;
  document.body.classList.add('android-app');
  const focusable = 'button,a[href],input,select,textarea';
  const editable = target => target?.closest('textarea,select,[contenteditable],input:not([type="range"])');
  const currentScope = () => Array.from(document.querySelectorAll('dialog[open]')).at(-1) || document;
  const visible = element => !element.disabled && element.getAttribute('tabindex') !== '-1' && element.getClientRects().length > 0;
  const activate = element => {
    if (element?.matches('button,a[href]') && visible(element)) {
      element.click();
      return true;
    }
    return false;
  };
  function moveFocus(key) {
    document.body.classList.add('controller-navigation');
    // Showing the controls first also gives them usable geometry in theater mode.
    document.querySelector('.stage')?.dispatchEvent(new Event('pointermove'));
    const choices = Array.from(currentScope().querySelectorAll(focusable)).filter(visible);
    if (!choices.length) return false;
    const active = document.activeElement;
    if (!choices.includes(active)) {
      const initial = choices.find(element => element.matches('.channel-card[aria-pressed="true"]')) || choices.find(element => element.id === 'play-toggle') || choices[0];
      initial.focus();
      initial.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    }
    const from = active.getBoundingClientRect();
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const forward = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
    const centerX = from.left + from.width / 2, centerY = from.top + from.height / 2;
    let best = null, bestScore = Infinity;
    for (const candidate of choices) {
      if (candidate === active) continue;
      const to = candidate.getBoundingClientRect();
      const deltaX = to.left + to.width / 2 - centerX;
      const deltaY = to.top + to.height / 2 - centerY;
      const along = (horizontal ? deltaX : deltaY) * forward;
      if (along < 1) continue;
      const across = Math.abs(horizontal ? deltaY : deltaX);
      const overlap = horizontal ? to.top < from.bottom && to.bottom > from.top : to.left < from.right && to.right > from.left;
      // Aligned neighbors come before distant controls across the window.
      const score = along + across * 3 + (overlap ? 0 : 1000);
      if (score < bestScore) { best = candidate; bestScore = score; }
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return true;
  }
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const scope = currentScope();
    const target = document.activeElement || event.target;
    if (editable(target)) return;
    if (/^Arrow(?:Up|Down|Left|Right)$/.test(event.key)) {
      if (target?.matches('input[type="range"]') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
      if (moveFocus(event.key)) event.preventDefault();
    } else if (event.key === 'Enter' && !event.repeat) {
      // Buttons and links remain ordinary DOM actions, including modal controls.
      if (activate(target)) event.preventDefault();
    } else if (event.key === 'MediaPlayPause' && !event.repeat && scope === document) {
      if (activate(document.getElementById('play-toggle'))) event.preventDefault();
    } else if ((event.key === 'PageUp' || event.key === 'PageDown') && !event.repeat && scope === document) {
      const channels = Array.from(document.querySelectorAll('.channel-card')).filter(element => !element.disabled);
      if (!channels.length) return;
      const index = channels.findIndex(element => element.getAttribute('aria-pressed') === 'true');
      const direction = event.key === 'PageDown' ? 1 : -1;
      const next = channels[(Math.max(0, index) + direction + channels.length) % channels.length];
      next.click();
      if (visible(next)) { next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      event.preventDefault();
    }
  });
  document.addEventListener('pointerdown', () => document.body.classList.remove('controller-navigation'), { passive: true });
})();
