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

  // ── Wave 3 ── Dense horizontal / directional walls with gaps ──────────────
  // Phase 0 (0–15s):  top-down walls, 2 gaps
  // Phase 1 (15–30s): top-down walls with drift (vx ±0.8), 2 gaps
  // Phase 2 (30–45s): top-down walls, 1 gap (harder)
  // Phase 3+ (45s+):  drift walls, 1 gap, drift direction alternates
  {
    wave: 3,
    label: 'Wave 3',
    burstIntervalTicks: 65,
    _burstCount: 0,
    _wallSeed: 0,
    generate(boss, _players, _tick) {
      const phase   = Math.floor(this._burstCount / 4); // 4 bursts × 65 ticks ≈ 13s ≈ 15s
      const count   = 22;
      const spacing = 1200 / count;
      const speed   = 4.4;

      const seed = this._wallSeed++;
      const gap1 = seed % count;
      const gap2 = (seed * 7 + 3) % count;

      const twoGaps  = phase < 2;
      const driftVx  = (phase === 1 || phase >= 3)
        ? ((phase % 2 === 0) ? 0.8 : -0.8)
        : 0;

      const spawns = [];
      for (let i = 0; i < count; i++) {
        if (i === gap1) continue;
        if (twoGaps && i === gap2) continue;
        spawns.push({
          x: spacing * i + spacing / 2,
          y: boss.y + 20,
          vx: driftVx,
          vy: speed,
        });
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
    burstIntervalTicks: 40,
    _burstCount: 0,
    generate(boss, players, _tick) {
      const phase = Math.floor(this._burstCount / 7); // 7 × 40 ticks ≈ 14s ≈ 15s
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
