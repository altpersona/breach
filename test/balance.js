// Playability probe: drives a "competent but simple" bot that only knows how to
// run to the most urgent incoming threat, then reports how much ring integrity
// each wave costs. A fair wave is one a reasonable player can survive.
'use strict';

const { boot } = require('./harness');

function makeBot(env, CS) {
  const pKey = (k, down) => env.dispatch(down ? 'keydown' : 'keyup', { key: k, preventDefault() {} });
  let held = null;

  return function think() {
    const w = CS.world();
    const p = w.player;
    const PS = 3.05 * CS.consts.PLAYER_R;   // arc px/s while unfocused

    // --- Threat model -----------------------------------------------------
    // In this arena the player blocks exactly one spoke. So the only thing that
    // matters is: which bullet will land first, and can we get to its spoke in
    // time? Enemies are treated as threats once they are close to the ring.
    let threat = null;
    const consider = (ang, tti, kind) => {
      const d = CS.helpers.angDelta(ang, p.ang);
      const travel = Math.abs(d) * CS.consts.PLAYER_R / PS; // seconds to get there
      const slack = tti - travel;                          // >0 means reachable
      if (!threat || slack < threat.slack) threat = { ang, slack, tti, kind };      
    };

    for (const b of w.bullets) {
      const tti = (CS.consts.RING_R - b.r) / Math.max(1, Math.abs(b.vr));
      if (tti > 6) continue;
      // Where will it hit? Account for its own angular drift.
      const land = b.ang + b.va * tti;
      consider(land, tti, 'bullet');
    }
    for (const e of w.enemies) {
      if (e.type === 'boss') continue;
      // A ship close to the orbit is also a *body*: standing on its spoke means
      // colliding, which now costs hull. Treat imminent contact as a threat in its
      // own right, not just as a source of fire.
      const gap = Math.abs(e.r - CS.consts.PLAYER_R);
      if (gap < e.size + 14) {
        const d = Math.abs(CS.helpers.angDelta(e.ang, p.ang));
        const contact = (d * CS.consts.PLAYER_R) / (3.05 * CS.consts.PLAYER_R);
        consider(e.ang, contact + 0.05, 'body');
      }
      const tti = (CS.consts.RING_R - e.r) / Math.max(1, e.vr);
      if (tti > 4) continue;
      consider(e.ang, tti, 'enemy');
    }

    let want = null;
    let targetAng = null;

    if (threat && threat.slack > -0.15) {
      targetAng = threat.ang;
    } else {
      // Nothing urgent: line up on the enemy that is easiest to kill, preferring
      // token-fire enemies so they stop shooting.
      let bestE = null;
      for (const e of w.enemies) {
        // A boss is the only target that matters when it is on the field.
        const bossBias = (e.type === 'boss' || e.type === 'warden') ? -400 : 0;
        // Lead the target. A fast orbiter (spinner, 0.55 rad/s) is otherwise
        // almost unkillable: by the time shots cross the gap it has left the
        // spoke. Without this the bot stalls instead of fighting, which makes
        // the whole balance measurement meaningless.
        const lead = e.va * (Math.abs(e.r - CS.consts.PLAYER_R) / 330);
        const d = Math.abs(CS.helpers.angDelta(e.ang + lead, p.ang));
        const score = d * CS.consts.PLAYER_R - (e.fireSlot ? 40 : 0) + e.r * 0.05 + bossBias;
        if (!bestE || score < bestE.score) bestE = { ang: e.ang + lead, score };
      }
      if (bestE) targetAng = bestE.ang;
      else if (w.enemies.length) targetAng = w.enemies[0].ang;
    }

    if (targetAng != null) {
      const d = CS.helpers.angDelta(targetAng, p.ang);
      // small deadzone so the bot does not jitter
      if (Math.abs(d) > 0.015) want = d > 0 ? 'ArrowRight' : 'ArrowLeft';
    }

    if (held && held !== want) { pKey(held, false); held = null; }
    if (want && held !== want) { pKey(want, true); held = want; }
  };
}

