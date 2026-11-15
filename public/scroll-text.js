(() => {
  'use strict';
  const selector='.channel-name,.channel-now,.channel-episode,.channel-meta,.guide-programme-title,.guide-programme-episode,.guide-channel-button,#now-title';
  let scheduled=false;
  const observed=new Set();
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  const visibility=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)entry.target.classList.toggle('text-visible',entry.isIntersecting);}):null;
  function update() {
    scheduled=false;
    for(const label of observed)if(!label.isConnected){resize?.unobserve(label);visibility?.unobserve(label);observed.delete(label);}
    for(const label of document.querySelectorAll(selector)) {
      if(!label.textContent?.trim())continue;
      let track=label.firstElementChild;
      if(!track?.classList.contains('scroll-text-track')||label.children.length!==1) {
        track=document.createElement('span');track.className='scroll-text-track';
        const text=document.createElement('span');text.className='scroll-text-content';
        while(label.firstChild)text.appendChild(label.firstChild);
        const copy=document.createElement('span');copy.className='scroll-text-copy';copy.setAttribute('aria-hidden','true');
        // Render the repeated copy from an attribute, keeping textContent and
        // aria-describedby limited to the real title. Guide updates can then
        // compare titles without resetting the loop every refresh.
        track.append(text,copy);label.appendChild(track);
        label.classList.add('scroll-text');
      }
      const text=track.firstElementChild,copy=track.lastElementChild;
      if(copy.getAttribute('data-scroll-text')!==text.textContent)copy.setAttribute('data-scroll-text',text.textContent);
      if(!observed.has(label)){observed.add(label);resize?.observe(label);if(visibility)visibility.observe(label);else label.classList.add('text-visible');}
      const textWidth=text.getBoundingClientRect().width;
      const overflowing=textWidth-label.clientWidth>2&&label.clientWidth>0;
      // One complete title plus its fixed gap is the exact repeat distance.
      // At the boundary the copy occupies the original title's old position.
      const distance=textWidth+32;
      label.classList.toggle('is-overflowing',overflowing);
      label.style.setProperty('--scroll-distance',`${distance}px`);
      label.style.setProperty('--scroll-duration',`${Math.max(6,distance/24)}s`);
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
