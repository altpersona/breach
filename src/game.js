/* =========================================================================
   BREACH
   A radial bullet-hell. The map is a circle: enemies pour out of the core and
   march toward the perimeter, the player is welded to the ring, and enemy fire
   that reaches the ring permanently cracks it. Breach a single arc and the run
   is over.

   Produced by Standardvibeware — standardvibeware.click
   ========================================================================= */
(function () {
  'use strict';

  /* ----------------------------------------------------------------------
     CONFIG
     ---------------------------------------------------------------------- */
  var W = 320, H = 320, CX = 160, CY = 160;
  var TAU = Math.PI * 2;

  var RING_R = 132;        // outer boundary: enemy fire smashes here
  var PLAYER_R = 120;      // player orbit radius (just inside the ring)
  var SEGMENTS = 14;       // ring is divided into this many arcs

  // Ring damage model: every segment owns its own damage pool. A bullet adds to
  // the pool of the segment it actually hits, so damage is localised and the
  // ring's appearance is a true readout of where it has been hurt. A segment
  // whose pool exceeds SEG_CAPACITY breaches, and one breach ends the run.
  //
  // This replaces a flat 14-point wave budget. The consequence is deliberate: a
  // scattered barrage is survivable, but letting fire pound one arc will kill you
  // fast. Movement is now defensive in a way it was not before, because camping a
  // single spoke concentrates your damage onto a single pool.
  //
  // Capacity is set so that the damage *types* read as a hierarchy:
  //   bullet = 1, ship crash = 2, boss crash = 5
  //   two minor hits on one arc: survives
  //   a third minor hit, or one crash + one bullet: breaches
  //   a boss crash breaches an untouched arc in a single blow
  // Raising this makes chip damage meaningless; lowering it makes a single crash
  // instantly lethal. See test/sweep-capacity.js for the measured tradeoff.
  // Damage each threat type deals to the ring. These are a designed hierarchy:
  // a minor hit is survivable, a crash is significant, a boss crash is fatal to
  // an untouched arc on its own. SEG_CAPACITY is chosen against these numbers.
  var DMG_BULLET = 1;
  var DMG_SHIP = 2;
  var DMG_BOSS = 5;

  var SEG_CAPACITY = 2;    // a segment absorbs this much before it breaches

  // Timed self-repair. An arc left undamaged for SEG_HEAL_TIME knits back one
  // point. The wait is deliberately punishing: it must never be a viable way to
  // absorb steady fire, only a reward for genuinely leaving an arc alone. At 22s
  // a wave that lasts ~15-30s yields at most one point back, and only if the
  // player successfully ignores that arc entirely for most of the wave.
  var SEG_HEAL_TIME = 22;
  var SEG_HEAL_MAX = 1;    // points restored per undisturbed stretch

  // How long the failure plays out after the ship dies, before the summary. The
  // run is already lost; this exists so the player watches the consequence —
  // remaining fire still landing on an undefended ring — instead of being cut
  // straight to a menu.
  var PLAYOUT_TIME = 2.6;

  // The player is a body, not a ghost: it has its own hull pool under the same
  // rule as a ring segment (overflow the cap and you are destroyed, and the run
  // ends with you). Ramming and eating rounds both cost hull.
  //
  // Capacity 3, not 2. Measured: at 2 the ship caused *every* death (12/12 runs)
  // and the ring never mattered, which inverts the game — the ring is the thing
  // under siege. Three points still means a couple of mistakes is fatal, but it
  // leaves room for the ring to be the pressure the player is actually fighting.
  var PLAYER_CAPACITY = 3;
  var PLAYER_DMG_BULLET = 1;   // an enemy round absorbed by the hull
  var PLAYER_DMG_RAM = 2;      // flying into a ship or a boss
  var HULL_REGEN_TIME = 9;     // seconds without being hit to regain one point
  var HULL_REGEN_MAX = 3;      // never regains beyond full

  var PLAYER_ARC_SPEED = 3.05;   // rad/s free movement
  var FOCUS_SCALE = 0.40;        // hold shift/space to creep for precision
  var SHOT_INTERVAL = 0.095;
  var SHOT_SPEED = 330;
  var STUN_TIME = 0.30;

  // Upgrade tokens. Killed enemies shed a token that drifts outward toward the
  // ring; the player collects it by being on that spoke when it arrives. Each
  // type needs a fixed number of tokens to fire, so a single stray pickup is
  // never a power spike.
  var TOKEN_SPEED = 26;      // px/s outward — slow enough to chase down
  var TOKEN_BONUS = 25;      // score for collecting one

  // Weapon families. Every enemy fights with one, its drop carries that family, and
  // collecting enough of a family upgrades *your* gun in that family's image. This
  // replaces three abstract stat upgrades with the same three slots named after
  // how the enemy that dropped them actually attacks.
  //
  //   BOLT    — the rapid single-shot gun (spinner, turret, drifter). Fast rounds.
  //   BEAM    — a held continuous line (sentry). Wide, sustained, slow to sweep.
  //   MISSILE — a guided round (weaver, splitter). Homes, so it must be met early.
  //
  // Ring repair is NOT a drop. It is a slow timed self-heal: an arc that has been
  // left undamaged long enough knits itself back by one point. See SEG_HEAL_TIME.
  var UPGRADES = {
    bolt: {
      label: 'BOLT',
      need: 3,               // collect 3 to gain the effect
      color: '#ffd166',
      maxLevel: 6,
      blurb: 'FIRE RATE UP'
    },
    beam: {
      label: 'BEAM',
      need: 4,
      color: '#5ce1e6',
      maxLevel: 4,
      blurb: 'WIDER BLOCK'
    },
    missile: {
      label: 'MSL',
      need: 3,
      color: '#c78bff',
      maxLevel: 4,
      blurb: 'PIERCING ROUNDS'
    }
  };

  // Which weapon family each enemy fights with. Its drop is always from this
  // family (except the rare universal PATCH), so what you shoot tells you what
  // you are about to be offered.
  var ENEMY_WEAPON = {
    drifter: 'bolt',
    spinner: 'bolt',
    turret: 'bolt',
    lancer: 'bolt',
    rammer: 'bolt',
    sentry: 'beam',
    weaver: 'missile',
    splitter: 'missile',
    shard: 'missile'
  };

  // Family mix for occasional universal drops is gone: a drop is always the
  // dropper's own family now, and repair is no longer a drop at all.

  // Not every kill pays out. A guaranteed drop made upgrades arrive like
  // clockwork; a chance-based one makes collecting a run of luck plus effort,
  // and keeps ordinary enemies from feeling like vending machines.
  //   shard  — never (a split would otherwise yield three chips)
  //   drifter/rammer — uncommon fodder
  //   heavies (turret, splitter, weaver, sentry) — most reliable
  //   lancer — rare, because it is the easiest to kill by accident
  var DROP_CHANCE = {
    shard: 0,
    drifter: 0.28,
    rammer: 0.34,
    lancer: 0.32,
    spinner: 0.45,
    turret: 0.62,
    splitter: 0.55,
    weaver: 0.58,
    sentry: 0.90
  };
  // A small pity floor: if the player has gone this many kills without a single
  // chip, the next kill drops one. Prevents a dead run with no upgrades at all.
  var DROP_PITY = 7;

  // Enemy fire is deliberately *slow* (roughly 40 px/s). In a one-dimensional
  // arena the player can only ever cover one spoke, so the reaction time a slow
  // bullet buys is the whole game: it is what makes a chase winnable.
  var BULLET_SPEED = 42;
  var BULLET_SPEED_FAST = 56;
  // Heavy rounds from a close-range shooter: slower, so the short distance from
  // a near-orbit hold to the ring still leaves a blockable window.
  var BULLET_SPEED_SLOW = 34;

  // Fairness cap. Even with slow bullets, N enemies firing from N different
  // spokes produce a situation no amount of skill can answer, because the player
  // occupies exactly one spoke and therefore blocks exactly one spoke. Enemy
  // fire is therefore serialised: at most one ordinary ship may fire at a time.
  // The ring budget then measures reactions, not arithmetic. Simultaneity is
  // reserved for the boss, which is a duel the player fights alone.
  //
  // From DUAL_FIRE_WAVE two ships may fire concurrently. That is not "more of the
  // same": both rounds are visible for seconds and can both be answered, but only
  // by committing to one and then sprinting, which is a new demand rather than
  // simply a higher number.
  var MAX_FIRING = 1;
  var DUAL_FIRE_WAVE = 13;

  function maxFiring(w) {
    return w.wave >= DUAL_FIRE_WAVE ? 2 : MAX_FIRING;
  }

  var C = {
    bg:        '#06050c',
    floor1:    '#0a0817',
    floor2:    '#0d0a1d',
    grid:      '#191333',
    dither:    '#141029',
    core:      '#241c48',
    coreHi:    '#7b5cff',
    corePulse: '#c8b6ff',
    ringOk:    '#5ce1e6',
    ringOkDim: '#2c7a86',
    ringBroken:'#3a1a2e',
    ringHot:   '#ff3860',
    ringWarn:  '#ffb03a',
    player:    '#7dfcb0',
    playerDim: '#2f8f66',
    shot:      '#fff8a3',
    shotDim:   '#b9a94e',
    bullet:    '#ff4f7a',
    bulletCore:'#ffd6e0',
    drifter:   '#ff9f45',
    spinner:   '#b6f36b',
    turret:    '#ff6bcb',
    splitter:  '#6bb6ff',
    boss:      '#ff3b3b',
    bossCore:  '#ffb3b3',
    hud:       '#cdc6ff',
    hudDim:    '#544d85',
    white:     '#ffffff'
  };

  /* ----------------------------------------------------------------------
     MATH / UTIL
     ---------------------------------------------------------------------- */
  function wrapPi(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }
  function angDelta(a, b) { return wrapPi(a - b); }
  function polar(a, r) { return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r }; }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function rndi(a, b) { return Math.floor(rnd(a, b + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  // Single source of truth for "is this a boss-class enemy". Bosses share the same
  // rules (a guaranteed firing slot, big breach damage, slow-mo and a shower on
  // death, their own HUD bar), so this must not be duplicated as string compares.
  function isBossType(type) { return type === 'boss' || type === 'warden'; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function approach(v, target, step) {
    if (v < target) return Math.min(v + step, target);
    return Math.max(v - step, target);
  }
  function pad(n, len) {
    var s = String(Math.floor(n));
    while (s.length < len) s = '0' + s;
    return s;
  }

  /* ----------------------------------------------------------------------
     CANVAS
     ---------------------------------------------------------------------- */
  var canvas = document.getElementById('cv');
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  var params = new URLSearchParams(location.search);
  var SELFTEST = params.get('selftest') === '1';

  function fit() {
    var pad = 16;
    var availW = Math.max(64, window.innerWidth - pad);
    var availH = Math.max(64, window.innerHeight - pad);
    // Allow going below 1x: on a viewport narrower than the native canvas the
    // old Math.max(1, ...) clamp forced an overflow instead of shrinking.
    var s = Math.min(availW / W, availH / H);
    s = Math.max(0.25, Math.floor(s * 8) / 8); // 1/8 steps keep pixels even-ish
    canvas.style.width = Math.round(W * s) + 'px';
    canvas.style.height = Math.round(H * s) + 'px';
  }
  window.addEventListener('resize', fit);
  fit();

  /* ----------------------------------------------------------------------
     WORLD
     ---------------------------------------------------------------------- */
  var state = 'title';   // title | playing | waveclear | gameover | paused
  var world = null;
  var best = loadBest();

  function loadBest() {
    try { return parseInt(localStorage.getItem('cs_best') || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem('cs_best', String(v)); } catch (e) {}
  }

  function newWorld() {
    return {
      t: 0,
      wave: 1,
      score: 0,
      kills: 0,
      damage: 0,          // ring damage taken this wave
      segments: [],       // per-segment damage pools, see resetRing
      breached: false,
      player: {
        ang: -Math.PI / 2,
        target: null,
        dir: 0,          // -1 / 0 / +1, used to predict movement
        stun: 0,
        cooldown: 0,
        alive: true,
        hull: 0,         // damage accumulated; > PLAYER_CAPACITY destroys the ship
        invuln: 0,       // brief grace so one collision cannot double-charge
        regen: 0,        // seconds since last hit, drives slow hull recovery
        trail: []
      },
      enemies: [],
      shots: [],
      bullets: [],
      beams: [],
      missiles: [],
      parts: [],
      floaters: [],
      spawnQueue: [],
      shake: 0,
      flash: 0,
      stateTime: 0,
      banner: null,
      slowmo: 0,
      focus: false,
      waveKills: 0,
      dryKills: 0,
      ringPulse: 0,
      ringPulseAng: 0,
      tokens: [],
      upgrades: { bolt: 0, beam: 0, missile: 0, repair: 0 },
      levels: { bolt: 0, beam: 0, missile: 0, repair: 0 },
      flares: []
    };
  }

  /* ----------------------------------------------------------------------
     INPUT
     ---------------------------------------------------------------------- */
  var keys = {};
  var pointer = { active: false, x: 0, y: 0, down: false };

  window.addEventListener('keydown', function (e) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar'].indexOf(e.key) >= 0) {
      e.preventDefault();
    }
    if (keys[e.key]) return;
    keys[e.key] = true;
    Sound.unlock();

    if (e.key === 'm' || e.key === 'M') { Sound.toggleMute(); return; }
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
      if (state === 'playing') { state = 'paused'; Sound.sfx.ui(); }
      else if (state === 'paused') { state = 'playing'; Sound.sfx.ui(); }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (state === 'title') { startRun(); }
      else if (state === 'gameover') { startRun(); }
      return;
    }
    if ((e.key === 'r' || e.key === 'R') && state === 'gameover') { startRun(); }
  });

  window.addEventListener('keyup', function (e) { keys[e.key] = false; });

  function canvasPos(ev) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / r.width * W,
      y: (ev.clientY - r.top) / r.height * H
    };
  }

  canvas.addEventListener('pointerdown', function (ev) {
    Sound.unlock();
    var p = canvasPos(ev);
    pointer.active = true; pointer.down = true;
    pointer.x = p.x; pointer.y = p.y;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    if (state === 'title') startRun();
    else if (state === 'gameover') startRun();
  });

  canvas.addEventListener('pointermove', function (ev) {
    var p = canvasPos(ev);
    pointer.x = p.x; pointer.y = p.y;
    if (ev.pointerType === 'mouse') pointer.active = true;
  });

  window.addEventListener('pointerup', function () { pointer.down = false; });
  canvas.addEventListener('pointerleave', function () {
    if (!pointer.down) pointer.active = false;
  });
  window.addEventListener('blur', function () {
    keys = {};
    if (state === 'playing') state = 'paused';
  });

  /* ----------------------------------------------------------------------
     PARTICLE HELPERS
     ---------------------------------------------------------------------- */
  function burst(w, x, y, n, color, spd, spread) {
    spd = spd || 70;
    for (var i = 0; i < n; i++) {
      var a = rnd(0, TAU);
      var s = rnd(spd * 0.35, spd);
      if (spread != null) a = spread + rnd(-0.5, 0.5);
      w.parts.push({
        x: x, y: y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rnd(0.18, 0.5), max: 0.5,
        color: color, size: Math.random() < 0.3 ? 2 : 1
      });
    }
  }

  function floater(w, x, y, text, color) {
    // Cap concurrent floaters so a burst of pickups cannot plaster the arena in
    // overlapping text; oldest is dropped first.
    if (w.floaters.length >= 4) w.floaters.shift();
    // Floaters live near the ring they describe, never over the centre banner.
    var cx = clamp(x, 26, W - 26);
    var cy = clamp(y, 40, H - 40);
    w.floaters.push({ x: cx, y: cy, text: text, color: color || C.hud, life: 0.9, max: 0.9 });
  }

  /* ----------------------------------------------------------------------
     UPGRADE TOKENS
     ---------------------------------------------------------------------- */
  // Does this kill shed a chip? Chance by type, with a guaranteed drop after
  // DROP_PITY dry kills so an unlucky run still progresses.
  function shouldDrop(w, e) {
    if ((w.dryKills || 0) >= DROP_PITY) return true;
    var chance = DROP_CHANCE[e.type];
    if (chance == null) chance = 0.4;
    return Math.random() < chance;
  }

  // A drop's family comes from the enemy that dropped it. Nothing is random about
  // which weapon you get: kill a beam enemy and the chip is a BEAM chip.
  function tokenTypeFor(w, enemyType) {
    var fam = ENEMY_WEAPON[enemyType];
    if (fam) return fam;
    return 'bolt';
  }

  // Dead enemies shed a token that drifts outward toward the ring. The player
  // collects it by occupying that spoke when it arrives — the same verb as
  // blocking, which is the point: every pickup is a small positional decision
  // traded against the fire you are not blocking while you chase it.
  function spawnToken(w, ang, r, forcedType, fromEnemyType) {
    w.tokens.push({
      ang: wrapPi(ang),
      r: r,
      vr: TOKEN_SPEED,
      type: forcedType || tokenTypeFor(w, fromEnemyType),
      born: 0,
      dead: false
    });
  }

  function collectToken(w, tok) {
    var up = UPGRADES[tok.type];
    if (!up) return;              // unknown family: ignore rather than throw
    var lv = w.levels;
    tok.dead = true;
    w.score += TOKEN_BONUS;

    var pos = polar(tok.ang, tok.r);
    burst(w, pos.x, pos.y, 10, up.color, 90);
    Sound.sfx.pickup();

    // Every family accrues until it reaches its required count. Ring repair is no
    // longer a token at all — it is the slow timed self-heal in stepRingHeal.
    if (lv[tok.type] >= up.maxLevel) {
      w.score += TOKEN_BONUS * 2;   // already maxed: pay out instead
      floater(w, pos.x, pos.y - 8, 'MAXED +' + (TOKEN_BONUS * 2), up.color);
      return;
    }
    w.upgrades[tok.type]++;
    if (w.upgrades[tok.type] >= up.need) {
      w.upgrades[tok.type] -= up.need;
      lv[tok.type]++;
      Sound.sfx.upgrade();
      addFlare(w, tok.type, tok.ang, pos);
      floater(w, pos.x, pos.y - 8, up.blurb + ' ' + lv[tok.type], up.color);
    } else {
      floater(w, pos.x, pos.y - 8, up.label + ' ' + w.upgrades[tok.type] + '/' + up.need, up.color);
    }
  }

  // Momentary visual confirmation when an upgrade activates. Each type gets its
  // own signature so the player can tell what fired without reading a label:
  //   rate   — concentric rings snapping inward (the gun getting tighter)
  //   spread — an arc fanning out along the ring (a wider wall of fire)
  //   rate    — unused now (repair is a timed self-heal)
  function addFlare(w, type, ang, pos) {
    w.flares.push({
      type: type,
      ang: wrapPi(ang),
      x: pos.x,
      y: pos.y,
      life: 0.85,
      max: 0.85,
      seed: rnd(0, TAU)
    });
  }

  // Beams sweep a live lane around the ring for their lifetime. They cannot be
  // intercepted, so the answer is movement: outrun the lane or step off the spoke
  // before it arrives. Each beam can only cost the ring one hit, however long the
  // player stands in it — otherwise a single beam would drain the whole pool.
  function stepBeams(w, dt) {
    var p = w.player;
    for (var i = w.beams.length - 1; i >= 0; i--) {
      var bm = w.beams[i];
      bm.life -= dt;
      if (bm.life <= 0) { w.beams.splice(i, 1); continue; }

      // The lane walks around the ring. This is the whole threat: standing still
      // means the beam eventually crosses you.
      bm.ang = wrapPi(bm.ang + bm.sweep * dt);

      if (bm.spent) continue;

      // A beam is pulsed (1.35s of live lane), not a permanent field, and it hurts
      // the ship as much as the ring. It is not immune to the hull — that was a
      // hack I put in to mask bad tuning, and it made the most lethal thing on the
      // field harmless. Fairness comes from the beam being slow enough to outrun,
      // not from the ship ignoring it.
      var arcToPlayer = Math.abs(angDelta(bm.ang, p.ang));
      if (arcToPlayer < bm.width + 0.02) {
        bm.spent = true;
        playerStun(w);
        playerDamage(w, PLAYER_DMG_BULLET, bm.ang);
        if (state !== 'playing' && state !== 'dying') return;
        continue;
      }

      // Does it reach the ring yet? Beams land on the arc they are pointing at.
      if (bm.life < bm.max * 0.55) {
        bm.spent = true;
        ringDamage(w, bm.ang, DMG_BULLET);
        if (state !== 'playing' && state !== 'dying') return;
      }
    }
  }

  // Missiles home on the player's spoke, so they must be met early. Late, they
  // have already corrected and are much harder to block.
  function stepMissiles(w, dt) {
    var p = w.player;
    for (var i = w.missiles.length - 1; i >= 0; i--) {
      var m = w.missiles[i];
      m.life -= dt;
      m.r += m.vr * dt;

      // Homing: steer toward the player's current spoke, capped by turn rate so
      // a player who commits to a move can outrun the correction.
      var want = angDelta(p.ang, m.ang);
      m.ang = wrapPi(m.ang + clamp(want, -m.turn * dt, m.turn * dt));

      // Player fire can still intercept a missile — it is a physical round.
      var intercepted = false;
      for (var j = 0; j < w.shots.length; j++) {
        var s = w.shots[j];
        if (s.dead) continue;
        if (Math.abs(s.r - m.r) < 7 &&
            Math.abs(angDelta(s.ang, m.ang)) * m.r < 7) {
          s.dead = true;
          intercepted = true;
          var ip = polar(m.ang, m.r);
          burst(w, ip.x, ip.y, 8, UPGRADES.missile.color, 90);
          w.score += 10;
          Sound.sfx.hit();
          break;
        }
      }
      if (intercepted) { w.missiles.splice(i, 1); continue; }

      // Body contact.
      if (m.r > PLAYER_R - 9 && m.r < PLAYER_R + 6 &&
          Math.abs(angDelta(m.ang, p.ang)) * PLAYER_R < 9) {
        w.missiles.splice(i, 1);
        playerStun(w);
        playerDamage(w, PLAYER_DMG_BULLET, m.ang);
        if (state !== 'playing' && state !== 'dying') return;
        continue;
      }

      if (m.r >= RING_R) {
        w.missiles.splice(i, 1);
        ringDamage(w, m.ang, DMG_BULLET);
        if (state !== 'playing' && state !== 'dying') return;
        continue;
      }
      if (m.life <= 0) w.missiles.splice(i, 1);
    }
  }

  function stepTokens(w, dt) {
    var p = w.player;

    // Activation flares tick down here (they are token-related feedback).
    for (var f = w.flares.length - 1; f >= 0; f--) {
      var fl = w.flares[f];
      fl.life -= dt;
      if (fl.life <= 0) w.flares.splice(f, 1);
    }
    for (var i = w.tokens.length - 1; i >= 0; i--) {
      var tok = w.tokens[i];
      tok.born += dt;

      // A slow drift outward, with a gentle wobble so it reads as loot, not a
      // bullet. It also slowly tracks the player so chasing it always pays off.
      tok.r += tok.vr * dt;
      var d = angDelta(p.ang, tok.ang);
      tok.ang = wrapPi(tok.ang + clamp(d, -0.45, 0.45) * dt * 0.5);

      // collected: on the same spoke, at the player's radius
      var arcDist = Math.abs(angDelta(tok.ang, p.ang)) * Math.max(10, tok.r);
      if (tok.r > PLAYER_R - 16 && arcDist < 13) {
        collectToken(w, tok);
        w.tokens.splice(i, 1);
        continue;
      }

      // missed: it hits the ring and fizzles (never damages — loot should never
      // punish, only be lost)
      if (tok.r >= RING_R - 2) {
        tok.dead = true;
        var pos = polar(tok.ang, RING_R);
        var art = UPGRADES[tok.type];
        burst(w, pos.x, pos.y, 4, art ? art.color : C.hudDim, 40);
        w.tokens.splice(i, 1);
      }
    }
  }

  /* ----------------------------------------------------------------------
     BULLETS / SHOTS
     ---------------------------------------------------------------------- */
  // A beam: a sustained lane from the firing ship out to the ring. It is not a
  // projectile and cannot be intercepted — the only answers are to outrun its
  // sweep or to not be standing in it. This is what makes the BEAM family a
  // different question from a bullet.
  function spawnBeam(w, e) {
    w.beams.push({
      ang: wrapPi(e.ang),
      originAng: wrapPi(e.ang),
      r0: Math.max(10, e.r),      // inner end, at the ship
      life: 1.35,
      max: 1.35,
      sweep: 0.85,                // rad/s the lane walks around the ring
      width: 0.085,               // half-width in radians
      spent: false,               // has this beam already cost a hit
      type: 'beam'
    });
  }

  // A missile: guided, so it corrects toward the player's spoke as it travels.
  // Meeting it early is far easier than meeting it late, which is the point.
  //
  // The turn rate is deliberately modest. A perfect lock means a missile always
  // lands on a stationary player with zero counterplay, which made missile waves
  // a fixed tax rather than a test. At this rate a player who commits to a move
  // can out-turn it, and one who stands still gets punished — which is the actual
  // lesson the family is meant to teach.
  function spawnMissile(w, e, offset) {
    w.missiles.push({
      ang: wrapPi(e.ang + offset),
      r: Math.max(8, e.r),
      vr: BULLET_SPEED * 0.78,
      turn: 0.30,                 // rad/s of homing correction
      life: 3.2,
      type: 'missile'
    });
  }

  function spawnBullet(w, ang, r, vr, va, opt) {
    opt = opt || {};
    w.bullets.push({
      ang: wrapPi(ang), r: r, vr: vr, va: va || 0,
      hit: 5,
      big: !!opt.big,
      dead: false,
      born: 0
    });
  }

  function resetRing(w) {
    w.segments = [];
    w.segQuiet = [];        // seconds since each arc was last hit
    w.segHealed = [];       // how many points this quiet stretch has already given back
    for (var i = 0; i < SEGMENTS; i++) {
      w.segments.push(0);
      w.segQuiet.push(0);
      w.segHealed.push(0);
    }
    w.breached = false;
  }

  // Slow self-repair. An arc that has been left alone long enough gives back one
  // point, once per quiet stretch. The reset on being hit is what makes this a
  // reward for *not* trading fire on that arc, rather than passive regen.
  function stepRingHeal(w, dt) {
    for (var i = 0; i < SEGMENTS; i++) {
      if (w.segments[i] <= 0) {
        w.segQuiet[i] = 0;
        w.segHealed[i] = 0;
        continue;
      }
      w.segQuiet[i] += dt;
      if (w.segQuiet[i] >= SEG_HEAL_TIME && w.segHealed[i] < SEG_HEAL_MAX) {
        w.segments[i] -= 1;
        w.segHealed[i] += 1;
        w.segQuiet[i] = 0;
        // A small, quiet confirmation at that arc — visible if you look, not
        // loud enough to distract during a fight.
        var segAngle = TAU / SEGMENTS;
        var mid = wrapPi(i * segAngle + segAngle / 2 - Math.PI);
        var pos = polar(mid, RING_R);
        burst(w, pos.x, pos.y, 5, UPGRADES.beam.color, 45);
        floater(w, pos.x, pos.y - 8, 'ARC MENDED', UPGRADES.beam.color);
      }
    }
  }

  // Which segment does an impact angle land in?
  function segAt(ang) {
    var idx = Math.floor((wrapPi(ang) + Math.PI) / TAU * SEGMENTS);
    if (idx >= SEGMENTS) idx = SEGMENTS - 1;
    if (idx < 0) idx = 0;
    return idx;
  }

  // Total ring damage, summed across pools. Used for scoring and the HUD; it is
  // NOT what ends the run — a single pool overflowing does.
  function ringTotal(w) {
    var t = 0;
    for (var i = 0; i < w.segments.length; i++) t += w.segments[i];
    return t;
  }

  // Worst segment: how close the ring is to breaching, and where.
  function ringWorst(w) {
    var worst = 0, at = 0;
    for (var i = 0; i < w.segments.length; i++) {
      if (w.segments[i] > worst) { worst = w.segments[i]; at = i; }
    }
    return { value: worst, index: at };
  }
  function aimedBullet(w, e, speed, capVa) {
    var t = Math.max(0.15, (RING_R - e.r) / speed);
    var need = angDelta(w.player.ang, e.ang);
    var va = clamp(need / t, -(capVa || 0.3), (capVa || 0.3));
    spawnBullet(w, e.ang, e.r, speed, va);
    Sound.sfx.hit();
  }

  function spawnShot(w, ang, r) {
    w.shots.push({ ang: wrapPi(ang), r: r, dead: false });
  }

  /* ----------------------------------------------------------------------
     RING DAMAGE  —  the loss condition
     ---------------------------------------------------------------------- */
  function ringDamage(w, ang, amount) {
    if (w.breached) return;
    amount = amount || 1;

    // Damage lands on the segment actually struck, so it is localised: the ring
    // records *where* it has been hurt, not just how much in total. A concentrated
    // barrage kills; a scattered one does not.
    var idx = segAt(ang);
    var before = w.segments[idx];
    w.segments[idx] = Math.min(SEG_CAPACITY + 1, before + amount);
    var taken = w.segments[idx] - before;
    if (taken <= 0) return;

    // Being hit restarts this arc's quiet clock and clears its heal allowance, so
    // self-repair can never outpace steady fire on the same arc.
    w.segQuiet[idx] = 0;
    w.segHealed[idx] = 0;

    var p = polar(ang, RING_R);
    burst(w, p.x, p.y, 5 + taken * 4, C.ringHot, 70 + taken * 22);
    burst(w, p.x, p.y, 2 + taken * 2, C.white, 40 + taken * 14);

    // The ring pulse is the damage readout. Its strength tracks how significant
    // the hit was (1 chip vs a whole enemy breaching), so the player can feel
    // severity without reading the HUD.
    w.ringPulse = Math.min(1, (w.ringPulse || 0) + 0.34 + taken * 0.22);
    w.ringPulseAng = ang;
    w.shake = Math.min(9, w.shake + 4 + taken * 2);
    w.flash = Math.min(1, w.flash + 0.18 + taken * 0.12);
    Sound.sfx.breach();

    if (w.segments[idx] > SEG_CAPACITY) {
      w.breached = true;
      w.breachSeg = idx;
      breachRing(w, idx);
      // Same playout rule as losing the ship: the breach is the moment of
      // failure, not the moment the menu appears. Fire already in the air keeps
      // landing, so the player watches the wall give way.
      beginPlayout(w);
    }
  }

  // A segment has given way. Make it loud: the breach is a hole in the map, not a
  // number, so it gets a flash, a hard shake and a debris spray across its arc.
  function breachRing(w, idx) {
    var segAngle = TAU / SEGMENTS;
    var mid = wrapPi(idx * segAngle + segAngle / 2 - Math.PI);
    for (var s = 0; s <= 8; s++) {
      var a = mid + (s / 8 - 0.5) * segAngle;
      var p = polar(a, RING_R);
      burst(w, p.x, p.y, 8, C.ringHot, 150);
      burst(w, p.x, p.y, 4, C.white, 90);
    }
    w.shake = 12;
    w.flash = 1;
    Sound.sfx.over();
  }

  function playerStun(w) {
    var p = w.player;
    p.stun = STUN_TIME;
    p.cooldown = Math.max(p.cooldown, STUN_TIME);
    w.shake = Math.min(7, w.shake + 3);
    var pos = polar(p.ang, PLAYER_R);
    burst(w, pos.x, pos.y, 8, C.player, 90);
    Sound.sfx.hurt();
  }

  // The hull takes damage under the same rule as a ring segment: accumulate, and
  // die when the pool exceeds PLAYER_CAPACITY. A short invulnerability window
  // follows each hit so one collision cannot drain the pool in a single frame.
  function playerDamage(w, amount, ang) {
    var p = w.player;
    if (p.invuln > 0 || !p.alive || state !== 'playing') return false;

    p.hull = Math.min(PLAYER_CAPACITY + 1, p.hull + amount);
    p.invuln = 0.55;
    p.regen = 0;              // any hit restarts the regen clock
    var pos = polar(p.ang, PLAYER_R);
    burst(w, pos.x, pos.y, 6 + amount * 4, C.player, 90 + amount * 20);
    burst(w, pos.x, pos.y, 3 + amount * 2, C.ringHot, 60 + amount * 15);
    w.shake = Math.min(9, w.shake + 3 + amount);
    w.flash = Math.min(1, w.flash + 0.10 + amount * 0.06);
    Sound.sfx.hurt();

    if (p.hull > PLAYER_CAPACITY) {
      p.alive = false;
      playerDestroyed(w);
      return true;
    }
    return false;
  }

  // Losing the ship is its own end condition, distinct from a ring breach.
  // Losing the ship does not cut to a menu. The pilot is gone, but the wave is
  // still in the air: the game keeps simulating in a 'dying' state so the player
  // watches the failure resolve — burning enemies, fire still closing on a ring
  // nobody is defending. Only after the playout does the summary appear.
  function playerDestroyed(w) {
    var pos = polar(w.player.ang, PLAYER_R);
    burst(w, pos.x, pos.y, 40, C.player, 160);
    burst(w, pos.x, pos.y, 24, C.white, 110);
    burst(w, pos.x, pos.y, 16, C.ringHot, 130);
    // Debris streaks outward along the orbit: the wreckage keeps drifting.
    for (var d = 0; d < 14; d++) {
      var a = w.player.ang + rnd(-0.5, 0.5);
      var sp = polar(a, PLAYER_R);
      w.parts.push({
        x: sp.x, y: sp.y,
        vx: Math.cos(a) * rnd(20, 70), vy: Math.sin(a) * rnd(20, 70),
        life: rnd(0.6, 1.4), max: 1.4,
        color: d % 3 === 0 ? C.white : C.player, size: 1
      });
    }
    w.shake = 12;
    w.flash = 1;
    w.lostShip = true;
    Sound.sfx.over();
    beginPlayout(w);
  }

  // Starts the failure playout. The run is already lost, but everything keeps
  // moving so the player sees *why* — this is the "you see your failure in real
  // time" beat. PLAYOUT_TIME is long enough for a wave's remaining fire to land.
  function beginPlayout(w) {
    state = 'dying';
    w.stateTime = 0;
    w.playout = PLAYOUT_TIME;
    // Drop any wave banner: "WAVE CLEAR" over a dead ship is nonsense.
    w.banner = null;
  }

  function finishPlayout() {
    gameOver();
  }

  /* ----------------------------------------------------------------------
     ENEMIES
     ---------------------------------------------------------------------- */
  var ENEMY_DEF = {
    // --- wave 1-5 core set -------------------------------------------------
    drifter: {
      hp: 6, size: 7, speed: 44, hold: 999, va: 0,
      color: C.drifter, sides: 3, score: 100, fire: 0
    },
    spinner: {
      hp: 9, size: 8, speed: 38, hold: 78, va: 0.42,
      color: C.spinner, sides: 4, score: 150, fire: 1.7
    },
    turret: {
      hp: 14, size: 9, speed: 34, hold: 100, va: 0.12,
      color: C.turret, sides: 6, score: 220, fire: 1.05
    },
    splitter: {
      hp: 8, size: 9, speed: 40, hold: 88, va: -0.3,
      color: C.splitter, sides: 8, score: 180, fire: 2.4
    },
    shard: {
      hp: 3, size: 5, speed: 62, hold: 999, va: 0,
      color: C.splitter, sides: 3, score: 60, fire: 0
    },

    // --- wave 6+: one new verb per wave -----------------------------------
    // LANCER: a sprint, no gun. It does not threaten your position, it threatens
    // the ring, and it arrives fast. Shooting it means standing still and eating
    // whatever else is in the air — the core trade of the game.
    lancer: {
      hp: 11, size: 7, speed: 86, hold: 999, va: 0.05,
      color: '#ff5f5f', sides: 3, score: 240, fire: 0
    },
    // WEAVER: weaves hard and fires a *drifting* round. The impact point moves,
    // so reacting once is not enough — you have to track it. Its orbit is fast but
    // deliberately under ~0.7 rad/s: above that it outruns the player's ability to
    // hold a firing line on it, and the wave turns into a chase that never ends.
    weaver: {
      hp: 12, size: 8, speed: 36, hold: 74, va: 0.68,
      color: '#c78bff', sides: 5, score: 260, fire: 1.9
    },
    // RAMMER: ignores the ring and hunts *you*. A hit stuns, and a stunned player
    // cannot block, so it turns one mistake into a follow-up leak.
    rammer: {
      hp: 9, size: 8, speed: 52, hold: 999, va: 0,
      color: '#ffb03a', sides: 4, score: 220, fire: 0
    },
    // SENTRY: the attrition tank. Sits mid-field (not near the orbit — a hold
    // radius close to PLAYER_R puts the tank inside the player's own firing line,
    // so shots expire before reaching it and the wave becomes a stall), hits hard
    // and slow. HP is modest: a tank that outlasts the wave is a grind, not a
    // threat.
    sentry: {
      hp: 19, size: 11, speed: 30, hold: 74, va: 0.08,
      color: '#8fe36b', sides: 6, score: 380, fire: 2.2
    },

    boss: {
      hp: 64, size: 20, speed: 26, hold: 86, va: 0.14,
      color: C.boss, sides: 12, score: 2000, fire: 0
    },
    // WARDEN: the second boss. Three phases that each ask a different question:
    // hold a lane (stream), keep moving (lock), or chase (spiral).
    warden: {
      hp: 78, size: 20, speed: 24, hold: 90, va: -0.20,
      color: '#e46bff', sides: 8, score: 3000, fire: 0
    }
  };

  function spawnEnemy(w, type, ang) {
    var def = ENEMY_DEF[type];
    var tier = 1 + (w.wave - 1) * 0.075;
    var e = {
      type: type,
      ang: wrapPi(ang),
      r: 9,
      vr: def.speed,
      va: def.va,
      hold: def.hold,
      hp: Math.round(def.hp * (isBossType(type) ? 1 + Math.max(0, w.wave / 5 - 1) * 0.30 : tier)),
      size: def.size,
      color: def.color,
      sides: def.sides,
      score: def.score,
      fireT: def.fire ? rnd(0.5, def.fire) : 0,
      fireEvery: def.fire,
      flash: 0,
      rot: rnd(0, TAU),
      dead: false,
      fireSlot: false,
      // boss bookkeeping
      atk: 0, atkT: 0, atkPhase: 0, armAng: rnd(0, TAU), sweepAng: 0
    };
    e.maxHp = e.hp;
    if (isBossType(type)) e.r = 14;
    w.enemies.push(e);
    // spawn puff
    var p = polar(e.ang, e.r);
    burst(w, p.x, p.y, 8, e.color, 60);
    return e;
  }

  // Hands out the limited firing slots. Bosses always occupy one, so the boss
  // can never be silenced by a crowd of drones. The remaining slots go to the
  // ships closest to the ring, since those are the pressing threat.
  function assignFireSlots(w) {
    var i;
    for (i = 0; i < w.enemies.length; i++) w.enemies[i].fireSlot = false;

    var cap = maxFiring(w);
    var used = 0;
    for (i = 0; i < w.enemies.length; i++) {
      if (isBossType(w.enemies[i].type)) {
        w.enemies[i].fireSlot = true;
        used++;
      }
    }
    if (used >= cap) return;

    // Nearest-to-ring first, ties broken by array order for determinism.
    var order = w.enemies.slice().sort(function (a, b) { return b.r - a.r; });
    for (i = 0; i < order.length && used < cap; i++) {
      var e = order[i];
      if (isBossType(e.type) || !e.fireEvery) continue;
      e.fireSlot = true;
      used++;
    }
  }

  function enemyFire(w, e, dt) {
    if (!e.fireEvery) return;
    // Without a firing slot an enemy just keeps closing in; it does not shoot.
    // Holding its timer still (rather than draining it) keeps the rhythm intact
    // so a slot holder feels deliberate rather than random.
    if (!e.fireSlot) return;
    e.fireT -= dt;
    if (e.fireT > 0) return;
    e.fireT = e.fireEvery * clamp(1 - (w.wave - 1) * 0.03, 0.55, 1);

    // DESIGN CONSTRAINT (this is a 1-D arena): the player can only cover one
    // spoke at a time. So every pattern here must be blockable by rotating to
    // one place — never a simultaneous multi-spoke spread. Patterns differ by
    // *how* they make the player move, not by making them cover more ground.
    //
    // Three weapon families, three different demands:
    //   BOLT    — a discrete round. Answer: be on its spoke when it lands.
    //   BEAM    — a held line that sweeps. Answer: outrun the sweep, or leave.
    //   MISSILE — a guided round. Answer: meet it EARLY, because it re-aims.
    var fam = ENEMY_WEAPON[e.type] || 'bolt';

    if (fam === 'beam') {
      // A beam is not a projectile: it opens a sustained lane that sweeps slowly
      // along the ring. It cannot be intercepted, only avoided or outrun, which
      // makes it the one threat that punishes standing still rather than
      // mis-blocking. Implemented as a beam entity with a live arc.
      spawnBeam(w, e);
      Sound.sfx.charge();
      return;
    }

    if (fam === 'missile') {
      // Guided: it locks on spawn and keeps correcting, so meeting it late is
      // much harder than meeting it early. One missile per volley, not two — a
      // homing round is already a larger threat than a straight one, and two per
      // shot made a pair of missile enemies a wall of trackers.
      spawnMissile(w, e, e.va > 0 ? 0.08 : -0.08);
      Sound.sfx.hit();
      return;
    }

    // BOLT family: discrete rounds, differing by how they force movement.
    if (e.type === 'spinner') {
      // A tight aimed pair on a single spoke: one rotation answers it.
      for (var i = -1; i <= 1; i += 2) {
        spawnBullet(w, e.ang + i * 0.05, e.r + 4, BULLET_SPEED, 0.05 * i);
      }
      Sound.sfx.hit();
    } else if (e.type === 'turret') {
      // Aimed, gently homing: rewards staying mobile rather than standing still.
      aimedBullet(w, e, BULLET_SPEED_FAST, 0.30);
    } else if (e.type === 'sentry') {
      // Heavy, slow round from close range. Large and bright so it reads as a
      // threat worth intercepting rather than something to sidestep.
      spawnBullet(w, w.player.ang, e.r + 3, BULLET_SPEED_SLOW, 0, { big: true });
      Sound.sfx.charge();
    } else {
      // Fallback bolt: a single aimed round. Drifters do not fire, so this only
      // catches new types that forget to declare a pattern.
      aimedBullet(w, e, BULLET_SPEED, 0.20);
    }
  }

  function bossThink(w, e, dt) {
    e.atkT -= dt;
    if (e.atkT <= 0) {
      e.atk = (e.atk + 1) % 3;
      e.atkPhase = 0;
      e.atkT = e.atk === 0 ? 5.0 : (e.atk === 1 ? 3.6 : 3.0);
      if (e.atk === 1) e.sweepAng = e.ang;
      Sound.sfx.charge();
    }

    var hpFrac = e.hp / e.maxHp;
    var rate = hpFrac < 0.4 ? 0.78 : 1;

    // Same one-spoke constraint as regular enemies: the boss creates pressure by
    // forcing a long chase or a well-timed block, never by spreading fire wider
    // than a single rotation can answer. Simultaneous arms are spaced far enough
    // apart in *time* that each can be met.
    if (e.atk === 0) {
      // Slow rotating single arm: the player can run with it or cut across.
      e.armAng += dt * 0.9 * rate;
      e.atkPhase += dt;
      if (e.atkPhase >= 0.55 / rate) {
        e.atkPhase = 0;
        spawnBullet(w, e.armAng, e.r + 4, BULLET_SPEED, 0.30, { big: true });
        Sound.sfx.hit();
      }
    } else if (e.atk === 1) {
      // A cut that sweeps around the circle: run with it or eat the leaks.
      e.atkPhase += dt;
      if (e.atkPhase >= 0.24 / rate) {
        e.atkPhase = 0;
        e.sweepAng += 0.34;
        spawnBullet(w, e.sweepAng, e.r + 4, BULLET_SPEED_FAST, 0);
        Sound.sfx.hit();
      }
    } else {
      // Aimed burst on the player's spoke, spaced so one block answers the pair.
      // NOTE: the cooldown must be armed here. Setting atkPhase above the
      // threshold instead (as this did) re-fired every frame and buried the arena
      // in ~150 bullets in 20s.
      e.atkPhase += dt;
      if (e.atkPhase >= 1.15 / rate) {
        e.atkPhase = 0;
        for (var k = 0; k < 2; k++) {
          spawnBullet(w, w.player.ang + (k - 0.5) * 0.05, e.r + 4, BULLET_SPEED, 0);
        }
        Sound.sfx.hit();
      }
    }
  }

  function damageEnemy(w, e, amount, at) {
    e.hp -= amount;
    e.flash = 0.09;
    burst(w, at.x, at.y, 3, C.white, 55);
    if (e.hp > 0) return;

    e.dead = true;
    w.kills++; w.waveKills++;
    w.score += e.score;
    var p = polar(e.ang, e.r);
    var big = isBossType(e.type);
    burst(w, p.x, p.y, big ? 46 : 14, e.color, big ? 150 : 100);
    burst(w, p.x, p.y, big ? 20 : 6, C.white, 80);
    floater(w, p.x, p.y - 6, '+' + e.score, e.color);
    w.shake = Math.min(10, w.shake + (big ? 9 : 1.6));
    Sound.sfx.kill();

    if (e.type === 'splitter') {
      for (var i = 0; i < 2; i++) {
        var s = spawnEnemy(w, 'shard', e.ang + (i ? 0.16 : -0.16));
        s.r = e.r;
        s.va = i ? 0.5 : -0.5;
      }
    }

    // Not every kill sheds a chip — see DROP_CHANCE. Bosses always drop a shower
    // so the reward for a long fight is visible rather than a single stray pickup.
    if (big) {
      for (var t = 0; t < 5; t++) {
        spawnToken(w, e.ang + (t - 2) * 0.16, e.r + 6, null, e.type);
      }
      w.dryKills = 0;
    } else if (shouldDrop(w, e)) {
      spawnToken(w, e.ang, e.r + 2, null, e.type);
      w.dryKills = 0;
    } else {
      w.dryKills = (w.dryKills || 0) + 1;
    }

    if (big) {
      w.score += 500 * w.wave;
      w.slowmo = 0.55;
    }
  }

  /* ----------------------------------------------------------------------
     WAVE DIRECTOR
     ---------------------------------------------------------------------- */
  function buildWave(n) {
    var q = [];
    var t = 0.35;
    function add(type, delay, ang) {
      t += delay;
      q.push({ t: t, type: type, ang: ang == null ? rnd(0, TAU) : ang });
    }

    if (n % 5 === 0) {
      // Alternate the two bosses so every tenth wave is a different fight.
      var bossType = (n % 10 === 0) ? 'warden' : 'boss';
      add(bossType, 1.0, rnd(0, TAU));
      return q;
    }

    // Waves 1-4 are hand-authored tutorials: each adds one idea, in the order the
    // player needs to learn them (move -> block -> chase -> split).
    // Waves 1-4 are hand-authored tutorials: each adds one idea, in the order the
    // player needs to learn them (move -> block -> chase -> split).
    if (n === 1) {
      add('drifter', 0.7, -Math.PI / 2 + 0.9);
      add('drifter', 0.9, -Math.PI / 2 - 0.9);
      add('drifter', 1.1);
      add('drifter', 1.0);
      return q;
    }
    if (n === 2) {
      add('drifter', 0.5);
      add('drifter', 0.6);
      add('turret', 1.0);
      add('drifter', 1.2);
      return q;
    }
    if (n === 3) {
      add('spinner', 0.5);
      add('drifter', 0.7);
      add('spinner', 1.0);
      add('drifter', 0.8);
      add('spinner', 1.2);
      return q;
    }
    if (n === 4) {
      // Teaches the splitter (and therefore missiles). One splitter only: two of
      // them plus a turret was a wall, because a missile-firing splitter is a much
      // bigger threat than the bullet-firing version it replaced.
      add('splitter', 0.6);
      add('drifter', 0.7);
      add('drifter', 1.0);
      add('turret', 1.2);
      return q;
    }

    // Waves 5-10 each introduce exactly one new enemy, so every wave in the first
    // ten teaches something instead of just stacking HP. Bosses land on 5 and 10.
    if (n === 6) {
      add('lancer', 0.5);
      add('drifter', 0.5);
      add('lancer', 0.55);
      add('turret', 0.6);
      add('lancer', 0.7);
      add('drifter', 0.55);
      add('lancer', 0.6);
      return q;
    }
    if (n === 7) {
      add('weaver', 0.5);
      add('drifter', 0.5);
      add('weaver', 0.6);
      add('spinner', 0.6);
      add('lancer', 0.6);
      add('lancer', 0.6);
      add('drifter', 0.5);
      return q;
    }
    if (n === 8) {
      add('rammer', 0.5);
      add('turret', 0.55);
      add('rammer', 0.6);
      add('weaver', 0.6);
      add('lancer', 0.6);
      add('drifter', 0.5);
      add('rammer', 0.6);
      add('drifter', 0.5);
      return q;
    }
    if (n === 9) {
      // Exactly one sentry: a tank is meant to be *a* priority target, not a pair
      // that splits the player's attention and turns the wave into a grind.
      add('sentry', 0.6);
      add('rammer', 0.6);
      add('lancer', 0.55);
      add('weaver', 0.6);
      add('turret', 0.7);
      add('drifter', 0.5);
      add('lancer', 0.55);
      return q;
    }

    // Procedural mix for waves 11+. Late waves escalate on three axes, not one:
    // more bodies, a wider mix (including tanks), and — via DUAL_FIRE_WAVE — a
    // second concurrent shooter. HP still creeps up, but it is not the only lever,
    // which is what made late waves feel like the same fight with bigger numbers.
    var pool = n >= 14
      ? ['drifter', 'spinner', 'turret', 'splitter', 'lancer', 'weaver', 'rammer', 'sentry']
      : ['drifter', 'spinner', 'turret', 'splitter', 'lancer', 'weaver', 'rammer'];
    var count = clamp(3 + Math.floor(n / 2), 4, 12);
    for (var i = 0; i < count; i++) {
      add(pick(pool), rnd(0.34, 0.75));
    }
    return q;
  }

  function startWave(w, n) {
    w.wave = n;
    w.waveKills = 0;
    w.spawnQueue = buildWave(n);
    waveStart = w.t;
    resetRing(w);
    w.banner = { text: (n % 5 === 0 ? 'WARNING  //  WAVE ' : 'WAVE ') + pad(n, 2), time: 1.5, kind: n % 5 === 0 ? 'boss' : 'wave' };
    if (n % 5 === 0) Sound.sfx.charge(); else Sound.sfx.wave();
  }

  function waveCleared(w) {
    var bonus = Math.max(0, SEGMENTS * SEG_CAPACITY - ringTotal(w)) * 25 * w.wave;
    w.score += bonus;
    w.banner = {
      text: 'WAVE ' + pad(w.wave, 2) + ' CLEAR',
      sub: 'RING BONUS +' + bonus,
      time: 1.8,
      kind: 'clear'
    };
    // leftover fire dissolves instead of cheap-shotting the ring
    for (var i = 0; i < w.bullets.length; i++) {
      var b = w.bullets[i];
      var p = polar(b.ang, b.r);
      burst(w, p.x, p.y, 2, C.bullet, 40);
    }
    w.bullets.length = 0;
    w.beams.length = 0;
    w.missiles.length = 0;
    state = 'waveclear';
    w.stateTime = 0;
    Sound.sfx.clear();
  }

  function gameOver() {
    state = 'gameover';
    world.stateTime = 0;
    world.shake = 12;    // Re-read first: another tab may hold a higher record than the one cached
    // at boot, and a run must never lower the stored best.
    best = Math.max(best, loadBest());
    world.newBest = world.wave > best;
    if (world.newBest) {
      best = world.wave;
      saveBest(best);
    }
    Sound.sfx.over();
  }

  function startRun() {
    world = newWorld();
    state = 'playing';
    world.stateTime = 0;
    startWave(world, 1);
    Sound.sfx.start();
  }
  /* ----------------------------------------------------------------------
     UPDATE
     ---------------------------------------------------------------------- */
  function update(dt) {
    if (state === 'title') { updateAmbient(dt); return; }
    if (state === 'paused') return;

    var w = world;
    if (!w) return;

    w.stateTime += dt;

    if (state === 'gameover') {
      w.t += dt * 0.35;
      stepParticles(w, dt);
      w.shake *= Math.pow(0.02, dt);
      return;
    }

    // Failure playout: the ship is gone but the battle keeps resolving. Enemies
    // keep moving and firing, and their fire still lands on the ring, so the
    // player sees exactly what killed them. Input is ignored; the summary waits.
    if (state === 'dying') {
      w.t += dt;
      w.flash = Math.max(0, w.flash - dt * 1.6);
      w.shake = Math.max(0, w.shake - dt * 12);
      w.ringPulse = Math.max(0, (w.ringPulse || 0) - dt * 3.4);
      assignFireSlots(w);
      stepEnemies(w, dt);
      stepBullets(w, dt);
      stepBeams(w, dt);
      stepMissiles(w, dt);
      stepTokens(w, dt);
      stepRingHeal(w, dt);
      stepParticles(w, dt);

      // Drift the wreckage along the orbit so the death does not look frozen.
      w.playout -= dt;
      if (w.playout <= 0) finishPlayout();
      return;
    }

    if (w.slowmo > 0) {
      w.slowmo -= dt;
      dt *= 0.35;
    }

    w.t += dt;
    w.flash = Math.max(0, w.flash - dt * 2.6);
    w.shake = Math.max(0, w.shake - dt * 26);
    // Ring pulse decays fast enough to read as a hit, slow enough to be seen.
    w.ringPulse = Math.max(0, (w.ringPulse || 0) - dt * 3.4);
    if (w.banner) {
      w.banner.time -= dt;
      if (w.banner.time <= 0) w.banner = null;
    }

    stepPlayer(w, dt);
    stepShots(w, dt);
    assignFireSlots(w);
    stepEnemies(w, dt);
    stepBullets(w, dt);
    stepBeams(w, dt);
    stepMissiles(w, dt);
    stepTokens(w, dt);
    stepRingHeal(w, dt);
    stepParticles(w, dt);

    if (state === 'playing') {
      // spawn queue
      for (var i = 0; i < w.spawnQueue.length; i++) {
        if (w.spawnQueue[i].t <= w.t - waveStart) {
          var s = w.spawnQueue.splice(i, 1)[0];
          spawnEnemy(w, s.type, s.ang);
          i--;
        }
      }
      if (w.spawnQueue.length === 0 && w.enemies.length === 0) waveCleared(w);
    } else if (state === 'waveclear') {
      if (w.stateTime > 1.9) {
        state = 'playing';
        w.stateTime = 0;
        startWave(w, w.wave + 1);
      }
    }
  }

  var waveStart = 0;

  function updateAmbient(dt) {
    // title screen: keep the decorative ring alive
    if (!world) world = newWorld();
    world.t += dt;
    world.player.ang += dt * 0.55;
    stepParticles(world, dt);
  }

  function stepPlayer(w, dt) {
    var p = w.player;
    p.stun = Math.max(0, p.stun - dt);
    p.invuln = Math.max(0, (p.invuln || 0) - dt);
    // Hull regen: a quiet stretch knits a point back. The clock resets on damage
    // (see playerDamage), so sustained fire still kills — this only forgives
    // isolated hits, which is what keeps the ring the primary pressure.
    p.regen = (p.regen || 0) + dt;
    if (p.hull > 0 && p.regen >= HULL_REGEN_TIME) {
      p.regen = 0;
      p.hull = Math.max(0, p.hull - 1);
      var rpos = polar(p.ang, PLAYER_R);
      burst(w, rpos.x, rpos.y, 4, C.player, 40);
    }
    p.cooldown -= dt;
    if (p.cooldown < 0) p.cooldown = 0;

    var dir = 0;
    if (keys['ArrowLeft'] || keys['a'] || keys['A']) dir -= 1;
    if (keys['ArrowRight'] || keys['d'] || keys['D']) dir += 1;

    w.focus = !!(keys['Shift'] || keys[' '] || pointer.down);

    // Strict left/right only. The arena is one-dimensional, so mouse steering was
    // redundant with the keys and made precision play mushy.
    p.dir = dir;
    if (dir !== 0) {
      var spd = PLAYER_ARC_SPEED * (w.focus ? FOCUS_SCALE : 1);
      p.ang = wrapPi(p.ang + dir * spd * dt);
    }

    // trail
    p.trail.push({ ang: p.ang, life: 0.28 });
    for (var i = p.trail.length - 1; i >= 0; i--) {
      p.trail[i].life -= dt;
      if (p.trail[i].life <= 0) p.trail.splice(i, 1);
    }

    // firing — interval and barrel spread both come from upgrades
    if (p.stun <= 0 && p.cooldown <= 0) {
      p.cooldown = fireInterval(w);
      var n = barrels(w);
      var spreadF = shotSpread(w);
      for (var b = 0; b < n; b++) {
        var t = n === 1 ? 0 : (b / (n - 1)) - 0.5;
        spawnShot(w, p.ang + t * spreadF * 2, PLAYER_R - 5);
      }
      Sound.sfx.shoot();
      var pos = polar(p.ang, PLAYER_R - 4);
      burst(w, pos.x, pos.y, 2, C.shot, 40, p.ang + Math.PI);
    }
  }

  // Upgrade effects. Kept as functions so the derived values are obvious and
  // testable rather than scattered magic numbers.
  // Upgrade effects, one per weapon family. Bolt is rate, beam is a wider block,
  // missile is piercing rounds that punch through a target and keep going.
  function fireInterval(w) {
    return SHOT_INTERVAL * Math.pow(0.88, w.levels.bolt);
  }
  // Wider block: more barrels means a wider arc of incoming fire is cancelled.
  function barrels(w) {
    return 2 + Math.floor(w.levels.beam / 2) * 2; // 2 -> 4 -> 6
  }
  // Piercing: a shot that kills its target carries on to the next body behind it.
  function shotPierce(w) {
    return 1 + Math.floor(w.levels.missile / 2); // 1 -> 2 -> 3 targets
  }
  function shotSpread(w) {
    return (w.focus ? 0.012 : 0.026) + w.levels.beam * 0.02;
  }

  function stepShots(w, dt) {
    var shots = w.shots;
    for (var i = shots.length - 1; i >= 0; i--) {
      var s = shots[i];
      s.r -= SHOT_SPEED * dt;
      if (s.r < 6 || s.dead) { shots.splice(i, 1); continue; }
      var pos = polar(s.ang, s.r);
      s.px = pos.x; s.py = pos.y;

      // Enemy bodies stop player fire. Interception is resolved first (in
      // stepBullets) so a bullet between you and a ship always wins the block.
      var hit = -1;
      for (var j = w.enemies.length - 1; j >= 0; j--) {
        var e = w.enemies[j];
        if (Math.abs(e.r - s.r) > e.size + 3) continue;
        if (Math.abs(angDelta(s.ang, e.ang)) * Math.max(8, s.r) > e.size + 4) continue;
        hit = j;
        break;
      }
      if (hit >= 0) {
        var target = w.enemies[hit];
        shots.splice(i, 1);
        damageEnemy(w, target, 1, pos);
        if (target.dead) {
          var at = w.enemies.indexOf(target);
          if (at >= 0) w.enemies.splice(at, 1);
        }
      }
    }
  }

  // WARDEN's three phases. Each asks a different question so the fight cannot be
  // solved once and repeated: hold a lane, keep moving, or chase.
  function wardenThink(w, e, dt) {
    e.atkT -= dt;
    if (e.atkT <= 0) {
      e.atk = (e.atk + 1) % 3;
      e.atkPhase = 0;
      e.atkT = e.atk === 0 ? 4.4 : (e.atk === 1 ? 4.0 : 4.8);
      if (e.atk === 1) e.sweepAng = e.ang;
      if (e.atk === 2) e.armAng = e.ang;
      Sound.sfx.charge();
    }

    var hpFrac = e.hp / e.maxHp;
    var rate = hpFrac < 0.4 ? 0.8 : 1;

    if (e.atk === 0) {
      // STREAM: consecutive rounds down one spoke, walking sideways. Stand still
      // and you eat the next one, so it forces a decision each beat.
      e.atkPhase += dt;
      if (e.atkPhase >= 0.30 / rate) {
        e.atkPhase = 0;
        e.armAng += 0.30;
        spawnBullet(w, e.armAng, e.r + 4, BULLET_SPEED, 0, { big: true });
        Sound.sfx.hit();
      }
    } else if (e.atk === 1) {
      // LOCK: three slow rounds converging on one predicted point. Being early is
      // as fatal as being late, so it rewards holding a lane and leaving on cue.
      e.atkPhase += dt;
      if (e.atkPhase >= 1.15 / rate) {
        e.atkPhase = 0;
        var t = Math.max(0.2, (RING_R - e.r) / BULLET_SPEED);
        var pred = wrapPi(w.player.ang + (w.player.dir || 0) * PLAYER_ARC_SPEED * t * 0.7);
        for (var k = -1; k <= 1; k++) {
          spawnBullet(w, e.ang, e.r + 4, BULLET_SPEED, angDelta(pred + k * 0.03, e.ang) / t);
        }
        Sound.sfx.charge();
      }
    } else {
      // SPIRAL: a slow rotating arc that grows. Chase the tail or be clipped.
      e.atkPhase += dt;
      if (e.atkPhase >= 0.20 / rate) {
        e.atkPhase = 0;
        e.sweepAng += 0.26;
        for (var s = 0; s < 2; s++) {
          spawnBullet(w, e.sweepAng - s * 0.42, e.r + 4, BULLET_SPEED_FAST, 0.10);
        }
        Sound.sfx.hit();
      }
    }
  }

  function stepEnemies(w, dt) {
    var list = w.enemies;
    for (var i = list.length - 1; i >= 0; i--) {
      var e = list[i];
      e.flash = Math.max(0, e.flash - dt);
      var isBoss = (e.type === 'boss' || e.type === 'warden');
      e.rot += dt * (isBoss ? 0.6 : 1.4);

      if (e.type === 'rammer') {
        // Hunt the player rather than the ring: steer straight at their spoke and
        // keep closing. This is the one enemy whose target is *you*, so it forces
        // movement even when the ring itself is safe.
        var da = angDelta(w.player.ang, e.ang);
        e.ang = wrapPi(e.ang + clamp(da, -1.5 * dt, 1.5 * dt));
        e.r += e.vr * dt;
      } else {
        // advance outward until the holding radius
        if (e.r < e.hold) {
          e.r += e.vr * dt;
          if (e.r > e.hold) e.r = e.hold;
        } else if (isBoss) {
          e.r = e.hold + Math.sin(w.t * 0.8) * 5;
        }
        e.ang = wrapPi(e.ang + e.va * dt);
      }

      if (isBossType(e.type)) {
        if (e.r > 40) {
          if (e.type === 'warden') wardenThink(w, e, dt);
          else bossThink(w, e, dt);
        }
      } else {
        enemyFire(w, e, dt);
      }

      // reached the ring
      if (e.r >= RING_R - 3) {
        e.dead = true;
        list.splice(i, 1);
        var rp = polar(e.ang, RING_R);
        burst(w, rp.x, rp.y, 16, e.color, 130);
        ringDamage(w, e.ang, isBoss ? DMG_BOSS : DMG_SHIP);
        continue;
      }

      // body contact with the player. Ramming is no longer free: the ship takes
      // real hull damage, so ploughing into a ship can end the run.
      if (Math.abs(e.r - PLAYER_R) < e.size + 4) {
        var ad = Math.abs(angDelta(e.ang, w.player.ang)) * PLAYER_R;
        if (ad < e.size + 6) {
          playerStun(w);
          playerDamage(w, PLAYER_DMG_RAM, e.ang);
          if (state !== 'playing' && state !== 'dying') break;
          damageEnemy(w, e, 2, polar(e.ang, e.r));
        }
      }

      if (e.dead) list.splice(i, 1);
    }
  }

  function stepBullets(w, dt) {
    var list = w.bullets;
    var p = w.player;

    for (var i = list.length - 1; i >= 0; i--) {
      var b = list[i];
      b.born += dt;
      b.r += b.vr * dt;
      b.ang = wrapPi(b.ang + b.va * dt);

      // --- intercept by player fire (the core defensive verb)
      if (!b.dead && b.r > 12) {
        for (var j = 0; j < w.shots.length; j++) {
          var s = w.shots[j];
          if (s.dead) continue;
          if (Math.abs(s.r - b.r) < 7) {
            var arc = Math.abs(angDelta(s.ang, b.ang)) * b.r;
            if (arc < 7) {
              b.dead = true; s.dead = true;
              var ip = polar(b.ang, b.r);
              burst(w, ip.x, ip.y, 6, C.shot, 80);
              burst(w, ip.x, ip.y, 3, C.white, 50);
              w.score += 5;
              Sound.sfx.hit();
              break;
            }
          }
        }
      }

      // --- player body absorbs it: costs hull integrity, not just tempo
      if (!b.dead && b.r > PLAYER_R - 9 && b.r < PLAYER_R + 6) {
        var pad = Math.abs(angDelta(b.ang, p.ang)) * PLAYER_R;
        if (pad < 9) {
          b.dead = true;
          playerStun(w);
          playerDamage(w, PLAYER_DMG_BULLET, b.ang);
          if (state !== 'playing' && state !== 'dying') break;
        }
      }

      // --- reached the ring
      if (!b.dead && b.r >= RING_R) {
        b.dead = true;
        ringDamage(w, b.ang, DMG_BULLET);
      }

      if (b.dead || b.r > RING_R + 4) list.splice(i, 1);
    }
  }

  function stepParticles(w, dt) {
    var i;
    for (i = w.parts.length - 1; i >= 0; i--) {
      var pt = w.parts[i];
      pt.life -= dt;
      if (pt.life <= 0) { w.parts.splice(i, 1); continue; }
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= 0.94; pt.vy *= 0.94;
    }
    for (i = w.floaters.length - 1; i >= 0; i--) {
      var f = w.floaters[i];
      f.life -= dt;
      f.y -= dt * 16;
      if (f.life <= 0) w.floaters.splice(i, 1);
    }
  }

  /* ----------------------------------------------------------------------
     DRAW
     ---------------------------------------------------------------------- */
  function polyPath(c, cx, cy, r, sides, rot) {
    for (var i = 0; i < sides; i++) {
      var a = rot + i * TAU / sides;
      var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
  }

  function drawArcSegment(c, a0, a1, r, wdt) {
    // More steps for wide spans: with only 3 the chords cut visibly inside the
    // circle, and a full TAU collapses into a single degenerate chord.
    var span = Math.abs(a1 - a0);
    var steps = Math.max(3, Math.ceil(span / 0.18));
    c.beginPath();
    for (var i = 0; i <= steps; i++) {
      var a = a0 + (a1 - a0) * (i / steps);
      var x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.lineWidth = wdt;
    c.stroke();
  }

  // Full-ring stroke as a real arc path (never a polyline that can degenerate).
  function drawRingCircle(c, r, wdt, color, alpha) {
    c.beginPath();
    c.arc(CX, CY, r, 0, TAU);
    c.strokeStyle = color;
    c.lineWidth = wdt;
    c.globalAlpha = alpha;
    c.stroke();
    c.globalAlpha = 1;
  }

  function drawArena(w) {
    // Base floor
    ctx.fillStyle = C.floor1;
    ctx.fillRect(0, 0, W, H);

    // Concentric 16-gons: alternating bands so the arena reads as a stepped
    // 8-bit floor rather than a smooth gradient disc.
    var bands = 9;
    for (var b = 0; b < bands; b++) {
      var r = RING_R - b * 14;
      if (r < 8) break;
      ctx.beginPath();
      polyPath(ctx, CX, CY, r, 16, Math.PI / 16 + w.t * 0.02 * (b % 2 ? 1 : -1));
      ctx.fillStyle = b === 0 ? C.floor2 : (b % 2 ? C.floor1 : C.floor2);
      ctx.fill();
    }

    // Dithered bands: a single-pixel checker, classic 8-bit shading.
    ctx.fillStyle = C.dither;
    for (var band = 0; band < 4; band++) {
      var rr = RING_R - 6 - band * 7;
      var dens = band % 2 === 0 ? 14 : 26;
      for (var a = 0; a < dens; a++) {
        var ang = (a / dens) * TAU + (band * 0.11) + w.t * 0.015 * (band % 2 ? -1 : 1);
        for (var k = 0; k < 2; k++) {
          var rad = rr + k * 2;
          if ((a + k + band) % 2) continue;
          ctx.fillRect(
            Math.round(CX + Math.cos(ang) * rad),
            Math.round(CY + Math.sin(ang) * rad), 1, 1);
        }
      }
    }

    // Radial spokes, quantised to 16 so the geometry reads as a grid.
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var s = 0; s < 16; s++) {
      var sa = s * TAU / 16 + Math.PI / 16;
      ctx.moveTo(Math.round(CX + Math.cos(sa) * 22), Math.round(CY + Math.sin(sa) * 22));
      ctx.lineTo(Math.round(CX + Math.cos(sa) * (RING_R - 2)), Math.round(CY + Math.sin(sa) * (RING_R - 2)));
    }
    ctx.stroke();
  }

  function drawCore(w) {
    var pulse = 0.5 + Math.sin(w.t * 2.2) * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    polyPath(ctx, CX, CY, 20 + pulse * 2, 6, w.t * 0.6);
    ctx.fillStyle = C.core;
    ctx.fill();
    ctx.strokeStyle = C.coreHi;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    polyPath(ctx, CX, CY, 11 + pulse * 3, 3, -w.t * 1.1);
    ctx.fillStyle = C.coreHi;
    ctx.fill();

    ctx.globalAlpha = 0.35 + pulse * 0.4;
    ctx.beginPath();
    polyPath(ctx, CX, CY, 5, 3, w.t * 2.4);
    ctx.fillStyle = C.corePulse;
    ctx.fill();
    ctx.restore();
  }

  // Ring rendering. Each segment's damage pool is drawn as its own state, so the
  // wall itself is the readout: intact segments glow clean, damaged ones darken
  // and thin out, nearly-breached ones run hot, and the breached arc is a hole.
  function drawRing(w) {
    var segAngle = TAU / SEGMENTS;
    var worst = ringWorst(w);

    for (var i = 0; i < SEGMENTS; i++) {
      var a0 = i * segAngle + 0.012;
      var a1 = (i + 1) * segAngle - 0.012;
      var dmg = w.segments[i] || 0;
      var isBreach = (w.breached && i === w.breachSeg);
      // Headroom, in points, before this arc breaches. Colour is driven by this
      // rather than by a fraction of capacity: with a small capacity a fraction
      // collapses distinct states onto one colour, and the player needs to know
      // "one more hit kills this arc" at a glance.
      var headroom = SEG_CAPACITY + 1 - dmg;

      if (isBreach) {
        // A hole: draw only the broken stubs, with the arc visually missing.
        ctx.strokeStyle = '#150710';
        ctx.lineWidth = 3;
        drawArcSegment(ctx, a0, a1, RING_R - 4, 3);
        ctx.strokeStyle = C.ringHot;
        ctx.globalAlpha = 0.55 + 0.25 * Math.sin(w.t * 22);
        ctx.lineWidth = 1;
        drawArcSegment(ctx, a0 + 0.01, a0 + segAngle * 0.16, RING_R - 2, 1);
        drawArcSegment(ctx, a1 - segAngle * 0.16, a1 - 0.01, RING_R - 2, 1);
        ctx.globalAlpha = 1;
      } else if (dmg <= 0) {
        // Pristine
        ctx.strokeStyle = C.ringOk;
        ctx.globalAlpha = 0.25;
        drawArcSegment(ctx, a0, a1, RING_R, 9);
        ctx.globalAlpha = 1;
        drawArcSegment(ctx, a0, a1, RING_R, 4);
        ctx.strokeStyle = C.white;
        ctx.globalAlpha = 0.55;
        drawArcSegment(ctx, a0 + segAngle * 0.28, a1 - segAngle * 0.28, RING_R, 1);
        ctx.globalAlpha = 1;
      } else {
        // Damaged. Colour by remaining headroom: green = room to spare,
        // amber = one hit from breaching, red = loaded and flashing.
        var col;
        if (headroom >= SEG_CAPACITY) col = '#9fe8a0';       // still comfortable
        else if (headroom > 1) col = C.ringWarn;              // getting thin
        else col = (Math.sin(w.t * 14) > 0) ? C.ringHot : C.ringWarn;  // one hit left
        var thick = headroom <= 1 ? 4 : 3;
        // The drawn arc shortens as damage accumulates: the wall is being eaten.
        var dmgFrac = dmg / (SEG_CAPACITY + 1);
        var keep = 1 - dmgFrac * 0.42;
        var da0 = a0 + (a1 - a0) * (1 - keep) * 0.5;
        var da1 = a1 - (a1 - a0) * (1 - keep) * 0.5;

        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.22;
        drawArcSegment(ctx, da0, da1, RING_R, 9);
        ctx.globalAlpha = 1;
        drawArcSegment(ctx, da0, da1, RING_R, thick);

        // Damage pips: one notch per point absorbed, so the exact pool is legible.
        ctx.fillStyle = col;
        for (var k = 0; k < dmg; k++) {
          var ta2 = a0 + (a1 - a0) * ((k + 1) / (SEG_CAPACITY + 2));
          var pp = polar(ta2, RING_R + 5);
          ctx.fillRect(Math.round(pp.x) - 1, Math.round(pp.y) - 1, 2, 2);
        }
      }

      // tick marks between segments
      var ta = i * segAngle;
      var p1 = polar(ta, RING_R - 5), p2 = polar(ta, RING_R + 5);
      ctx.strokeStyle = dmg > 0 ? '#3a1220' : '#0d2a2e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(p1.x), Math.round(p1.y));
      ctx.lineTo(Math.round(p2.x), Math.round(p2.y));
      ctx.stroke();
    }

    // A slow pulse around the single worst segment, so the player can see which
    // arc is about to kill them without counting pips.
    if (worst.value >= SEG_CAPACITY && !w.breached) {
      var wa0 = worst.index * segAngle + 0.03;
      var wa1 = (worst.index + 1) * segAngle - 0.03;
      ctx.strokeStyle = C.ringHot;
      ctx.globalAlpha = 0.35 + 0.35 * Math.sin(w.t * 12);
      ctx.lineWidth = 7;
      drawArcSegment(ctx, wa0, wa1, RING_R, 7);
      ctx.globalAlpha = 1;
    }

    // Damage pulse, drawn once per frame after the segments: a red shock that
    // spreads both ways around the ring from the impact spoke. Reach and
    // intensity scale with how much was taken at once, so a single chip reads as
    // a flicker while a breach flares the whole ring.
    if (w.ringPulse > 0.01) {
      var pp = w.ringPulse;
      var reach = pp * 1.5;                 // radians of spread
      var hot = 1 - Math.pow(1 - pp, 2);    // eased intensity
      var thick = 2 + Math.round(pp * 4);
      ctx.strokeStyle = pp > 0.55 ? '#ff2740' : C.ringHot;
      for (var side = -1; side <= 1; side += 2) {
        for (var k = 0; k < 3; k++) {
          var spread = reach * (1 - k * 0.3);
          var a = (w.ringPulseAng || 0) + side * spread;
          ctx.globalAlpha = hot * (0.85 - k * 0.24);
          drawArcSegment(ctx, a - 0.07, a + 0.07, RING_R, thick);
        }
      }
      // wide wash so the whole ring reads red at high severity
      if (pp > 0.3) {
        drawRingCircle(ctx, RING_R, 9, C.ringHot, hot * 0.18);
      }
      ctx.globalAlpha = 1;
    }
  }

  // ----------------------------------------------------------------------
  // PIXEL SPRITES
  // ----------------------------------------------------------------------
  // Hand-authored bitmaps. '.' is transparent; every other key looks up a
  // palette colour. Drawing real pixel art (instead of scaled primitives) is
  // what makes the game read as 8-bit rather than as vector shapes.
  var PLAYER_ART = [
    '.....B.....',
    '.....B.....',
    '....BBB....',
    '....BCB....',
    '...BBBBB...',
    '...BBCBB...',
    '..BBBBBBB..',
    '..BBBBBBB..',
    '.BBBBBBBBB.',
    'BBBBBBBBBBB'
  ];

  function drawSprite(art, pal, ox, oy, outline, scale) {
    scale = scale || 1;
    var h = art.length, w = art[0].length;
    var x, y, ch, col;
    if (outline) {
      // Halo pass so the sprite stays legible over any floor tone.
      ctx.fillStyle = outline;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          if (art[y][x] === '.') continue;
          var px = ox + x * scale, py = oy + y * scale;
          ctx.fillRect(px - scale, py, scale, scale);
          ctx.fillRect(px + scale, py, scale, scale);
          ctx.fillRect(px, py - scale, scale, scale);
          ctx.fillRect(px, py + scale, scale, scale);
        }
      }
    }
    for (y = 0; y < h; y++) {
      var row = art[y];
      for (x = 0; x < w; x++) {
        ch = row[x];
        if (ch === '.') continue;
        col = pal[ch];
        if (!col) continue;
        ctx.fillStyle = col;
        ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
      }
    }
  }

  function drawPlayer(w) {
    var p = w.player;
    var stunned = p.stun > 0;

    // trail
    for (var i = 0; i < p.trail.length; i++) {
      var tr = p.trail[i];
      var a = tr.life / 0.28;
      var pp = polar(tr.ang, PLAYER_R);
      ctx.globalAlpha = a * 0.30;
      ctx.fillStyle = C.player;
      ctx.fillRect(Math.round(pp.x) - 1, Math.round(pp.y) - 1, 3, 3);
    }
    ctx.globalAlpha = 1;

    var pos = polar(p.ang, PLAYER_R);
    var x = Math.round(pos.x), y = Math.round(pos.y);

    ctx.save();
    ctx.translate(x, y);
    // Rotate so local -Y (the nose) points at the core. A point at angle θ has
    // inward direction -θ̂; mapping local (0,-1) there needs θ_rot = ang - π/2.
    ctx.rotate(p.ang - Math.PI / 2);

    var body = stunned ? C.playerDim : C.player;
    if (stunned && Math.floor(w.t * 30) % 2 === 0) body = C.white;
    // Hull damage tints the ship hot and strobes during the invulnerability window,
    // so a collision is unmistakable and the grace period is visible.
    if (p.hull > 0 && Math.floor(w.t * 26) % 2 === 0) {
      body = p.hull >= PLAYER_CAPACITY ? C.ringHot : C.ringWarn;
    }

    // Muzzle flash on the inward tip while the gun is hot.
    if (p.cooldown > SHOT_INTERVAL * 0.55 && !stunned) {
      ctx.fillStyle = C.shot;
      ctx.fillRect(-1, -11, 2, 3);
    }

    drawSprite(PLAYER_ART, {
      B: body,
      W: C.white,
      C: '#0a2b1e',
      D: C.playerDim
    }, -5, -9, '#04120c', 1);

    // Focus ring: the hitbox readout that makes precision play possible.
    if (w.focus) {
      ctx.strokeStyle = C.player;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  var ENEMY_ART = {
    drifter: [
      '..A..',
      '.AAA.',
      'A.A.A',
      '.AAA.',
      '..A..'
    ],
    spinner: [
      '.A.A.',
      'AAAAA',
      'A.C.A',
      'AAAAA',
      '.A.A.'
    ],
    turret: [
      '.AAAAA.',
      'AACCCAA',
      'ACWCWCA',
      'AACCCAA',
      '.AAAAA.',
      '..A.A..'
    ],
    splitter: [
      '.A.A.A.',
      'AAAAAAA',
      'AA.C.AA',
      'A.CDC.A',
      'AA.C.AA',
      'AAAAAAA',
      '.A.A.A.'
    ],
    shard: [
      '.A.',
      'A.A',
      '.A.'
    ],
    // A dart: everything about it says "this one is fast".
    lancer: [
      '..A..',
      '.AAA.',
      'A.A.A',
      '.AAA.',
      '..A..'
    ],
    // A wide diamond with broken edges: unpredictable, like its drifting shot.
    weaver: [
      '..A..',
      '.ACA.',
      'AC.CA',
      '.ACA.',
      '..A..'
    ],
    // A wedge with a bright nose, pointing wherever it is about to ram.
    rammer: [
      '.A.A.',
      'AAAAA',
      'A.W.A',
      'A.A.A',
      '.A.A.'
    ],
    // A heavy slab with a large eye: slow, thick, hard to miss.
    sentry: [
      'AAAAAAA',
      'ACCCCCA',
      'ACCWCCA',
      'ACCCCCA',
      'AAAAAAA',
      '.A.A.A.',
      '..A.A..'
    ],
    // WARDEN: a diamond shell around a slit pupil, distinct from the boss's
    // circular eye so the two fights read differently at a glance.
    warden: [
      '......AAA......',
      '.....AAAAA.....',
      '....AAAAAAA....',
      '...AA.CCC.AA...',
      '..AA.CCCCC.AA..',
      '.AA.CCCCCCC.AA.',
      'AAA.CCCWCCC.AAA',
      '.AA.CCCWCCC.AA.',
      '..AA.CCCCC.AA..',
      '...AA.CCC.AA...',
      '....AAAAAAA....',
      '.....AAAAA.....',
      '......AAA......'
    ],
    boss: [
      '....AAAAAAA....',
      '...AAAAAAAAA...',
      '..AAAAAAAAAAA..',
      '.AAAA.CCC.AAAA.',
      'AAAAACCCCCAAAAA',
      'AAAACCWWWCCAAAA',
      'AAACCWWCWWCCAAA',
      'AAACCWWCWWCCAAA',
      'AAAACCWWWCCAAAA',
      'AAAAACCCCCAAAAA',
      '.AAAA.CCC.AAAA.',
      '..AAAAAAAAAAA..',
      '...AAAAAAAAA...',
      '....AAAAAAA....',
      '..A.A.....A.A..',
      '.A...A...A...A.'
    ]
  };

  function drawEnemies(w) {
    for (var i = 0; i < w.enemies.length; i++) {
      var e = w.enemies[i];
      var pos = polar(e.ang, e.r);
      var x = Math.round(pos.x), y = Math.round(pos.y);
      var art = ENEMY_ART[e.type];
      if (!art) continue;

      var main = e.flash > 0 ? C.white : e.color;
      var pal = {
        A: main,
        C: e.flash > 0 ? C.white : '#0b0718',
        W: e.flash > 0 ? C.white : C.white,
        D: e.flash > 0 ? C.white : '#1a1030'
      };

      ctx.save();
      if (isBossType(e.type)) {
        // A dithered aura that fades with distance (random per-pixel threshold
        // rather than a hard checker) so the edge breaks up instead of reading
        // as a drawn circle.
        var pulse = 0.5 + Math.sin(w.t * 3) * 0.5;
        var auraR = e.size + 16 + Math.round(pulse * 3);
        ctx.fillStyle = e.color;
        ctx.globalAlpha = 0.16 + pulse * 0.10;
        for (var ady = -auraR; ady <= auraR; ady++) {
          var half = Math.round(Math.sqrt(Math.max(0, auraR * auraR - ady * ady)));
          for (var adx = -half; adx <= half; adx++) {
            var d2 = Math.sqrt(adx * adx + ady * ady) / auraR;
            if (d2 < 0.52) continue;                 // hollow around the ship
            // Higher distance => sparser dots. Deterministic per pixel so it
            // does not strobe between frames.
            var thresh = (d2 - 0.52) / 0.48;
            var h = ((adx * 73 + ady * 151) & 255) / 255;
            if (h > 1 - thresh * 0.85) continue;
            ctx.fillRect(x + adx, y + ady, 1, 1);
          }
        }
        ctx.globalAlpha = 1;
        // Centre whichever boss sprite is in play rather than assuming a size:
        // the warden's art is a different width from the boss's.
        var bscale = 2;
        var bw = art[0].length * bscale, bh = art.length * bscale;
        drawSprite(art, pal, x - (bw >> 1), y - (bh >> 1), '#20040a', bscale);
      } else {
        // Integer 2x keeps the pixels crisp while making 5px art readable.
        var sw = art[0].length * 2, sh = art.length * 2;
        drawSprite(art, pal, x - (sw >> 1), y - (sh >> 1), '#0a0614', 2);
      }
      ctx.restore();

      // Telegraph: a bright pip on the muzzle side just before firing, only for
      // ships that actually hold a firing slot.
      if (e.fireEvery && e.fireSlot && e.fireT < 0.35) {
        var blinkOn = Math.floor(e.fireT * 30) % 2 === 0;
        if (blinkOn) {
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = C.white;
          var tip = polar(e.ang, e.r + e.size * 0.7);
          ctx.fillRect(Math.round(tip.x) - 1, Math.round(tip.y) - 1, 2, 2);
          ctx.globalAlpha = 1;
        }
      }

      // Small HP pip bar for tanky units, so damage is legible.
      if (e.maxHp >= 8 && e.hp < e.maxHp && !isBossType(e.type)) {
        var frac = clamp(e.hp / e.maxHp, 0, 1);
        var bw = 10;
        var bx = Math.round(x - bw / 2), by = Math.round(y - e.size - 5);
        ctx.fillStyle = '#12091f';
        ctx.fillRect(bx - 1, by - 1, bw + 2, 3);
        ctx.fillStyle = frac > 0.4 ? main : C.ringWarn;
        ctx.fillRect(bx, by, Math.max(1, Math.round(bw * frac)), 1);
      }
    }
  }

  // Beams are drawn as a lane from the ship to the ring, brightest where it will
  // land. They must never look like a bullet: no discrete projectile, a continuous
  // bar that visibly sweeps.
  function drawBeams(w) {
    for (var i = 0; i < w.beams.length; i++) {
      var bm = w.beams[i];
      var fade = bm.life / bm.max;
      var inner = polar(bm.ang, bm.r0);
      var outer = polar(bm.ang, RING_R);

      // wide soft body
      ctx.globalAlpha = 0.28 * fade;
      ctx.strokeStyle = UPGRADES.beam.color;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(Math.round(inner.x), Math.round(inner.y));
      ctx.lineTo(Math.round(outer.x), Math.round(outer.y));
      ctx.stroke();

      // hot core
      ctx.globalAlpha = 0.85 * fade;
      ctx.strokeStyle = '#eafcff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.round(inner.x), Math.round(inner.y));
      ctx.lineTo(Math.round(outer.x), Math.round(outer.y));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Missiles: a small dart with a trail, drawn so its heading is readable — the
  // player needs to see it correcting toward them.
  function drawMissiles(w) {
    for (var i = 0; i < w.missiles.length; i++) {
      var m = w.missiles[i];
      var pos = polar(m.ang, m.r);
      var x = Math.round(pos.x), y = Math.round(pos.y);

      // trail back along its own spoke
      var tp = polar(m.ang, Math.max(2, m.r - 7));
      ctx.globalAlpha = 0.30;
      ctx.fillStyle = UPGRADES.missile.color;
      ctx.fillRect(Math.round(tp.x) - 1, Math.round(tp.y) - 1, 2, 2);
      ctx.globalAlpha = 1;

      ctx.fillStyle = '#150a20';
      diamond(x, y, 4);
      ctx.fillStyle = UPGRADES.missile.color;
      diamond(x, y, 3);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  function drawBullets(w) {
    // Enemy fire. Readability beats elegance in a bullet hell: every bullet
    // gets a dark outline, a bright body and a white core so it stays legible
    // against both the floor and a swarm of other bullets.
    for (var i = 0; i < w.bullets.length; i++) {
      var b = w.bullets[i];
      var pos = polar(b.ang, b.r);
      var x = Math.round(pos.x), y = Math.round(pos.y);
      var s = b.big ? 3 : 2;   // radius in pixels

      // tail toward the core, fading
      var tp = polar(b.ang, Math.max(2, b.r - (b.big ? 9 : 7)));
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = C.bullet;
      ctx.fillRect(Math.round(tp.x) - 1, Math.round(tp.y) - 1, 2, 2);
      ctx.globalAlpha = 1;

      // outline pass
      ctx.fillStyle = '#1a0410';
      diamond(x, y, s + 1);
      // body
      ctx.fillStyle = C.bullet;
      diamond(x, y, s);
      // core
      ctx.fillStyle = C.bulletCore;
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }

    // player shots: bright, elongated away from the core
    for (var j = 0; j < w.shots.length; j++) {
      var sh = w.shots[j];
      var sp = polar(sh.ang, sh.r);
      var sx = Math.round(sp.x), sy = Math.round(sp.y);
      var inx = Math.round(Math.cos(sh.ang)), iny = Math.round(Math.sin(sh.ang));
      ctx.fillStyle = C.shotDim;
      ctx.fillRect(sx - 1, sy - 1, 3, 3);
      ctx.fillStyle = C.shot;
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
      ctx.fillStyle = C.white;
      ctx.fillRect(sx - 1 + inx, sy - 1 + iny, 1, 1);
    }
  }

  // Filled diamond of radius r — the enemy-bullet silhouette.
  function diamond(cx, cy, r) {
    for (var dy = -r; dy <= r; dy++) {
      var half = r - Math.abs(dy);
      ctx.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
    }
  }

  // Activation flares, one per weapon family. Each is the family's attack shape
  // rendered at the player, so the confirmation reads as "your gun changed",
  // not as a generic sparkle.
  function drawFlares(w) {
    for (var i = 0; i < w.flares.length; i++) {
      var fl = w.flares[i];
      var t = 1 - fl.life / fl.max;        // 0 at spawn, 1 at expiry
      var fade = fl.life / fl.max;
      var up = UPGRADES[fl.type];
      if (!up) continue;

      // A short centred label under the core, readable even in peripheral vision.
      if (t < 0.72) {
        var labelAlpha = t < 0.12 ? t / 0.12 : (1 - (t - 0.12) / 0.6);
        ctx.globalAlpha = clamp(labelAlpha, 0, 1);
        Pixel.draw(ctx, up.blurb, CX, CY + 34, {
          color: up.color, align: 'center', scale: 1, shadow: '#05040a'
        });
        ctx.globalAlpha = 1;
      }

      var base = polar(fl.ang, PLAYER_R);

      if (fl.type === 'bolt') {
        // Fast discrete pips shooting inward: the bolt gun speeding up.
        for (var r = 0; r < 3; r++) {
          var prog = (t + r * 0.22) % 1;
          var rad = 26 - prog * 22;
          if (rad <= 1) continue;
          ctx.globalAlpha = fade * (1 - prog) * 0.95;
          ctx.fillStyle = up.color;
          // a small cross of pixels, drawn as a bolt in flight
          ctx.fillRect(Math.round(base.x) - 1, Math.round(base.y - rad), 2, 3);
          ctx.fillRect(Math.round(base.x) - 2, Math.round(base.y - rad + 1), 4, 1);
        }

      } else if (fl.type === 'beam') {
        // A solid lane snapping open then fading: the block widening.
        var span = 0.10 + t * 0.55;
        ctx.globalAlpha = fade * 0.9;
        ctx.strokeStyle = up.color;
        ctx.lineWidth = 2 + Math.round((1 - t) * 4);
        for (var k = -1; k <= 1; k++) {
          var a = fl.ang + k * span * 0.45;
          var inner = polar(a, PLAYER_R - 4);
          var outer = polar(a, RING_R);
          ctx.beginPath();
          ctx.moveTo(Math.round(inner.x), Math.round(inner.y));
          ctx.lineTo(Math.round(outer.x), Math.round(outer.y));
          ctx.stroke();
        }

      } else {
        // A homing arc that curls inward: the missile rounds turning.
        ctx.globalAlpha = fade * 0.95;
        ctx.strokeStyle = up.color;
        ctx.lineWidth = 2;
        for (var m = 0; m < 3; m++) {
          var start = fl.ang + (m - 1) * 0.5 + t * 1.1;
          for (var s2 = 0; s2 < 5; s2++) {
            var aa = start - s2 * 0.09;
            var rr = PLAYER_R - 2 - s2 * 3;
            var pp = polar(aa, rr);
            ctx.fillRect(Math.round(pp.x), Math.round(pp.y), 2, 2);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // Weapon token chips. A = frame colour, C = bright icon, '.' = transparent.
  // Each icon is the family's attack, so the chip tells you what it will upgrade
  // before you commit to chasing it.
  var TOKEN_ART = {
    // a bolt: solid arrowhead, the fast single round
    bolt: [
      '.AAAAA.',
      'A..C..A',
      'A.CCC.A',
      'ACCCCCA',
      'A.CCC.A',
      'A..C..A',
      '.AAAAA.'
    ],
    // a beam: a solid bar through the chip with emitter brackets
    beam: [
      '.AAAAA.',
      'A.C.C.A',
      'A.C.C.A',
      'ACCCCCA',
      'A.C.C.A',
      'A.C.C.A',
      '.AAAAA.'
    ],
    // a missile: a body with fins and a pointed nose
    missile: [
      '.AAAAA.',
      'A..C..A',
      'A.CCC.A',
      'A.C.C.A',
      'AC...CA',
      'A.C.C.A',
      '.AAAAA.'
    ]
  };

  function drawTokens(w) {
    for (var i = 0; i < w.tokens.length; i++) {
      var tok = w.tokens[i];
      var up = UPGRADES[tok.type];
      var pos = polar(tok.ang, tok.r);
      var x = Math.round(pos.x), y = Math.round(pos.y);
      // Bob on a per-token phase so a cluster does not read as one object.
      var bob = Math.round(Math.sin(w.t * 6 + tok.born * 3) * 1.5);

      // Halo: makes pickups read as friendly loot, never as hostile fire.
      ctx.globalAlpha = 0.14 + 0.09 * Math.sin(w.t * 7 + tok.born * 2);
      ctx.fillStyle = up.color;
      diamond(x, y + bob, 6);
      ctx.globalAlpha = 1;

      drawSprite(TOKEN_ART[tok.type], {
        A: up.color,
        C: '#ffffff'
      }, x - 3, y + bob - 3, '#07050f', 1);
    }
  }

  function drawParticles(w) {
    for (var i = 0; i < w.parts.length; i++) {
      var p = w.parts[i];
      var a = p.life / p.max;
      ctx.globalAlpha = a > 0.6 ? 1 : (a > 0.3 ? 0.65 : 0.32);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;

    for (var j = 0; j < w.floaters.length; j++) {
      var f = w.floaters[j];
      var al = f.life / f.max;
      ctx.globalAlpha = al > 0.5 ? 1 : 0.6;
      Pixel.draw(ctx, f.text, Math.round(f.x), Math.round(f.y), {
        scale: 1, color: f.color, align: 'center'
      });
      ctx.globalAlpha = 1;
    }
  }

  function drawHUD(w) {
    var m = 8;
    Pixel.draw(ctx, 'WAVE ' + pad2(w.wave), m, 7, { color: C.hud, scale: 1 });
    Pixel.draw(ctx, pad2(w.score, 6), W - m, 7, { color: C.hud, align: 'right', scale: 1 });

    // Hull readout, paired with the ring readout. Both use the same rule, so both
    // report the same way: how many points of damage the thing can still take.
    var hullLeft = Math.max(0, PLAYER_CAPACITY - w.player.hull);
    var hullHot = hullLeft <= 1;
    var hullCol = hullHot ? (Math.sin(w.t * 10) > 0 ? C.ringHot : C.ringWarn) : C.player;

    // Integrity readout: the *weakest arc* is what kills you, so that is what the
    // HUD reports. "RING n/cap" means "the most-damaged arc can still take n more
    // points". Labelled WEAK so it is never mistaken for a whole-ring total —
    // under the per-segment model a total would be misleading, since 20 points
    // spread thin is safe while 3 on one arc is fatal.
    var worst = ringWorst(w);
    var left = Math.max(0, SEG_CAPACITY - worst.value);
    var hot = left <= 1;
    var col = hot ? (Math.sin(w.t * 10) > 0 ? C.ringHot : C.ringWarn) : C.ringOk;
    // HULL (left of centre) and WEAK ARC (right of centre) share one row: they are
    // the two ways to lose, so they belong side by side rather than stacked.
    Pixel.draw(ctx, 'HULL ' + hullLeft + '/' + PLAYER_CAPACITY, W / 2 - 8, H - 14,
      { color: hullCol, align: 'right', scale: 1 });
    Pixel.draw(ctx, 'ARC ' + left + '/' + SEG_CAPACITY, W / 2 + 8, H - 14,
      { color: col, align: 'left', scale: 1 });

    // Upgrade status: a label, the banked count toward activation, and pips.
    // Shown bottom-left so it never fights the ring counter for attention.
    var y = H - 26;
    var order = ['bolt', 'beam', 'missile'];
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var up = UPGRADES[key];
      var banked = w.upgrades[key];
      var lvl = w.levels[key];
      var maxed = lvl >= up.maxLevel;
      var rowY = y - i * 11;
      var labelCol = maxed ? up.color : (banked > 0 ? up.color : C.hudDim);
      Pixel.draw(ctx, up.label, m, rowY, { color: labelCol, scale: 1 });

      if (maxed) {
        Pixel.draw(ctx, 'MAX', m + 34, rowY, { color: up.color, scale: 1 });
      } else {
        // pips: filled = banked, hollow = still needed, one block per required
        for (var k = 0; k < up.need; k++) {
          var px = m + 34 + k * 4;
          if (k < banked) {
            ctx.fillStyle = up.color;
            ctx.fillRect(px, rowY, 3, 5);
          } else {
            ctx.fillStyle = C.hudDim;
            ctx.fillRect(px, rowY, 1, 1);
            ctx.fillRect(px + 2, rowY, 1, 1);
            ctx.fillRect(px, rowY + 4, 1, 1);
            ctx.fillRect(px + 2, rowY + 4, 1, 1);
          }
        }
        if (lvl > 0) {
          Pixel.draw(ctx, 'X' + lvl, m + 34 + up.need * 4 + 3, rowY, { color: up.color, scale: 1 });
        }
      }
    }

    // Best
    if (best > 0) {
      Pixel.draw(ctx, 'BEST W' + pad2(best), W - m, H - 26, { color: C.hudDim, align: 'right', scale: 1 });
    }

    // boss bar
    var boss = null;
    for (var i = 0; i < w.enemies.length; i++) if (isBossType(w.enemies[i].type)) boss = w.enemies[i];
    if (boss) {
      var bw = 120, bx = CX - bw / 2, by = 20;
      ctx.fillStyle = '#1a0710';
      ctx.fillRect(bx, by, bw, 4);
      ctx.fillStyle = C.boss;
      ctx.fillRect(bx, by, Math.max(0, Math.round(bw * (boss.hp / boss.maxHp))), 4);
      ctx.strokeStyle = C.ringHot;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 3);
    }
  }

  function pad2(n, len) { return pad(n, len || 2); }

  function drawBanner(w) {
    if (!w.banner) return;
    var b = w.banner;
    var t = b.time;
    var pop = t > 1.3 ? 2 : 1;
    var col = b.kind === 'boss' ? C.ringHot : (b.kind === 'clear' ? C.player : C.hud);
    var y = 128;
    ctx.globalAlpha = t < 0.35 ? t / 0.35 : 1;
    Pixel.draw(ctx, b.text, W / 2, y, {
      color: col, scale: pop, align: 'center', shadow: '#000000'
    });
    if (b.sub) {
      Pixel.draw(ctx, b.sub, W / 2, y + 22, {
        color: C.hud, align: 'center', shadow: '#000000'
      });
    }
    ctx.globalAlpha = 1;
  }

  function drawTitle(w) {
    // The title screen keeps the arena visible as a backdrop, so text must avoid
    // the core sprite at the centre (roughly y=150-190) and the ring itself.
    Pixel.draw(ctx, 'BREACH', W / 2, 46, {
      color: C.ringHot, scale: 4, align: 'center', shadow: '#2a0710'
    });
    Pixel.draw(ctx, 'A RADIAL BULLET HELL', W / 2, 84, {
      color: C.ringOk, align: 'center'
    });

    var blink = Math.floor(w.t * 1.6) % 2 === 0;
    if (blink) {
      Pixel.draw(ctx, 'PRESS ENTER', W / 2, 104, { color: C.white, align: 'center' });
    }

    // Controls live in the lower half, clear of the core.
    Pixel.draw(ctx, 'LEFT/RIGHT = ROTATE', W / 2, 206, { color: C.hudDim, align: 'center' });
    Pixel.draw(ctx, 'HOLD SHIFT = FOCUS', W / 2, 218, { color: C.hudDim, align: 'center' });
    Pixel.draw(ctx, 'FIRE IS AUTOMATIC', W / 2, 230, { color: C.hudDim, align: 'center' });
    Pixel.draw(ctx, 'M MUTE    P PAUSE', W / 2, 242, { color: C.hudDim, align: 'center' });

    if (best > 0) {
      Pixel.draw(ctx, 'BEST WAVE ' + pad2(best), W / 2, 262, { color: C.ringWarn, align: 'center' });
    }

    // Branding sits below the ring's bottom edge (y=292) so it never competes
    // with the arena for attention.
    Pixel.draw(ctx, 'PRODUCED BY STANDARDVIBEWARE', W / 2, 298, {
      color: C.hudDim, align: 'center'
    });
    Pixel.draw(ctx, 'STANDARDVIBEWARE.CLICK', W / 2, 309, {
      color: C.ringOkDim, align: 'center'
    });
  }

  function drawGameOver(w) {
    ctx.fillStyle = 'rgba(4,3,10,0.72)';
    ctx.fillRect(0, 0, W, H);

    // Solid panel behind the stats: the arena is still full of sprites and thin
    // pixel text is unreadable directly on top of them.
    var px = 46, pw = W - 92, py = 84, ph = 118;
    ctx.fillStyle = 'rgba(6,5,14,0.94)';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = C.ringHot;
    ctx.fillRect(px, py, pw, 1);
    ctx.fillRect(px, py + ph - 1, pw, 1);
    ctx.fillStyle = '#2a0d1c';
    ctx.fillRect(px, py, 1, ph);
    ctx.fillRect(px + pw - 1, py, 1, ph);

    Pixel.draw(ctx, w.lostShip ? 'SHIP DESTROYED' : 'RING BREACHED', W / 2, 96, {
      color: C.ringHot, scale: 2, align: 'center', shadow: '#000'
    });
    Pixel.draw(ctx, 'WAVE ' + pad2(w.wave), W / 2, 132, { color: C.hud, align: 'center' });
    Pixel.draw(ctx, 'SCORE ' + pad(w.score, 6), W / 2, 148, { color: C.hud, align: 'center' });
    Pixel.draw(ctx, 'KILLS ' + pad(w.kills, 3), W / 2, 164, { color: C.hudDim, align: 'center' });

    if (w.newBest) {
      Pixel.draw(ctx, 'NEW BEST WAVE', W / 2, 182, { color: C.ringWarn, align: 'center' });
    }

    // No delay gate here: the playout already gave the failure its moment, so the
    // retry prompt can be immediate and always visible.
    var blink2 = Math.floor(w.t * 1.6) % 2 === 0;
    if (blink2) Pixel.draw(ctx, 'PRESS ENTER TO RETRY', W / 2, 222, { color: C.white, align: 'center' });
  }

  function drawPause(w) {
    ctx.fillStyle = 'rgba(4,3,10,0.7)';
    ctx.fillRect(0, 0, W, H);
    Pixel.draw(ctx, 'PAUSED', W / 2, 140, { color: C.hud, scale: 2, align: 'center' });
    Pixel.draw(ctx, 'P TO RESUME', W / 2, 170, { color: C.hudDim, align: 'center' });
  }

  function draw() {
    var w = world || newWorld();

    ctx.save();
    var sx = 0, sy = 0;
    if (w.shake > 0.2) {
      sx = Math.round(rnd(-w.shake, w.shake) * 0.5);
      sy = Math.round(rnd(-w.shake, w.shake) * 0.5);
    }
    ctx.translate(sx, sy);

    drawArena(w);
    drawCore(w);
    drawRing(w);
    drawTokens(w);
    drawFlares(w);
    drawBullets(w);
    drawBeams(w);
    drawMissiles(w);
    drawEnemies(w);
    if (state !== 'title' && state !== 'gameover' && w.player.alive) drawPlayer(w);
    drawParticles(w);
    ctx.restore();

    if (state === 'title') { drawTitle(w); return; }

    drawHUD(w);
    drawBanner(w);

    // The playout gets a bare caption — no panel, no stats — so the failure
    // remains watchable. The summary only arrives once the battle settles.
    if (state === 'dying') {
      var pulse = 0.55 + 0.45 * Math.sin(w.t * 9);
      ctx.globalAlpha = pulse;
      Pixel.draw(ctx, w.lostShip ? 'SHIP LOST' : 'RING BREACHED', W / 2, 44, {
        color: C.ringHot, scale: 2, align: 'center', shadow: '#05040a'
      });
      ctx.globalAlpha = 1;
    }

    if (state === 'gameover') drawGameOver(w);
    if (state === 'paused') drawPause(w);

    if (w.flash > 0.01) {
      ctx.fillStyle = 'rgba(255,60,90,' + (w.flash * 0.30).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ----------------------------------------------------------------------
     LOOP
     ---------------------------------------------------------------------- */
  var last = 0, acc = 0;
  var STEP = 1 / 60;

  function loop(ts) {
    if (!last) last = ts;
    var dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.25) dt = 0.25;
    acc += dt;
    var guard = 0;
    while (acc >= STEP && guard < 8) {
      update(STEP);
      acc -= STEP;
      guard++;
    }
    if (guard >= 8) acc = 0;
    draw();
    requestAnimationFrame(loop);
  }

  /* ----------------------------------------------------------------------
     BOOT
     ---------------------------------------------------------------------- */
  window.CS = {
    newWorld: newWorld,
    newGame: function () { startRun(); },
    update: update,
    draw: draw,
    world: function () { return world; },
    setState: function (s) { state = s; },
    getState: function () { return state; },
    consts: {
      W: W, H: H, CX: CX, CY: CY,
      RING_R: RING_R, PLAYER_R: PLAYER_R,
      SEG_CAPACITY: SEG_CAPACITY, SEGMENTS: SEGMENTS,
      DMG_BULLET: DMG_BULLET, DMG_SHIP: DMG_SHIP, DMG_BOSS: DMG_BOSS,
      PLAYER_CAPACITY: PLAYER_CAPACITY, PLAYER_DMG_BULLET: PLAYER_DMG_BULLET,
      PLAYER_DMG_RAM: PLAYER_DMG_RAM,
      TAU: TAU
    },
    helpers: { wrapPi: wrapPi, angDelta: angDelta, polar: polar, segAt: segAt },
    ringTotal: function () { return ringTotal(world); },
    ringWorst: function () { return ringWorst(world); },
    playerDamage: function (n) { return playerDamage(world, n, world.player.ang); },
    ringDamage: function (ang, n) { ringDamage(world, ang, n); },
    spawnEnemy: function (t, a) { return spawnEnemy(world, t, a); },
    spawnBullet: function (a, r, vr, va) { spawnBullet(world, a, r, vr, va); },
    dropPickup: function (a, r, kind, fromType) { spawnToken(world, a, r, kind, fromType); },
    grabPickup: function () {
      if (!world.tokens.length) return null;
      var t = world.tokens[0];
      collectToken(world, t);
      world.tokens.splice(world.tokens.indexOf(t), 1);
      return t.type;
    },
    upgrades: UPGRADES,
    enemyWeapon: ENEMY_WEAPON,
    dropChance: DROP_CHANCE,
    dropPity: DROP_PITY,
    segHealTime: SEG_HEAL_TIME,
    fireInterval: function () { return fireInterval(world); },
    barrels: function () { return barrels(world); },
    step: function (n, dt) { for (var i = 0; i < (n || 1); i++) update(dt || 1 / 60); }
  };

  if (SELFTEST) {
    // Tests drive update() directly; no rAF, no title screen.
    world = newWorld();
    state = 'playing';
    startWave(world, 1);
  } else {
    world = newWorld();
    requestAnimationFrame(loop);
  }
})();
