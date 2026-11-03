// Sweeps SEG_CAPACITY and reports how the damage model behaves at each value.
// Temporarily rewrites the constant, always restores the file afterwards.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = path.join(__dirname, '..', 'src', 'game.js');
const original = fs.readFileSync(FILE, 'utf8');

const CANDS = [2, 3, 4];

function restore() {
  fs.writeFileSync(FILE, original);
}

function withCapacity(cap, fn) {
  const patched = original.replace(
    /var SEG_CAPACITY = \d+;/,
    'var SEG_CAPACITY = ' + cap + ';'
  );
  if (patched === original && !/var SEG_CAPACITY = /.test(original)) {
    throw new Error('could not find SEG_CAPACITY to patch');
  }
  fs.writeFileSync(FILE, patched);
  try {
    return fn();
  } finally {
    restore();
  }
}

// In-process probe (no child process) so each capacity runs in the same node.
function probe(cap) {
  // Clear require cache so the patched source is re-read.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/test/') || k.endsWith('harness.js')) delete require.cache[k];
  }
  const { boot } = require('./harness');

  function bot(env, CS) {
    const key = (k, d) => env.dispatch(d ? 'keydown' : 'keyup', { key: k, preventDefault() {} });
    let held = null;
    return () => {
      const w = CS.world(); const p = w.player;
      const PS = 3.05 * CS.consts.PLAYER_R;
      let threat = null;
      const consider = (ang, tti) => {
        const d = CS.helpers.angDelta(ang, p.ang);
        const slack = tti - Math.abs(d) * CS.consts.PLAYER_R / PS;
        if (!threat || slack < threat.slack) threat = { ang, slack };
      };
      for (const b of w.bullets) {
        const tti = (CS.consts.RING_R - b.r) / Math.max(1, Math.abs(b.vr));
        if (tti <= 6) consider(b.ang + b.va * tti, tti);
      }
      for (const e of w.enemies) {
        if (e.type === 'boss' || e.type === 'warden') continue;
        const tti = (CS.consts.RING_R - e.r) / Math.max(1, e.vr);
        if (tti <= 4) consider(e.ang, tti);
      }
      let target = null;
      if (threat && threat.slack > -0.15) target = threat.ang;
      else {
        let best = null;
        for (const e of w.enemies) {
          const boss = (e.type === 'boss' || e.type === 'warden') ? -400 : 0;
          const lead = e.va * (Math.abs(e.r - CS.consts.PLAYER_R) / 330);
          const d = Math.abs(CS.helpers.angDelta(e.ang + lead, p.ang));
          const sc = d * CS.consts.PLAYER_R - (e.fireSlot ? 40 : 0) + e.r * 0.05 + boss;
          if (!best || sc < best.score) best = { ang: e.ang + lead, score: sc };
        }
        if (best) target = best.ang;
      }
      let want = null;
      if (target != null) {
        const d = CS.helpers.angDelta(target, p.ang);
        if (Math.abs(d) > 0.015) want = d > 0 ? 'ArrowRight' : 'ArrowLeft';
      }
      if (held && held !== want) { key(held, false); held = null; }
      if (want && held !== want) { key(want, true); held = want; }
    };
  }

  // --- continuous runs with a competent bot: how deep does it get?
  let depth = 0, runs = 3, deaths = 0;
  for (let r = 0; r < runs; r++) {
    const env = boot({ search: '?selftest=1' });
    const CS = env.CS;
    CS.newGame();
    const think = bot(env, CS);
    let t = 0;
    while (t < 480 && CS.getState() !== 'gameover') {
      CS.update(1 / 60); think(); t += 1 / 60;
    }
    depth = Math.max(depth, CS.world().wave);
    if (CS.getState() === 'gameover') deaths++;
  }

  // --- a camper on one spoke: how long does standing still survive?
  let campTimes = [];
  for (let r = 0; r < 3; r++) {
    const env = boot({ search: '?selftest=1' });
    const CS = env.CS; const w = CS.world();
    let guard = 0;
    while (w.wave < 9 && guard++ < 60000) {
      w.enemies.length = 0; w.spawnQueue.length = 0; CS.update(1 / 60);
    }
    let t = 0;
    while (t < 60 && CS.getState() === 'playing') {
      CS.update(1 / 60); t += 1 / 60;
      w.player.ang = 0;
    }
    campTimes.push(CS.getState() === 'gameover' ? t : null);
  }
  const camped = campTimes.filter((x) => x != null);
  const campAvg = camped.length ? camped.reduce((a, b) => a + b, 0) / camped.length : null;

  return { cap, depth, deaths, runs, campSurvived: camped.length, campAvg };
}

const rows = [];
try {
  for (const cap of CANDS) {
    rows.push(withCapacity(cap, () => probe(cap)));
  }
} finally {
  restore();
}

console.log('\n=== SEG_CAPACITY sweep (bullet=1, ship=2, boss=5; breach at >cap) ===\n');
console.log('cap | chip hits to breach | ships to breach | bot depth | camper on W9');
console.log('----|---------------------|-----------------|-----------|-------------');
for (const r of rows) {
  const chips = r.cap + 1;
  const ships = Math.ceil((r.cap + 1) / 2);
  const camp = r.campSurvived === 0
    ? 'died every time'
    : (r.campAvg ? 'avg ' + r.campAvg.toFixed(1) + 's' : 'survived');
  console.log(
    ' ' + r.cap + '  |          ' + chips + '          |       ' + ships +
    '         |  wave ' + String(r.depth).padStart(2) + '   | ' + camp
  );
}
console.log('\n(bot depth is the deepest wave reached across ' + rows[0].runs + ' continuous runs)');
