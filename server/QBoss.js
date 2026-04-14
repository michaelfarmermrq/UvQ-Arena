'use strict';

const WAVE_PATTERNS = require('./WavePatterns');
const Projectile = require('./Projectile');

// Seconds elapsed at which each wave triggers (index = wave - 1)
const WAVE_THRESHOLDS_TICKS = [
  0,    // Wave 1 starts immediately
  1200, // Wave 2 at 60s (20 ticks/s × 60s)
  2400, // Wave 3 at 120s
  3600, // Wave 4 at 180s
];

const WAVE_PAUSE_TICKS = 100; // 5s pause on wave transition

class QBoss {
  constructor() {
    this.x = 600;
    this.y = 350;
    this.visible = true;

    this._currentWaveIndex = 0; // index into WAVE_PATTERNS
    this._ticksSinceLastBurst = 0;
    this._pauseTicksRemaining = 0;
  }

  reset() {
    this._currentWaveIndex = 0;
    this._ticksSinceLastBurst = 0;
    this._pauseTicksRemaining = 0;
    this.visible = true;

    // Reset stateful wave generators
    WAVE_PATTERNS[0]._burstCount = 0;
    WAVE_PATTERNS[0]._rotationAngle = 0;
    WAVE_PATTERNS[1]._spiralAngle = 0;
    WAVE_PATTERNS[1]._spiralCount = 0;
    WAVE_PATTERNS[2]._burstCount = 0;
    WAVE_PATTERNS[2]._wallSeed = 0;
    WAVE_PATTERNS[3]._burstCount = 0;
  }

  /**
   * Called each server tick.
   * @param {number} roundElapsedTicks
   * @param {Map} players
   * @param {Function} emitWaveAnnounce  callback(waveNumber, label)
   * @returns {Projectile[]} new projectiles to add
   */
  tick(roundElapsedTicks, players, emitWaveAnnounce) {
    const newProjectiles = [];

    // Check for wave advancement
    const nextWaveIndex = this._currentWaveIndex + 1;
    if (
      nextWaveIndex < WAVE_PATTERNS.length &&
      roundElapsedTicks >= WAVE_THRESHOLDS_TICKS[nextWaveIndex]
    ) {
      this._currentWaveIndex = nextWaveIndex;
      this._pauseTicksRemaining = WAVE_PAUSE_TICKS;
      this._ticksSinceLastBurst = 0;
      const pattern = WAVE_PATTERNS[this._currentWaveIndex];
      emitWaveAnnounce(pattern.wave, pattern.label);
    }

    if (this._pauseTicksRemaining > 0) {
      this._pauseTicksRemaining--;
      return newProjectiles;
    }

    const pattern = WAVE_PATTERNS[this._currentWaveIndex];
    this._ticksSinceLastBurst++;

    if (this._ticksSinceLastBurst >= pattern.burstIntervalTicks) {
      this._ticksSinceLastBurst = 0;
      const spawns = pattern.generate(this, players, roundElapsedTicks);
      for (const spawn of spawns) {
        newProjectiles.push(
          new Projectile({
            x: spawn.x,
            y: spawn.y,
            vx: spawn.vx,
            vy: spawn.vy,
            type: 'q_bullet',
            ownerId: 'boss',
          })
        );
      }
    }

    return newProjectiles;
  }

  /**
   * Returns seconds until the next wave starts, or null if on the last wave.
   * @param {number} roundElapsedTicks
   */
  getNextWaveCountdown(roundElapsedTicks) {
    const nextWaveIndex = this._currentWaveIndex + 1;
    if (nextWaveIndex >= WAVE_PATTERNS.length) return null;
    const ticksRemaining = Math.max(0, WAVE_THRESHOLDS_TICKS[nextWaveIndex] - roundElapsedTicks);
    return Math.ceil(ticksRemaining / 20); // 20 ticks/s → seconds
  }

  /** True when we're in the between-wave pause (no spawning, no combat). */
  isPausing() {
    return this._pauseTicksRemaining > 0;
  }

  toState() {
    return {
      x: this.x,
      y: this.y,
      visible: this.visible,
      wavePausing: this._pauseTicksRemaining > 0,
      wavePauseRemaining: this._pauseTicksRemaining > 0
        ? Math.ceil(this._pauseTicksRemaining / 20)
        : 0,
    };
  }
}

module.exports = QBoss;