const CSI_BIAS = 0;

function probeWave(waveTarget, opts) {
  opts = opts || {};
  const env = boot({ search: '?selftest=1' });
  const CS = env.CS;
  const world = CS.world();

  // Fast-forward to the requested wave, clearing boards.
  let guard = 0;
  while (world.wave < waveTarget && guard++ < 20000) {
    // Wipe the board to advance quickly; damage is irrelevant here.
    world.enemies.length = 0;
    world.spawnQueue.length = 0;
    CS.update(1 / 60);
  }

  const think = makeBot(env, CS);
  let maxDmg = 0;
  let maxWorst = 0;
  let t = 0;
  const dt = 1 / 60;

  while (t < (opts.seconds || 40)) {
    CS.update(dt);
    think();
    t += dt;
    maxDmg = Math.max(maxDmg, CS.ringTotal());
    maxWorst = Math.max(maxWorst, CS.ringWorst().value);
    if (CS.getState() === 'gameover') break;
    if (CS.getState() === 'waveclear') break;
  }

  return {
    wave: world.wave,
    damage: maxDmg,
    worst: maxWorst,
    budget: CS.consts.SEG_CAPACITY,
    alive: CS.getState() !== 'gameover',
    state: CS.getState(),
    kills: world.kills,
    enemiesLeft: world.enemies.length,
    bullets: world.bullets.length,
    seconds: t,
    bossHp: (world.enemies.find((e) => e.type === 'boss') || {}).hp || null,
    bossMaxHp: (world.enemies.find((e) => e.type === 'boss') || {}).maxHp || null
  };
}

console.log('\n=== bot survival per wave (budget 14, 6 trials each) ===\n');
const TRIALS = Number(process.argv[2] || 6);
const rows = [];
for (let wave = 1; wave <= 10; wave++) {
  const trials = [];
  for (let i = 0; i < TRIALS; i++) trials.push(probeWave(wave, { seconds: 60 }));
  const survived = trials.filter((r) => r.alive).length;
  const avgDmg = trials.reduce((a, r) => a + r.damage, 0) / trials.length;
  const avgWorst = trials.reduce((a, r) => a + r.worst, 0) / trials.length;
  const cap = trials[0].budget;
  // Distinguish the two ways a wave fails to clear: dying, or running out of
  // test time still fighting. Conflating them hides stalemates (a wave that can
  // never be won) as if they were ordinary difficulty.
  const cleared = trials.filter((r) => r.state === 'waveclear').length;
  const died = trials.filter((r) => r.state === 'gameover').length;
  const timedOut = trials.filter((r) => r.state === 'playing').length;
  rows.push({ wave, survived, trials: TRIALS, avgDmg, avgWorst, cleared, died, timedOut });
  console.log(
    'wave ' + String(wave).padStart(2) +
    ' | clear ' + String(cleared).padStart(2) + '/' + TRIALS +
    ' | died ' + String(died).padStart(2) +
    ' | timeout ' + String(timedOut).padStart(2) +
    ' | worst arc ' + avgWorst.toFixed(1).padStart(4) + '/' + cap +
    ' | total ' + avgDmg.toFixed(0).padStart(3)
  );
}

const walls = rows.filter((r) => r.died > 0);
const stalls = rows.filter((r) => r.timedOut > 0);
console.log('\nwaves with deaths: ' + (walls.length ? walls.map((r) => 'W' + r.wave + ' (' + r.died + '/' + r.trials + ')').join(', ') : 'none'));
console.log('waves that timed out (possible stalemate): ' +
  (stalls.length ? stalls.map((r) => 'W' + r.wave + ' (' + r.timedOut + '/' + r.trials + ')').join(', ') : 'none'));
const overall = rows.reduce((a, r) => a + r.survived, 0) / (rows.length * TRIALS);
console.log('overall survival rate: ' + (overall * 100).toFixed(0) + '%');
if (stalls.length) {
  console.log('\nWARNING: a wave that times out without dying is a grind, not a fight.');
  process.exit(1);
}
