'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createUpdateNotifications } = require('../mac/updates.cjs');

test('Mac checks on a finite startup schedule and notifies without ever offering unsigned installation', async()=>{
  const sent=[],timeouts=[],intervals=[];let checks=0,closed=0;
  const controller=createUpdateNotifications({send:message=>sent.push(message),checker:{async check(){checks++;return{status:'available',currentVersion:'0.3.0',latestVersion:'0.4.0',releaseUrl:'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.4.0'};},close(){closed++;}},setTimeout:(fn,ms)=>{timeouts.push({fn,ms});return 1;},setInterval:(fn,ms)=>{intervals.push({fn,ms});return 2;},clearTimeout(){},clearInterval(){}});
  controller.start();controller.start();assert.equal(checks,0);assert.equal(timeouts.length,1);assert.equal(timeouts[0].ms,10000);assert.equal(intervals[0].ms,14400000);
  timeouts[0].fn();await new Promise(setImmediate);
  assert.equal(checks,1);assert.equal(sent.at(-1).status,'available-manual');assert.equal(sent.at(-1).automatic,true);assert.equal(sent.at(-1).installMode,'manual');
  controller.request({type:'charliflix-updater',action:'restart'});assert.equal(checks,1);
  await controller.request({type:'charliflix-updater',action:'check'});assert.equal(checks,2);assert.equal(sent.at(-1).automatic,false);
  controller.close();timeouts[0].fn();intervals[0].fn();await new Promise(setImmediate);assert.equal(checks,2);assert.equal(closed,1);
});

test('Mac shutdown aborts a pending check and prevents late notifications',async()=>{
  const sent=[];let finish,closed=false;
  const controller=createUpdateNotifications({send:message=>sent.push(message),checker:{check:()=>new Promise(resolve=>{finish=resolve;}),close(){closed=true;}}});
  const pending=controller.request({type:'charliflix-updater',action:'check'});
  controller.close();finish({status:'current'});await pending;
  assert.equal(closed,true);assert.equal(sent.length,1);assert.equal(sent[0].status,'checking');
});

test('Mac preload exposes only fixed update messages and never exposes Electron event objects',()=>{
  let api,listener;const sent=[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../mac/preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld:(key,value)=>{assert.equal(key,'charliflixUpdates');api=value;}},ipcRenderer:{send:(channel,message)=>sent.push({channel,message}),on:(channel,fn)=>{assert.equal(channel,'charliflix-update-status');listener=fn;}}};}});
  api.postMessage({type:'charliflix-updater',action:'check',url:'https://attacker.example'});
  api.postMessage({type:'charliflix-updater',action:'restart'});api.postMessage({type:'other',action:'check'});
  assert.equal(sent.length,1);assert.equal(sent[0].channel,'charliflix-updater');assert.equal(sent[0].message.url,undefined);
  let response;api.onMessage(value=>{response=value;});listener({sender:'privileged'}, {status:'current'});assert.equal(response.sender,undefined);assert.equal(response.data.status,'current');
});
