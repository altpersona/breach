// The test bot: one canonical implementation, shared by every probe.
//
// It exists because the balance numbers only mean something if every suite flies
// the same pilot. Copies had already drifted (different threat windows, different
// boss handling), which made cross-run comparisons meaningless.
//
// The bot is deliberately simple and deliberately *not* optimal: it answers
// "which incoming thing lands first, and can I reach its spoke?" and nothing
// else. It has no self-preservation instinct beyond that, so it walks into
// bodies while lining up shots. That is a known bias — read balance numbers as a
// floor, not a forecast of human play.
'use strict';

var PLAYER_ARC_SPEED = 3.05;   // mirrors the constant in src/game.js

function makeBot(env, CS, opts) {
  opts = opts || {};
  const fine = opts.fine || 0.015;      // angular deadzone
  const urgentSlack = opts.urgentSlack != null ? opts.urgentSlack : -0.12;
  const avoidBodies = !!opts.avoidBodies;

  const key = (k, down) => env.dispatch(down ? 'keydown' : 'keyup', { key: k, preventDefault() {} });
  let held = null;

  return function think() {
    const w = CS.world();
    const p = w.player;
    const PS = PLAYER_ARC_SPEED * CS.consts.PLAYER_R;   // arc px/s

    // --- threat model -----------------------------------------------------
    // The player blocks exactly one spoke, so the only question is which hostile
    // thing reaches a dangerous radius first and whether we can get there.
    let threat = null;
    const consider = (ang, tti, kind) => {
      const d = CS.helpers.angDelta(ang, p.ang);
      const travel = Math.abs(d) * CS.consts.PLAYER_R / PS;
      const slack = tti - travel;
      if (!threat || slack < threat.slack) threat = { ang, slack, tti, kind };
    };

    for (const b of w.bullets) {
      const tti = (CS.consts.RING_R - b.r) / Math.max(1, Math.abs(b.vr));
      if (tti > 6) continue;
      consider(b.ang + b.va * tti, tti, 'bullet');   // lead its drift
    }
    for (const m of w.missiles) {
      const tti = (CS.consts.RING_R - m.r) / Math.max(1, m.vr);
      if (tti > 6) continue;
      consider(m.ang, tti, 'missile');
    }
    for (const bm of w.beams) {
      // A beam cannot be intercepted; treat its lane as an immediate hazard.
      const d = Math.abs(CS.helpers.angDelta(bm.ang, p.ang));
      if (d < 0.6) consider(bm.ang, d / 0.85 + 0.02, 'beam');
    }
    for (const e of w.enemies) {
      if (e.type === 'boss' || e.type === 'warden') continue;
      if (avoidBodies) {
        // Standing on a ship's spoke means colliding, which costs hull.
        const gap = Math.abs(e.r - CS.consts.PLAYER_R);
        if (gap < e.size + 18) {
          const d = Math.abs(CS.helpers.angDelta(e.ang, p.ang));
          consider(e.ang, d * CS.consts.PLAYER_R / PS + 0.02, 'body');
        }
      }
      const tti = (CS.consts.RING_R - e.r) / Math.max(1, e.vr);
      if (tti <= 4) consider(e.ang, tti, 'enemy');
    }

    // --- choose a heading -------------------------------------------------
    let targetAng = null;
    if (threat && threat.slack > urgentSlack) {
      targetAng = threat.ang;
    } else {
      // Nothing urgent: line up on the cheapest useful kill.
      let best = null;
      for (const e of w.enemies) {
        const isBoss = (e.type === 'boss' || e.type === 'warden');
        const bossBias = isBoss ? -400 : 0;
        // Lead moving targets: a fast orbiter is otherwise unkillable.
        const lead = e.va * (Math.abs(e.r - CS.consts.PLAYER_R) / 330);
        const d = Math.abs(CS.helpers.angDelta(e.ang + lead, p.ang));
        let score = d * CS.consts.PLAYER_R - (e.fireSlot ? 40 : 0) + e.r * 0.05 + bossBias;
        if (avoidBodies && Math.abs(e.r - CS.consts.PLAYER_R) < e.size + 18) score += 400;
        if (!best || score < best.score) best = { ang: e.ang + lead, score };
      }
      if (best) targetAng = best.ang;
    }

    let want = null;
    if (targetAng != null) {
      const d = CS.helpers.angDelta(targetAng, p.ang);
      if (Math.abs(d) > fine) want = d > 0 ? 'ArrowRight' : 'ArrowLeft';
    }
    if (held && held !== want) { key(held, false); held = null; }
    if (want && held !== want) { key(want, true); held = want; }
  };
}

/**
 * Play a run from the current world state until death or a time cap.
 * Returns depth, time, and the cause of death — the shape every probe wants.
 */
function playRun(env, CS, opts) {
  opts = opts || {};
  const maxSeconds = opts.maxSeconds || 300;
  const think = makeBot(env, CS, opts);
  const dt = 1 / 60;
  let t = 0;
  while (t < maxSeconds && CS.getState() !== 'gameover') {
    CS.update(dt);
    think();
    t += dt;
  }
  // Settle any in-progress playout so the reported outcome is terminal rather
  // than mid-animation. Without this the wave/state reported could be read from
  // the frame the ship died instead of after the failure resolved.
  let settle = 0;
  while (CS.getState() === 'dying' && settle++ < 60 * 6) { CS.update(dt); t += dt; }
  const w = CS.world();
  return {
    wave: w.wave,
    seconds: t,
    state: CS.getState(),
    byShip: !!w.lostShip,
    hull: w.player.hull,
    ringTotal: CS.ringTotal(),
    worstArc: CS.ringWorst().value,
    kills: w.kills
  };
}

module.exports = { makeBot, playRun };
