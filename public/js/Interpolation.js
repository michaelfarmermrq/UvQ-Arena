/**
 * Interpolation helpers for smooth rendering between server snapshots.
 *
 * Remote players: linearly interpolate between the last two received positions.
 * Projectiles: extrapolate forward from last known position using velocity.
 */

export class PlayerInterpolator {
  constructor() {
    // Map<playerId, { prev: {x,y,t}, curr: {x,y,t} }>
    this._states = new Map();
  }

  /** Called each time a game_state snapshot arrives */
  pushSnapshot(players, receivedAt) {
    for (const p of players) {
      const existing = this._states.get(p.id);
      if (existing) {
        existing.prev = existing.curr;
        existing.curr = { x: p.x, y: p.y, t: receivedAt };
      } else {
        // First sighting — no previous, just set both the same
        const state = { x: p.x, y: p.y, t: receivedAt };
        this._states.set(p.id, { prev: state, curr: state });
      }
    }
  }

  remove(playerId) {
    this._states.delete(playerId);
  }

  /**
   * Returns interpolated {x, y} for the given player at `now`.
   * Falls back to the latest known position if no two states exist.
   */
  getPosition(playerId, now) {
    const s = this._states.get(playerId);
    if (!s) return null;

    const { prev, curr } = s;
    if (prev.t === curr.t) return { x: curr.x, y: curr.y };

    const t = Math.min(1, (now - curr.t) / (curr.t - prev.t + 1));
    return {
      x: curr.x + (curr.x - prev.x) * t,
      y: curr.y + (curr.y - prev.y) * t,
    };
  }
}

/**
 * Extrapolates a projectile position from its last snapshot values.
 * @param {{ x, y, vx, vy }} proj
 * @param {number} msSinceSnapshot
 * @returns {{ x, y }}
 */
export function extrapolateProjectile(proj, msSinceSnapshot) {
  const ticksElapsed = msSinceSnapshot / 50; // 50ms per server tick
  return {
    x: proj.x + proj.vx * ticksElapsed,
    y: proj.y + proj.vy * ticksElapsed,
  };
}
