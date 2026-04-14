import { Renderer } from './Renderer.js';
import { PlayerInterpolator } from './Interpolation.js';
import { InputHandler } from './InputHandler.js';
import { HUD } from './HUD.js';

const PLAYER_SPEED     = 0.209; // px/ms  →  209 px/s (~5% slower than original 220)
const MOVE_THROTTLE_MS = 20;   // max rate to emit c2s:move (50 Hz)
const ARENA_W = 1200;
const ARENA_H = 700;
const INV_SQRT2 = 0.7071067811865476; // 1/√2 for diagonal normalisation
// Boss Q is rendered at 144px — collision radius ≈ half glyph height + player radius
const BOSS_COLLIDE_R = 80; // combined boss + player exclusion radius (px)

export class GameClient {
  constructor(canvas, localPlayerId, socket) {
    this.canvas = canvas;
    this.localPlayerId = localPlayerId;
    this.socket = socket;

    this.renderer = new Renderer(canvas);
    this.interpolator = new PlayerInterpolator();
    this.hud = new HUD();
    this.input = new InputHandler(canvas, socket, {
      onFired: () => this.hud.onFreezeFired(),
      onMelee: (targetPos) => this._startMeleeAnim(targetPos),
    });

    this._snapshot = null;
    this._snapshotTime = 0;
    this._rafId = null;
    this._running = false;
    this._elimAnimations = new Map();
    this._mineBlasts = []; // { x, y, startTime }[] for AOE flash animations
    this._meleeAnim = null; // { dirX, dirY, startTime } — thrust animation
    this._hitFlashes = new Map(); // id → { startTime } — brief red flash on hit

    // Client-side position for zero-latency local player rendering
    this._localPos = { x: ARENA_W / 2, y: ARENA_H / 2 };
    this._localPosSeeded = false; // true once we've synced from first snapshot
    this._lastFrameTime = null;
    this._lastMoveSent = 0;
  }

  start() {
    this._localPos = { x: ARENA_W / 2, y: ARENA_H / 2 };
    this._localPosSeeded = false;
    this._lastFrameTime = null;
    this._lastMoveSent = 0;
    this._spectator = false;
    this._running = true;
    this.input.attach();
    this._loop();
  }

  /** Start in spectator mode — renders game but sends no input. */
  startSpectator() {
    this._localPos = { x: ARENA_W / 2, y: ARENA_H / 2 };
    this._localPosSeeded = false;
    this._lastFrameTime = null;
    this._lastMoveSent = 0;
    this._spectator = true;
    this._running = true;
    // Don't attach input — spectators don't move or fire
    if (!this._rafId) this._loop();
  }

