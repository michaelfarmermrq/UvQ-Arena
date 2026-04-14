'use strict';

let _pickupIdCounter = 0;

/**
 * A collectible pickup on the arena floor.
 * type: 'shield' | 'speed'
 */
class Pickup {
  constructor({ x, y, type }) {
    this.id   = `pickup_${++_pickupIdCounter}`;
    this.x    = x;
    this.y    = y;
    this.type = type; // 'shield' | 'speed'
  }

  toState() {
    return { id: this.id, x: this.x, y: this.y, type: this.type };
  }
}

module.exports = Pickup;
