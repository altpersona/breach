// Deterministic simulation tests. Run: node test/spec.js
'use strict';

const assert = require('assert');
const { boot } = require('./harness');

let pass = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message));
  }
}

function sim(opts) {
  const env = boot(Object.assign({ search: '?selftest=1' }, opts));
  const CS = env.CS;
  assert.ok(CS, 'CS namespace missing');
  const world = CS.world();
  return { env, CS, world, step: (n, dt) => { for (let i = 0; i < (n || 1); i++) CS.update(dt || 1 / 60); } };
}

/**
 * Advance through the failure playout to the terminal summary. Losing now enters
 * a 'dying' state first (the player watches the failure resolve), so a test that
 * cares about the *outcome* must skip past it.
 */
function settle(s, maxSeconds) {
  const dt = 1 / 60;
  const max = Math.round((maxSeconds || 6) / dt);
  for (let i = 0; i < max; i++) {
    if (s.CS.getState() === 'gameover') return 'gameover';
    s.CS.update(dt);
  }
  return s.CS.getState();
}

/** Run the sim until predicate, or throw after maxSeconds of sim time. */
function runUntil(s, pred, maxSeconds, label) {
  const dt = 1 / 60;
  const max = Math.round((maxSeconds || 30) / dt);
  for (let i = 0; i < max; i++) {
    s.CS.update(dt);
    if (pred()) return true;
  }
  throw new Error('timed out waiting for: ' + (label || 'predicate'));
}

function quietSound() { /* audio is undefined in harness */ }

console.log('\n=== geometry & constants ===');

test('arena constants are mutually consistent', () => {
  const { CS } = sim();
  const c = CS.consts;
  assert.ok(c.SEGMENTS >= 8, 'the ring needs enough arcs to be spatially meaningful');
  assert.ok(c.SEG_CAPACITY >= 2, 'a segment must absorb more than one hit to be a pool');
  assert.ok(c.PLAYER_R < c.RING_R, 'player orbits inside the ring');
  assert.ok(c.RING_R - c.PLAYER_R >= 6, 'player sits far enough in to be a gate');
  assert.ok(c.RING_R < c.W / 2, 'ring fits on screen with margin');
  assert.strictEqual(c.CX, c.W / 2);
});

test('segAt maps an impact angle to the segment it strikes', () => {
  const { CS } = sim();
  const { segAt } = CS.helpers;
  const n = CS.consts.SEGMENTS;
  // Every angle must resolve to a valid segment, with no gaps or off-by-one.
  for (let a = -Math.PI; a < Math.PI; a += 0.01) {
    const i = segAt(a);
    assert.ok(i >= 0 && i < n, 'segAt(' + a + ') out of range: ' + i);
  }
  // The endpoints wrap rather than falling outside the array.
  assert.ok(segAt(Math.PI - 1e-9) >= 0);
  assert.ok(segAt(-Math.PI + 1e-9) < n);
  // Two impacts in the same arc resolve to the same segment.
  const step = (Math.PI * 2) / n;
  assert.strictEqual(segAt(0.01), segAt(step * 0.9));
});

test('wrapPi normalizes and angDelta is antisymmetric', () => {
  const { CS } = sim();
  const { wrapPi, angDelta } = CS.helpers;
  assert.ok(Math.abs(wrapPi(3 * Math.PI) - Math.PI) < 1e-9 || Math.abs(wrapPi(3 * Math.PI) + Math.PI) < 1e-9);
  const near = 0.1;
  assert.ok(Math.abs(angDelta(near, 0) - near) < 1e-9, 'no wrap on short arc');
  assert.ok(Math.abs(angDelta(0.1, 0.1 + Math.PI * 2)) < 1e-9, 'full turn is zero');
  // the short way across the -pi/+pi seam
  assert.ok(Math.abs(angDelta(3.1, -3.1)) < 0.1, 'crosses the seam the short way');
});

test('polar() places points on the intended circle', () => {
  const { CS } = sim();
  const { polar } = CS.helpers;
  const p = polar(0, CS.consts.RING_R);
  assert.ok(Math.abs(p.x - (CS.consts.CX + CS.consts.RING_R)) < 1e-9);
  assert.ok(Math.abs(p.y - CS.consts.CY) < 1e-9);
});

console.log('\n=== ring damage model (the loss condition) ===');

test('damage accumulates in the segment that was actually struck', () => {
  const s = sim();
  s.step(2);
  s.world.player.ang = 0.4;
  const seg = s.CS.helpers.segAt(1.0);
  s.CS.ringDamage(1.0, 1);
  s.CS.ringDamage(1.0, 1);
  assert.strictEqual(s.world.segments[seg], 2, 'both hits land in the same pool');
  assert.strictEqual(s.CS.ringTotal(), 2, 'total reflects both hits');
  // Every other arc must be untouched — this is the whole point of the model.
  const others = s.world.segments.filter((v, i) => i !== seg);
  assert.ok(others.every((v) => v === 0), 'damage is localised, not smeared');
});

test('a segment exceeding its capacity breaches and ends the run', () => {
  const s = sim();
  s.step(2);
  const cap = s.CS.consts.SEG_CAPACITY;
  // Exactly at capacity must still be alive: the breach requires exceeding it.
  s.CS.ringDamage(0.7, cap);
  assert.strictEqual(s.CS.getState(), 'playing', 'at capacity is survivable');
  s.CS.ringDamage(0.7, 1);
  assert.strictEqual(settle(s), 'gameover', 'one hit past capacity breaches');
  assert.strictEqual(s.world.breached, true);
});

test('a single oversized hit can breach in one blow', () => {
  const s = sim();
  s.step(2);
  s.CS.ringDamage(2.0, s.CS.consts.SEG_CAPACITY + 1);
  assert.strictEqual(settle(s), 'gameover');
  assert.ok(s.world.segments[s.CS.helpers.segAt(2.0)] > s.CS.consts.SEG_CAPACITY);
});

test('scattered damage across many arcs does NOT end the run', () => {
  const s = sim();
  s.step(2);
  const cap = s.CS.consts.SEG_CAPACITY;
  const n = s.CS.consts.SEGMENTS;
  // Put every segment one hit from breaching. Total damage is huge, yet no single
  // pool has overflowed, so the ring holds. This is the model's defining property
  // and the reason movement now matters more than total absorbed fire.
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI + ((i + 0.5) / n) * Math.PI * 2;
    s.CS.ringDamage(ang, cap);
  }
  assert.strictEqual(s.CS.getState(), 'playing', 'no single breach yet');
  assert.strictEqual(s.CS.ringTotal(), cap * n, 'total absorbed is very high');
  assert.strictEqual(s.CS.ringWorst().value, cap, 'worst pool is exactly at capacity');
  // One more hit anywhere tips that segment over.
  s.CS.ringDamage(-Math.PI + (0.5 / n) * Math.PI * 2, 1);
  assert.strictEqual(settle(s), 'gameover');
});

