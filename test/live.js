// Verifies the PUBLISHED game boots in a real browser from its public URL.
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 9350; const URL = 'https://altpersona.github.io/breach/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d=''; r.on('data', c=>d+=c); r.on('end', ()=>res(d)); }).on('error', rej);
});
(async () => {
  const profile = '/tmp/cs-live-profile';
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn('/usr/bin/google-chrome', ['--headless=new','--disable-gpu','--no-sandbox',
    '--disable-dev-shm-usage','--mute-audio','--window-size=760,760',
    '--remote-debugging-port='+PORT,'--user-data-dir='+profile, URL], { stdio: 'ignore' });
  let targets = null;
  for (let i=0;i<80;i++){ try{ targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
    if (targets.some(t=>t.type==='page'&&t.webSocketDebuggerUrl)) break; }catch(e){} await sleep(250); }
  const page = targets.find(t=>t.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0; const pend=new Map(); const errors=[];
  ws.onmessage = (ev) => { const m=JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); };
  const send=(method,params)=>new Promise(res=>{const mid=++id;pend.set(mid,res);
    ws.send(JSON.stringify({id:mid,method,params:params||{}}));});
  const ev=async(x)=>{const m=await send('Runtime.evaluate',{expression:x,returnByValue:true});
    if(m.result&&m.result.exceptionDetails) throw new Error('eval: '+JSON.stringify(m.result.exceptionDetails).slice(0,200));
    return m.result.result.value;};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(2500);
  for (let i=0;i<60;i++){ if (await ev('typeof CS === "object"')) break; await sleep(250); }

  const booted = await ev('typeof CS === "object"');
  const title = await ev('document.title');
  await ev('CS.newGame()');
  for (let i=0;i<120;i++) await ev('CS.update(1/60)');
  const state = await ev('CS.getState()');
  const wave = await ev('CS.world().wave');
  const painted = await ev(`(function(){var c=document.getElementById('cv'),g=c.getContext('2d');
    var d=g.getImageData(0,0,c.width,c.height).data,n=0;
    for(var i=0;i<d.length;i+=4) if(d[i]+d[i+1]+d[i+2]>40) n++;
    return n;})()`);
  console.log('LIVE booted:', booted);
  console.log('LIVE title:', title);
  console.log('LIVE state after start:', state, '| wave:', wave);
  console.log('LIVE painted pixels:', painted);
  console.log('LIVE page errors:', errors.length ? errors.join(' | ') : 'none');
  ws.close(); chrome.kill();
  const ok = booted && state==='playing' && painted>2000 && errors.length===0;
  console.log(ok ? '\nPUBLISHED BUILD PLAYS' : '\nPUBLISHED BUILD BROKEN');
  process.exit(ok?0:1);
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
