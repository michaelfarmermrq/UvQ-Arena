'use strict';

let _mineIdCounter = 0;

class Mine {
  constructor({ x, y }) {
    this.id  = `mine_${++_mineIdCounter}`;
    this.x   = x;
    this.y   = y;
    this.triggered = false;
  }

  toState() {
    return { id: this.id, x: this.x, y: this.y };
  }
}

module.exports = Mine;
