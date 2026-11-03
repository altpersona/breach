// Per-wave balance probe: how does one wave go, in isolation, across N trials?
//
// Waves are reached by clearing the board, then measured with the shared bot. It
// reports four distinct outcomes because conflating them hides real problems:
//   clear   — the wave was beaten
//   died    — the player was killed
//   timeout — still fighting when the clock ran out (a stall, not difficulty)
//   worst   — the most-loaded arc, i.e. how close the ring came to breaching
'use strict';

const { boot } = require('./harness');
const { makeBot } = require('./bot');

function probeWave(waveTarget, opts) {
  opts = opts || {};
  const env = boot({ search: '?selftest=1' });
  const CS = env.CS;
  const world = CS.world();

  // Fast-forward: wipe each board to advance the director to the wave under test.
  let guard = 0;
  while (world.wave < waveTarget && guard++ < 40000) {
    world.enemies.length = 0;
    world.spawnQueue.length = 0;
    CS.update(1 / 60);
  }

  // Measure ONLY this wave: stop the moment it is cleared or the run is lost.
  //
  // NOTE the extra 'dying' clause. Losing enters a playout state before
  // 'gameover', so a loop that stops on `!== 'playing'` would exit before the
  // outcome is recorded and silently count a death as neither a clear nor a
  // death — which is how this probe once reported "0 clears, 0 deaths".
  const think = makeBot(env, CS);
  const dt = 1 / 60;
  let t = 0;
  const maxSeconds = opts.seconds || 60;
  while (t < maxSeconds) {
    const st = CS.getState();
    if (st !== 'playing' && st !== 'dying') break;   // waveclear / gameover
    CS.update(dt);
    think();
    t += dt;
  }
  // Let a playout finish so the outcome is terminal, not mid-animation.
  let settle = 0;
  while (CS.getState() === 'dying' && settle++ < 60 * 6) { CS.update(dt); t += dt; }

  return {
    state: CS.getState(),
    seconds: t,
    wave: world.wave,
    byShip: !!world.lostShip,
    ringTotal: CS.ringTotal(),
    worstArc: CS.ringWorst().value
  };
}

const TRIALS = Number(process.argv[2] || 5);
const MAX_WAVE = Number(process.argv[3] || 10);

// Read capacity once, from a throwaway boot, so it cannot drift from the game.
const CAP = boot({ search: '?selftest=1' }).CS.consts.SEG_CAPACITY;

console.log('\n=== bot survival per wave (' + TRIALS + ' trials each) ===\n');
const rows = [];
for (let wave = 1; wave <= MAX_WAVE; wave++) {
  const trials = [];
  for (let i = 0; i < TRIALS; i++) trials.push(probeWave(wave, { seconds: 60 }));

  const cleared = trials.filter((r) => r.state === 'waveclear').length;
  const died = trials.filter((r) => r.state === 'gameover').length;
  const timedOut = trials.filter((r) => r.state === 'playing').length;
  const avgWorst = trials.reduce((a, r) => a + r.worstArc, 0) / trials.length;
  const avgTotal = trials.reduce((a, r) => a + r.ringTotal, 0) / trials.length;

  rows.push({ wave, cleared, died, timedOut, trials: TRIALS });

  console.log(
    'wave ' + String(wave).padStart(2) +
    ' | clear ' + String(cleared).padStart(2) + '/' + TRIALS +
    ' | died ' + String(died).padStart(2) +
    ' | timeout ' + String(timedOut).padStart(2) +
    ' | worst arc ' + avgWorst.toFixed(1).padStart(4) + '/' + CAP +
    ' | total ' + avgTotal.toFixed(0).padStart(3)
  );
}

const stalls = rows.filter((r) => r.timedOut > 0);
const deaths = rows.filter((r) => r.died > 0);

console.log('\nwaves with deaths: ' + (deaths.length
  ? deaths.map((r) => 'W' + r.wave + ' (' + r.died + '/' + r.trials + ')').join(', ')
  : 'none'));
console.log('waves that timed out (possible stalemate): ' + (stalls.length
  ? stalls.map((r) => 'W' + r.wave + ' (' + r.timedOut + '/' + r.trials + ')').join(', ')
  : 'none'));

const survived = rows.reduce((a, r) => a + (r.trials - r.died), 0);
const total = rows.length * TRIALS;
console.log('overall survival rate: ' + (survived / total * 100).toFixed(0) + '%');

if (stalls.length) {
  console.log('\nWARNING: a wave that times out without dying is a grind, not a fight.');
  process.exit(1);
}
