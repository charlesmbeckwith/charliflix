'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CDNLIVE_ORIGIN, CHANNEL_SOURCE_IDS, isCdnLiveChannel, cdnLivePlayerUrl, parseCdnLiveSource, assertCdnLiveMediaUrl } = require('../lib/cdnlive-source.cjs');
const source = (id='52') => `${CDNLIVE_ORIGIN}/secure/api/v1/${CHANNEL_SOURCE_IDS[id]}/playlist.m3u8?token=fixture-token`;
const segment = (id='52') => `${CDNLIVE_ORIGIN}/stream-segment/${CHANNEL_SOURCE_IDS[id]}?d=fixture-data&token=fixture-token`;
function envelope(url=source(),prefix='data') {
  const split=[url.slice(0,7),url.slice(7,23),url.slice(23)];
  return `<script>function ${prefix}Decode(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';try{return decodeURIComponent(escape(atob(s)))}catch(e){return atob(s)}}
  ${split.map((value,index)=>`const ${prefix}Part${index}='${Buffer.from(value).toString('base64url')}';`).join('\n')}
  const ${prefix}Url=${split.map((_value,index)=>`${prefix}Decode(${prefix}Part${index})`).join('+')};</script>`;
}

test('public free player URLs are fixed to the four exact catalog network entries',()=>{
  const expected={'51':'ABC US','52':'CBS US','53':'NBC US','54':'FOX US'};
  for(const [id,name]of Object.entries(expected)){
    assert.equal(isCdnLiveChannel(id),true);
    const url=new URL(cdnLivePlayerUrl(id));
    assert.equal(url.origin,CDNLIVE_ORIGIN);
    assert.equal(url.pathname,'/api/v1/channels/player/');
    assert.deepEqual([...url.searchParams],[['name',name],['code',''],['user','cdnlivetv'],['plan','free']]);
  }
  for(const id of ['339','310','317','298','303','300','999',null,'https://attacker.example']){assert.equal(isCdnLiveChannel(id),false);assert.throws(()=>cdnLivePlayerUrl(id),/no verified/);}
});

test('the bounded decoder joins independently encoded literal data fragments without running any JavaScript',()=>{
  global.__cdnLiveExecuted=false;
  const html=envelope().replace('<script>','<script>global.__cdnLiveExecuted=true;');
  assert.equal(parseCdnLiveSource(html),source());
  assert.equal(global.__cdnLiveExecuted,false);
  delete global.__cdnLiveExecuted;
  assert.equal(parseCdnLiveSource(envelope(source('51'),'other$Name'),'51'),source('51'));
  assert.throws(()=>parseCdnLiveSource(envelope(source('51')),'52'),/does not match/);
  assert.throws(()=>parseCdnLiveSource(envelope(),'339'),/does not match/);
});

test('unsupported expressions, unresolved identifiers, malformed data and ambiguous envelopes fail safely',()=>{
  for(const html of [
    envelope().replace('dataDecode(dataPart0)+','makeUrl()+'),
    envelope().replace('dataDecode(dataPart2);','dataDecode(dataPart2)+sideEffect();'),
    envelope().replace('dataDecode(dataPart2);','dataDecode(missingPart);'),
    envelope().replace("const dataPart0='", "const dataPart0='!"),
    envelope().replace('const dataUrl=',"const dataPart0='YWJj'; const dataUrl="),
    envelope()+envelope(source('51'),'second'),
    `<!--${envelope()}-->`,
  ])assert.throws(()=>parseCdnLiveSource(html));
  for(const html of [null,Buffer.from('data'),'x'.repeat(2*1024*1024+1)])assert.throws(()=>parseCdnLiveSource(html),/too large/);
});

test('HLS sources stay inside exact verified HTTPS host, routes, channel IDs and query shape',()=>{
  for(const value of [
    source().replace('https:','http:'),source().replace('cdnlivetv.tv','cdnlivetv.tv.attacker.example'),
    source().replace('cdnlivetv.tv','user:secret@cdnlivetv.tv'),source().replace('cdnlivetv.tv','cdnlivetv.tv:8443'),
    source().replace('/secure/api/v1/','/api/v1/channels/player/'),source().replace(CHANNEL_SOURCE_IDS['52'],'000000000000000000000000'),
    source()+'&token=other',source()+'&url=https://attacker.example',source()+'#fragment',
    source().replace('fixture-token',''),source().replace('fixture-token','%0d%0a'),
  ]){assert.throws(()=>assertCdnLiveMediaUrl(value));assert.throws(()=>parseCdnLiveSource(envelope(value)));}
  assert.throws(()=>assertCdnLiveMediaUrl(source(),'https://other.example'));
});

test('registered media permits only the observed segment proxy with bounded opaque values',()=>{
  assert.equal(assertCdnLiveMediaUrl(segment()).href,segment());
  assert.equal(assertCdnLiveMediaUrl(source()).href,source());
  for(const value of [
    segment().replace('/stream-segment/','/admin/'),segment().replace('fixture-data',''),
    segment().replace('fixture-data','%0a'),segment()+'&d=other',segment()+'&callback=execute',
    segment().replace('fixture-token','x'.repeat(4097)),segment().replace('fixture-data','x'.repeat(4097)),
    segment().replace(CHANNEL_SOURCE_IDS['52'],'../../private'),segment().replace('cdnlivetv.tv','127.0.0.1'),
  ])assert.throws(()=>assertCdnLiveMediaUrl(value));
});