  stop() {
    this._running = false;
    this.input.detach();
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  reset() {
    this._snapshot = null;
    this._snapshotTime = 0;
    this._elimAnimations.clear();
    this._mineBlasts = [];
    this.interpolator = new PlayerInterpolator();
    this.hud.reset();
    this._localPos = { x: ARENA_W / 2, y: ARENA_H / 2 };
    this._localPosSeeded = false;
    this._lastFrameTime = null;
    this._lastMoveSent = 0;
    this._spectator = false;
    this._running = true;
    this.input.attach();
    if (!this._rafId) this._loop();
  }

  // ── Server event handlers ──────────────────────────────────────────────────

  receiveSnapshot(snapshot) {
    this._snapshot = snapshot;
    this._snapshotTime = performance.now();
    this.interpolator.pushSnapshot(snapshot.players, this._snapshotTime);

    // Seed client position from the server's assigned spawn on the first snapshot,
    // so the player appears at their correct spawn rather than the canvas centre.
    if (!this._localPosSeeded) {
      const me = snapshot.players.find((p) => p.id === this.localPlayerId);
      if (me) {
        this._localPos.x = me.x;
        this._localPos.y = me.y;
        this._localPosSeeded = true;
      }
    }
  }

  onPlayerHit(data) {
    if (data.targetId === this.localPlayerId) {
      this.hud.setHp(data.hp);
      this.hud.triggerHitFlash();
    }
    // Flash the hit player's glyph red
    this._hitFlashes.set(data.targetId, { startTime: performance.now() });
    setTimeout(() => this._hitFlashes.delete(data.targetId), 200);
  }

  onPlayerEliminated(data) {
    this._elimAnimations.set(data.id, { startTime: performance.now() });
    setTimeout(() => {
      this._elimAnimations.delete(data.id);
      this.interpolator.remove(data.id);
    }, 700);
  }

  onPlayerFrozen(data) {
    if (data.id === this.localPlayerId) {
      this.hud.setFrozen(true, data.duration);
    }
  }

  _startMeleeAnim(targetPos) {
    if (!this._localPos) return;
    const dx = targetPos.x - this._localPos.x;
    const dy = targetPos.y - this._localPos.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    this._meleeAnim = { dirX: dx / len, dirY: dy / len, startTime: performance.now() };
  }

  onMeleeHit(data) {
    // Flash the hit player's glyph red
    this._hitFlashes.set(data.targetId, { startTime: performance.now() });
    setTimeout(() => this._hitFlashes.delete(data.targetId), 200);
  }

  onMineTriggered(data) {
    this._mineBlasts.push({ x: data.x, y: data.y, startTime: performance.now() });
    // Clean up after animation completes
    setTimeout(() => {
      const idx = this._mineBlasts.findIndex((b) => b.x === data.x && b.y === data.y);
      if (idx !== -1) this._mineBlasts.splice(idx, 1);
    }, 500);
  }

  onPlayerLeft(data) {
    this.interpolator.remove(data.id);
  }

  onCooldownRejected() {
    this.hud.rejectFreeze();
  }

  // ── Movement ───────────────────────────────────────────────────────────────

  /**
   * Integrate WASD / arrow key input over `dt` milliseconds.
   * Updates this._localPos and emits c2s:move when throttle allows.
   */
  _updateLocalPosition(dt, now) {
    if (dt <= 0) return;

    // Respect server-authoritative freeze and alive state
    let speedMult = 1;
    if (this._snapshot) {
      const me = this._snapshot.players.find((p) => p.id === this.localPlayerId);
      this.input.frozen = !!(me && me.frozen);
      if (me && (me.frozen || !me.alive)) return;
      if (me?.speeding) speedMult = 1.25; // speed boost active
    }

    const { up, down, left, right } = this.input.keys;
    let dx = 0;
    let dy = 0;
    if (left)  dx -= 1;
    if (right) dx += 1;
    if (up)    dy -= 1;
    if (down)  dy += 1;

    // Nothing held — skip update and don't emit
    if (dx === 0 && dy === 0) return;

    // Normalise diagonal so diagonal speed == cardinal speed
    if (dx !== 0 && dy !== 0) {
      dx *= INV_SQRT2;
      dy *= INV_SQRT2;
    }

    this._localPos.x = Math.max(0, Math.min(ARENA_W, this._localPos.x + dx * PLAYER_SPEED * speedMult * dt));
    this._localPos.y = Math.max(0, Math.min(ARENA_H, this._localPos.y + dy * PLAYER_SPEED * speedMult * dt));

    // Boss collision — push player to the surface of the Q exclusion circle
    const boss = this._snapshot?.boss;
    if (boss?.visible) {
      const cdx = this._localPos.x - boss.x;
      const cdy = this._localPos.y - boss.y;
      const dist = Math.sqrt(cdx * cdx + cdy * cdy);
      if (dist < BOSS_COLLIDE_R) {
        const d = dist > 0 ? dist : 1; // guard against exact overlap (dist == 0)
        this._localPos.x = boss.x + (cdx / d) * BOSS_COLLIDE_R;
        this._localPos.y = boss.y + (cdy / d) * BOSS_COLLIDE_R;
      }
    }

    // Throttled position emit — only fires when actually moving
    if (now - this._lastMoveSent >= MOVE_THROTTLE_MS) {
      this._lastMoveSent = now;
      this.socket.emit('c2s:move', { x: this._localPos.x, y: this._localPos.y });
    }
  }

  // ── Render loop ────────────────────────────────────────────────────────────

  _loop() {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(() => this._loop());

    const now = performance.now();
    const dt = this._lastFrameTime === null ? 0 : now - this._lastFrameTime;
    this._lastFrameTime = now;

    if (!this._spectator) this._updateLocalPosition(dt, now);

    this.renderer.drawFrame({
      snapshot: this._snapshot,
      localPlayerId: this.localPlayerId,
      localPos: this._localPos,
      interpolator: this.interpolator,
      snapshotTime: this._snapshotTime,
      now,
      mousePos: this.input.mousePos,
      elimAnimations: this._elimAnimations,
      hud: this.hud,
      mineBlasts: this._mineBlasts,
      meleeAnim: this._meleeAnim,
      hitFlashes: this._hitFlashes,
    });
  }
}
