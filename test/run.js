// Continuous-run probe: plays from wave 1 as far as the bot can get in one life,
// so wave transitions, banners, and per-wave ring resets are exercised together.
// (test/balance.js measures waves in isolation; this measures the real run.)
'use strict';

const { boot } = require('./harness');

function makeBot(env, CS) {
  const pKey = (k, down) => env.dispatch(down ? 'keydown' : 'keyup', { key: k, preventDefault() {} });
  let held = null;
  return function think() {
    const w = CS.world();
    const p = w.player;
    const PS = 3.05 * CS.consts.PLAYER_R;

    let threat = null;
    const consider = (ang, tti) => {
      const d = CS.helpers.angDelta(ang, p.ang);
      const travel = Math.abs(d) * CS.consts.PLAYER_R / PS;
      const slack = tti - travel;
      if (!threat || slack < threat.slack) threat = { ang, slack };
    };
    for (const b of w.bullets) {
      const tti = (CS.consts.RING_R - b.r) / Math.max(1, Math.abs(b.vr));
      if (tti > 6) continue;
      consider(b.ang + b.va * tti, tti);
    }
    for (const e of w.enemies) {
      if (e.type === 'boss') continue;
      const tti = (CS.consts.RING_R - e.r) / Math.max(1, e.vr);
      if (tti > 4) continue;
      consider(e.ang, tti);
    }

    let targetAng = null;
    if (threat && threat.slack > -0.15) targetAng = threat.ang;
    else {
      let bestE = null;
      for (const e of w.enemies) {
        const d = Math.abs(CS.helpers.angDelta(e.ang, p.ang));
        const bossBias = e.type === 'boss' ? -400 : 0;
        const score = d * CS.consts.PLAYER_R - (e.fireSlot ? 40 : 0) + e.r * 0.05 + bossBias;
        if (!bestE || score < bestE.score) bestE = { ang: e.ang, score };
      }
      if (bestE) targetAng = bestE.ang;
    }

    let want = null;
    if (targetAng != null) {
      const d = CS.helpers.angDelta(targetAng, p.ang);
      if (Math.abs(d) > 0.015) want = d > 0 ? 'ArrowRight' : 'ArrowLeft';
    }
    if (held && held !== want) { pKey(held, false); held = null; }
    if (want && held !== want) { pKey(want, true); held = want; }
  };
}

const RUNS = Number(process.argv[2] || 3);
const results = [];

for (let run = 0; run < RUNS; run++) {
  const env = boot({ search: '?selftest=1' });
  const CS = env.CS;
  CS.newGame();
  const think = makeBot(env, CS);

  let maxWave = 1, t = 0;
  const dt = 1 / 60;

  while (t < 480 && CS.getState() !== 'gameover') {   // cap at 8 sim-minutes
    CS.update(dt);
    think();
    t += dt;
    maxWave = Math.max(maxWave, CS.world().wave);
  }

  const w = CS.world();
  results.push({ maxWave, score: w.score, kills: w.kills, t });
  console.log(
    'run ' + (run + 1) + ': reached wave ' + String(maxWave).padStart(2) +
    ' | score ' + String(w.score).padStart(6) +
    ' | kills ' + String(w.kills).padStart(3) +
    ' | ' + t.toFixed(0) + 's' +
    ' | ' + CS.getState()
  );
}

const avg = results.reduce((a, r) => a + r.maxWave, 0) / results.length;
console.log('\naverage depth: wave ' + avg.toFixed(1));
const stuck = results.filter((r) => r.maxWave < 2);
if (stuck.length) {
  console.log('WARNING: ' + stuck.length + ' run(s) never left wave 1');
  process.exit(1);
}
console.log('every run progressed past wave 1');
