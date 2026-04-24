import { extrapolateProjectile } from './Interpolation.js';
import { getSprite } from './SpriteCache.js';

const ARENA_W = 2000;   // world size — must match server/GameSession.js
const ARENA_H = 1900;
const VP_W    = 1200;   // viewport (canvas visible area)
const VP_H    = 700;

// On-canvas draw sizes (sprites are rendered at these widths/heights)
const PLAYER_SIZE = 56;   // U sprite — slightly larger than the old text glyph
const BOSS_SIZE   = 220;  // Q boss sprite
const Q_PROJ_SIZE = 28;   // Q projectile / mine
const U_PROJ_SIZE = 28;   // U freeze projectile
// Legacy glyph fallback size (used while sprites are still loading)
const PLAYER_GLYPH_SIZE = 32;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._pngs = new Map();
    this._loadPng('pickup-shield', '/assets/png/shield-pickup.2x.png');
    this._loadPng('pickup-speed',  '/assets/png/turbo-pickup.2x.png');
    this._loadPng('arena-bg',      '/assets/png/arena-bg.2x.png');
    this._loadPng('countdown-1',   '/assets/png/countdown-1.2x.png');
    this._loadPng('countdown-2',   '/assets/png/countdown-2.2x.png');
    this._loadPng('countdown-3',   '/assets/png/countdown-3.2x.png');
  }

  _loadPng(key, src) {
    const img = new Image();
    img.onload = () => this._pngs.set(key, img);
    img.src = src;
  }

  _getPng(key) {
    return this._pngs.get(key) || null;
  }

  /**
   * Draw a complete frame.
   * @param {object} snapshot        Latest GameSnapshot from server
   * @param {string} localPlayerId
   * @param {object} interpolator    PlayerInterpolator instance
   * @param {number} snapshotTime    Timestamp when snapshot was received
   * @param {number} now             Current timestamp
   * @param {object} mousePos        { x, y } in logical canvas coords
   * @param {Map}    elimAnimations  Map<id, {startTime}>
   * @param {object} localPos        { x, y } client-side position for local player
   * @param {object} hud             HUD instance
   */
  drawFrame({
    snapshot,
    localPlayerId,
    localPos,
    interpolator,
    snapshotTime,
    now,
    mousePos,
    elimAnimations,
    hud,
    mineBlasts,
    meleeAnim,
    fireFlash,
    hitFlashes,
    camera,
  }) {
    const ctx = this.ctx;
    const msSince = now - snapshotTime;

    // 1. Clear viewport (screen space — cheap fill of visible area only)
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, VP_W, VP_H);

    // ── WORLD-SPACE pass: translated by -camera ──
    ctx.save();
    if (camera) ctx.translate(-camera.x, -camera.y);

    // 1b. Arena background image (covers the world; stretches to arena dims).
    const bg = this._getPng('arena-bg');
    if (bg) {
      ctx.drawImage(bg, 0, 0, ARENA_W, ARENA_H);
    }

    // 2. Arena border glow
    this._drawArenaBorder(ctx);

    if (!snapshot) {
      ctx.restore();
      return;
    }

    // 3. Q Boss
    if (snapshot.boss?.visible) {
      this._drawBoss(ctx, snapshot.boss);
    }

    // 3b. Pickups (on ground)
    if (snapshot.pickups) {
      for (const pickup of snapshot.pickups) {
        this._drawPickup(ctx, pickup.x, pickup.y, pickup.type);
      }
    }

    // 3c. Mines (on ground, below projectiles and players)
    if (snapshot.mines) {
      for (const mine of snapshot.mines) {
        this._drawMine(ctx, mine.x, mine.y);
      }
    }

    // 3c. Mine blast animations
    if (mineBlasts) {
      for (const blast of mineBlasts) {
        const age = now - blast.startTime;
        if (age < 400) this._drawMineBlast(ctx, blast.x, blast.y, age);
      }
    }

    // 4. Q projectiles
    for (const proj of snapshot.qProjectiles) {
      const pos = extrapolateProjectile(proj, msSince);
      this._drawQProjectile(ctx, pos.x, pos.y);
    }

    // 5. U freeze projectiles
    for (const proj of snapshot.uProjectiles) {
      const pos = extrapolateProjectile(proj, msSince);
      this._drawUProjectile(ctx, pos.x, pos.y, proj.vx, proj.vy);
    }

    // 6 + 7. Players (remote first, local on top)
    const localPlayer = snapshot.players.find((p) => p.id === localPlayerId);
    const remotePlayers = snapshot.players.filter((p) => p.id !== localPlayerId);

    for (const p of remotePlayers) {
      if (!p.alive && !elimAnimations.has(p.id)) continue;
      const pos = interpolator.getPosition(p.id, now) || { x: p.x, y: p.y };
      this._drawPlayer(ctx, pos.x, pos.y, p, false, elimAnimations, now, hitFlashes);
    }

    if (localPlayer) {
      // Use client-side position for zero-latency rendering.
      // Fall back to snapshot coords if localPos isn't available yet.
      const pos = localPos || localPlayer;
      this._drawPlayer(ctx, pos.x, pos.y, localPlayer, true, elimAnimations, now, hitFlashes);
    }

    // 10. Melee thrust animation (world-space — follows the player)
    if (meleeAnim && localPlayer?.alive) {
      const age = now - meleeAnim.startTime;
      if (age < 250) {
        const pos = localPos || localPlayer;
        this._drawMeleeThrust(ctx, pos.x, pos.y, meleeAnim.dirX, meleeAnim.dirY, age);
      }
    }

    // 10b. Instant fire-flash (client-side) — gives the local player visible
    // feedback in the frame of the click, before the server-authoritative U
    // projectile shows up in the next snapshot.
    if (fireFlash && localPlayer?.alive) {
      const age = now - fireFlash.startTime;
      if (age < 140) {
        const pos = localPos || localPlayer;
        this._drawFireFlash(ctx, pos.x, pos.y, fireFlash.dirX, fireFlash.dirY, age);
      }
    }

    ctx.restore();
    // ── End world-space pass ──

    // 8. HUD (screen-space)
    if (hud && localPlayer) {
      hud.draw(ctx, localPlayer, snapshot.players, now, snapshot, (k) => this._getPng(k));
    }

    // 9. Between-wave pause overlay — screen-space so it's always viewport-centered
    if (snapshot.boss?.wavePausing) {
      this._drawWavePause(ctx, snapshot.wave, snapshot.eliminatedCount ?? 0);
    }

    // 9b. Between-wave countdown
    if (snapshot.boss?.waveCountdown > 0) {
      this._drawCountdown(ctx, snapshot.boss.waveCountdown);
    }

    // 10. Grace-period countdown
    if (snapshot.graceRemaining > 0 && snapshot.graceRemaining <= 3) {
      this._drawCountdown(ctx, snapshot.graceRemaining);
    }

    // 11. Aim reticle — screen-space at the cursor's viewport position
    if (mousePos && localPlayer?.alive) {
      this._drawReticle(ctx, mousePos.x, mousePos.y);
    }
  }

  _drawWavePause(ctx, currentWave, eliminatedCount) {
    ctx.save();
    // Dim overlay (full viewport)
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, VP_W, VP_H);

    // Info card (centered in viewport)
    const bw = 340;
    const bh = eliminatedCount > 0 ? 140 : 110;
    const bx = VP_W / 2 - bw / 2;
    const by = VP_H / 2 - bh / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,60,60,0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Title
    ctx.font = '700 24px "Formula Condensed", Gilroy, sans-serif';
    ctx.fillStyle = '#ff4444';
    ctx.shadowColor = 'rgba(255,68,68,0.6)';
    ctx.shadowBlur = 10;
    ctx.fillText('BOSS Q POWERING UP…', VP_W / 2, by + 38);

    // Wave label
    ctx.font = '600 14px Gilroy, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.shadowBlur = 0;
    ctx.fillText(`Wave ${currentWave + 1} incoming`, VP_W / 2, by + 68);

    // Eliminated count
    if (eliminatedCount > 0) {
      ctx.font = '500 13px Gilroy, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,100,100,0.75)';
      ctx.fillText(`${eliminatedCount} player${eliminatedCount !== 1 ? 's' : ''} eliminated`, VP_W / 2, by + 95);
    }

    ctx.restore();
  }

  _drawCountdown(ctx, seconds) {
    ctx.save();
    // Dim overlay (full viewport)
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, VP_W, VP_H);

    // "GET READY" label above the countdown
    ctx.font = '700 20px Gilroy, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.letterSpacing = '0.3em';
    ctx.fillText('GET READY', VP_W / 2, VP_H / 2 - 110);

    // Countdown number — use PNG if loaded, else fall back to procedural text
    const png = this._getPng(`countdown-${seconds}`);
    if (png) {
      // PNGs are @2x (source); draw at ~220px on canvas for a commanding presence
      const size = 240;
      ctx.drawImage(png, VP_W / 2 - size / 2, VP_H / 2 - size / 2 + 10, size, size);
    } else {
      ctx.font = '700 160px "Formula Condensed", Gilroy, sans-serif';
      ctx.fillStyle = '#0A2ECB';
      ctx.shadowColor = 'rgba(10,46,203,0.8)';
      ctx.shadowBlur = 40;
      ctx.fillText(String(seconds), VP_W / 2, VP_H / 2 + 20);
    }
    ctx.restore();
  }

  _drawPickup(ctx, x, y, type) {
    const key = type === 'shield' ? 'pickup-shield' : 'pickup-speed';
    const img = this._getPng(key);
    const size = 42; // on-canvas size; PNG source is 280×280 @2x
    if (img) {
      // Gentle bob via a small vertical offset based on time (independent per pickup
      // location so neighbours don't all bob in lockstep)
      const bobY = Math.sin((performance.now() + x * 31 + y * 17) / 420) * 2;
      ctx.drawImage(img, x - size / 2, y - size / 2 + bobY, size, size);
      return;
    }
    // Fallback — procedural ring + icon while PNG loads
    ctx.save();
    const isShield = type === 'shield';
    const ringColor = isShield ? 'rgba(10,46,203,0.8)' : 'rgba(80,220,80,0.8)';
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,5,0.65)';
    ctx.fill();
    ctx.font = '18px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isShield ? '#4488ff' : '#88ff88';
    ctx.fillText(isShield ? '🛡' : '»', x, y + 1);
    ctx.restore();
  }

  _drawMine(ctx, x, y) {
    const sprite = getSprite('q-mine');
    if (sprite) {
      const s = Q_PROJ_SIZE;
      ctx.drawImage(sprite, x - s / 2, y - s / 2, s, s);
      return;
    }
    this._drawQProjectile(ctx, x, y);
  }

  _drawMineBlast(ctx, x, y, ageMs) {
    const progress = ageMs / 400; // 0 → 1
    const alpha = 1 - progress;
    const r = 80 * progress; // expands to AOE radius
    ctx.save();
    ctx.globalAlpha = alpha * 0.6;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4444';
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#ffaa44';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  _drawArenaBorder(ctx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, ARENA_W - 2, ARENA_H - 2);

    // Subtle inner glow
    const grad = ctx.createLinearGradient(0, 0, 0, ARENA_H);
    grad.addColorStop(0,   'rgba(249,60,60,0.03)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0)');
    grad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
    ctx.restore();
  }

  _drawBoss(ctx, boss) {
    const sprite = getSprite('q-boss');
    if (sprite) {
      const s = BOSS_SIZE;
      ctx.drawImage(sprite, boss.x - s / 2, boss.y - s / 2, s, s);
      return;
    }
    // Fallback while sprite loads
    ctx.save();
    ctx.font = `bold 144px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff3333';
    ctx.shadowColor = 'rgba(255,50,50,0.7)';
    ctx.shadowBlur = 24;
    ctx.fillText('Q', boss.x, boss.y);
    ctx.restore();
  }

  _drawQProjectile(ctx, x, y) {
    const sprite = getSprite('projectile-q');
    if (sprite) {
      const s = Q_PROJ_SIZE;
      ctx.drawImage(sprite, x - s / 2, y - s / 2, s, s);
      return;
    }
    // Fallback
    ctx.save();
    ctx.font = `bold 14px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff4444';
    ctx.shadowColor = 'rgba(255,68,68,0.6)';
    ctx.shadowBlur = 8;
    ctx.fillText('Q', x, y);
    ctx.restore();
  }

  _drawUProjectile(ctx, x, y, vx = 1, vy = 0) {
    const sprite = getSprite('projectile-u');
    if (sprite) {
      // New projectile-u.svg is a 140×80 "bullet with trail" — U head on the
      // right, cyan trail on the left. Rotate along the velocity vector and
      // anchor so the U head (roughly 70% of the width from left) sits at
      // the projectile's reported position, trail extending behind.
      const w = 56;
      const h = 32; // maintains 140:80 aspect
      const angle = Math.atan2(vy, vx);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.drawImage(sprite, -w * 0.7, -h / 2, w, h);
      ctx.restore();
      return;
    }
    // Fallback
    ctx.save();
    ctx.font = `bold 13px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#44aaff';
    ctx.shadowColor = 'rgba(68,170,255,0.8)';
    ctx.shadowBlur = 12;
    ctx.fillText('U', x, y);
    ctx.restore();
  }

  _drawPlayer(ctx, x, y, player, isLocal, elimAnimations, now, hitFlashes) {
    ctx.save();

    // Determine visual state and size
    let size = PLAYER_SIZE;
    let alpha = 1;
    let state = 'normal';
    if (hitFlashes && hitFlashes.has(player.id))  state = 'hit';
    else if (player.frozen)                       state = 'frozen';

    const elim = elimAnimations.get(player.id);
    if (elim) {
      const progress = Math.min(1, (now - elim.startTime) / 500);
      size = PLAYER_SIZE + (PLAYER_SIZE * 1.5 * progress); // grow to 2.5×
      alpha = 1 - progress * 0.3;
      state = 'hit'; // elim uses the red palette
    }

    ctx.globalAlpha = alpha;

    // Shield bubble (drawn before player sprite)
    if (player.shielded && !elim) {
      ctx.beginPath();
      ctx.arc(x, y, PLAYER_SIZE * 0.58, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(10,46,203,0.85)';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(10,46,203,0.7)';
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Player sprite (rasterized from u-hero.svg with per-color CSS vars)
    const sprite = getSprite('u-hero', player.color, state);
    if (sprite) {
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    } else {
      // Fallback to legacy glyph while sprite loads
      let color = player.color;
      if (state === 'frozen') color = '#88ccff';
      else if (state === 'hit') color = '#ff3333';
      ctx.font = `bold ${PLAYER_GLYPH_SIZE}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.shadowColor = color + '88';
      ctx.shadowBlur = 10;
      ctx.fillText('U', x, y);
      ctx.shadowBlur = 0;
    }

    // Labels above player: "You" closest, then status icons above that
    if (!elim) {
      ctx.shadowBlur = 0;
      ctx.textAlign = 'center';

      let curY = y - size * 0.55;

      if (isLocal) {
        ctx.font = '600 11px Gilroy, system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText('You', x, curY);
        curY -= 14;
      }

      // Active pickup icons above the player — use the actual pickup sprites
      // rather than emoji so they match the in-game look.
      const activePickups = [];
      if (player.shielded) activePickups.push(this._getPng('pickup-shield'));
      if (player.speeding) activePickups.push(this._getPng('pickup-speed'));
      if (activePickups.length > 0) {
        const iconSize = 22;
        const spacing = 26;
        const startX = x - ((activePickups.length - 1) * spacing) / 2;
        const iconY = curY - iconSize; // above the "You" label
        for (let i = 0; i < activePickups.length; i++) {
          const img = activePickups[i];
          if (img) {
            ctx.drawImage(img, startX + i * spacing - iconSize / 2, iconY, iconSize, iconSize);
          }
        }
      }
    }

    ctx.restore();
  }

  _drawMeleeThrust(ctx, originX, originY, dirX, dirY, ageMs) {
    // 0–100ms: extend to 80px; 100–250ms: retract
    const EXTEND_MS = 100;
    const TOTAL_MS  = 250;
    const MAX_LEN   = 80;

    let len;
    if (ageMs <= EXTEND_MS) {
      len = MAX_LEN * (ageMs / EXTEND_MS);
    } else {
      len = MAX_LEN * (1 - (ageMs - EXTEND_MS) / (TOTAL_MS - EXTEND_MS));
    }

    const tipX = originX + dirX * len;
    const tipY = originY + dirY * len;
    const alpha = 1 - ageMs / TOTAL_MS;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(originX + dirX * PLAYER_SIZE * 0.45, originY + dirY * PLAYER_SIZE * 0.45);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(255,255,255,0.8)';
    ctx.shadowBlur = 8;
    ctx.stroke();

    // Tip flash
    ctx.beginPath();
    ctx.arc(tipX, tipY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  _drawFireFlash(ctx, originX, originY, dirX, dirY, ageMs) {
    // 0–40ms: bright cyan streak ahead of the player; 40–140ms: fade + extend
    const TOTAL_MS = 140;
    const progress = ageMs / TOTAL_MS;      // 0 → 1
    const alpha    = Math.max(0, 1 - progress);
    const len      = 36 + progress * 28;    // 36 → 64 px

    // Forward offset so the streak starts at the player's rim, not their centre
    const startOffset = 18;
    const x0 = originX + dirX * startOffset;
    const y0 = originY + dirY * startOffset;
    const x1 = originX + dirX * (startOffset + len);
    const y1 = originY + dirY * (startOffset + len);

    ctx.save();
    ctx.globalAlpha = alpha;

    // Streak
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 3.5;
    ctx.shadowColor = 'rgba(0, 179, 255, 0.9)';
    ctx.shadowBlur = 14;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Muzzle bloom at origin
    ctx.beginPath();
    ctx.arc(x0, y0, 10 * (1 - progress * 0.6), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.shadowColor = 'rgba(0, 179, 255, 1)';
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.restore();
  }

  _drawReticle(ctx, x, y) {
    const r = 12;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
