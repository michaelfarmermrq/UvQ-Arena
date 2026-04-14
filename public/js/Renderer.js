import { extrapolateProjectile } from './Interpolation.js';

const ARENA_W = 1200;
const ARENA_H = 700;

// Player glyph size in px
const PLAYER_SIZE = 32;
const BOSS_SIZE   = 144;
const Q_PROJ_SIZE = 14;
const U_PROJ_SIZE = 13;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
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
    hitFlashes,
  }) {
    const ctx = this.ctx;
    const msSince = now - snapshotTime;

    // 1. Background
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);

    // 2. Arena border glow
    this._drawArenaBorder(ctx);

    if (!snapshot) return;

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
      this._drawUProjectile(ctx, pos.x, pos.y);
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

    // 8. HUD
    if (hud && localPlayer) {
      hud.draw(ctx, localPlayer, snapshot.players, now, snapshot);
    }

    // 9. Between-wave pause overlay
    if (snapshot.boss?.wavePausing) {
      this._drawWavePause(ctx, snapshot.boss.wavePauseRemaining, snapshot.wave, snapshot.eliminatedCount ?? 0);
    }

    // 10. Grace-period countdown — only show final 3 s so it doesn't overlap wave text
    if (snapshot.graceRemaining > 0 && snapshot.graceRemaining <= 3) {
      this._drawCountdown(ctx, snapshot.graceRemaining);
    }

    // 10. Melee thrust animation (drawn above players, below reticle)
    if (meleeAnim && localPlayer?.alive) {
      const age = now - meleeAnim.startTime;
      if (age < 250) {
        const pos = localPos || localPlayer;
        this._drawMeleeThrust(ctx, pos.x, pos.y, meleeAnim.dirX, meleeAnim.dirY, age);
      }
    }

    // 11. Aim reticle (drawn last, on top of everything)
    if (mousePos && localPlayer?.alive) {
      this._drawReticle(ctx, mousePos.x, mousePos.y);
    }
  }

  _drawWavePause(ctx, secondsRemaining, currentWave, eliminatedCount) {
    ctx.save();
    // Dim overlay
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);

    // Info card
    const bw = 340;
    const bh = eliminatedCount > 0 ? 170 : 140;
    const bx = ARENA_W / 2 - bw / 2;
    const by = ARENA_H / 2 - bh / 2;
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
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.fillStyle = '#ff4444';
    ctx.shadowColor = 'rgba(255,68,68,0.6)';
    ctx.shadowBlur = 10;
    ctx.fillText('Boss Q powering up…', ARENA_W / 2, by + 38);

    // Wave label
    ctx.font = '14px "Courier New", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.shadowBlur = 0;
    ctx.fillText(`Wave ${currentWave + 1} incoming`, ARENA_W / 2, by + 68);

    // Eliminated count
    if (eliminatedCount > 0) {
      ctx.font = '13px "Courier New", monospace';
      ctx.fillStyle = 'rgba(255,100,100,0.75)';
      ctx.fillText(`${eliminatedCount} player${eliminatedCount !== 1 ? 's' : ''} eliminated`, ARENA_W / 2, by + 95);
    }

    // Countdown — show for last 3 s
    if (secondsRemaining <= 3 && secondsRemaining > 0) {
      ctx.font = 'bold 52px monospace';
      ctx.fillStyle = '#0A2ECB';
      ctx.shadowColor = 'rgba(10,46,203,0.8)';
      ctx.shadowBlur = 30;
      ctx.fillText(String(secondsRemaining), ARENA_W / 2, by + bh - 40);
    }

    ctx.restore();
  }

  _drawCountdown(ctx, seconds) {
    ctx.save();
    // Dim overlay
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
    // Dark backdrop box
    const bw = 200;
    const bh = 180;
    const bx = ARENA_W / 2 - bw / 2;
    const by = ARENA_H / 2 - bh / 2 - 20;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 14);
    ctx.fill();
    // "Get ready" label
    ctx.font = '18px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('GET READY', ARENA_W / 2, ARENA_H / 2 - 60);
    // Big number
    ctx.font = 'bold 120px monospace';
    ctx.fillStyle = '#0A2ECB';
    ctx.shadowColor = 'rgba(10,46,203,0.8)';
    ctx.shadowBlur = 40;
    ctx.fillText(String(seconds), ARENA_W / 2, ARENA_H / 2 + 20);
    ctx.restore();
  }

  _drawPickup(ctx, x, y, type) {
    ctx.save();
    const isShield = type === 'shield';
    const ringColor = isShield ? 'rgba(10,46,203,0.8)' : 'rgba(80,220,80,0.8)';
    const glowColor = isShield ? 'rgba(10,46,203,0.5)' : 'rgba(80,220,80,0.5)';

    // Ring
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 10;
    ctx.stroke();

    // Fill
    ctx.fillStyle = 'rgba(0,0,5,0.65)';
    ctx.fill();

    // Icon
    ctx.font = '18px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isShield ? '#4488ff' : '#88ff88';
    ctx.shadowBlur = 8;
    ctx.fillText(isShield ? '🛡' : '»', x, y + 1);
    ctx.restore();
  }

  _drawMine(ctx, x, y) {
    ctx.save();
    // Outer danger ring
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,68,68,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Pulsing fill
    ctx.fillStyle = 'rgba(30,0,0,0.7)';
    ctx.fill();
    // Q glyph
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff4444';
    ctx.shadowColor = 'rgba(255,68,68,0.8)';
    ctx.shadowBlur = 6;
    ctx.fillText('Q', x, y);
    ctx.restore();
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
    ctx.save();
    ctx.font = `bold ${BOSS_SIZE}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff3333';
    ctx.shadowColor = 'rgba(255,50,50,0.7)';
    ctx.shadowBlur = 24;
    ctx.fillText('Q', boss.x, boss.y);
    ctx.restore();
  }

  _drawQProjectile(ctx, x, y) {
    ctx.save();
    ctx.font = `bold ${Q_PROJ_SIZE}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff4444';
    ctx.shadowColor = 'rgba(255,68,68,0.6)';
    ctx.shadowBlur = 8;
    ctx.fillText('Q', x, y);
    ctx.restore();
  }

  _drawUProjectile(ctx, x, y) {
    ctx.save();
    ctx.font = `bold ${U_PROJ_SIZE}px monospace`;
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

    let size = PLAYER_SIZE;
    let color = player.color;
    let alpha = 1;

    // Elimination animation
    const elim = elimAnimations.get(player.id);
    if (elim) {
      const progress = Math.min(1, (now - elim.startTime) / 500);
      size = PLAYER_SIZE + (PLAYER_SIZE * 1.5 * progress); // grow to 2.5×
      color = `rgba(255, ${Math.round(80 * (1 - progress))}, ${Math.round(80 * (1 - progress))}, ${1 - progress * 0.3})`;
      alpha = 1 - progress * 0.3;
    } else if (hitFlashes && hitFlashes.has(player.id)) {
      color = '#ff3333';
      ctx.shadowColor = 'rgba(255,50,50,0.9)';
      ctx.shadowBlur = 18;
    } else if (player.frozen) {
      color = '#88ccff';
      ctx.shadowColor = 'rgba(68,170,255,0.9)';
      ctx.shadowBlur = 16;
    }

    ctx.globalAlpha = alpha;

    // Shield bubble (drawn before player glyph)
    if (player.shielded && !elim) {
      ctx.beginPath();
      ctx.arc(x, y, PLAYER_SIZE * 0.9, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(10,46,203,0.85)';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(10,46,203,0.7)';
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.font = `bold ${size}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Local player: white outline stroke
    if (isLocal && !elim) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.strokeText('U', x, y);
    }

    ctx.fillStyle = color;
    if (!player.frozen) {
      ctx.shadowColor = color + '88';
      ctx.shadowBlur = 10;
    }
    ctx.fillText('U', x, y);

    // Labels above player: "You" closest, then status icons above that
    if (!elim) {
      ctx.shadowBlur = 0;
      ctx.textAlign = 'center';

      let curY = y - 22; // start just above the glyph

      // "You" label (drawn first, closest to player)
      if (isLocal) {
        ctx.font = '10px "Courier New", monospace';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText('You', x, curY);
        curY -= 14;
      }

      // Status icons above the "You" label
      const icons = [];
      if (player.shielded) icons.push({ icon: '🛡', color: '#4488ff' });
      if (player.speeding) icons.push({ icon: '»', color: '#88ff88' });

      if (icons.length > 0) {
        ctx.font = '14px monospace';
        ctx.textBaseline = 'bottom';
        const spacing = 18;
        const startX = x - ((icons.length - 1) * spacing) / 2;
        for (let i = 0; i < icons.length; i++) {
          ctx.fillStyle = icons[i].color;
          ctx.fillText(icons[i].icon, startX + i * spacing, curY);
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
