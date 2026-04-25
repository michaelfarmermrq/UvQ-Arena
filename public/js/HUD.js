const FREEZE_COOLDOWN_MS  = 3000;
const SHIELD_DURATION_MS  = 8000;
const SPEED_DURATION_MS   = 5000;
const HEART_FULL  = '♥';
const HEART_EMPTY = '♡';

export class HUD {
  constructor() {
    this._hp = 3;
    this._freezeFiredAt = 0;
    this._frozenUntil = 0;
    this._hitFlashUntil = 0;
    this._shieldUntil = 0;
    this._speedUntil = 0;
    this._shieldFlashUntil = 0;
  }

  reset() {
    this._hp = 3;
    this._freezeFiredAt = 0;
    this._frozenUntil = 0;
    this._hitFlashUntil = 0;
    this._shieldUntil = 0;
    this._speedUntil = 0;
    this._shieldFlashUntil = 0;
  }

  onPickupCollected(type, durationMs) {
    if (type === 'shield') this._shieldUntil = performance.now() + durationMs;
    if (type === 'speed')  this._speedUntil  = performance.now() + durationMs;
  }

  triggerShieldFlash() {
    this._shieldFlashUntil = performance.now() + 200;
  }

  setHp(hp) {
    this._hp = hp;
  }

  triggerHitFlash() {
    this._hitFlashUntil = performance.now() + 300;
  }

  setFrozen(frozen, durationMs) {
    if (frozen) {
      this._frozenUntil = performance.now() + durationMs;
    } else {
      this._frozenUntil = 0;
    }
  }

  /** Called when the local player fires a freeze shot */
  onFreezeFired() {
    this._freezeFiredAt = performance.now();
  }

  /** Called when server rejects the fire */
  rejectFreeze() {
    this._freezeFiredAt = 0;
  }

  /**
   * Draws the HUD onto the canvas context.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} localPlayer  PlayerState for local player
   * @param {object[]} allPlayers All PlayerState entries
   * @param {number} now          performance.now()
   */
  draw(ctx, localPlayer, allPlayers, now, snapshot, getPng) {
    const W = 1200;
    const H = 700;

    // ── Hit flash overlay ──────────────────────────────────────────────────
    if (now < this._hitFlashUntil) {
      const alpha = 0.25 * (1 - (now - (this._hitFlashUntil - 300)) / 300);
      ctx.save();
      ctx.fillStyle = `rgba(255,60,60,${alpha})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // ── Frozen overlay ────────────────────────────────────────────────────
    if (localPlayer.frozen) {
      ctx.save();
      ctx.fillStyle = 'rgba(68,170,255,0.12)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // ── Hearts ─────────────────────────────────────────────────────────────
    ctx.save();
    ctx.font = 'bold 22px sans-serif';
    ctx.textBaseline = 'top';
    const maxHp = 3;
    let heartStr = '';
    for (let i = 0; i < maxHp; i++) {
      heartStr += i < this._hp ? HEART_FULL : HEART_EMPTY;
    }
    ctx.fillStyle = '#f94a4a';
    ctx.shadowColor = 'rgba(249,74,74,0.6)';
    ctx.shadowBlur = 8;
    ctx.fillText(heartStr, 16, 14);
    ctx.restore();

    // ── Alive player count ─────────────────────────────────────────────────
    const alive = allPlayers.filter((p) => p.alive).length;
    ctx.save();
    ctx.font = '600 12px Gilroy, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(`${alive} player${alive !== 1 ? 's' : ''} remaining`, W - 16, 14);
    ctx.restore();

    // ── Freeze cooldown ring ───────────────────────────────────────────────
    const cooldownElapsed = now - this._freezeFiredAt;
    const cooldownFraction = Math.min(1, cooldownElapsed / FREEZE_COOLDOWN_MS);
    const isReady = cooldownFraction >= 1;

    const cx = 40;
    const cy = H - 40;
    const r  = 18;

    ctx.save();
    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Fill arc
    if (!isReady) {
      const startAngle = -Math.PI / 2;
      const endAngle   = startAngle + Math.PI * 2 * cooldownFraction;
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.strokeStyle = '#44aaff';
      ctx.lineWidth = 3;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#44aaff';
      ctx.shadowColor = 'rgba(68,170,255,0.8)';
      ctx.shadowBlur = 12;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // "U" label inside ring
    ctx.font = '800 14px Gilroy, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isReady ? '#44aaff' : 'rgba(68,170,255,0.4)';
    ctx.shadowBlur = 0;
    ctx.fillText('U', cx, cy);
    ctx.restore();

    // Frozen status text near the ring
    if (localPlayer.frozen) {
      const remaining = Math.max(0, (this._frozenUntil - now) / 1000).toFixed(1);
      ctx.save();
      ctx.font = '700 11px Gilroy, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#88ccff';
      ctx.fillText(`FROZEN ${remaining}s`, cx, cy + r + 6);
      ctx.restore();
    }

    // ── Shield timer ring (always present; inactive until pickup) ─────────
    {
      const shieldActive = now < this._shieldUntil;
      const shieldFlash  = now < this._shieldFlashUntil;
      const fraction = shieldActive ? (this._shieldUntil - now) / SHIELD_DURATION_MS : 0;
      const img = getPng ? getPng('pickup-shield') : null;
      this._drawStatusRing(ctx, 90, H - 40, fraction, '#0A2ECB', img, '🛡', shieldFlash);
    }

    // ── Speed timer ring (always present; inactive until pickup) ──────────
    {
      const speedActive = now < this._speedUntil;
      const fraction = speedActive ? (this._speedUntil - now) / SPEED_DURATION_MS : 0;
      const img = getPng ? getPng('pickup-speed') : null;
      this._drawStatusRing(ctx, 140, H - 40, fraction, '#88ff88', img, '»', false);
    }

    // ── Next wave countdown ────────────────────────────────────────────────
    if (snapshot && snapshot.nextWaveIn != null) {
      ctx.save();
      ctx.font = '600 12px Gilroy, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(`Wave ${(snapshot.wave ?? 1) + 1} in ${snapshot.nextWaveIn}s`, W / 2, H - 12);
      ctx.restore();
    }
  }

  _drawStatusRing(ctx, cx, cy, fraction, color, iconImg, iconFallback, flash) {
    const r = 18;
    ctx.save();

    if (flash) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Remaining arc
    if (fraction > 0) {
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + Math.PI * 2 * fraction;
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Icon — prefer the PNG sprite; fall back to text emoji while it loads.
    ctx.shadowBlur = 0;
    // Inactive (fraction === 0) gets a very dim icon so the slot reads as
    // "available, not active". Low-time-remaining (fraction ≤ 0.2) is an
    // "about to expire" mid-state.
    const alpha = fraction === 0 ? 0.22 : (fraction > 0.2 ? 1 : 0.55);
    if (iconImg) {
      const s = r * 1.45;
      ctx.globalAlpha = alpha;
      ctx.drawImage(iconImg, cx - s / 2, cy - s / 2, s, s);
      ctx.globalAlpha = 1;
    } else {
      ctx.font = 'bold 13px Gilroy, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = fraction > 0.2 ? color : `rgba(255,255,255,${alpha})`;
      ctx.fillText(iconFallback, cx, cy);
    }
    ctx.restore();
  }
}
