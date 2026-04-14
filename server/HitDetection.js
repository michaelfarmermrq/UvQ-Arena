'use strict';

const PLAYER_RADIUS = 14;
const Q_BULLET_RADIUS = 6;
const U_FREEZE_RADIUS = 8;

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Check Q projectiles against alive, unfrozen players.
 * Returns array of { projectile, player } collision pairs.
 */
function checkQToPlayers(qProjectiles, players) {
  const hits = [];
  for (const proj of qProjectiles.values()) {
    for (const player of players.values()) {
      if (!player.alive) continue;
      if (dist(proj.x, proj.y, player.x, player.y) < Q_BULLET_RADIUS + PLAYER_RADIUS) {
        hits.push({ projectile: proj, player });
      }
    }
  }
  return hits;
}

/**
 * Check U freeze projectiles against alive players (cannot freeze self).
 * Returns array of { projectile, player } collision pairs.
 */
function checkUToPlayers(uProjectiles, players) {
  const hits = [];
  for (const proj of uProjectiles.values()) {
    for (const player of players.values()) {
      if (!player.alive) continue;
      if (player.id === proj.ownerId) continue; // can't freeze self
      if (player.frozen) continue; // already frozen
      if (dist(proj.x, proj.y, player.x, player.y) < U_FREEZE_RADIUS + PLAYER_RADIUS) {
        hits.push({ projectile: proj, player });
      }
    }
  }
  return hits;
}

module.exports = { checkQToPlayers, checkUToPlayers };