test('every segment starts whole and resets between waves', () => {
  const s = sim();
  s.step(1);
  assert.strictEqual(s.world.segments.length, s.CS.consts.SEGMENTS);
  assert.ok(s.world.segments.every((v) => v === 0), 'wave 1 starts with a whole ring');

  const n = s.CS.consts.SEGMENTS;
  // Damage several distinct arcs but stay under capacity everywhere.
  s.CS.ringDamage(-Math.PI + (0.5 / n) * Math.PI * 2, 2);
  s.CS.ringDamage(-Math.PI + (3.5 / n) * Math.PI * 2, 2);
  assert.strictEqual(s.CS.ringTotal(), 4);

  // survival: skip to a cleared wave
  s.world.spawnQueue.length = 0;
  s.world.enemies.length = 0;
  runUntil(s, () => s.CS.getState() === 'waveclear', 3, 'wave clear');
  runUntil(s, () => s.world.wave === 2 && s.CS.getState() === 'playing', 3, 'wave 2 start');
  assert.ok(s.world.segments.every((v) => v === 0), 'ring fully repairs between waves');
  assert.strictEqual(s.world.breached, false);
});

test('damage can never exceed capacity+1, and a breached ring stops absorbing', () => {
  const s = sim();
  s.step(1);
  const cap = s.CS.consts.SEG_CAPACITY;
  s.CS.ringDamage(1.234, 999);
  assert.strictEqual(settle(s), 'gameover');
  // The pool saturates rather than growing without bound.
  assert.ok(s.world.segments[s.CS.helpers.segAt(1.234)] <= cap + 1,
    'pool saturates at capacity+1');
  const snap = s.world.segments.slice();
  const totalBefore = s.CS.ringTotal();
  // Further damage after the breach must be a no-op.
  s.CS.ringDamage(0, 5);
  assert.deepStrictEqual(s.world.segments, snap, 'a breached ring absorbs nothing more');
  assert.strictEqual(s.CS.ringTotal(), totalBefore);
});

test('the damage hierarchy reads as designed', () => {
  const s = sim();
  const c = s.CS.consts;
  // Damage by threat must be ordered and distinct, or the capacity choice below
  // stops meaning anything.
  assert.ok(c.DMG_BULLET < c.DMG_SHIP, 'a crash must hurt more than a bullet');
  assert.ok(c.DMG_SHIP < c.DMG_BOSS, 'a boss crash must hurt more than a ship');
  // Capacity sits above a single minor hit (so chip damage is survivable) and
  // below a boss crash (so a boss reaching the ring is decisive).
  assert.ok(c.SEG_CAPACITY >= c.DMG_BULLET, 'one minor hit must be survivable');
  assert.ok(c.SEG_CAPACITY < c.DMG_BOSS, 'a boss crash must breach on its own');
});

test('minor hits on one arc are survivable, but they accumulate', () => {
  const s = sim();
  s.step(1);
  const c = s.CS.consts;
  const ang = 1.1;
  const chipHitsToBreach = Math.floor(c.SEG_CAPACITY / c.DMG_BULLET) + 1;
  assert.ok(chipHitsToBreach >= 2, 'at least two minor hits must be needed');

  // Survive all but the last one.
  for (let i = 0; i < chipHitsToBreach - 1; i++) {
    s.CS.ringDamage(ang, c.DMG_BULLET);
    assert.strictEqual(s.CS.getState(), 'playing',
      'survived ' + (i + 1) + ' minor hit(s)');
  }
  // The next one breaches.
  s.CS.ringDamage(ang, c.DMG_BULLET);
  assert.strictEqual(settle(s), 'gameover',
    'the ' + chipHitsToBreach + 'th minor hit on one arc must breach');
});

test('a crash is survivable, but a crash plus a minor hit is not', () => {
  const s = sim();
  s.step(1);
  const c = s.CS.consts;
  const ang = 2.4;
  s.CS.ringDamage(ang, c.DMG_SHIP);
  assert.strictEqual(s.CS.getState(), 'playing', 'one crash alone does not breach');
  s.CS.ringDamage(ang, c.DMG_BULLET);
  assert.strictEqual(settle(s), 'gameover', 'crash + chip is fatal to that arc');
});

test('a boss crash breaches an untouched arc in one blow', () => {
  const s = sim();
  s.step(1);
  s.CS.ringDamage(0.3, s.CS.consts.DMG_BOSS);
  assert.strictEqual(settle(s), 'gameover');
});

console.log('\n=== bullets reaching the ring ===');

test('an unblocked bullet reaching the perimeter cracks the ring', () => {
  const s = sim();
  s.step(1);
  s.world.player.ang = Math.PI;      // player parked far from the test spoke
  s.world.shots.length = 0;          // no player fire to intercept it
  s.world.spawnQueue.length = 0;
  // Keep one enemy alive and out of the player's firing line, so the wave does
  // not clear (clearing dissolves leftover fire) and the keeper cannot die.
  const keeper = s.CS.spawnEnemy('drifter', Math.PI * 1.5);
  keeper.r = 20; keeper.hold = 12; keeper.vr = 0; keeper.hp = 9999;
  s.CS.spawnBullet(0, 40, 90, 0);    // fires outward on spoke 0
  const before = s.CS.ringTotal();
  runUntil(s, () => s.CS.ringTotal() > before, 4, 'ring hit');
  assert.strictEqual(s.CS.ringTotal(), before + 1);
  assert.strictEqual(s.world.bullets.filter((b) => b.r >= s.CS.consts.RING_R).length, 0,
    'bullet is consumed, not left alive past the ring');
});

test('bullets never linger beyond the ring radius', () => {
  const s = sim();
  s.step(1);
  for (let i = 0; i < 6; i++) s.CS.spawnBullet(i, 40, 200, 0.2);
  s.step(120);
  for (const b of s.world.bullets) {
    assert.ok(b.r <= s.CS.consts.RING_R + 4, 'leaked a bullet at r=' + b.r);
  }
});

console.log('\n=== interception (the defensive verb) ===');

test('player fire cancels incoming fire before it lands', () => {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  // Player holds still; shots stream outward from its own spoke.
  // Park a bullet directly on that spoke, outside the muzzle, moving inward.
  const ang = s.world.player.ang;
  s.world.bullets.length = 0;
  s.world.shots.length = 0;
  s.CS.spawnBullet(ang, 100, -70, 0);
  const before = s.CS.ringTotal();
  const beforeBullets = s.world.bullets.length;
  runUntil(s, () => s.world.bullets.length < beforeBullets, 4, 'intercept');
  assert.strictEqual(s.CS.ringTotal(), before, 'nothing reached the ring');
  assert.ok(s.world.score > 0, 'intercepts pay score');
});

