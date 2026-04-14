'use strict';

/**
 * Bot AI — runs entirely server-side each tick.
 *
 * Movement design:
 *   - When a threatening Q bullet is detected, commit to a perpendicular dodge
 *     direction for DODGE_COMMIT_TICKS ticks.  This prevents the rapid
 *     back-and-forth jitter caused by recomputing direction every single frame.
 *   - While not committed to a dodge, the bot wanders toward a target point,
 *     refreshing the target only when it arrives or a timer expires.
 *
 * Firing design:
 *   - Fire at the nearest alive, unfrozen player once the 3 s cooldown is up.
 *   - Re-freeze immunity is handled in GameSession (frozenRecoveryUntil).
 */

const BOT_SPEED          = 11;  // px/tick  (same as real players: 0.22 px/ms × 50 ms)
const DODGE_RADIUS       = 130; // px — react to Q bullets within this range
const DODGE_COMMIT_TICKS = 15;  // ticks (~0.75 s) to maintain a committed dodge
const WANDER_MIN_TICKS   = 25;
const WANDER_MAX_TICKS   = 60;
const ARENA_W            = 1200;
const ARENA_H            = 700;
const BOSS_X             = 600;
const BOSS_Y             = 350;
const BOSS_COLLIDE_R     = 85;
const FREEZE_COOLDOWN_MS = 3000;
const ARENA_MARGIN       = 50;

/**
 * Compute one tick of bot behaviour.
 * Mutates bot._dodgeDir, bot._dodgeTicks, bot._wanderTarget, bot._wanderTimer.
 *
 * @returns {{ dx, dy, fireTarget: {x,y}|null }}
 */
function tickBot(bot, allPlayers, qProjectiles, now, inPause = false) {
  const move = computeMovement(bot, inPause ? new Map() : qProjectiles);
  const fireTarget = inPause ? null : computeFireTarget(bot, allPlayers, now);
  return { dx: move.dx, dy: move.dy, fireTarget };
}

// ─── Movement ────────────────────────────────────────────────────────────────

function computeMovement(bot, qProjectiles) {
  // 1. If we're mid-commit on a previous dodge, keep going
  if (bot._dodgeTicks > 0) {
    bot._dodgeTicks--;
    return applySpeed(bot, bot._dodgeDir.x, bot._dodgeDir.y);
  }

  // 2. Scan for threatening bullets
  let dodgeX = 0;
  let dodgeY = 0;
  let threatened = false;

  for (const proj of qProjectiles.values()) {
    const tobx = bot.x - proj.x;
    const toby = bot.y - proj.y;
    const dist2 = tobx * tobx + toby * toby;
    if (dist2 > DODGE_RADIUS * DODGE_RADIUS) continue;

    // Is the bullet heading toward the bot?
    if (tobx * proj.vx + toby * proj.vy <= 0) continue;

    // Perpendicular component of (bot − proj) relative to bullet velocity
    const vlen = Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy) || 1;
    const nvx = proj.vx / vlen;
    const nvy = proj.vy / vlen;
    const dot = tobx * nvx + toby * nvy;
    const perpX = tobx - dot * nvx;
    const perpY = toby - dot * nvy;
    const plen = Math.sqrt(perpX * perpX + perpY * perpY);

    if (plen > 0.1) {
      dodgeX += perpX / plen;
      dodgeY += perpY / plen;
    } else {
      // Directly in line — pick an arbitrary perpendicular
      dodgeX += -nvy;
      dodgeY +=  nvx;
    }
    threatened = true;
  }

  if (threatened) {
    // Normalise accumulated dodge vector and commit
    const dlen = Math.sqrt(dodgeX * dodgeX + dodgeY * dodgeY) || 1;
    bot._dodgeDir  = { x: dodgeX / dlen, y: dodgeY / dlen };
    bot._dodgeTicks = DODGE_COMMIT_TICKS;
    return applySpeed(bot, bot._dodgeDir.x, bot._dodgeDir.y);
  }

  // 3. Wander toward target
  if (
    !bot._wanderTarget ||
    bot._wanderTimer <= 0 ||
    distSq(bot, bot._wanderTarget) < 30 * 30
  ) {
    bot._wanderTarget = randomArenaPoint();
    bot._wanderTimer  = WANDER_MIN_TICKS +
      Math.floor(Math.random() * (WANDER_MAX_TICKS - WANDER_MIN_TICKS));
  }
  bot._wanderTimer--;

  const tdx = bot._wanderTarget.x - bot.x;
  const tdy = bot._wanderTarget.y - bot.y;
  const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
  return applySpeed(bot, tdx / tlen, tdy / tlen);
}

/**
 * Clamp the bot's new position to arena bounds and resolve boss collision,
 * then return the actual delta to apply.
 */
function applySpeed(bot, dirX, dirY) {
  let nx = Math.max(ARENA_MARGIN, Math.min(ARENA_W - ARENA_MARGIN, bot.x + dirX * BOT_SPEED));
  let ny = Math.max(ARENA_MARGIN, Math.min(ARENA_H - ARENA_MARGIN, bot.y + dirY * BOT_SPEED));

  const cdx = nx - BOSS_X;
  const cdy = ny - BOSS_Y;
  const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
  if (cdist < BOSS_COLLIDE_R) {
    const s = BOSS_COLLIDE_R / (cdist || 1);
    nx = BOSS_X + cdx * s;
    ny = BOSS_Y + cdy * s;
  }

  return { dx: nx - bot.x, dy: ny - bot.y };
}

// ─── Firing ──────────────────────────────────────────────────────────────────

function computeFireTarget(bot, allPlayers, now) {
  if (now - bot.lastFreezeFiredAt < FREEZE_COOLDOWN_MS) return null;

  let nearest = null;
  let nearestDist = Infinity;

  for (const p of allPlayers.values()) {
    if (p.id === bot.id) continue;
    if (!p.alive || p.frozen) continue;
    // Respect re-freeze immunity window (set in GameSession when a player unfreezes)
    if (p.frozenRecoveryUntil && now < p.frozenRecoveryUntil) continue;
    const d = distSq(bot, p);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = p;
    }
  }

  return nearest ? { x: nearest.x, y: nearest.y } : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function randomArenaPoint() {
  let x, y, attempts = 0;
  do {
    x = ARENA_MARGIN + Math.random() * (ARENA_W - ARENA_MARGIN * 2);
    y = ARENA_MARGIN + Math.random() * (ARENA_H - ARENA_MARGIN * 2);
    attempts++;
  } while (
    distSq({ x, y }, { x: BOSS_X, y: BOSS_Y }) < (BOSS_COLLIDE_R + 60) ** 2 &&
    attempts < 10
  );
  return { x, y };
}

module.exports = { tickBot };
