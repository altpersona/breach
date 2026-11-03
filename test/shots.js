// Screenshot driver: loads the game in real Chrome via CDP and captures frames.
// Usage: node test/shots.js
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'shots');
const PORT = 9333;
const CHROME = '/usr/bin/google-chrome';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=720,720',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=/tmp/cs-chrome-profile',
    'file://' + path.join(ROOT, 'index.html')
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      targets = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
      if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  if (!targets) { chrome.kill(); throw new Error('chrome never came up'); }

  const page = targets.find((t) => t.type === 'page');
  console.log('  target url:', page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleLog = [];

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLog.push(msg.params.args.map((a) => a.value).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleLog.push('EXCEPTION: ' + (d.exception && d.exception.description || d.text));
    }
    if (msg.method === 'Log.entryAdded') {
      consoleLog.push('LOG[' + msg.params.entry.level + ']: ' + msg.params.entry.text);
    }
  };

  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  // The debugger can attach after first paint; reload so we observe a full boot.
  await send('Page.reload', { ignoreCache: true });
  await sleep(400);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 720, height: 720, deviceScaleFactor: 1, mobile: false
  });

  async function shot(name, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = Object.assign({ scale: 3 }, clip);
    const { data } = await send('Page.captureScreenshot', params);
    const p = path.join(OUT, name + '.png');
    fs.writeFileSync(p, Buffer.from(data, 'base64'));
    console.log('  wrote', path.relative(ROOT, p));
  }

  // Reset a scene to a known-clean board so screenshots do not inherit damage.
  const FRESH = `(function(){
    var w = CS.world();
    w.enemies.length = 0;
    w.bullets.length = 0;
    w.shots.length = 0;
    w.spawnQueue.length = 0;
    w.segments = w.segments.map(function(){ return 0; });
    w.breached = false;
    CS.setState('playing');
    return w.wave;
  })()`;

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error('eval failed: ' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }

  // ---- wait until the game scripts have actually executed
  let ready = false;
  for (let i = 0; i < 80; i++) {
    ready = await evaluate('typeof CS === "object" && typeof CS.newGame === "function"');
    if (ready) break;
    await sleep(150);
  }
  if (!ready) throw new Error('game never booted (CS undefined after 12s)');

  // ---- 1. title screen
  await sleep(900);
  await shot('01-title');
  console.log('  title state:', await evaluate('CS.getState()'));

  // ---- 2. start a run and let wave 1 develop
  await evaluate('CS.newGame()');
  await sleep(2600);
  await shot('02-wave1');

  // ---- 3. force a mid-game scene: many enemies, rain of fire
  await evaluate(FRESH);
  await evaluate(`(function(){
    var w = CS.world();
    w.player.ang = -Math.PI/2;
    for (var i=0;i<7;i++) CS.spawnEnemy(['drifter','spinner','turret','splitter'][i%4], i*0.85);
    for (var j=0;j<40;j++) CS.spawnBullet(j*0.157, 30 + (j%60), 40, 0.18);
    for (var k=0;k<4;k++) CS.ringDamage(k*0.5, 1);
    return w.enemies.length;
  })()`);
  await sleep(900);
  await shot('03-combat');
  // zoom on the player so the sprite and bullets can be judged at real size
  await shot('03b-detail', { x: 300, y: 60, width: 130, height: 130 });

  // ---- 4. boss
  await evaluate(FRESH);
  await evaluate(`(function(){
    var b = CS.spawnEnemy('boss', 1.2);
    b.r = 80;
    return b.type;
  })()`);
  await sleep(2600);
  await shot('04-boss');

  // ---- 4b. the new enemy set, and the second boss
  await evaluate(FRESH);
  await evaluate(`(function(){
    var w = CS.world();
    w.player.ang = -Math.PI/2;
    var types = ['lancer','weaver','rammer','sentry'];
    for (var i = 0; i < types.length; i++) {
      var e = CS.spawnEnemy(types[i], -1.1 + i * 0.62);
      e.r = 60 + i * 8;
    }
    return w.enemies.length;
  })()`);
  await sleep(900);
  await shot('04b-new-enemies');

  await evaluate(FRESH);
  await evaluate(`(function(){
    var w = CS.world();
    w.player.ang = -Math.PI/2;
    var b = CS.spawnEnemy('warden', 1.4);
    b.r = 80;
    return b.type;
  })()`);
  await sleep(2600);
  await shot('04c-warden');

  // ---- 5. low ring / danger state (stays under the budget so play continues)
  await evaluate(FRESH);
  await evaluate(`(function(){
    var w = CS.world();
    w.player.ang = 0.4;
    for (var i=0;i<3;i++) CS.spawnEnemy('turret', i*2.1);
    // Load every arc to one hit from breaching: maximum visible danger, no loss.
    var n = CS.consts.SEGMENTS, TAU = CS.consts.TAU, cap = CS.consts.SEG_CAPACITY;
    for (var k=0;k<n;k++) CS.ringDamage(-Math.PI + ((k+0.5)/n)*TAU, cap);
    return CS.ringWorst().value;
  })()`);
  await sleep(700);
  await shot('05-danger');
  console.log('  danger worst arc:', await evaluate('CS.ringWorst().value'), '/',
    await evaluate('CS.consts.SEG_CAPACITY'));

  // ---- 5. upgrade tokens in flight + a rate activation flare
  await evaluate(FRESH);
  await evaluate(`(function(){
    var w = CS.world();
    w.player.ang = 0.4;
    w.flares.length = 0;
    CS.dropPickup(0.4, 70, 'bolt');
    CS.dropPickup(1.9, 88, 'beam');
    CS.dropPickup(3.1, 55, 'missile');
    CS.dropPickup(4.6, 96, 'bolt');
    // force a spread activation so all three signature styles can be seen
    var need = CS.upgrades.bolt.need;
    for (var i = 0; i < need; i++) { CS.dropPickup(0.4, 60, 'bolt'); CS.grabPickup(); }
    return w.tokens.length;
  })()`);
  await sleep(200);
  await shot('05-tokens');
  await shot('05b-tokens-detail', { x: 250, y: 40, width: 220, height: 220 });

  // ---- 5c. timed self-repair: a damaged arc mending after a long quiet stretch
  await evaluate(FRESH);
  await evaluate(`(function(){
    var w = CS.world();
    var n = CS.consts.SEGMENTS, TAU = CS.consts.TAU;
    w.player.ang = Math.PI / 2;
    // Damage two arcs to capacity, then let the quiet clock run past the threshold.
    CS.ringDamage(Math.PI / 2, CS.consts.SEG_CAPACITY);
    CS.ringDamage(-Math.PI / 2, CS.consts.SEG_CAPACITY);
    w.segQuiet[n === 0 ? 0 : Math.floor((Math.PI/2 + Math.PI) / TAU * n)] = CS.segHealTime + 0.01;
    return CS.ringWorst().value;
  })()`);
  await sleep(400);
  await shot('05c-self-heal');

  // ---- 5d. ring damage pulse at three severities (chip / ship / boss)
  for (const [name, key] of [['05d-pulse-chip', 'DMG_BULLET'], ['05e-pulse-ship', 'DMG_SHIP'], ['05f-pulse-boss', 'DMG_BOSS']]) {
    await evaluate(FRESH);
    await evaluate(`(function(){
      var w = CS.world();
      w.player.ang = 0.4;
      CS.ringDamage(-Math.PI / 2, CS.consts['${key}']);
      return w.ringPulse;
    })()`);
    await sleep(90);
    await shot(name);
  }

  // ---- 5g. the failure playout: the run is lost but the battle resolves
  await evaluate(FRESH);
  await evaluate(`(function(){
    var w = CS.world();
    w.player.ang = -Math.PI/2;
    for (var i=0;i<6;i++) CS.spawnEnemy(['turret','weaver','sentry','drifter','spinner','rammer'][i], i*0.9);
    for (var j=0;j<12;j++) CS.spawnBullet(j*0.52, 30 + (j%50), 45, 0.12);
    // Kill the ship outright so the playout begins with live fire inbound.
    CS.playerDamage(CS.consts.PLAYER_CAPACITY + 1);
    return CS.getState();
  })()`);
  await sleep(420);
  await shot('10-playout-ship');
  console.log('  playout state:', await evaluate('CS.getState()'));

  // ---- 6. game over
  await evaluate('CS.ringDamage(2.0, CS.consts.SEG_CAPACITY + 1)');
  await sleep(1400);
  await shot('06-gameover');
  console.log('  final state:', await evaluate('CS.getState()'));

  if (consoleLog.length) {
    console.log('\n--- page console ---');
    consoleLog.forEach((l) => console.log(l));
  } else {
    console.log('\n(no console errors)');
  }

  ws.close();
  chrome.kill();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