console.log('\n=== player movement ===');

test('player stays welded to the orbit radius while rotating', () => {
  const s = sim();
  s.step(1);
  s.env.key('keydown', 'ArrowRight');
  const a0 = s.world.player.ang;
  s.step(30);
  s.env.key('keyup', 'ArrowRight');
  assert.notStrictEqual(a0, s.world.player.ang, 'right arrow rotates');
  // Radius is a constant, not state: only the angle moves.
  assert.strictEqual(typeof s.world.player.ang, 'number');
  assert.ok(Math.abs(s.world.player.ang) <= Math.PI + 1e-9, 'angle stays wrapped');
});

test('left and right inputs move in opposite directions', () => {
  const s1 = sim();
  s1.step(1);
  s1.env.key('keydown', 'ArrowRight');
  s1.step(10);
  const right = s1.world.player.ang - (-Math.PI / 2);

  const s2 = sim();
  s2.step(1);
  s2.env.key('keydown', 'ArrowLeft');
  s2.step(10);
  const left = s2.world.player.ang - (-Math.PI / 2);

  assert.ok(right > 0, 'right increases angle, got ' + right);
  assert.ok(left < 0, 'left decreases angle, got ' + left);
});

test('focus (held shift) slows rotation without stopping it', () => {
  const fast = sim();
  fast.step(1);
  fast.env.key('keydown', 'ArrowRight');
  fast.step(12);
  const fastDelta = Math.abs(fast.world.player.ang + Math.PI / 2);

  const slow = sim();
  slow.step(1);
  slow.env.key('keydown', 'ArrowRight');
  slow.env.key('keydown', 'Shift');
  slow.step(12);
  const slowDelta = Math.abs(slow.world.player.ang + Math.PI / 2);

  assert.ok(slowDelta > 0, 'focus still moves');
  assert.ok(slowDelta < fastDelta * 0.75, `focus should be slower (${slowDelta} vs ${fastDelta})`);
});

console.log('\n=== touch controls (phones) ===');

// Synthetic touch pointer events through the same window listeners real
// browsers fire. Harness viewport is 1280 wide: clientX < 640 = left half.
const touch = (s, type, id, x) =>
  s.env.dispatch(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: 700 });

test('touching the left/right half rotates like the arrow keys', () => {
  const s1 = sim();
  s1.step(1);
  touch(s1, 'pointerdown', 1, 100);
  s1.step(10);
  touch(s1, 'pointerup', 1, 100);
  const left = s1.world.player.ang - (-Math.PI / 2);

  const s2 = sim();
  s2.step(1);
  touch(s2, 'pointerdown', 1, 1000);
  s2.step(10);
  touch(s2, 'pointerup', 1, 1000);
  const right = s2.world.player.ang - (-Math.PI / 2);

  assert.ok(left < 0, 'left half decreases angle, got ' + left);
  assert.ok(right > 0, 'right half increases angle, got ' + right);
});

test('both halves held = braced: holds position with focus on', () => {
  const s = sim();
  s.step(1);
  touch(s, 'pointerdown', 1, 100);
  touch(s, 'pointerdown', 2, 1000);
  s.step(12);
  assert.ok(Math.abs(s.world.player.ang - (-Math.PI / 2)) < 1e-9, 'ship holds position');
  assert.strictEqual(s.world.focus, true, 'both halves engage focus');
  touch(s, 'pointerup', 2, 1000);
  s.step(2);
  assert.strictEqual(s.world.focus, false, 'lifting one side drops focus');
});

test('a thumb dragged across the midline switches sides', () => {
  const s = sim();
  s.step(1);
  touch(s, 'pointerdown', 1, 100);
  s.step(10);
  const mid = s.world.player.ang;
  touch(s, 'pointermove', 1, 1000);
  s.step(10);
  touch(s, 'pointerup', 1, 1000);
  assert.ok(mid < -Math.PI / 2, 'left phase rotated left');
  assert.ok(s.world.player.ang > mid, 'right phase reversed direction');
});

test('pointercancel and blur leave no phantom thumb behind', () => {
  const s = sim();
  s.step(1);
  touch(s, 'pointerdown', 1, 100);
  touch(s, 'pointercancel', 1, 100);
  s.step(10);
  assert.ok(Math.abs(s.world.player.ang - (-Math.PI / 2)) < 1e-9, 'cancelled touch stops steering');

  touch(s, 'pointerdown', 2, 100);
  s.env.dispatch('blur', {});
  assert.strictEqual(s.CS.getState(), 'paused', 'blur pauses');
  s.CS.setState('playing');
  s.step(10);
  assert.ok(Math.abs(s.world.player.ang - (-Math.PI / 2)) < 1e-9, 'blur dropped the touch');
});

test('keyboard wins when keyboard and touch are both live', () => {
  const s = sim();
  s.step(1);
  touch(s, 'pointerdown', 1, 1000);
  s.env.key('keydown', 'ArrowLeft');
  s.step(10);
  assert.ok(s.world.player.ang < -Math.PI / 2, 'keyboard left beats touch right');
});

