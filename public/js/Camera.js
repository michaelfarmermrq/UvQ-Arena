/**
 * Smooth-lerp camera for following the local player through a larger world.
 * Inspired by the Google "Celebrating Popcorn" Doodle.
 *
 * World coords:   0..worldW × 0..worldH (larger than viewport)
 * Viewport coords: 0..vpW × 0..vpH (what the canvas shows)
 * Camera (x,y) is the world coord of the viewport's top-left corner.
 */
export class Camera {
  constructor({ vpW, vpH, worldW, worldH, lerp = 0.12 }) {
    this.vpW = vpW;
    this.vpH = vpH;
    this.worldW = worldW;
    this.worldH = worldH;
    this.lerp = lerp;
    this.x = 0;
    this.y = 0;
    this.targetX = 0;
    this.targetY = 0;
  }

  /**
   * Set the desired camera position to center the viewport on (targetX, targetY).
   * Clamped so the viewport never shows past the world edges.
   */
  follow(targetX, targetY) {
    let tx = targetX - this.vpW / 2;
    let ty = targetY - this.vpH / 2;
    tx = Math.max(0, Math.min(this.worldW - this.vpW, tx));
    ty = Math.max(0, Math.min(this.worldH - this.vpH, ty));
    this.targetX = tx;
    this.targetY = ty;
  }

  /**
   * Snap camera to target immediately (no lerp) — used on spawn / reset.
   */
  snap() {
    this.x = this.targetX;
    this.y = this.targetY;
  }

  /**
   * Advance the camera one frame toward its target.
   */
  tick() {
    this.x += (this.targetX - this.x) * this.lerp;
    this.y += (this.targetY - this.y) * this.lerp;
  }

  /**
   * Convert a viewport (screen) coord to a world coord.
   */
  viewportToWorld(vx, vy) {
    return { x: vx + this.x, y: vy + this.y };
  }
}
