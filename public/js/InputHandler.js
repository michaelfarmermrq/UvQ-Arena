const FREEZE_COOLDOWN_MS = 3000;
const MELEE_COOLDOWN_MS  = 250; // right-click melee cooldown
const VP_W = 1200;              // viewport (canvas visible) width
const VP_H = 700;

export class InputHandler {
  constructor(canvas, socket, { camera, onFired, onMelee } = {}) {
    this.canvas = canvas;
    this.socket = socket;
    this.camera = camera || null;   // needed for viewport→world conversion
    this._onFired = onFired || null;
    this._onMelee = onMelee || null;

    // Mouse position in viewport (screen) coords — 0..VP_W × 0..VP_H
    this.mousePos = { x: VP_W / 2, y: VP_H / 2 };

    // Boolean key state read by GameClient each frame
    this.keys = { up: false, down: false, left: false, right: false };

    // Set by GameClient each frame — blocks fire and melee when true
    this.frozen = false;

    this._lastFired  = -FREEZE_COOLDOWN_MS; // ready to fire immediately on page load
    this._lastMelee  = -MELEE_COOLDOWN_MS;

    this._onMouseMove    = this._handleMouseMove.bind(this);
    this._onClick        = this._handleClick.bind(this);
    this._onContextMenu  = this._handleContextMenu.bind(this);
    this._onKeyDown      = this._handleKeyDown.bind(this);
    this._onKeyUp        = this._handleKeyUp.bind(this);
  }

  attach() {
    this.canvas.addEventListener('mousemove',   this._onMouseMove);
    this.canvas.addEventListener('click',       this._onClick);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
  }

  detach() {
    this.canvas.removeEventListener('mousemove',   this._onMouseMove);
    this.canvas.removeEventListener('click',       this._onClick);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    this.keys.up = false;
    this.keys.down = false;
    this.keys.left = false;
    this.keys.right = false;
  }

  /** Convert a DOM mouse event's (clientX, clientY) to viewport coords (0..VP_W × 0..VP_H). */
  _toViewport(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = VP_W / rect.width;
    const scaleY = VP_H / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top)  * scaleY,
    };
  }

  /** Convert a DOM mouse event to world coords by adding the camera offset. */
  _toWorld(clientX, clientY) {
    const vp = this._toViewport(clientX, clientY);
    if (this.camera) return this.camera.viewportToWorld(vp.x, vp.y);
    return vp; // fallback (shouldn't happen — camera is always supplied)
  }

  _handleMouseMove(e) {
    this.mousePos = this._toViewport(e.clientX, e.clientY);
  }

  _handleClick(e) {
    if (this.frozen) return;
    const now = performance.now();
    if (now - this._lastFired < FREEZE_COOLDOWN_MS) return;
    this._lastFired = now;
    this._onFired?.();

    const pos = this._toWorld(e.clientX, e.clientY);
    this.socket.emit('c2s:fire_freeze', { targetX: pos.x, targetY: pos.y });
  }

  _handleContextMenu(e) {
    e.preventDefault(); // always suppress browser context menu on canvas
    if (this.frozen) return;
    const now = performance.now();
    if (now - this._lastMelee < MELEE_COOLDOWN_MS) return;
    this._lastMelee = now;

    const pos = this._toWorld(e.clientX, e.clientY);
    this._onMelee?.(pos);
    this.socket.emit('c2s:melee', { targetX: pos.x, targetY: pos.y });
  }

  _handleKeyDown(e) {
    switch (e.code) {
      case 'KeyW':     case 'ArrowUp':    this.keys.up    = true; e.preventDefault(); break;
      case 'KeyS':     case 'ArrowDown':  this.keys.down  = true; e.preventDefault(); break;
      case 'KeyA':     case 'ArrowLeft':  this.keys.left  = true; e.preventDefault(); break;
      case 'KeyD':     case 'ArrowRight': this.keys.right = true; e.preventDefault(); break;
    }
  }

  _handleKeyUp(e) {
    switch (e.code) {
      case 'KeyW':     case 'ArrowUp':    this.keys.up    = false; break;
      case 'KeyS':     case 'ArrowDown':  this.keys.down  = false; break;
      case 'KeyA':     case 'ArrowLeft':  this.keys.left  = false; break;
      case 'KeyD':     case 'ArrowRight': this.keys.right = false; break;
    }
  }

  resetFireCooldown() {
    this._lastFired = 0;
  }
}
