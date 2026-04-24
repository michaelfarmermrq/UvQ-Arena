'use strict';

/**
 * Each wave definition:
 *   wave: number (1-based)
 *   label: string shown in the overlay
 *   burstIntervalTicks: how many server ticks between bursts
 *   generate(boss, players, tick) => ProjectileSpawn[]
 *
 * ProjectileSpawn = { x, y, vx, vy }
 * All speeds are in px per server tick (50ms).
 *
 * Each wave changes its rhythm every 15 s (300 ticks / burstIntervalTicks bursts).
 * This prevents players from learning a single safe position.
 */

const WAVE_PATTERNS = [
  // ── Wave 1 ── Circular burst ─────────────────────────────────────────────
  // Phase 0 (0–15s):  12 spokes, no rotation
  // Phase 1 (15–30s): 14 spokes, slow clockwise rotation
  // Phase 2 (30–45s): 16 spokes, faster clockwise rotation
  // Phase 3+ (45s+):  18 spokes, rotation reverses direction each phase
  {
    wave: 1,
    label: 'Wave 1',
    burstIntervalTicks: 40, // fire every 2 s
    _burstCount: 0,
    _rotationAngle: 0,
    generate(boss, _players, _tick) {
      const phase = Math.floor(this._burstCount / 7); // 7 bursts ≈ 15s at 40 ticks
      const speed = 2.75;

      let count, rotStep;
      if (phase === 0) { count = 12; rotStep = 0; }
      else if (phase === 1) { count = 14; rotStep =  (Math.PI / count) * 0.4; }
      else if (phase === 2) { count = 16; rotStep =  (Math.PI / count) * 0.7; }
      else                  { count = 18; rotStep = ((phase % 2 === 0) ? 1 : -1) * (Math.PI / count); }

      this._rotationAngle += rotStep;

      const spawns = [];
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + this._rotationAngle;
        spawns.push({ x: boss.x, y: boss.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
      }
      this._burstCount++;
      return spawns;
    },
  },

  // ── Wave 2 ── Spiral ──────────────────────────────────────────────────────
  // Phase 0 (0–15s):  1 arm, clockwise (+0.3 rad/burst)
  // Phase 1 (15–30s): 2 arms, REVERSED (−0.3 rad/burst) — forces repositioning
  // Phase 2 (30–45s): 2 arms, fast clockwise (+0.5 rad/burst)
  // Phase 3+ (45s+):  3 arms, alternating direction per phase
  {
    wave: 2,
    label: 'Wave 2',
    burstIntervalTicks: 3, // denser than before (was 4)
    _spiralAngle: 0,
    _spiralCount: 0,
    generate(boss, _players, _tick) {
      const phase = Math.floor(this._spiralCount / 100); // 100 bursts × 3 ticks = 300 ticks = 15s
      const speed = 3.3;

      let armCount, angleStep;
      if (phase === 0) { armCount = 1; angleStep =  0.30; }
      else if (phase === 1) { armCount = 2; angleStep = -0.30; } // reversal — breaks standing-still
      else if (phase === 2) { armCount = 2; angleStep =  0.50; }
      else                  { armCount = 3; angleStep = (phase % 2 === 0 ? 0.40 : -0.40); }

      const spawns = [];
      for (let arm = 0; arm < armCount; arm++) {
        const angle = this._spiralAngle + (arm * Math.PI * 2) / armCount;
        spawns.push({ x: boss.x, y: boss.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
      }
      this._spiralAngle += angleStep;
      this._spiralCount++;
      return spawns;
    },
  },

  // ── Wave 3 ── Walls from top + sides ──────────────────────────────────────
  // Phase 0 (0–15s):  top-down walls, 2 small gaps (30 columns = tight spacing)
  // Phase 1 (15–30s): top-down + left-to-right walls alternating, 2 gaps
  // Phase 2 (30–45s): top-down walls, 1 gap, faster; side walls with 1 gap
  // Phase 3+ (45s+):  both directions, 1 gap, faster, drift added
  {
    wave: 3,
    label: 'Wave 3',
    burstIntervalTicks: 50,
    _burstCount: 0,
    _wallSeed: 0,
    generate(boss, _players, _tick) {
      const phase = Math.floor(this._burstCount / 6); // 6 bursts × 50 ticks = 300 ticks = 15s
      const seed = this._wallSeed++;
      const spawns = [];

      const spawnWall = (axis, count, speed, gapCount, drift) => {
        const isHorizontal = axis === 'top'; // top-down wall
        const len = isHorizontal ? 2000 : 1900; // must match ARENA_W / ARENA_H
        const spacing = len / count;
        const gap1 = seed % count;
        const gap2 = (seed * 7 + 3) % count;
        // Ensure gaps aren't adjacent for tighter walls
        const gap2Adj = Math.abs(gap2 - gap1) <= 1 ? (gap1 + Math.floor(count / 2)) % count : gap2;

        for (let i = 0; i < count; i++) {
          if (i === gap1) continue;
          if (gapCount >= 2 && i === gap2Adj) continue;
          if (isHorizontal) {
            spawns.push({ x: spacing * i + spacing / 2, y: -10, vx: drift, vy: speed });
          } else {
            // Left-to-right wall
            const fromLeft = seed % 2 === 0;
            spawns.push({
              x: fromLeft ? -10 : 2010,
              y: spacing * i + spacing / 2,
              vx: fromLeft ? speed : -speed,
              vy: drift,
            });
          }
        }
      };

      if (phase === 0) {
        // Top-down only, 30 columns, 2 gaps
        spawnWall('top', 30, 4.4, 2, 0);
      } else if (phase === 1) {
        // Alternate top-down and side walls
        if (this._burstCount % 2 === 0) {
          spawnWall('top', 30, 4.4, 2, 0);
        } else {
          spawnWall('side', 18, 4.0, 2, 0);
        }
      } else if (phase === 2) {
        // Top-down with 1 gap (harder), plus side walls every other burst
        spawnWall('top', 30, 5.0, 1, 0);
        if (this._burstCount % 2 === 0) {
          spawnWall('side', 18, 4.0, 1, 0);
        }
      } else {
        // Both directions, 1 gap, drift added
        const drift = (phase % 2 === 0) ? 0.6 : -0.6;
        spawnWall('top', 30, 5.5, 1, drift);
        spawnWall('side', 18, 4.5, 1, drift);
      }

      this._burstCount++;
      return spawns;
    },
  },

  // ── Wave 4 ── Aimed burst at nearest player ────────────────────────────────
  // Phase 0 (0–15s):  8-bullet fan at nearest player, ±22.5° spread
  // Phase 1 (15–30s): 10-bullet fan, tighter spread (±15°) — more accurate
  // Phase 2 (30–45s): dual burst: aimed + 90° offset simultaneously
  // Phase 3+ (45s+):  dual burst, tighter, faster
  {
    wave: 4,
    label: 'Wave 4',
    burstIntervalTicks: 18,
    _burstCount: 0,
    generate(boss, players, _tick) {
      const phase = Math.floor(this._burstCount / 16); // 16 × 18 ticks ≈ 288 ticks ≈ 15s
      const speed = 3.85;

      let nearestTarget = null;
      let bestDist = Infinity;
      for (const p of players.values()) {
        if (!p.alive) continue;
        const dx = p.x - boss.x;
        const dy = p.y - boss.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; nearestTarget = p; }
      }

      this._burstCount++;
      if (!nearestTarget) return [];

      const baseAngle = Math.atan2(nearestTarget.y - boss.y, nearestTarget.x - boss.x);
      const spawns = [];

      const fireFan = (centerAngle, bulletCount, totalSpread) => {
        const step = totalSpread / Math.max(1, bulletCount - 1);
        for (let i = 0; i < bulletCount; i++) {
          const a = centerAngle - totalSpread / 2 + step * i;
          spawns.push({ x: boss.x, y: boss.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed });
        }
      };

      if (phase === 0) {
        fireFan(baseAngle, 8, Math.PI / 4);       // 8 bullets, 45° spread
      } else if (phase === 1) {
        fireFan(baseAngle, 10, Math.PI / 6);      // 10 bullets, tighter 30° spread
      } else if (phase === 2) {
        fireFan(baseAngle, 8, Math.PI / 5);       // aimed
        fireFan(baseAngle + Math.PI / 2, 6, Math.PI / 5); // 90° offset burst
      } else {
        fireFan(baseAngle, 10, Math.PI / 6);
        fireFan(baseAngle + Math.PI / 2, 8, Math.PI / 6);
      }

      return spawns;
    },
  },
];

module.exports = WAVE_PATTERNS;
