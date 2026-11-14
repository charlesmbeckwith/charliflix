(function () {
  'use strict';
  const THEME_KEY='charliflix:theme';
  const PIP_KEY='charliflix:pip-enabled';
  const THEMES=Object.freeze(['teal','blue','purple','pink','orange','white']);
  function create(options={}) {
    const document=options.document;
    const storage=options.storage;
    const history=options.history;
    const get=id=>document?.getElementById(id);
    let theme='teal',pip=true,previousFocus=null;
    try { const saved=storage?.getItem(THEME_KEY);if(THEMES.includes(saved))theme=saved;pip=storage?.getItem(PIP_KEY)!=='false'; } catch {}
    const dialog=get('settings-dialog');
    function notice(message) { const node=get('settings-status');if(node)node.textContent=message; }
    function save(key,value) { try { if(!storage)throw new Error('Storage unavailable');storage.setItem(key,value);return true; } catch { notice('Couldn’t save this setting. It will last until the app closes.');return false; } }
    function paint() {
      if(document?.documentElement)document.documentElement.dataset.theme=theme;
      for(const button of document?.querySelectorAll('[data-theme-choice]')||[])button.setAttribute('aria-pressed',String(button.dataset.themeChoice===theme));
      if(get('settings-pip'))get('settings-pip').checked=pip;
    }
    function updateHistory() {
      let count=0;
      try { count=history?.getEntries?.().length||0; } catch {}
      if(get('settings-history-count'))get('settings-history-count').textContent=count===0?'No watched episodes yet.':`${count} watched ${count===1?'episode':'episodes'} saved.`;
      if(get('settings-clear-history'))get('settings-clear-history').disabled=count===0;
      if(!count&&get('settings-clear-confirm'))get('settings-clear-confirm').hidden=true;
    }
    function setTheme(value) {
      if(!THEMES.includes(value))return false;
      theme=value;paint();notice('');save(THEME_KEY,value);return true;
    }
    function setPictureInPictureEnabled(value) { pip=Boolean(value);paint();notice('');save(PIP_KEY,String(pip)); }
    function close() {
      if(!dialog?.open)return false;
      dialog.close();
      if(previousFocus?.isConnected!==false)previousFocus?.focus?.();
      return true;
    }
    function open() {
      if(!dialog||dialog.open)return;
      previousFocus=document.activeElement;
      if(get('settings-clear-confirm'))get('settings-clear-confirm').hidden=true;
      notice('');updateHistory();dialog.showModal();
      get('close-settings')?.focus();
    }
    for(const button of document?.querySelectorAll('[data-theme-choice]')||[])button.addEventListener('click',()=>setTheme(button.dataset.themeChoice));
    get('open-settings')?.addEventListener('click',open);
    get('close-settings')?.addEventListener('click',close);
    dialog?.addEventListener('cancel',event=>{event.preventDefault();close();});
    get('settings-pip')?.addEventListener('change',event=>setPictureInPictureEnabled(event.target.checked));
    if(get('settings-pip-section'))get('settings-pip-section').hidden=!options.android;
    get('settings-clear-history')?.addEventListener('click',()=>{get('settings-clear-confirm').hidden=false;get('settings-cancel-clear')?.focus();});
    get('settings-cancel-clear')?.addEventListener('click',()=>{get('settings-clear-confirm').hidden=true;get('settings-clear-history')?.focus();});
    get('settings-confirm-clear')?.addEventListener('click',()=>{
      try { const result=history?.clear?.();if(result===false||result?.ok===false)throw new Error('Storage unavailable');updateHistory();notice('Watched history cleared.'); }
      catch { notice('Couldn’t clear watched history. Try again.'); }
    });
    const unsubscribe=history?.subscribe?.(updateHistory);
    paint();updateHistory();
    return Object.freeze({open,close,toggle:()=>dialog?.open?close():open(),isOpen:()=>Boolean(dialog?.open),getTheme:()=>theme,setTheme,isPictureInPictureEnabled:()=>pip,setPictureInPictureEnabled,refreshHistory:updateHistory,destroy:()=>unsubscribe?.()});
  }
  if(typeof module==='object'&&module.exports)module.exports={create,THEMES,THEME_KEY,PIP_KEY};
  else {
    let storage;try{storage=window.localStorage;}catch{}
    window.CharliflixSettings=create({document,storage,history:window.CharliflixHistory,android:/CharliflixAndroid\//.test(window.navigator?.userAgent||'')});
  }
})();