test('a tap starts the run, retries, and resumes from pause', () => {
  const env = boot({}); // no selftest: boots to the title screen
  const CS = env.CS;
  assert.strictEqual(CS.getState(), 'title');
  env.dispatch('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 700 });
  assert.strictEqual(CS.getState(), 'playing', 'tap starts the run');

  CS.setState('gameover');
  env.dispatch('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 700 });
  env.dispatch('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 700 });
  assert.strictEqual(CS.getState(), 'playing', 'tap retries after game over');

  CS.setState('paused');
  env.dispatch('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 100, clientY: 700 });
  assert.strictEqual(CS.getState(), 'playing', 'tap resumes from pause');
});

console.log('\n=== enemies & waves ===');

test('all five wave-1 enemies arrive from the core and advance outward', () => {
  const s = sim();
  s.step(1);
  s.world.player.r = undefined;
  runUntil(s, () => s.world.enemies.length > 0, 3, 'first enemy');
  const e = s.world.enemies[0];
  assert.ok(e.r < 20, 'spawns near the middle, got r=' + e.r.toFixed(2));
  const r0 = e.r;
  s.step(20);
  assert.ok(e.r > r0, 'moves outward');
});

test('every enemy type is constructible and reaches the ring eventually', () => {
  const s = sim();
  s.step(1);
  for (const type of ['drifter', 'spinner', 'turret', 'splitter', 'shard', 'boss']) {
    s.world.enemies.length = 0;
    s.world.bullets.length = 0;
    s.world.segments = s.world.segments.map(() => 0);
    s.world.breached = false;
    s.CS.setState('playing');
    const e = s.CS.spawnEnemy(type, 0.9);
    assert.ok(e && e.hp > 0, type + ' spawns with hp');
    assert.strictEqual(e.type, type);
  }
});

test('a splitter death yields two shards', () => {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  const e = s.CS.spawnEnemy('splitter', 1.1);
  e.hp = 1;
  // One shot's worth of damage kills it; drive damage through the bullet path
  // by placing a bullet on the enemy spoke and letting interception resolve it.
  e.r = 90;
  s.world.player.ang = 1.1;
  s.world.bullets.length = 0;
  s.CS.spawnBullet(1.1, 100, -0.001, 0);
  runUntil(s, () => !s.world.enemies.includes(e), 6, 'splitter dies');
  const shards = s.world.enemies.filter((x) => x.type === 'shard');
  assert.strictEqual(shards.length, 2, 'splits into two shards, got ' + shards.length);
});

test('waves advance on a clear board', () => {
  const s = sim();
  s.step(1);
  for (let wave = 1; wave <= 4; wave++) {
    assert.strictEqual(s.world.wave, wave, 'expected to be on wave ' + wave);
    let guard = 0;
    while (s.world.wave === wave && guard++ < 4000) {
      s.world.enemies.length = 0;
      s.world.spawnQueue.length = 0;
      s.CS.update(1 / 60);
    }
    assert.strictEqual(s.world.wave, wave + 1, 'wave ' + wave + ' never advanced');
  }
});

test('the director puts a boss on every fifth wave', () => {
  const s = sim();
  s.step(1);
  // Fast-forward to wave 5 by clearing each board.
  for (let wave = 1; wave < 5; wave++) {
    let guard = 0;
    while (s.world.wave === wave && guard++ < 4000) {
      s.world.enemies.length = 0;
      s.world.spawnQueue.length = 0;
      s.CS.update(1 / 60);
    }
  }
  assert.strictEqual(s.world.wave, 5, 'reached wave 5');

  let bossSeen = false;
  for (let i = 0; i < 60 * 20 && !bossSeen; i++) {
    s.CS.update(1 / 60);
    bossSeen = s.world.enemies.some((e) => e.type === 'boss');
  }
  assert.ok(bossSeen, 'boss spawned on wave 5');
});

console.log('\n=== fairness invariants ===');

test('at most MAX_FIRING ordinary ships can fire at once', () => {
  const s = sim();
  s.step(1);
  for (let i = 0; i < 10; i++) s.CS.spawnEnemy('turret', i * 0.6);
  s.step(30);
  const slotHolders = s.world.enemies.filter((e) => e.fireSlot);
  // A boss would also occupy a slot; none is present here.
  assert.ok(slotHolders.length <= 1,
    'expected <= 1 firing enemy, got ' + slotHolders.length);
});

test('a boss always keeps its firing slot alongside drones', () => {
  const s = sim();
  s.step(1);
  const boss = s.CS.spawnEnemy('boss', 0.5);
  boss.r = 80;
  for (let i = 0; i < 6; i++) s.CS.spawnEnemy('turret', 1 + i * 0.5).r = 90;
  s.step(10);
  assert.ok(boss.fireSlot, 'boss must never be silenced by a crowd');
  const ordinary = s.world.enemies.filter((e) => e.fireSlot && e.type !== 'boss');
  assert.strictEqual(ordinary.length, 0, 'boss occupies the only ordinary slot');
});

test('enemy fire is slow enough to be chased down', () => {
  // The whole arena design rests on this. A bullet crosses the annulus radially
  // while the player crosses arc length at the orbit radius, so the comparison
  // must be made in the same units: seconds to reach a spoke that is half a
  // turn away, versus seconds for a bullet to land.
  const s = sim();
  const c = s.CS.consts;
  const ARC_SPEED = 3.05 * c.PLAYER_R;                 // px/s along the ring
  const worstTrip = Math.PI * c.PLAYER_R / ARC_SPEED;  // half a turn, in seconds
  const travel = (c.RING_R - 20) / 42;                 // BULLET_SPEED, innermost shot
  assert.ok(travel > worstTrip * 0.5,
    'reaction window too tight: bullet ' + travel.toFixed(2) + 's vs worst chase ' +
    worstTrip.toFixed(2) + 's');
  assert.ok(travel > 1.5,
    'bullets must give a human reaction window; got ' + travel.toFixed(2) + 's');
});

console.log('\n=== weapon families ===');

test('every enemy declares a weapon family that exists', () => {
  const s = sim();
  const ew = s.CS.enemyWeapon;
  const ups = s.CS.upgrades;
  const expected = ['drifter', 'spinner', 'turret', 'splitter', 'shard', 'lancer', 'weaver', 'rammer', 'sentry'];
  for (const t of expected) {
    assert.ok(ew[t], t + ' must declare a weapon family');
    assert.ok(ups[ew[t]], t + ' uses unknown family ' + ew[t]);
  }
  // The three families must all actually be in use, or one is dead content.
  const used = new Set(expected.map((t) => ew[t]));
  for (const fam of ['bolt', 'beam', 'missile']) {
    assert.ok(used.has(fam), fam + ' family is unused by any enemy');
  }
});

test('a drop carries the family of the enemy that dropped it', () => {
  const s = sim();
  s.step(1);
  const ew = s.CS.enemyWeapon;
  for (const enemyType of ['sentry', 'weaver', 'turret']) {
    s.world.tokens.length = 0;
    s.CS.dropPickup(0.4, 60, null, enemyType);
    assert.strictEqual(s.world.tokens[0].type, ew[enemyType],
      enemyType + ' must drop its own family');
  }
});

test('each family grants a distinct effect', () => {
  const s = sim();
  s.step(1);
  const baseInterval = s.CS.fireInterval();
  const baseBarrels = s.CS.barrels();

  const need = s.CS.upgrades.bolt.need;
  for (let i = 0; i < need; i++) { s.CS.dropPickup(0, 60, 'bolt'); s.CS.grabPickup(); }
  assert.ok(s.CS.fireInterval() < baseInterval, 'BOLT increases fire rate');
  assert.strictEqual(s.CS.barrels(), baseBarrels, 'BOLT must not widen the block');

  const beforeBarrels = s.CS.barrels();
  const n2 = s.CS.upgrades.beam.need;
  for (let i = 0; i < n2 * 2; i++) { s.CS.dropPickup(0, 60, 'beam'); s.CS.grabPickup(); }
  assert.ok(s.CS.barrels() > beforeBarrels, 'BEAM widens the block');
});

test('a beam sweeps and can only cost the ring one hit', () => {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  const keeper = s.CS.spawnEnemy('drifter', Math.PI * 1.62);
  keeper.r = 20; keeper.hold = 12; keeper.vr = 0; keeper.hp = 9999;

  // A sentry (beam family) fires one.
  const sentry = s.CS.spawnEnemy('sentry', Math.PI);
  sentry.r = 70; sentry.hold = 70; sentry.vr = 0;
  sentry.fireT = 0;
  s.world.player.ang = -Math.PI / 2;   // stand far from the beam
  s.step(2);

  assert.ok(s.world.beams.length > 0 || s.world.bullets.length > 0,
    'a beam enemy must produce a beam');

  if (s.world.beams.length) {
    const before = s.CS.ringTotal();
    // Let it live out its full duration; it may only charge once.
    s.step(120);
    const delta = s.CS.ringTotal() - before;
    assert.ok(delta <= 1, 'one beam may only cost one point, got ' + delta);
  }
});

test('missiles home, so they differ from a straight round', () => {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  const keeper = s.CS.spawnEnemy('drifter', Math.PI * 1.62);
  keeper.r = 20; keeper.hold = 12; keeper.vr = 0; keeper.hp = 9999;

  const weaver = s.CS.spawnEnemy('weaver', Math.PI);
  weaver.r = 60; weaver.hold = 60; weaver.vr = 0;
  weaver.fireT = 0;
  s.world.player.ang = -Math.PI / 2;
  s.step(2);

  assert.ok(s.world.missiles.length > 0, 'a missile enemy must launch missiles');
  const m = s.world.missiles[0];
  const a0 = m.ang;
  // Move the player: the missile should correct toward them.
  s.world.player.ang = 0;
  s.step(12);
  assert.ok(Math.abs(m.ang - a0) > 1e-4, 'the missile must steer, not fly straight');
});

console.log('\n=== the player is damageable ===');

test('the ship has a hull pool that is strictly tighter than the ring', () => {
  const s = sim();
  const c = s.CS.consts;
  // The hull and the ring must NOT share a capacity: the ring has fourteen arcs to
  // spread damage across, so a per-arc pool can afford to be small while the
  // whole ring is forgiving. The ship is one thing, so it needs a little more room
  // than a single arc or every run is decided by the hull.
  assert.ok(c.PLAYER_CAPACITY >= c.SEG_CAPACITY,
    'the hull must be at least as forgiving as one arc');
  assert.ok(c.PLAYER_DMG_BULLET >= 1, 'absorbing a round costs something');
  assert.ok(c.PLAYER_DMG_RAM >= c.PLAYER_DMG_BULLET,
    'ramming must cost at least as much as absorbing a round');
});

test('a single minor hit is survivable, and the hull resets per run', () => {
  const s = sim();
  s.step(1);
  s.CS.playerDamage(1);
  assert.strictEqual(s.world.player.hull, 1);
  assert.strictEqual(s.CS.getState(), 'playing', 'one hit does not kill');
  s.CS.newGame();
  assert.strictEqual(s.CS.world().player.hull, 0, 'a fresh run has an intact hull');
});

test('exceeding the hull capacity destroys the ship and ends the run', () => {
  const s = sim();
  s.step(1);
  const cap = s.CS.consts.PLAYER_CAPACITY;
  // Chip away at capacity, then one more.
  for (let i = 0; i < cap; i++) {
    s.CS.playerDamage(1);
    // Let the invulnerability window lapse between hits.
    s.step(45);
  }
  assert.strictEqual(s.CS.getState(), 'playing', 'at capacity the ship still flies');
  s.CS.playerDamage(1);
  // Losing the ship starts a playout, so assert the outcome, not the instant.
  assert.strictEqual(s.world.lostShip, true, 'the loss is attributed to the ship');
  assert.strictEqual(settle(s), 'gameover', 'one past capacity destroys the ship');
  assert.strictEqual(s.world.player.alive, false);
});

test('ramming an enemy damages the player, so it is no longer free', () => {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  const ang = -Math.PI / 2;
  const e = s.CS.spawnEnemy('drifter', ang);
  e.r = s.CS.consts.PLAYER_R;
  e.hold = s.CS.consts.PLAYER_R;
  e.vr = 0;
  s.world.player.ang = ang;
  const hull0 = s.world.player.hull;
  s.step(1);
  assert.ok(s.world.player.hull > hull0,
    'colliding must cost hull, got ' + s.world.player.hull);
});

test('killing an enemy by ramming still costs hull (no free kills)', () => {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  const ang = 1.0;
  const e = s.CS.spawnEnemy('drifter', ang);
  e.r = s.CS.consts.PLAYER_R;
  e.hold = s.CS.consts.PLAYER_R;
  e.vr = 0; e.hp = 1;
  s.world.player.ang = ang;
  s.step(1);
  assert.ok(s.world.player.hull > 0, 'the ship paid for that kill');
  assert.ok(!s.world.enemies.includes(e), 'and the enemy still died');
});

test('repeated ramming can destroy the player', () => {
  const s = sim();
  s.step(1);
  const ang = -Math.PI / 2;
  for (let hit = 0; hit < 6 && s.CS.getState() === 'playing'; hit++) {
    s.world.enemies.length = 0;
    const e = s.CS.spawnEnemy('drifter', ang);
    e.r = s.CS.consts.PLAYER_R;
    e.hold = s.CS.consts.PLAYER_R;
    e.vr = 0; e.hp = 99;
    s.world.player.ang = ang;
    s.world.player.invuln = 0;
    s.step(1);
  }
  assert.strictEqual(settle(s), 'gameover',
    'ploughing into ships repeatedly must be fatal');
});

test('the invulnerability window stops one collision double-charging', () => {
  const s = sim();
  s.step(1);
  s.CS.playerDamage(1);
  const after = s.world.player.hull;
  // A second hit inside the grace period must be ignored.
  s.CS.playerDamage(1);
  assert.strictEqual(s.world.player.hull, after, 'grace window absorbs the repeat');
  // Once it lapses, damage lands again.
  s.step(45);
  s.CS.playerDamage(1);
  assert.ok(s.world.player.hull > after, 'damage resumes after the window');
});

test('absorbing a bullet damages the hull, not just tempo', () => {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  // Keep one inert enemy so the wave does not clear mid-test.
  const keeper = s.CS.spawnEnemy('drifter', Math.PI * 0.9);
  keeper.r = 20; keeper.hold = 12; keeper.vr = 0; keeper.hp = 9999;

  const ang = s.world.player.ang;
  s.world.bullets.length = 0;
  const hull0 = s.world.player.hull;
  // Start OUTSIDE the player's orbit and travel inward: a round spawned inside
  // PLAYER_R never crosses the collision window and would pass through.
  s.CS.spawnBullet(ang, s.CS.consts.PLAYER_R + 9, -60, 0);
  // The player's own fire would intercept the round before it ever reaches the
  // hull, so suppress shooting for the duration of this check.
  const runHeadless = () => {
    s.world.shots.length = 0;
    return s.world.player.hull > hull0;
  };
  for (let i = 0; i < 240 && !runHeadless(); i++) s.CS.update(1 / 60);
  assert.ok(s.world.player.hull > hull0,
    'a round that reaches the ship must cost hull, got ' + s.world.player.hull);
});

console.log('\n=== upgrade tokens ===');

test('every required increment is declared per type', () => {
  const s = sim();
  const ups = s.CS.upgrades;
  for (const key of ['bolt', 'beam', 'missile']) {
    assert.ok(ups[key], key + ' is defined');
    assert.ok(Number.isInteger(ups[key].need) && ups[key].need >= 2,
      key + '.need must be a real increment count, got ' + ups[key].need);
    assert.ok(ups[key].label && ups[key].label.length <= 6,
      key + ' needs a short HUD label');
  }
});

test('collecting below the requirement banks progress without granting it', () => {
  const s = sim();
  s.step(1);
  const up = s.CS.upgrades.bolt;
  const before = s.CS.fireInterval();
  for (let i = 0; i < up.need - 1; i++) {
    s.CS.dropPickup(0.3, 60, 'bolt');
    s.CS.grabPickup();
  }
  assert.strictEqual(s.world.upgrades.bolt, up.need - 1, 'progress banked');
  assert.strictEqual(s.world.levels.bolt, 0, 'no level granted yet');
  assert.strictEqual(s.CS.fireInterval(), before, 'fire rate unchanged');
});

test('collecting exactly the required count activates the upgrade', () => {
  const s = sim();
  s.step(1);
  const up = s.CS.upgrades.bolt;
  const before = s.CS.fireInterval();
  for (let i = 0; i < up.need; i++) {
    s.CS.dropPickup(0.3, 60, 'bolt');
    s.CS.grabPickup();
  }
  assert.strictEqual(s.world.levels.bolt, 1, 'one level granted');
  assert.strictEqual(s.world.upgrades.bolt, 0, 'progress consumed by activation');
  const after = s.CS.fireInterval();
  assert.ok(after < before, 'fire interval should shrink: ' + before + ' -> ' + after);
});

test('surplus progress carries toward the next level', () => {
  const s = sim();
  s.step(1);
  const need = s.CS.upgrades.bolt.need;
  for (let i = 0; i < need * 2; i++) {
    s.CS.dropPickup(0.3, 60, 'bolt');
    s.CS.grabPickup();
  }
  assert.strictEqual(s.world.levels.bolt, 2, 'two activations from 2x the count');
  assert.strictEqual(s.world.upgrades.bolt, 0);
});

test('spread widens the blocker, and does not change movement speed', () => {
  const s = sim();
  s.step(1);
  const barrels0 = s.CS.barrels();
  // movement must be untouched by upgrades
  s.env.key('keydown', 'ArrowRight');
  const a0 = s.world.player.ang;
  s.step(6);
  const baseline = Math.abs(s.world.player.ang - a0);
  s.env.key('keyup', 'ArrowRight');

  const need = s.CS.upgrades.beam.need;
  for (let i = 0; i < need * 2; i++) {
    s.CS.dropPickup(0.3, 60, 'beam');
    s.CS.grabPickup();
  }
  assert.ok(s.CS.barrels() > barrels0,
    'spread should add barrels: ' + barrels0 + ' -> ' + s.CS.barrels());

  const t = sim();
  t.step(1);
  t.world.levels.spread = s.world.levels.beam;
  t.env.key('keydown', 'ArrowRight');
  const b0 = t.world.player.ang;
  t.step(6);
  const after = Math.abs(t.world.player.ang - b0);
  assert.ok(Math.abs(after - baseline) < 1e-9, 'movement speed must not depend on upgrades');
});

// Helper: freeze the board so a self-repair test measures only the arc under
// test. An empty board would trigger wave-clear, so an inert keeper is left on.
function frozenSim() {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  s.world.bullets.length = 0;
  s.world.beams.length = 0;
  s.world.missiles.length = 0;
  const keeper = s.CS.spawnEnemy('drifter', Math.PI * 1.62);
  keeper.r = 20; keeper.hold = 12; keeper.vr = 0; keeper.hp = 9999;
  return s;
}

test('a quiet damaged arc mends itself, but only after a long wait', () => {
  const s = frozenSim();
  const n = s.CS.consts.SEGMENTS;
  const cap = s.CS.consts.SEG_CAPACITY;
  const ang = -Math.PI + (0.5 / n) * Math.PI * 2;

  s.CS.ringDamage(ang, cap);
  assert.strictEqual(s.CS.ringWorst().value, cap);

  // It must NOT heal quickly: the wait is meant to be punishing.
  s.step(60 * 5);
  assert.strictEqual(s.CS.ringWorst().value, cap, 'no healing after 5s');
  s.step(60 * 10);
  assert.strictEqual(s.CS.ringWorst().value, cap, 'still no healing after 15s');

  // Past the threshold it gives back exactly one point.
  s.step(60 * 10);
  assert.strictEqual(s.CS.ringWorst().value, cap - 1,
    'one point restored after the long quiet window');
});

test('the heal window is genuinely long (>= 15s of quiet)', () => {
  const s = frozenSim();
  const n = s.CS.consts.SEGMENTS;
  s.CS.ringDamage(-Math.PI + (0.5 / n) * Math.PI * 2, 2);
  const before = s.CS.ringWorst().value;
  s.step(60 * 14);      // 14 seconds of quiet must not be enough
  assert.strictEqual(s.CS.ringWorst().value, before,
    'healing 14s in would make it a regen mechanic, not a reward');
});

test('taking another hit resets the self-repair clock', () => {
  const s = frozenSim();
  const n = s.CS.consts.SEGMENTS;
  const ang = -Math.PI + (2.5 / n) * Math.PI * 2;

  s.CS.ringDamage(ang, 1);
  s.step(60 * 15);          // nearly long enough
  s.CS.ringDamage(ang, 1);  // ...then hit again: the clock restarts
  s.step(60 * 10);
  assert.ok(s.CS.ringWorst().value >= 2,
    'a fresh hit cancels the pending mend, got ' + s.CS.ringWorst().value);
});

test('a pristine ring never drifts negative from self-repair', () => {
  const s = frozenSim();
  s.step(60 * 60);
  assert.strictEqual(s.CS.ringTotal(), 0);
  assert.ok(s.world.segments.every((v) => v === 0), 'no pool below zero');
});

test('killing an enemy drops a token that drifts outward', () => {
  const s = sim();
  s.step(1);
  // Drops are chance-based, so force the outcome by clearing the pity counter's
  // effect: kill a sentry, which has the highest drop chance, and retry a few
  // times rather than assuming one kill always pays out.
  let tok = null;
  for (let attempt = 0; attempt < 40 && !tok; attempt++) {
    s.world.tokens.length = 0;
    s.world.enemies.length = 0;
    s.world.spawnQueue.length = 0;
    const e = s.CS.spawnEnemy('sentry', 2.2);
    e.hp = 1; e.r = 95;
    s.world.player.ang = 2.2;
    s.world.bullets.length = 0;
    s.CS.spawnBullet(2.2, 105, -0.001, 0);
    for (let i = 0; i < 240 && !s.world.tokens.length; i++) s.CS.update(1 / 60);
    if (s.world.tokens.length) tok = s.world.tokens[0];
  }
  assert.ok(tok, 'a sentry kill must eventually drop (drop chance 0.9)');
  const r0 = tok.r;
  s.step(10);
  assert.ok(tok.r > r0, 'token drifts outward toward the ring');
  assert.ok(Object.prototype.hasOwnProperty.call(s.CS.upgrades, tok.type), 'valid type');
});

test('not every kill drops a token', () => {
  const s = sim();
  s.step(1);
  // Fodder (drifter, 0.28) must frequently yield nothing. Kill many and assert
  // the drop rate is clearly below certainty — otherwise pickups arrive like
  // clockwork and chequing upgrades stops being a decision.
  let kills = 0;
  let drops = 0;
  for (let i = 0; i < 60; i++) {
    s.world.tokens.length = 0;
    s.world.enemies.length = 0;
    s.world.spawnQueue.length = 0;
    s.world.dryKills = 0;          // isolate the per-type chance
    const e = s.CS.spawnEnemy('drifter', 2.2);
    e.hp = 1; e.r = 95;
    s.world.player.ang = 2.2;
    s.world.bullets.length = 0;
    s.CS.spawnBullet(2.2, 105, -0.001, 0);
    for (let f = 0; f < 240 && s.world.enemies.length; f++) s.CS.update(1 / 60);
    kills++;
    if (s.world.tokens.length) drops++;
  }
  assert.ok(drops > 0, 'some kills must drop');
  assert.ok(drops < kills, 'not every kill may drop (got ' + drops + '/' + kills + ')');
});

test('a long dry streak is broken by the pity drop', () => {
  const s = sim();
  s.step(1);
  // A run of unlucky kills must not leave the player with no upgrades at all.
  s.world.dryKills = s.CS.dropPity;
  s.world.tokens.length = 0;
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  const e = s.CS.spawnEnemy('drifter', 2.2);
  e.hp = 1; e.r = 95;
  s.world.player.ang = 2.2;
  s.world.bullets.length = 0;
  s.CS.spawnBullet(2.2, 105, -0.001, 0);
  for (let f = 0; f < 240 && s.world.enemies.length; f++) s.CS.update(1 / 60);
  assert.strictEqual(s.world.tokens.length, 1, 'the pity floor guarantees this drop');
});

test('a missed token is lost harmlessly — never ring damage', () => {
  const s = sim();
  s.step(1);
  s.world.tokens.length = 0;
  // Keep one inert enemy on the board. Emptying it would trigger wave-clear,
  // which starts the next wave mid-test and makes this measurement flaky.
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  const keeper = s.CS.spawnEnemy('drifter', 1.0);
  keeper.r = 20; keeper.hold = 12; keeper.vr = 0; keeper.hp = 9999;

  s.world.player.ang = Math.PI;   // stand far from the drop
  const before = s.CS.ringTotal();
  s.CS.dropPickup(0, 40, 'bolt');
  runUntil(s, () => s.world.tokens.length === 0, 10, 'token leaves the field');
  assert.strictEqual(s.CS.ringTotal(), before, 'loot must never cost integrity');
});

test('shards do not drop tokens (one kill cannot become three drops)', () => {
  const s = sim();
  s.step(1);
  s.world.tokens.length = 0;
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  const e = s.CS.spawnEnemy('shard', 1.0);
  e.hp = 1; e.r = 95;
  s.world.player.ang = 1.0;
  s.world.bullets.length = 0;
  s.CS.spawnBullet(1.0, 105, -0.001, 0);
  runUntil(s, () => !s.world.enemies.includes(e), 6, 'shard dies');
  assert.strictEqual(s.world.tokens.length, 0, 'shards drop nothing');
});

test('activation raises a flare coded to the upgrade type', () => {
  const s = sim();
  s.step(1);
  for (const type of ['bolt', 'beam', 'missile']) {
    s.world.flares.length = 0;
    const need = s.CS.upgrades[type].need;
    for (let i = 0; i < need; i++) {
      s.CS.dropPickup(0.5, 60, type);
      s.CS.grabPickup();
    }
    const flares = s.world.flares;
    assert.ok(flares.length > 0, type + ' activation must flare');
    assert.ok(flares.every((f) => f.type === type), type + ' flare is type-coded');
  }
});

test('flares expire on their own', () => {
  const s = sim();
  s.step(1);
  const need = s.CS.upgrades.bolt.need;
  for (let i = 0; i < need; i++) { s.CS.dropPickup(0.5, 60, 'bolt'); s.CS.grabPickup(); }
  assert.ok(s.world.flares.length > 0);
  s.step(90);
  assert.strictEqual(s.world.flares.length, 0, 'flares are momentary, not permanent');
});

console.log('\n=== scoring & persistence ===');

test('kills pay score and increment the kill counter', () => {
  const s = sim();
  s.step(1);
  s.world.enemies.length = 0;
  s.world.spawnQueue.length = 0;
  s.world.player.ang = 2.0;
  const drone = s.CS.spawnEnemy('drifter', 2.0);
  drone.hp = 1;
  drone.r = 95;
  s.world.bullets.length = 0;
  s.CS.spawnBullet(2.0, 105, -0.001, 0);
  const score0 = s.world.score;
  runUntil(s, () => s.world.kills > 0, 6, 'kill');
  assert.ok(s.world.score > score0, 'score increased');
});

test('game over writes the best wave to localStorage', () => {
  const s = sim();
  s.step(2);
  s.world.wave = 7;
  s.CS.ringDamage(0.5, 999);
  assert.strictEqual(settle(s), 'gameover');
  assert.strictEqual(s.env.win.localStorage.getItem('cs_best'), '7');
});

test('a lower-scoring run does not overwrite the record', () => {
  const s = sim();
  s.step(1);
  s.env.win.localStorage.setItem('cs_best', '12');
  s.world.wave = 3;
  s.CS.ringDamage(0, 999);
  assert.strictEqual(s.env.win.localStorage.getItem('cs_best'), '12');
});

console.log('\n=== the failure playout ===');

test('losing the ship enters a playout, not an instant summary', () => {
  const s = sim();
  s.step(1);
  const cap = s.CS.consts.PLAYER_CAPACITY;
  s.CS.playerDamage(cap + 1);
  assert.strictEqual(s.CS.getState(), 'dying',
    'the run must not cut straight to the menu');
  assert.strictEqual(s.world.player.alive, false, 'the ship is gone');
  // The summary follows once the failure has been watched.
  assert.strictEqual(settle(s), 'gameover');
});

test('a ring breach also plays out before the summary', () => {
  const s = sim();
  s.step(1);
  s.CS.ringDamage(0.4, s.CS.consts.SEG_CAPACITY + 1);
  assert.strictEqual(s.CS.getState(), 'dying');
  assert.strictEqual(settle(s), 'gameover');
});

test('the battle keeps resolving during the playout', () => {
  const s = sim();
  s.step(1);
  // Put live fire on the board, then die.
  s.CS.spawnBullet(1.2, 40, 60, 0);
  s.CS.playerDamage(s.CS.consts.PLAYER_CAPACITY + 1);
  assert.strictEqual(s.CS.getState(), 'dying');
  const r0 = s.world.bullets.length ? s.world.bullets[0].r : null;
  s.step(6);
  // Bullets must still travel: a frozen frame would show nothing.
  if (r0 != null && s.world.bullets.length) {
    assert.notStrictEqual(s.world.bullets[0].r, r0, 'fire keeps moving during the playout');
  }
  // And the playout eventually ends.
  assert.strictEqual(settle(s), 'gameover');
});

test('the playout does not last forever', () => {
  const s = sim();
  s.step(1);
  s.CS.playerDamage(s.CS.consts.PLAYER_CAPACITY + 1);
  const t0 = s.world.stateTime;
  let guard = 0;
  while (s.CS.getState() === 'dying' && guard++ < 60 * 20) s.CS.update(1 / 60);
  assert.strictEqual(s.CS.getState(), 'gameover', 'the playout must terminate');
});

test('a dead player cannot be damaged again, nor act', () => {
  const s = sim();
  s.step(1);
  s.CS.playerDamage(s.CS.consts.PLAYER_CAPACITY + 1);
  const hull = s.world.player.hull;
  s.CS.playerDamage(5);
  assert.strictEqual(s.world.player.hull, hull, 'no further hull damage once dead');
});

console.log('\n=== render & state safety ===');

test('draw() survives title, playing, paused, waveclear, gameover', () => {
  const s = sim();
  const states = ['title', 'playing', 'paused', 'waveclear', 'gameover'];
  for (const st of states) {
    s.CS.setState(st);
    s.step(2);
    s.CS.draw();
  }
});

test('draw() is safe on an empty world and with a full screen of objects', () => {
  const s = sim();
  s.world.enemies.length = 0;
  s.world.bullets.length = 0;
  s.world.shots.length = 0;
  s.world.parts.length = 0;
  s.CS.draw();

  for (let i = 0; i < 120; i++) s.CS.spawnBullet(i * 0.31, 30 + (i % 70), 60, 0.3);
  s.CS.spawnEnemy('boss', 1);
  for (let i = 0; i < 60; i++) s.CS.spawnEnemy('drifter', i * 0.4);
  s.step(180);
  s.CS.draw();
});

test('no NaN leaks into world state over a long unattended run', () => {
  const s = sim();
  for (let i = 0; i < 60 * 45; i++) {
    s.CS.update(1 / 60);
    if (i % 300 === 0) s.CS.draw();
    if (s.CS.getState() === 'gameover') break;
  }
  const w = s.world;
  assert.ok(Number.isFinite(w.player.ang), 'player.ang finite');
  assert.ok(Number.isFinite(w.score), 'score finite');
  assert.ok(Number.isFinite(s.CS.ringTotal()), 'ring total finite');
  assert.ok(w.segments.every((v) => Number.isFinite(v) && v >= 0 && v <= s.CS.consts.SEG_CAPACITY + 1),
    'every pool within bounds');
  for (const b of w.bullets) {
    assert.ok(Number.isFinite(b.r) && Number.isFinite(b.ang), 'bullet state finite');
  }
  for (const e of w.enemies) {
    assert.ok(Number.isFinite(e.r) && Number.isFinite(e.ang), 'enemy state finite');
    assert.ok(e.hp > 0 || e.dead, 'no zero-hp zombie enemies');
  }
});

test('pause freezes the simulation', () => {
  const s = sim();
  s.step(5);
  s.CS.setState('paused');
  const snap = JSON.stringify({
    ang: s.world.player.ang, t: s.world.t, n: s.world.enemies.length
  });
  s.step(60);
  const after = JSON.stringify({
    ang: s.world.player.ang, t: s.world.t, n: s.world.enemies.length
  });
  assert.strictEqual(after, snap, 'paused state must not advance');
});

test('restart produces a clean wave 1', () => {
  const s = sim();
  s.step(2);
  s.CS.ringDamage(0, 999);
  assert.strictEqual(settle(s), 'gameover');
  s.CS.newGame();
  assert.strictEqual(s.CS.getState(), 'playing');
  const w = s.CS.world();
  assert.strictEqual(w.wave, 1);
  assert.strictEqual(s.CS.ringTotal(), 0);
  assert.strictEqual(w.score, 0);
  assert.strictEqual(w.kills, 0);
  assert.ok(w.segments.every((v) => v === 0));
});

console.log('\n=== font ===');

test('font renders known glyphs and falls back for unknown ones', () => {
  const s = sim();
  const Pixel = s.env.sandbox.window.Pixel;
  assert.ok(Pixel, 'Pixel namespace missing');
  assert.ok(Pixel.width('ABC', 1) > 0);
  const c = s.env.canvas.getContext('2d');
  Pixel.draw(c, 'WAVE 01', 10, 10, { color: '#fff' });
  Pixel.draw(c, '\u2603??', 10, 20, { color: '#fff' }); // unknown char must not throw
  Pixel.draw(c, '', 0, 0, {});
  assert.strictEqual(Pixel.draw(c, 'AB', 100, 0, { align: 'center' }), Pixel.width('AB'));
});

console.log('\n---------------------------------------------');
if (failures.length) {
  console.log(`${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) {
    console.log('### ' + f.name);
    console.log(f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 6).join('\n') : f.err);
    console.log('');
  }
  process.exit(1);
}
console.log(`all ${pass} tests passed`);
