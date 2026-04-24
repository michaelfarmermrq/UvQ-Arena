'use strict';

// Hitbox radii — tuned to line up with the SVG sprite visuals after the
// design-kit swap. Sprites render larger than the old text glyphs, so the
// hitboxes grew in proportion to keep "if it looks like a hit, it's a hit."
const PLAYER_RADIUS = 18;    // U sprite is ~36px visual body at PLAYER_SIZE=56
const Q_BULLET_RADIUS = 10;  // Q projectile ball ~20px visual at Q_PROJ_SIZE=28
const U_FREEZE_RADIUS = 12;  // U projectile head ~24px visual

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
