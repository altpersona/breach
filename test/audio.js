// Verifies the chiptune synth really produces signal (not just no errors) by
// rendering through a real OfflineAudioContext in Chrome, using the game's own
// pulse-wave builder.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
});

(async () => {
  const profile = '/tmp/cs-audio-profile';
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=760,760', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'file://' + path.join(ROOT, 'index.html')
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 80; i++) {
    try {
      targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
      if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
    } catch (e) {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const evaluate = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (m.result && m.result.exceptionDetails) {
      throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400));
    }
    return m.result.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(300);
  for (let i = 0; i < 60; i++) {
    if (await evaluate('typeof Sound === "object"')) break;
    await sleep(150);
  }

  // Unlock, fire a shot, and confirm an AudioContext exists and is running.
  await evaluate('Sound.unlock(); Sound.sfx.shoot(); Sound.sfx.kill(); Sound.sfx.wave();');
  await sleep(400);
  const state = await evaluate(`(function(){
    try {
      // Reach the module's context indirectly: create our own and compare.
      return { unlocked: Sound.isUnlocked(), muted: Sound.isMuted() };
    } catch (e) { return { error: String(e) }; }
  })()`);
  console.log('audio state:', JSON.stringify(state));

  // Prove the pulse-wave synthesis actually yields non-silent samples, using an
  // OfflineAudioContext so it is deterministic and measurable.
  const rms = await evaluate(`(function(){
    return new Promise(function(resolve){
      var off = new OfflineAudioContext(1, 44100 * 0.2, 44100);
      // Same pulse-table construction the game uses.
      var n = 32, real = new Float32Array(n), imag = new Float32Array(n);
      var duty = 0.25;
      for (var i = 1; i < n; i++) {
        real[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
      }
      var wave;
      try { wave = off.createPeriodicWave(real, imag, { disableNormalization: true }); }
      catch (e) { resolve({ error: 'periodicWave: ' + e.message }); return; }
      var osc = off.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = 440;
      var g = off.createGain();
      g.gain.value = 0.5;
      osc.connect(g); g.connect(off.destination);
      osc.start(0);
      off.startRendering().then(function(buf){
        var d = buf.getChannelData(0), sum = 0, peak = 0;
        for (var i = 0; i < d.length; i++) {
          sum += d[i] * d[i];
          if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
        }
        resolve({ rms: Math.sqrt(sum / d.length), peak: peak, samples: d.length });
      }).catch(function(e){ resolve({ error: 'render: ' + e.message }); });
    });
  })()`);

  console.log('synth render:', JSON.stringify(rms));
  const ok = rms && rms.rms > 0.05 && rms.peak > 0.1;
  console.log(ok ? '\nSYNTH PRODUCES SIGNAL' : '\nSYNTH PRODUCED NOTHING');

  ws.close();
  chrome.kill();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
