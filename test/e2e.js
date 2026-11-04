// End-to-end input test against real Chrome: dispatches genuine key and pointer
// events and asserts the game actually responds. This is the only test that
// exercises the real event listeners, scaling, and boot path.
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
});

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); failures++; }
}

(async () => {
  const profile = '/tmp/cs-e2e-profile';
  fs.rmSync(profile, { recursive: true, force: true });

  const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--mute-audio', '--window-size=760,760',
    '--remote-debugging-port=' + PORT,
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
  if (!targets) { chrome.kill(); throw new Error('chrome never started'); }

  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(d.exception ? d.exception.description : d.text);
    }
  };
  const send = (method, params) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const evaluate = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (m.result && m.result.exceptionDetails) {
      throw new Error('eval: ' + JSON.stringify(m.result.exceptionDetails).slice(0, 300));
    }
    return m.result.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 760, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload', { ignoreCache: true });
  await sleep(300);

  for (let i = 0; i < 60; i++) {
    if (await evaluate('typeof CS === "object"')) break;
    await sleep(150);
  }
  check('game boots', await evaluate('typeof CS === "object"'));
  check('title screen first', (await evaluate('CS.getState()')) === 'title');

  // --- real Enter key starts the run
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(300);
  check('Enter starts the game', (await evaluate('CS.getState()')) === 'playing',
    'state=' + await evaluate('CS.getState()'));

  // --- real arrow key rotates the player
  const ang0 = await evaluate('CS.world().player.ang');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  await sleep(420);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  const ang1 = await evaluate('CS.world().player.ang');
  check('ArrowRight rotates the player', Math.abs(ang1 - ang0) > 0.05,
    `ang0=${ang0} ang1=${ang1}`);

  // --- holding left goes the other way
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  await sleep(300);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  const ang2 = await evaluate('CS.world().player.ang');
  check('ArrowLeft rotates back', Math.abs(ang2 - ang1) > 0.03, `ang1=${ang1} ang2=${ang2}`);

  // --- the player fires without being told to
  check('player auto-fires', (await evaluate('CS.world().shots.length')) > 0,
    'shots=' + await evaluate('CS.world().shots.length'));

  // --- pointer input must NOT steer the ship: navigation is left/right only
  const before = await evaluate('CS.world().player.ang');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 380, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 560, button: 'left' });
  await sleep(450);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 160, y: 560, button: 'left', clickCount: 1 });
  const after = await evaluate('CS.world().player.ang');
  check('mouse does not steer (left/right keys are the only navigation)',
    Math.abs(after - before) < 1e-9, `before=${before} after=${after}`);

  // --- P pauses, P resumes
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 });
  await sleep(200);
  check('P pauses', (await evaluate('CS.getState()')) === 'paused',
    'state=' + await evaluate('CS.getState()'));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 });
  await sleep(200);
  check('P resumes', (await evaluate('CS.getState()')) === 'playing');

  // --- M mutes
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, nativeVirtualKeyCode: 77 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, nativeVirtualKeyCode: 77 });
  await sleep(120);
  check('M toggles mute', (await evaluate('Sound.isMuted()')) === true);

  // --- canvas is scrolled into the visible layout (not clipped)
  const rect = await evaluate('(function(){var r=document.getElementById("cv").getBoundingClientRect();return {w:r.width,h:r.height,top:r.top,left:r.left};})()');
  check('canvas is laid out at a playable size', rect.w > 300 && rect.h > 300,
    JSON.stringify(rect));
  check('canvas fits inside the viewport', rect.top >= 0 && rect.left >= 0);

  // --- pixel art is actually non-blank
  const nonBlack = await evaluate(`(function(){
    var c = document.getElementById('cv');
    var g = c.getContext('2d');
    var d = g.getImageData(0,0,c.width,c.height).data;
    var n = 0;
    for (var i=0;i<d.length;i+=4) {
      if (d[i]+d[i+1]+d[i+2] > 40) n++;
    }
    return n;
  })()`);
  check('the frame is actually drawn (non-blank pixels)', nonBlack > 2000,
    'bright pixels=' + nonBlack);

  // --- the per-segment model is live: a breach needs one pool to overflow, not a
  // total-damage threshold, so verify both halves of that contract in the browser.
  await evaluate('CS.newGame()');
  await sleep(150);
  await evaluate(`(function(){
    var n = CS.consts.SEGMENTS, TAU = CS.consts.TAU, cap = CS.consts.SEG_CAPACITY;
    for (var i=0;i<n;i++) CS.ringDamage(-Math.PI + ((i+0.5)/n)*TAU, cap);
  })()`);
  const spreadState = await evaluate('CS.getState()');
  check('damage spread across every arc does not breach', spreadState === 'playing',
    'state=' + spreadState);
  const worstAtCap = await evaluate('CS.ringWorst().value === CS.consts.SEG_CAPACITY');
  check('worst arc sits exactly at capacity', worstAtCap === true);
  await evaluate('CS.ringDamage(-Math.PI + 0.02, 1)');
  // A breach starts a playout, not an instant menu: the failure must be watchable.
  const breachState = await evaluate('CS.getState()');
  check('one hit past capacity breaches the ring (into a playout)',
    breachState === 'dying', 'state=' + breachState);
  // Let the playout resolve.
  await sleep(3200);
  const settled = await evaluate('CS.getState()');
  check('the playout resolves to the summary', settled === 'gameover',
    'state=' + settled);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(400);
  check('Enter restarts after game over', (await evaluate('CS.getState()')) === 'playing');
  check('restart resets to wave 1', (await evaluate('CS.world().wave')) === 1);

  // --- phone: portrait viewport, touch emulation, genuine touch events
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.reload', { ignoreCache: true });
  await sleep(300);
  for (let i = 0; i < 60; i++) {
    if (await evaluate('typeof CS === "object"')) break;
    await sleep(150);
  }
  check('game boots in phone viewport', await evaluate('typeof CS === "object"'));
  check('phone reports a coarse pointer', (await evaluate('matchMedia("(pointer: coarse)").matches')) === true);

  const phoneRect = await evaluate('(function(){var r=document.getElementById("cv").getBoundingClientRect();return {w:r.width,h:r.height,top:r.top,left:r.left};})()');
  check('canvas fits the phone viewport', phoneRect.w > 300 && phoneRect.w <= 390 && phoneRect.h > 300 && phoneRect.top >= 0,
    JSON.stringify(phoneRect));

  // a tap starts the run from the title screen
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 700 }] });
  await sleep(150);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  check('touch tap starts the game', (await evaluate('CS.getState()')) === 'playing',
    'state=' + await evaluate('CS.getState()'));

  // the pause button is live while playing on a phone
  check('pause button visible on phone',
    (await evaluate('getComputedStyle(document.getElementById("pauseBtn")).display')) !== 'none');

  // hold the left half -> rotate left (the only navigation, like the keys)
  const ta = await evaluate('CS.world().player.ang');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: 700 }] });
  await sleep(400);
  const tb = await evaluate('CS.world().player.ang');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('touch on left half rotates left', tb < ta - 0.05, `a0=${ta} a1=${tb}`);

  // hold the right half -> rotate right
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 700 }] });
  await sleep(400);
  const tc = await evaluate('CS.world().player.ang');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('touch on right half rotates right', tc > tb + 0.05, `a1=${tb} a2=${tc}`);

  // both halves held -> braced: focus on
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: 700 }, { x: 300, y: 700 }] });
  await sleep(250);
  check('two thumbs brace with focus', (await evaluate('CS.world().focus')) === true);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  check('focus drops when thumbs lift', (await evaluate('CS.world().focus')) === false);

  // the pause button pauses; a tap anywhere resumes
  const btn = await evaluate('(function(){var r=document.getElementById("pauseBtn").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: btn.x, y: btn.y }] });
  await sleep(120);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  check('pause button pauses', (await evaluate('CS.getState()')) === 'paused',
    'state=' + await evaluate('CS.getState()'));

  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 700 }] });
  await sleep(120);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  check('tap resumes from pause', (await evaluate('CS.getState()')) === 'playing');

  check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 400));

  console.log('');
  console.log(failures ? failures + ' FAILED' : 'all e2e checks passed');

  ws.close();
  chrome.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
