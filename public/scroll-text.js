(() => {
  'use strict';
  const selector='.channel-name,.channel-now,.channel-episode,.channel-meta,.guide-programme-title,.guide-programme-episode,.guide-channel-button';
  let scheduled=false;
  const observed=new Set();
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  const visibility=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)entry.target.classList.toggle('text-visible',entry.isIntersecting);}):null;
  function update() {
    scheduled=false;
    for(const label of observed)if(!label.isConnected){resize?.unobserve(label);visibility?.unobserve(label);observed.delete(label);}
    for(const label of document.querySelectorAll(selector)) {
      if(!label.textContent?.trim())continue;
      let text=label.firstElementChild;
      if(!text?.classList.contains('scroll-text-content')||label.children.length!==1) {
        text=document.createElement('span');text.className='scroll-text-content';
        while(label.firstChild)text.appendChild(label.firstChild);
        label.appendChild(text);
        label.classList.add('scroll-text');
      }
      if(!observed.has(label)){observed.add(label);resize?.observe(label);if(visibility)visibility.observe(label);else label.classList.add('text-visible');}
      const distance=Math.max(0,text.scrollWidth-label.clientWidth);
      label.classList.toggle('is-overflowing',distance>2&&label.clientWidth>0);
      label.style.setProperty('--scroll-distance',`${Math.ceil(distance)}px`);
      label.style.setProperty('--scroll-duration',`${Math.max(8,distance/22+4)}s`);
      if(!label.title)label.title=label.textContent;
    }
  }
  function schedule() { if(!scheduled){scheduled=true;requestAnimationFrame(update);} }
  const mutation=new MutationObserver(schedule);
  mutation.observe(document.body,{childList:true,subtree:true,characterData:true});
  window.addEventListener('resize',schedule,{passive:true});
  document.addEventListener('toggle',schedule,true);
  document.addEventListener('focusin',schedule);
  window.addEventListener('pagehide',()=>{mutation.disconnect();resize?.disconnect();visibility?.disconnect();observed.clear();});
  window.CharliflixScrollText=Object.freeze({refresh:schedule});
  schedule();
})();
