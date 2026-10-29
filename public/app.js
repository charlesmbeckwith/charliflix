(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const video = $('video');
  const releasePrefix = 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v';
  function isReleaseUrl(value) { return typeof value === 'string' && value.startsWith(releasePrefix) && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.slice(releasePrefix.length)); }
  const updateBridge=window.charliflixUpdates||window.chrome?.webview;
  let nativeUpdateMode=false;
  let nativeUpdateReady=false;
  function receiveUpdate(event) {
    const data=event?.data;
    if(!data||data.type!=='charliflix-updater'||typeof data.status!=='string'||data.status==='unsupported')return;
    if(!['idle','checking','current','no-release','downloading','ready','restarting','available-manual','error'].includes(data.status))return;
    nativeUpdateMode=true;nativeUpdateReady=data.status==='ready';
    $('restart-update').hidden=!nativeUpdateReady;
    $('restart-update').disabled=false;
    $('open-release').hidden=true;
    const busy=['checking','downloading','restarting'].includes(data.status);
    $('check-updates').disabled=busy;
    $('check-updates').textContent=busy?'Updating…':'Check for updates';
    if(data.status==='idle')return;
    if(data.automatic===true&&['checking','current','no-release','error'].includes(data.status))return;
    $('update-result').hidden=false;
    if(data.status==='checking')$('update-message').textContent='Checking for an update…';
    else if(data.status==='downloading')$('update-message').textContent=`Downloading update${Number.isFinite(data.progress)?` · ${Math.round(Math.min(100,Math.max(0,data.progress)))}%`:''}. You can keep watching.`;
    else if(data.status==='ready')$('update-message').textContent='An update is ready. Restart when you’re finished watching.';
    else if(data.status==='restarting')$('update-message').textContent='Closing the player and applying the update…';
    else if(data.status==='available-manual'&&isReleaseUrl(data.releaseUrl)){
      $('update-message').textContent='A new Mac version is available. Download and replace the app; automatic installation needs Apple signing.';
      $('open-release').href=data.releaseUrl;$('open-release').hidden=false;
    } else if(data.status==='current')$('update-message').textContent='You have the latest release.';
    else if(data.status==='no-release')$('update-message').textContent='There are no published releases yet. Check again later.';
    else $('update-message').textContent='Couldn’t update right now. Try again later.';
  }
  if(updateBridge?.postMessage){
    if(updateBridge.onMessage)updateBridge.onMessage(receiveUpdate);
    else updateBridge.addEventListener?.('message',receiveUpdate);
    updateBridge.postMessage({type:'charliflix-updater',action:'status'});
  }
  $('restart-update').addEventListener('click',()=>{
    if(!nativeUpdateMode||!nativeUpdateReady)return;
    $('restart-update').disabled=true;
    updateBridge.postMessage({type:'charliflix-updater',action:'restart'});
  });
  $('check-updates').addEventListener('click', async () => {
    if(nativeUpdateMode){updateBridge.postMessage({type:'charliflix-updater',action:'check'});return;}
    const button = $('check-updates');
    button.disabled = true;
    button.textContent = 'Checking…';
    $('update-result').hidden = false;
    $('update-message').textContent = 'Checking GitHub for a new release…';
    $('open-release').hidden = true;
    try {
      const response = await fetch('/api/updates');
      if (!response.ok) throw new Error('Update check failed.');
      const result = await response.json();
      if (result.status === 'available' && isReleaseUrl(result.releaseUrl)) {
        $('update-message').textContent = `Version ${result.latestVersion} is available. Download it from the release page, then replace your app.`;
        $('open-release').href = result.releaseUrl;
        $('open-release').hidden = false;
      } else if (result.status === 'current') {
        $('update-message').textContent = 'You have the latest release.';
      } else if (result.status === 'no-release') {
        $('update-message').textContent = 'There are no published releases yet. Check again later.';
      } else {
        $('update-message').textContent = result.reason === 'rate-limit' ? 'GitHub’s update limit was reached. Try again later.' : 'Couldn’t check for updates. Try again later.';
      }
    } catch { $('update-message').textContent = 'Couldn’t check for updates. Try again later.'; }
    finally { button.disabled = false; button.textContent = 'Check for updates'; }
  });
  fetch('/api/version').then(response => { if (!response.ok) throw new Error('Version unavailable.'); return response.json(); }).then(data => {
    if (typeof data.version === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(data.version)) $('app-version').textContent = `v${data.version}`;
  }).catch(() => {});
  const initials = { '339':'CN', '310':'CC', '317':'FX', '298':'FXX', '303':'AMC', '51':'abc', '52':'CBS', '53':'NBC', '54':'FOX', '210':'PBS', '300':'CW' };
  const names = { '339':'Cartoon Network', '310':'Comedy Central', '317':'FX', '298':'FXX', '303':'AMC', '51':'ABC', '52':'CBS', '53':'NBC', '54':'FOX', '210':'PBS', '300':'CW' };
  const state = { channels:[], selected:null, hls:null, started:false, retries:0, mediaRecoveries:0, generation:0, retryTimer:null, stallTimer:null, muted:false, volume:0.75, feed:null, attemptedFeeds:new Set(), feedChoices:Object.create(null), fallbackFrom:'', receivedPlayback:false, lastTime:0, lastProgressAt:0 };
  try { state.muted = localStorage.getItem('channel-room:muted') === 'true'; const stored = localStorage.getItem('channel-room:volume'); if(stored !== null && Number.isFinite(Number(stored))) state.volume = Math.min(1,Math.max(0,Number(stored))); } catch {}
  try { const choices=JSON.parse(localStorage.getItem('channel-room:feeds')||'{}'); for(const [id,feed] of Object.entries(choices||{})) if(typeof feed==='string')state.feedChoices[id]=feed; } catch {}
  video.muted = state.muted;
  video.volume = state.volume;
  let guideController = null;
  let theater = false;
  let previousScroll = 0;
  let controlsTimer;
  const controls = document.querySelector('.player-controls');
  function showTheaterControls() {
    clearTimeout(controlsTimer);
    document.body.classList.remove('controls-hidden');
    if(theater && !video.paused) controlsTimer = setTimeout(() => {
      if(!controls.matches(':hover') && !controls.contains(document.activeElement)) document.body.classList.add('controls-hidden');
    }, 3000);
  }
  function setTheater(enabled) {
    if(theater === enabled) return;
    theater = enabled;
    if(enabled) previousScroll = window.scrollY;
    document.body.classList.toggle('theater-mode', enabled);
    $('theater').setAttribute('aria-pressed', String(enabled));
    $('theater').setAttribute('aria-label', enabled ? 'Exit theater mode' : 'Enter theater mode');
    $('theater').querySelector('span').textContent = enabled ? 'Exit theater' : 'Theater';
    $('theater').title = enabled ? 'Exit theater mode (T or Escape)' : 'Theater mode (T)';
    window.scrollTo(0, enabled ? 0 : previousScroll);
    try { localStorage.setItem('channel-room:theater', String(enabled)); } catch {}
    showTheaterControls();
  }
  function saveAudio() { try { localStorage.setItem('channel-room:muted', String(video.muted)); localStorage.setItem('channel-room:volume', String(video.volume)); } catch {} }
  function updateAudio() {
    const silent = video.muted || video.volume === 0;
    $('mute-toggle').setAttribute('aria-label',silent?'Unmute':'Mute');
    $('volume-wave').setAttribute('d',silent?'M17 9l5 6m0-6-5 6':'M17 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14');
    $('volume').value = String(Math.round(video.volume*100));
    $('volume-value').textContent = `${Math.round(video.volume*100)}%`;
  }
  function updatePlay() { const paused=video.paused; $('play-toggle').setAttribute('aria-label',paused?'Play':'Pause'); $('play-path').setAttribute('d',paused?'m8 5 11 7-11 7z':'M7 5h4v14H7zM15 5h4v14h-4z'); }
  function status(kind, label, detail) {
    document.body.dataset.playback = kind;
    $('state-pill').dataset.state = kind;
    $('state-text').textContent = label;
    if(detail) $('playback-note').textContent = detail;
    $('now-kicker').textContent = kind === 'playing' ? 'NOW WATCHING' : kind === 'idle' ? 'READY TO WATCH' : 'YOUR CHANNEL';
    updatePlay();
  }
  function feedsFor(channel) { return channel.feeds?.length ? channel.feeds : [{id:'default',label:'Primary feed',legacy:true}]; }
  function playableFeeds(channel) { return feedsFor(channel).filter(feed=>feed.enabled!==false); }
  function preferredFeed(channel) {
    const feeds=playableFeeds(channel);
    return feeds.find(feed=>String(feed.id)===state.feedChoices[channel.id])||feeds.find(feed=>String(feed.id)===String(channel.defaultFeed))||feeds[0];
  }
  function renderFeeds(channel, feed) {
    $('feed-select').replaceChildren();
    for(const optionFeed of feedsFor(channel)) {
      const option=document.createElement('option');option.value=String(optionFeed.id);
      option.textContent=optionFeed.label||`Feed ${optionFeed.id}`;option.disabled=optionFeed.enabled===false;
      if(option.disabled){option.textContent+=' · unavailable';option.title=optionFeed.reason||'This feed is unavailable.';}
      $('feed-select').append(option);
    }
    $('feed-select').disabled=feedsFor(channel).length<2;
    if(feed)$('feed-select').value=String(feed.id);
    $('feed-select').title=feed?.detail||'Choose another feed if this one is unavailable or has no sound';
    $('next-feed').hidden=playableFeeds(channel).length<2;
  }
  function feedLabel() { return state.feed?.label||'Live feed'; }
  function feedProgress(action) { return state.fallbackFrom?`${state.fallbackFrom} failed; ${action.charAt(0).toLowerCase()+action.slice(1)} ${feedLabel()}`:`${action} ${feedLabel()}`; }
  function chooseFeed(feedId) {
    if(!state.selected)return;
    const feed=playableFeeds(state.selected).find(option=>String(option.id)===String(feedId));
    if(!feed)return;
    state.feedChoices[state.selected.id]=String(feed.id);
    try{localStorage.setItem('channel-room:feeds',JSON.stringify(state.feedChoices));}catch{}
    start(state.selected,{feed});
  }
  function armStallTimer(delay=25000) {
    clearTimeout(state.stallTimer);
    const generation=state.generation;
    const remaining=Math.max(0,delay-(Date.now()-state.lastProgressAt));
    state.stallTimer=setTimeout(()=>{if(generation===state.generation&&state.started&&$('error-overlay').hidden)advanceFeed('The feed stopped delivering playable video.');},remaining);
  }
  function advanceFeed(message) {
    clearTimeout(state.retryTimer);clearTimeout(state.stallTimer);
    const next=playableFeeds(state.selected).find(feed=>!state.attemptedFeeds.has(String(feed.id)));
    if(next){start(state.selected,{feed:next,attemptedFeeds:state.attemptedFeeds,automatic:true,failedFeed:feedLabel()});return;}
    state.hls?.stopLoad();
    const labels=[...state.attemptedFeeds].map(id=>feedsFor(state.selected).find(feed=>String(feed.id)===id)?.label||id);
    const extra=labels.length>1?` The available feeds have been tried (${labels.join(' → ')}).`:'';
    fail(`${message}${extra} You can retry or choose a feed manually.`);
  }
  function select(channel) {
    state.selected = channel;
    const name=names[channel.id]||channel.name;
    $('now-title').textContent=name;
    $('small-channel').textContent=initials[channel.id]||name.slice(0,2);
    $('channel-description').replaceChildren(document.createTextNode(name+' '));
    const region=document.createElement('span');region.className='muted-text';region.textContent='· USA feed';$('channel-description').append(region);
    $('welcome-detail').textContent=`${name} is one click away.`;
    $('start-watching').querySelector('span').textContent=`Watch ${name}`;
    for(const card of document.querySelectorAll('.channel-card')) card.setAttribute('aria-pressed',String(card.dataset.id===channel.id));
    try{localStorage.setItem('channel-room:last-channel',channel.id);}catch{}
    document.title=`${name} · Charliflix`;
  }
  function fail(message) {
    clearTimeout(state.retryTimer);clearTimeout(state.stallTimer);
    $('loading-overlay').hidden=true;
    $('idle-slate').hidden=true;
    $('error-overlay').hidden=false;
    $('error-detail').textContent=message||'The feed is unavailable right now. Try this channel again in a moment.';
    status('error','Unavailable',state.selected?`${feedLabel()} unavailable · Try another feed or channel`:'Try again in a moment');
  }
  async function tryPlay() { const generation=state.generation;if(document.body.dataset.playback==='paused'){state.lastProgressAt=Date.now();armStallTimer(35000);}try { await video.play(); } catch(error) { if(generation!==state.generation)return;if(error.name==='NotAllowedError'){clearTimeout(state.stallTimer);$('loading-overlay').hidden=true;status('paused','Press play','Press play to start with sound');}else if(error.name!=='AbortError'){advanceFeed('The player could not start this feed.');} } }
  function showQuality(){ const level=state.hls?.currentLevel; const info=level>=0?state.hls.levels[level]:null; const height=video.videoHeight||info?.height; $('quality-label').textContent=height?`${height}p`:'—'; }
  function start(channel, options={}) {
    clearTimeout(state.retryTimer);clearTimeout(state.stallTimer);
    const generation=++state.generation;
    const muted=state.muted,volume=state.volume;
    state.hls?.destroy();state.hls=null;
    video.pause();video.removeAttribute('src');video.load();
    select(channel);state.started=true;state.retries=0;state.mediaRecoveries=0;state.receivedPlayback=false;state.lastTime=0;state.lastProgressAt=Date.now();
    state.feed=options.feed||preferredFeed(channel);
    state.fallbackFrom=options.automatic?options.failedFeed||'The previous feed':'';
    state.attemptedFeeds=options.attemptedFeeds?new Set(options.attemptedFeeds):new Set();
    renderFeeds(channel,state.feed);
    if(!state.feed){fail('No playable feeds are configured for this channel.');return;}
    state.attemptedFeeds.add(String(state.feed.id));
    state.muted=muted;state.volume=volume;video.muted=muted;video.volume=volume;updateAudio();
    $('idle-slate').hidden=true;$('error-overlay').hidden=true;$('loading-overlay').hidden=false;
    $('loading-text').textContent=options.automatic?`${feedProgress('Trying')}…`:`Tuning in to ${names[channel.id]||channel.name}…`;
    $('go-live').disabled=true;$('quality-label').textContent='—';
    status('loading','Connecting',feedProgress(options.automatic?'Trying':'Connecting to'));
    armStallTimer(35000);
    const base=`/api/channels/${encodeURIComponent(channel.id)}`;
    const source=state.feed.legacy?`${base}/playlist.m3u8`:`${base}/feeds/${encodeURIComponent(state.feed.id)}/playlist.m3u8`;
    if(window.Hls?.isSupported()) {
      const hls=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:2,liveMaxLatencyDurationCount:5,maxBufferLength:24,backBufferLength:20,capLevelToPlayerSize:true});
      state.hls=hls;
      hls.on(Hls.Events.MEDIA_ATTACHED,()=>{if(generation===state.generation)hls.loadSource(source);});
      hls.on(Hls.Events.MANIFEST_PARSED,()=>{if(generation===state.generation){$('go-live').disabled=false;tryPlay();}});
      hls.on(Hls.Events.LEVEL_SWITCHED,showQuality);
      hls.on(Hls.Events.ERROR,(_event,data)=>{
        if(generation!==state.generation||!data.fatal)return;
        if(data.type===Hls.ErrorTypes.NETWORK_ERROR&&!/^manifest/i.test(data.details||'')&&state.retries<2){state.retries++;status('buffering','Reconnecting',feedProgress('Reconnecting to'));state.retryTimer=setTimeout(()=>{if(generation===state.generation)hls.startLoad();},state.retries*1500);}
        else if(data.type===Hls.ErrorTypes.MEDIA_ERROR&&state.mediaRecoveries<1){state.mediaRecoveries++;hls.recoverMediaError();}
        else advanceFeed(data.response?.code===404?'This feed is not available from the current source.':'The feed stopped responding.');
      });
      hls.attachMedia(video);
    } else if(video.canPlayType('application/vnd.apple.mpegurl')) { video.src=source;tryPlay(); }
    else fail('This browser does not support the video format. Try a current version of Chrome, Edge or Safari.');
  }
  function renderChannels(channels) {
    $('favorite-channels').replaceChildren();$('network-channels').replaceChildren();
    let networkCount=0, favoriteCount=0;
    for(const channel of channels){
      channel.id=String(channel.id);
      const favorite=channel.pinned===true||channel.category==='favorites';if(favorite)favoriteCount++;else networkCount++;
      const button=document.createElement('button');button.type='button';button.className='channel-card';button.dataset.id=channel.id;button.setAttribute('aria-pressed','false');button.setAttribute('aria-label',`Watch ${names[channel.id]||channel.name}`);
      const badge=document.createElement('span');badge.className='channel-badge';badge.textContent=initials[channel.id]||channel.name.slice(0,2);
      const label=document.createElement('span');label.className='channel-copy';const title=document.createElement('span');title.className='channel-name';title.textContent=names[channel.id]||channel.name;const detail=document.createElement('span');detail.className='channel-meta';const feedCount=playableFeeds(channel).length;detail.textContent=feedCount>1?`USA · ${feedCount} feeds`:'USA feed';const now=document.createElement('span');now.className='channel-now';now.id=`channel-now-${channel.id}`;now.textContent='Loading guide…';button.setAttribute('aria-describedby',now.id);label.append(title,now,detail);
      const dot=document.createElement('span');dot.className='selection-indicator';dot.setAttribute('aria-hidden','true');button.append(badge,label,dot);button.addEventListener('click',()=>start(channel));
      $(favorite?'favorite-channels':'network-channels').append(button);
    }
    $('favorite-count').textContent=String(favoriteCount).padStart(2,'0');$('network-count').textContent=String(networkCount).padStart(2,'0');$('lineup-summary').textContent=`${channels.length} channels · USA feeds · Local playback`;
  }
  $('start-watching').addEventListener('click',()=>{if(state.selected)start(state.selected);});
  $('retry').addEventListener('click',()=>{if(state.selected)start(state.selected,{feed:state.feed});});
  $('feed-select').addEventListener('change',event=>chooseFeed(event.target.value));
  $('next-feed').addEventListener('click',()=>{if(!state.selected)return;const feeds=playableFeeds(state.selected);const index=feeds.findIndex(feed=>String(feed.id)===String(state.feed?.id));chooseFeed(feeds[(index+1)%feeds.length]?.id);});
  $('play-toggle').addEventListener('click',()=>{if((!state.started||document.body.dataset.playback==='error')&&state.selected)start(state.selected,{feed:state.feed});else if(video.paused)tryPlay();else{clearTimeout(state.stallTimer);video.pause();}});
  function toggleMute(){video.muted=!(video.muted||video.volume===0);if(!video.muted&&video.volume===0)video.volume=0.5;state.muted=video.muted;state.volume=video.volume;saveAudio();updateAudio();}
  $('mute-toggle').addEventListener('click',toggleMute);
  $('volume').addEventListener('input',event=>{video.volume=Number(event.target.value)/100;video.muted=video.volume===0;state.volume=video.volume;state.muted=video.muted;saveAudio();updateAudio();});
  $('go-live').addEventListener('click',()=>{const position=state.hls?.liveSyncPosition;if(Number.isFinite(position))video.currentTime=position;tryPlay();});
  $('theater').addEventListener('click',()=>setTheater(!theater));
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.repeat)return;
    if(event.isComposing)return;
    if(event.key==='Escape'&&guideController?.isOpen()){event.preventDefault();guideController.close();}
    else if(!event.target.closest('input,textarea,select,[contenteditable]')&&event.key.toLowerCase()==='g'&&guideController){event.preventDefault();guideController.toggle();}
    else if(!event.target.closest('input,textarea,select,[contenteditable]')&&event.key.toLowerCase()==='m'){event.preventDefault();toggleMute();}
    else if(event.key==='Escape'&&theater&&!document.fullscreenElement){event.preventDefault();setTheater(false);$('theater').focus();}
    else if(event.key.toLowerCase()==='t'&&!document.fullscreenElement&&!event.target.closest('input,textarea,select,[contenteditable]')){event.preventDefault();setTheater(!theater);}
  });
  document.querySelector('.stage').addEventListener('pointermove',showTheaterControls);
  document.querySelector('.stage').addEventListener('pointerdown',showTheaterControls);
  controls.addEventListener('focusin',showTheaterControls);
  controls.addEventListener('focusout',showTheaterControls);
  controls.addEventListener('pointerleave',showTheaterControls);
  $('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else{video.controls=true;await video.requestFullscreen();}}catch{video.controls=false;$('playback-note').textContent='Fullscreen needs an active browser window';}});
  document.addEventListener('fullscreenchange',()=>{video.controls=document.fullscreenElement===video;$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen');});
  video.addEventListener('playing',()=>{if(document.body.dataset.playback==='paused')state.lastProgressAt=Date.now();state.receivedPlayback=true;state.fallbackFrom='';$('idle-slate').hidden=true;$('error-overlay').hidden=true;$('loading-overlay').hidden=true;$('go-live').disabled=false;status('playing','Live',`Watching live · ${feedLabel()}`);showQuality();showTheaterControls();armStallTimer();});
  video.addEventListener('waiting',()=>{if(state.started&&$('error-overlay').hidden&&(!video.paused||!state.receivedPlayback)){$('loading-overlay').hidden=false;$('loading-text').textContent=`${feedProgress('Buffering')}…`;status('buffering','Buffering',feedProgress('Waiting for'));armStallTimer();}});
  video.addEventListener('timeupdate',()=>{if(state.started&&!video.paused&&$('error-overlay').hidden&&Math.abs(video.currentTime-state.lastTime)>0.05){state.lastTime=video.currentTime;state.lastProgressAt=Date.now();armStallTimer();}});
  video.addEventListener('pause',()=>{showTheaterControls();if(state.started&&state.receivedPlayback&&$('error-overlay').hidden){clearTimeout(state.stallTimer);$('loading-overlay').hidden=true;status('paused','Paused','Paused · Press play to resume');}});
  video.addEventListener('error',()=>{if(state.started&&!state.hls&&$('error-overlay').hidden)advanceFeed('The player could not read this feed.');});
  video.addEventListener('volumechange',()=>{state.muted=video.muted;state.volume=video.volume;updateAudio();saveAudio();});video.addEventListener('loadedmetadata',showQuality);video.addEventListener('resize',showQuality);
  window.addEventListener('pagehide',()=>{clearTimeout(state.retryTimer);clearTimeout(state.stallTimer);clearTimeout(controlsTimer);guideController?.destroy();state.hls?.destroy();});
  try { setTheater(localStorage.getItem('channel-room:theater') === 'true'); } catch {}
  updateAudio();
  fetch('/api/channels').then(response=>{if(!response.ok)throw new Error('The channel list is unavailable.');return response.json();}).then(data=>{state.channels=data.channels.filter(channel=>channel.enabled!==false);renderChannels(state.channels);let last='339';try{last=localStorage.getItem('channel-room:last-channel')||last;}catch{}const initial=state.channels.find(channel=>String(channel.id)===last)||state.channels[0];if(initial){select(initial);state.feed=preferredFeed(initial);renderFeeds(initial,state.feed);}else fail('No channels are configured.');if(window.CharliflixGuide&&window.CharliflixGuideModel){guideController=window.CharliflixGuide.create({channels:state.channels,channelName:channel=>names[channel.id]||channel.name,onTune:id=>{const channel=state.channels.find(item=>item.id===String(id));if(channel)start(channel);}});}}).catch(error=>fail(error.message));
})();
