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

const WAVE_PAUSE_TICKS = 100;          // 5s "powering up" message
const WAVE_ANNOUNCE_TICKS = 40;        // 2s wave title display
const WAVE_COUNTDOWN_TICKS = 60;       // 3s countdown after wave title

class QBoss {
  constructor() {
    this.x = 1000;
    this.y = 950;
    this.visible = true;

    this._currentWaveIndex = 0; // index into WAVE_PATTERNS
    this._ticksSinceLastBurst = 0;
    this._pauseTicksRemaining = 0;
    this._waveAnnounceTicksRemaining = 0;
    this._countdownTicksRemaining = 0;
    this._pendingWaveAnnounce = null; // { waveNum, label } deferred until pause ends
    this._countdownJustEnded = false; // true for one tick after countdown finishes
  }

  reset() {
    this._currentWaveIndex = 0;
    this._ticksSinceLastBurst = 0;
    this._pauseTicksRemaining = 0;
    this._waveAnnounceTicksRemaining = 0;
    this._countdownTicksRemaining = 0;
    this._pendingWaveAnnounce = null;
    this._countdownJustEnded = false;
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
    this._countdownJustEnded = false;

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
      // Defer wave announce until powering-up phase ends
      this._pendingWaveAnnounce = { waveNum: pattern.wave, label: pattern.label };
    }

    // Phase 1: "Boss Q powering up" message
    if (this._pauseTicksRemaining > 0) {
      this._pauseTicksRemaining--;
      if (this._pauseTicksRemaining === 0) {
        // Emit the wave announce now and start the announce display phase
        if (this._pendingWaveAnnounce) {
          emitWaveAnnounce(this._pendingWaveAnnounce.waveNum, this._pendingWaveAnnounce.label);
          this._pendingWaveAnnounce = null;
        }
        this._waveAnnounceTicksRemaining = WAVE_ANNOUNCE_TICKS;
      }
      return newProjectiles;
    }

    // Phase 2: Wave title display ("Wave 2", etc.)
    if (this._waveAnnounceTicksRemaining > 0) {
      this._waveAnnounceTicksRemaining--;
      if (this._waveAnnounceTicksRemaining === 0) {
        this._countdownTicksRemaining = WAVE_COUNTDOWN_TICKS;
      }
      return newProjectiles;
    }

    // Phase 3: Countdown (3-2-1)
    if (this._countdownTicksRemaining > 0) {
      this._countdownTicksRemaining--;
      if (this._countdownTicksRemaining === 0) {
        this._countdownJustEnded = true;
      }
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

  /** True for exactly one tick after the between-wave countdown finishes. */
  didCountdownEnd() {
    return this._countdownJustEnded;
  }

  /** True when we're in any between-wave phase (no spawning, no combat). */
  isPausing() {
    return this._pauseTicksRemaining > 0 || this._waveAnnounceTicksRemaining > 0 || this._countdownTicksRemaining > 0;
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
      waveCountdown: this._countdownTicksRemaining > 0
        ? Math.ceil(this._countdownTicksRemaining / 20)
        : 0,
    };
  }
}

module.exports = QBoss;
