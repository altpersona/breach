// Continuous-run probe: plays from wave 1 as far as the bot can get in one life,
// so wave transitions, banners, and per-wave ring resets are exercised together.
// (test/balance.js measures waves in isolation; this measures the real run.)
'use strict';

const { boot } = require('./harness');
const { playRun } = require('./bot');

const RUNS = Number(process.argv[2] || 3);
const results = [];

for (let run = 0; run < RUNS; run++) {
  const env = boot({ search: '?selftest=1' });
  const CS = env.CS;
  CS.newGame();
  const r = playRun(env, CS, { maxSeconds: 480 });
  results.push(r);
  console.log(
    'run ' + (run + 1) +
    ': reached wave ' + String(r.wave).padStart(2) +
    ' | score ' + String(CS.world().score).padStart(6) +
    ' | kills ' + String(r.kills).padStart(3) +
    ' | ' + r.seconds.toFixed(0) + 's' +
    ' | ' + (r.byShip ? 'ship lost' : 'ring breached')
  );
}

const avg = results.reduce((a, r) => a + r.wave, 0) / results.length;
console.log('\naverage depth: wave ' + avg.toFixed(1));

const stuck = results.filter((r) => r.wave < 2);
if (stuck.length) {
  console.log('WARNING: ' + stuck.length + ' run(s) never left wave 1');
  process.exit(1);
}
console.log('every run progressed past wave 1');
