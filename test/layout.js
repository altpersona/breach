// Layout probe: checks the canvas fits a range of viewports without overflowing.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
});

const VIEWPORTS = [
  { name: 'phone portrait', w: 360, h: 640 },
  { name: 'phone landscape', w: 640, h: 360 },
  { name: 'small phone', w: 320, h: 480 },
  { name: 'laptop', w: 1280, h: 720 },
  { name: 'tablet', w: 768, h: 1024 },
  { name: 'huge', w: 2560, h: 1440 },
  { name: 'tiny watch', w: 280, h: 280 },
  { name: 'narrow split', w: 300, h: 900 }
];

(async () => {
  const profile = '/tmp/cs-layout-profile';
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--mute-audio', '--remote-debugging-port=' + PORT,
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
    const m = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (m.result && m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300));
    return m.result.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(400);
  for (let i = 0; i < 60; i++) {
    if (await evaluate('typeof CS === "object"')) break;
    await sleep(150);
  }

  let bad = 0;
  for (const v of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: v.w, height: v.h, deviceScaleFactor: 1, mobile: false
    });
    // trigger the resize handler
    await evaluate('window.dispatchEvent(new Event("resize"))');
    await sleep(200);

    const r = await evaluate(`(function(){
      var c = document.getElementById('cv');
      var b = c.getBoundingClientRect();
      return {
        cw: Math.round(b.width), ch: Math.round(b.height),
        top: Math.round(b.top), left: Math.round(b.left),
        right: Math.round(b.right), bottom: Math.round(b.bottom),
        vw: window.innerWidth, vh: window.innerHeight,
        scrollW: document.documentElement.scrollWidth,
        scrollH: document.documentElement.scrollHeight
      };
    })()`);

    const fits = r.right <= r.vw + 1 && r.bottom <= r.vh + 1 &&
                 r.left >= -1 && r.top >= -1 &&
                 r.cw >= 200 && r.ch >= 200;
    if (!fits) bad++;
    console.log(
      (fits ? '  ok   ' : '  FAIL ') + v.name.padEnd(16) +
      ` ${String(v.w).padStart(4)}x${String(v.h).padStart(4)}` +
      ` -> canvas ${r.cw}x${r.ch} at (${r.left},${r.top})` +
      (fits ? '' : `  OVERFLOW right=${r.right}/${r.vw} bottom=${r.bottom}/${r.vh}`)
    );
  }

  console.log('');
  console.log(bad ? bad + ' viewport(s) broken' : 'all viewports fit');
  ws.close();
  chrome.kill();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
