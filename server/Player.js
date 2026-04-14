'use strict';

const PLAYER_COLORS = [
  '#f9e84a', // yellow
  '#4af9a0', // green
  '#4ab4f9', // blue
  '#f94a4a', // red
  '#f94af0', // pink
  '#f9a44a', // orange
  '#a44af9', // purple
  '#4af9f9', // cyan
  '#ff8c69', // salmon
  '#b0f94a', // lime
  '#4affd4', // mint
  '#ff6eb4', // hot pink
];

let colorIndex = 0;

class Player {
  constructor(socketId) {
    this.socketId = socketId;
    this.id = socketId;
    this.color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
    colorIndex++;

    // Spawn in the lower 60% of the arena with some padding
    this.x = 100 + Math.random() * 1000;
    this.y = 420 + Math.random() * 220;

    this.hp = 3;
    this.alive = true;
    this.ready = false;

    this.frozen = false;
    this.frozenUntil = 0;
    this.frozenRecoveryUntil = 0; // immunity window after unfreeze

    this.lastFreezeFiredAt = 0;

    this.shieldUntil = 0;  // epoch ms — 0 = no shield
    this.speedUntil  = 0;  // epoch ms — 0 = no speed boost

    this.wins = 0; // scaffold for leaderboard
    this.hat = null; // scaffold for cosmetics
  }

  resetForRound() {
    this.x = 100 + Math.random() * 1000;
    this.y = 420 + Math.random() * 220;
    this.hp = 3;
    this.alive = true;
    this.frozen = false;
    this.frozenUntil = 0;
    this.frozenRecoveryUntil = 0;
    this.lastFreezeFiredAt = 0;
    this.shieldUntil = 0;
    this.speedUntil  = 0;
  }

  toState() {
    const now = Date.now();
    return {
      id: this.id,
      color: this.color,
      x: this.x,
      y: this.y,
      hp: this.hp,
      frozen: this.frozen,
      alive: this.alive,
      shielded: this.shieldUntil > now,
      shieldRemaining: Math.max(0, this.shieldUntil - now),
      speeding: this.speedUntil > now,
      speedRemaining: Math.max(0, this.speedUntil - now),
    };
  }

  toLobbyEntry() {
    return {
      id: this.id,
      color: this.color,
      ready: this.ready,
    };
  }
}

module.exports = { Player, PLAYER_COLORS };
