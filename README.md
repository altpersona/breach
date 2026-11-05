# BREACH

> **Produced by [Standardvibeware](https://standardvibeware.click)**

A radial bullet hell. The map is a circle, the player is welded to the perimeter,
and the ring itself is the health bar: enemy fire that reaches the perimeter
cracks it, and a single breached arc ends the run.

Low-poly / 8-bit presentation: 320×320 internal resolution, integer-scaled,
hand-authored pixel sprites, a 5×7 bitmap font, and a WebAudio chiptune synth.
No dependencies, no build step, no assets.

## Play

Open `index.html` in a browser. That's it — it runs from the file system
(`file://`), no server required.

| Input | Action |
| --- | --- |
| `←` / `→` or `A` / `D` | Rotate around the ring (the only navigation) |
| `Shift` or `Space` (held) | Focus: slow, precise rotation |
| `Enter` | Start / retry |
| `P` or `Esc` | Pause |
| `M` | Mute |
| Touch: hold left / right half of the screen | Rotate |
| Touch: hold both halves | Focus |
| Touch: tap | Start / retry / resume |

Firing is automatic. Your job is positioning: block fire, and chase pickups.
The ship does not follow the mouse — the arena is one-dimensional, so left/right
is the whole control surface. On a phone the two screen halves stand in for the
keys (they cover the letterbox too, so thumbs work anywhere), a corner button
pauses, and backgrounding the app pauses automatically.

## How it works

**The arena is one-dimensional.** The player only has an angle. Enemy fire
travels outward from the core along a spoke, so the only defence is to be on
the right spoke when it arrives. Shots fired inward from the perimeter also
intercept incoming bullets, so the player is both a gun and a shield on the same
line.

**The ring is the health bar, segment by segment.** The perimeter is split into
the 14 arcs you can see. Each arc owns its own damage pool (`SEG_CAPACITY`, 3):
an impact adds to the pool of the segment it actually strikes. When any single
arc's pool exceeds its capacity, that arc breaches and the run ends.

| Event | Damage |
| --- | --- |
| Enemy bullet reaches the ring | 1 |
| Enemy ship reaches the ring | 2 |
| Boss/warden reaches the ring | 5 |

This means **total absorbed damage is not the loss condition — concentration is.**
You can soak far more than 3 hits overall as long as no single arc exceeds its
pool, and you can die in three hits if you stand still and let everything land on
one spoke. Measured with a passive player vs a mobile one on wave 9: the camper
dies in ~7–10s having absorbed only 9–11 damage, while a roaming player can clear
the same wave with 6 total absorbed. Staying put is now the mistake it should be.

**The ring draws its own state.** Pristine arcs glow cyan, damaged arcs turn
green → amber → red and visibly thin out, damage pips appear above an arc showing
exactly how many points it has absorbed, the single most-loaded arc pulses when
it is one hit from breaching, and a breach is a hole with debris and a hard
flash. The wall is the readout: there is no separate health bar to check.

**Damage pulses.** When the ring is struck it flares red at the impact spoke and
the flare scales with how much was taken at once: a single bullet is a brief
local flicker, a ship breaching is a wide hot smear, a boss collision turns a
large arc deep red. Severity is legible without reading the counter.

## Weapon tokens

Dead enemies **may** shed a chip that drifts outward toward the ring. Collect it
by being on its spoke when it arrives — the same verb as blocking. A chip is
always the weapon family of the enemy that dropped it, so what you shoot tells
you what you are about to be offered.

Each family needs a fixed number of chips before it does anything; the HUD shows
pips for banked progress.

| Token | Icon | Needed | Effect |
| --- | --- | --- | --- |
| `BOLT` | arrow | **3** | Fire interval shrinks 12% per level (max 6) |
| `BEAM` | bar | **4** | Adds barrels: 2 → 4 → 6 shots, a wider arc blocked |
| `MSL` | dart | **3** | Piercing rounds: a kill carries into the next body (max 3) |

Banked progress is consumed on activation and any surplus carries toward the next
level. Shards drop nothing (one splitter kill should not yield three chips).
Bosses drop a shower of five.

**Not every kill drops.** Chance is per enemy type, so tanks pay out and fodder
mostly does not:

| Enemy | Drop chance |
| --- | --- |
| Sentry | 0.90 |
| Turret | 0.62 |
| Weaver | 0.58 |
| Splitter | 0.55 |
| Spinner | 0.45 |
| Rammer / Lancer | 0.34 / 0.32 |
| Drifter | 0.28 |
| Shard | never |

A pity floor (`DROP_PITY`, 7 kills) forces a drop after a long dry streak.

Activating a family is confirmed by a flare shaped like that family's attack, a
centred label under the core, and an arpeggio.

## Ring self-repair

There is **no repair drop**. An arc that is left undamaged for `SEG_HEAL_TIME`
(22s) knits back one point, once per quiet stretch. Being hit resets that arc's
clock.

The wait is deliberately punishing. At 22s a typical wave yields at most one
point back, and only if the player genuinely ignores that arc for most of it. It
rewards *leaving a damaged arc alone* — a real tactical choice — rather than
hoping for a lucky drop.

## The ship can die

The player is a body, not a ghost. It has a hull pool (`PLAYER_CAPACITY`, 3):

| Cause | Hull cost |
| --- | --- |
| Absorbing an enemy round (bullet, missile, beam) | 1 |
| Flying into a ship or a boss | 2 |

Exceeding the hull cap destroys the ship and ends the run — the pilot dying takes
the ring with it. The hull regenerates one point after `HULL_REGEN_TIME` (9s)
without being hit, so it guards against burst damage rather than slow attrition:
trading steadily still kills you, clean play recovers.

**Losing does not cut to a menu.** Both a ring breach and losing the ship enter a
`dying` playout (`PLAYOUT_TIME`, 2.6s) where the battle keeps resolving — enemies
still move, fire still lands on the ring, wreckage drifts — before the summary
appears. You watch the failure play out rather than being told about it.

## Layout

```
index.html        markup, CSS frame, scanline overlay
src/font.js       5×7 bitmap font + blitter
src/audio.js      WebAudio chiptune synth (square/triangle/noise), gesture-gated
src/game.js       the game: config, world, wave director, collision, render loop
test/             headless harness + suites (see below)
```

## Tests

Everything is verifiable. There is no build step; the "build" is a syntax check
plus these suites.

```sh
node test/spec.js       # 77 unit/integration tests, headless (no browser)
node test/e2e.js        # 31 checks in real Chrome via CDP (real key, touch and pointer events)
node test/layout.js     # canvas fits 8 viewports, incl. narrower-than-native
node test/audio.js      # the synth actually produces non-silent signal
node test/balance.js 5  # bot survival per wave, N trials each (slow: ~1 min)
node test/run.js 3      # continuous runs to game over; reports depth reached
node test/shots.js      # renders screenshots into test/shots/
node test/live.js       # boots the PUBLISHED game from its public URL in Chrome
node test/sweep-capacity.js 3  # tuning sweep; patches a constant, always restores
```

`test/spec.js` covers the ring-damage model, interception, movement, wave
progression, fairness invariants, NaN safety over long runs, and drawing every
game state. It boots the real game files in a stubbed DOM, so it tests the
shipped code rather than a copy.

`test/bot.js` holds the single test pilot. Every probe flies the same one — copies
had already drifted between suites, which made their numbers incomparable.

`test/balance.js` is the interesting one: a bot that only understands "which
bullet lands first and can I reach its spoke" plays each wave repeatedly, and
the suite reports survival rate and average damage per wave. It is how the
unwinnable-wave bug was found and how the current numbers were tuned. A healthy
curve is roughly 90% survival for this crude bot.

`test/run.js` complements it by playing real back-to-back runs; the same crude
bot currently dies around wave 6, which is the intended shape of the difficulty
curve (a human should get meaningfully further).

## Tuning

The knobs that actually move the feel, all at the top of `src/game.js`:

- `SEG_CAPACITY` — hits one arc absorbs before it breaches. This is the
  difficulty dial now: raising it forgives crowding, lowering it punishes it.
- `SEGMENTS` — how finely the ring is divided. More arcs means damage spreads
  thinner, so this is a difficulty dial too, not just a visual choice.
- `BULLET_SPEED` / `BULLET_SPEED_FAST` — reaction window.
- `MAX_FIRING` — how many ships may shoot at once. Raising this makes the game
  mathematically unfair before it makes it harder.
- `PLAYER_ARC_SPEED`, `FOCUS_SCALE` — movement.
- `SHOT_INTERVAL` — rate of fire, which doubles as the interception cadence.
- `ENEMY_DEF` — per-type HP/speed/hold radius/fire interval.
- `UPGRADES` — per-type `need` (increments to activate), `maxLevel`, colour.
- `DROP_CHANCE` — per-enemy chance of dropping anything at all; `DROP_PITY` is
  the dry-streak floor.
- `ENEMY_WEAPON` — which weapon family each enemy uses (and therefore drops).
- `SEG_HEAL_TIME` — how long an arc must be left alone to mend (22s); raising it
  makes the ring effectively unrecoverable within a wave.
- `PLAYER_CAPACITY`, `PLAYER_DMG_*`, `HULL_REGEN_TIME` — hull tuning.
- `PLAYOUT_TIME` — how long the failure is watchable before the summary (2.6s).
- `DROP_CHANCE` — per-enemy chance of dropping anything at all; `DROP_PITY` —
  the dry-streak floor.
- `DUAL_FIRE_WAVE` — first wave at which two ships may fire concurrently (13).
- `TOKEN_SPEED` — how generous the pickup chase is.
- `TOKEN_BONUS` — score per collected chip.

## Version

Current: **1.2.0** (shown bottom-left on the title screen).

Every code revision bumps this. The number lives in three places and
`test/version.js` fails the build if they disagree:

1. `package.json` — the source of truth, used for tagging.
2. `VERSION` in `src/game.js` — what a player actually sees.
3. This file.

Releases are tagged `vMAJOR.MINOR.PATCH` and published as GitHub releases whose
notes summarise the changes below.

## Changelog

### 1.2.0 — versioned builds and release discipline
- The build now knows its own version and shows it on the title screen, so a
  screenshot identifies which release it came from.
- `test/version.js` fails the build if `package.json`, the in-game constant and
  this file disagree — part of `npm run verify`.
- `AGENTS.md` records the repo-location, versioning and release rules, plus the
  design invariants that keep the game playable.

### 1.1.0 — phone support
- Touch controls: hold a screen half to rotate, both halves to focus, tap to
  start/retry. Zones cover the letterbox so thumbs work anywhere.
- On-screen pause button on touch devices; auto-pause when the app is
  backgrounded.
- Pause-by-background uses `visibilitychange` rather than `blur`, which is
  unreliable on mobile.

### 1.0.0 — first release
- Radial bullet-hell: the ring is the health bar, split into 14 arcs that each
  own a damage pool. A breached arc ends the run.
- Three weapon families (bolt, beam, missile) with distinct attack shapes; drops
  carry the dropper's family and upgrade the player's gun in that image.
- Timed ring self-repair (22s undisturbed per arc) instead of a repair pickup.
- Damageable ship with slow hull regen; losing the ship ends the run after a
  short playout in which the battle keeps resolving.
- 10 enemy types, two bosses (boss/warden), 77 unit tests and 31 browser tests.
