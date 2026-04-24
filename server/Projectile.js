'use strict';

let nextId = 1;

class Projectile {
  constructor({ x, y, vx, vy, type, ownerId }) {
    this.id = String(nextId++);
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.type = type; // 'q_bullet' | 'u_freeze'
    this.ownerId = ownerId; // socketId or 'boss'
    this.createdAt = Date.now();
  }

  advance() {
    this.x += this.vx;
    this.y += this.vy;
  }

  isOutOfBounds(width = 2000, height = 1900) {
    const margin = 30;
    return (
      this.x < -margin ||
      this.x > width + margin ||
      this.y < -margin ||
      this.y > height + margin
    );
  }

  toState() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      type: this.type,
    };
  }
}

module.exports = Projectile;
