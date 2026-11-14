'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {create,THEMES,THEME_KEY,PIP_KEY}=require('../public/settings-ui.js');

function fixture(initial={},options={}) {
  const storage=new Map(Object.entries(initial)),nodes=new Map();
  class Element {
    constructor(id){this.id=id;this.handlers={};this.dataset={};this.hidden=true;this.open=false;this.disabled=false;this.isConnected=true;this.attributes={};}
    addEventListener(name,handler){(this.handlers[name]??=[]).push(handler);}
    emit(name,extra={}){const event={target:this,preventDefault(){this.defaultPrevented=true;},...extra};for(const fn of this.handlers[name]||[])fn(event);return event;}
    setAttribute(name,value){this.attributes[name]=value;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    focus(){document.activeElement=this;}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
  const choices=THEMES.map(theme=>{const node=get('theme-'+theme);node.dataset.themeChoice=theme;return node;});
  const document={getElementById:get,documentElement:{dataset:{}},querySelectorAll:()=>choices,activeElement:get('open-settings')};
  let entries=options.entries||[],listener,clears=0;
  const history={getEntries:()=>entries,subscribe:callback=>{listener=callback;return()=>{listener=null;};},clear(){clears++;if(options.clearFails)return{ok:false};entries=[];listener?.();return{ok:true};}};
  const settings=create({document,android:options.android!==false,history,storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{if(options.storageFails)throw new Error('Storage full');storage.set(key,value);}}});
  return{get,choices,document,storage,settings,get clears(){return clears;},setEntries(value){entries=value;listener?.();},click:id=>get(id).emit('click')};
}

test('all six theme choices apply immediately and the selected color survives a new settings instance',()=>{
  const p=fixture();
  assert.deepEqual(THEMES,['teal','blue','purple','pink','orange','white']);
  for(const choice of p.choices){choice.emit('click');assert.equal(p.document.documentElement.dataset.theme,choice.dataset.themeChoice);assert.equal(choice.attributes['aria-pressed'],'true');assert.equal(p.choices.filter(item=>item.attributes['aria-pressed']==='true').length,1);}
  assert.equal(p.storage.get(THEME_KEY),'white');
  const reopened=fixture(Object.fromEntries(p.storage));
  assert.equal(reopened.settings.getTheme(),'white');
  assert.equal(reopened.document.documentElement.dataset.theme,'white');
});

test('unrecognized saved themes and arbitrary theme inputs cannot inject attributes or stored values',()=>{
  const p=fixture({[THEME_KEY]:'url(https://invalid.example)'});
  assert.equal(p.settings.getTheme(),'teal');
  for(const value of ['green','',{},null,'BLUE'])assert.equal(p.settings.setTheme(value),false);
  assert.equal(p.document.documentElement.dataset.theme,'teal');
  assert.equal(p.storage.get(THEME_KEY),'url(https://invalid.example)');
});

test('picture-in-picture starts enabled, uses its stable key and remains optional on Android',()=>{
  const p=fixture();
  assert.equal(p.settings.isPictureInPictureEnabled(),true);
  assert.equal(p.get('settings-pip-section').hidden,false);
  p.get('settings-pip').checked=false;p.get('settings-pip').emit('change');
  assert.equal(p.settings.isPictureInPictureEnabled(),false);
  assert.equal(p.storage.get(PIP_KEY),'false');
  assert.equal(fixture(Object.fromEntries(p.storage)).settings.isPictureInPictureEnabled(),false);
  assert.equal(fixture({}, {android:false}).get('settings-pip-section').hidden,true);
});

test('settings open and Back-compatible close preserve focus and do not modify playback',()=>{
  const p=fixture();
  p.click('open-settings');
  assert.equal(p.settings.isOpen(),true);
  assert.equal(p.document.activeElement.id,'close-settings');
  assert.equal(p.settings.close(),true);
  assert.equal(p.settings.isOpen(),false);
  assert.equal(p.document.activeElement.id,'open-settings');
  assert.equal(p.settings.close(),false);
  p.settings.toggle();
  const cancel=p.get('settings-dialog').emit('cancel');
  assert.equal(cancel.defaultPrevented,true);
  assert.equal(p.settings.isOpen(),false);
});

test('watched history updates its count and clearing requires the explicit confirmation action',()=>{
  const p=fixture({}, {entries:[{title:'Episode one'},{title:'Episode two'}]});
  assert.equal(p.get('settings-history-count').textContent,'2 watched episodes saved.');
  p.click('settings-clear-history');
  assert.equal(p.clears,0);
  assert.equal(p.get('settings-clear-confirm').hidden,false);
  p.click('settings-cancel-clear');
  assert.equal(p.clears,0);
  assert.equal(p.get('settings-clear-confirm').hidden,true);
  p.click('settings-clear-history');p.click('settings-confirm-clear');
  assert.equal(p.clears,1);
  assert.equal(p.get('settings-history-count').textContent,'No watched episodes yet.');
  assert.equal(p.get('settings-clear-history').disabled,true);
  p.setEntries([{title:'Another episode'}]);
  assert.equal(p.get('settings-history-count').textContent,'1 watched episode saved.');
});

test('storage and history-clear failures are visible and never claim persistent success',()=>{
  const p=fixture({}, {storageFails:true,clearFails:true,entries:[{}]});
  p.settings.setTheme('pink');
  assert.equal(p.settings.getTheme(),'pink');
  assert.equal(p.storage.get(THEME_KEY),undefined);
  assert.match(p.get('settings-status').textContent,/Couldn’t save/);
  p.click('settings-clear-history');p.click('settings-confirm-clear');
  assert.match(p.get('settings-status').textContent,/Couldn’t clear/);
  assert.equal(p.get('settings-history-count').textContent,'1 watched episode saved.');
});
