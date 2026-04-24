'use strict';

const { Player } = require('./Player');
const Projectile = require('./Projectile');
const Mine = require('./Mine');
const Pickup = require('./Pickup');
const QBoss = require('./QBoss');
const { checkQToPlayers, checkUToPlayers } = require('./HitDetection');
const { tickBot } = require('./BotAI');

const TICK_RATE_MS       = 50;    // 20 Hz
const LOBBY_COUNTDOWN_S  = 10;
const FREEZE_DURATION_MS = 3000;
const FREEZE_COOLDOWN_MS = 3000;
const FREEZE_SPEED       = 15;    // px per tick for U projectile
const MIN_PLAYERS_TO_START = 2;

const ARENA_W = 2000;
const ARENA_H = 1900;

// ─── Pickup constants ─────────────────────────────────────────────────────────
const PICKUP_COLLECT_R   = 28;   // px — player must be within this to collect
const SHIELD_DURATION_MS = 8000; // 8 s shield
const SPEED_DURATION_MS  = 5000; // 5 s speed boost
const SPEED_MULTIPLIER   = 1.25; // 25% faster

// ─── Mine constants ──────────────────────────────────────────────────────────
const MINE_TRIGGER_R   = 22;  // px — contact radius to trigger
const MINE_AOE_R       = 80;  // px — AOE blast radius
const MINE_SAFE_SPAWN_R = 120; // px — minimum distance from any player at spawn

// Mines placed at start of each wave (index = waveNum - 1)
const MINES_PER_WAVE = [0, 48, 72, 96]; // progressive mine count per wave — tune: 3× for 2000×2000 world

// ─── Solo mode constants ─────────────────────────────────────────────────────
// Bots spawned at the start of each wave (index = waveNum - 1).
// Total across all 4 waves = 10.
const SOLO_BOTS_PER_WAVE = [12, 8, 12, 8]; // tune: 2× for 2000×2000 world

// Survive all 4 waves (each 60 s, 1200 ticks) to win.
const SOLO_WIN_TICKS = 4800; // 4 × 1200 ticks = 240 s

// Grace period at round start — bots are inactive, player sees a countdown.
const ROUND_START_GRACE_TICKS = 100; // 5 s at 20 Hz

let _botIdCounter = 0;

class GameSession {
  constructor(io) {
    this.io = io;

    this.phase = 'lobby'; // lobby | countdown | playing | round_over
    this.players      = new Map(); // id → Player
    this.qProjectiles = new Map(); // id → Projectile
    this.uProjectiles = new Map(); // id → Projectile
    this.mines        = new Map(); // id → Mine
    this.pickups      = new Map(); // id → Pickup
    this.boss = new QBoss();
    this.wave = 1;
    this.roundElapsedTicks = 0;

    this._tickInterval      = null;
    this._countdownInterval = null;
    this._countdownRemaining = 0;
    this._roundOverTimeout  = null;
    this._roundStartPlayerCount = 0;

    // Solo mode state
    this._soloMode = false;
    this._soloSocketId = null;     // socket.id of the player who triggered solo
    this._roundParticipants = new Set(); // player IDs in the current round
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  onConnect(_socket) {}

  onJoin(socket) {
    if (this.players.has(socket.id)) return;

    const player = new Player(socket.id);
    this.players.set(socket.id, player);

    socket.emit('s2c:assigned', { id: player.id, color: player.color });
    this._broadcastLobbyState();
  }

  onReady(socket) {
    const player = this.players.get(socket.id);
    if (!player) return;
    if (this.phase !== 'lobby' && this.phase !== 'round_over') return;

    player.ready = true;
    this._broadcastLobbyState();
    this._checkStartCountdown();
  }

  onUnready(socket) {
    const player = this.players.get(socket.id);
    if (!player) return;
    if (this.phase !== 'lobby' && this.phase !== 'round_over') return;

    player.ready = false;
    this._broadcastLobbyState();

    const readyCount = this._countReadyPlayers();
    if (readyCount < MIN_PLAYERS_TO_START && this._countdownInterval) {
      this._stopCountdown();
      this._broadcastLobbyState();
    }
  }

  /** Solo Play: start an immediate solo round with bots. */
  onSoloStart(socket) {
    if (!this.players.has(socket.id)) {
      this.onJoin(socket);
    }

    if (this.phase === 'playing') return;

    if (this.phase === 'lobby' || this.phase === 'round_over') {
      this._stopCountdown();
      const player = this.players.get(socket.id);
      if (player) player.ready = true;
      this._soloMode = true;
      this._soloSocketId = socket.id;
      this._startRound();
    }
  }

  onMove(socket, data) {
    const player = this.players.get(socket.id);
    if (!player || !player.alive || player.frozen) return;
    if (this.phase !== 'playing') return;

    const x = Math.max(0, Math.min(ARENA_W, Number(data.x) || 0));
    const y = Math.max(0, Math.min(ARENA_H, Number(data.y) || 0));
    player.x = x;
    player.y = y;
  }

  onFireFreeze(socket, data) {
    const player = this.players.get(socket.id);
    if (!player || !player.alive || player.frozen) return;
    if (this.phase !== 'playing') return;
    if (this.boss.isPausing()) return; // no combat during between-wave pause

    const now = Date.now();
    if (now - player.lastFreezeFiredAt < FREEZE_COOLDOWN_MS) {
      socket.emit('s2c:cooldown_rejected', {});
      return;
    }

    this._fireFreeze(player, Number(data.targetX) || 0, Number(data.targetY) || 0, now);
  }

  onMelee(socket, data) {
    const attacker = this.players.get(socket.id);
    if (!attacker || !attacker.alive || attacker.frozen) return;
    if (this.phase !== 'playing') return;
    if (this.boss.isPausing()) return;

    const now = Date.now();
    if (now - (attacker._lastMeleeAt || 0) < 250) return; // 250ms cooldown (matches client)
    attacker._lastMeleeAt = now;

    const tx = Number(data.targetX) || 0;
    const ty = Number(data.targetY) || 0;
    const dx = tx - attacker.x;
    const dy = ty - attacker.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const dirX = dx / len;
    const dirY = dy / len;

    // Melee range: 80px (thrust length) + player radius (14px)
    const MELEE_RANGE = 94;

    for (const target of this.players.values()) {
      if (target.id === attacker.id) continue;
      if (!target.alive) continue;
      if (!(this._roundParticipants.has(target.id) || target.isBot)) continue;

      // Check if target is within the thrust cone (range + within ±40° of direction)
      const tdx = target.x - attacker.x;
      const tdy = target.y - attacker.y;
      const dist = Math.sqrt(tdx * tdx + tdy * tdy);
      if (dist > MELEE_RANGE) continue;

      // Dot product check — must be roughly in the direction of swing
      const dot = (tdx / dist) * dirX + (tdy / dist) * dirY;
      if (dot < 0.5) continue; // must be within ~60° arc

      // Shield blocks melee too
      if (now < target.shieldUntil) {
        this.io.emit('s2c:shield_hit', { targetId: target.id });
        continue;
      }

      // Apply 1 damage
      target.hp = Math.max(0, target.hp - 1);
      this.io.emit('s2c:player_hit', { targetId: target.id, hp: target.hp, byId: socket.id });
      this.io.emit('s2c:melee_hit',  { attackerId: socket.id, targetId: target.id });
      if (target.hp <= 0) {
        target.alive = false;
        this.io.emit('s2c:player_eliminated', { id: target.id });
      }
    }
  }

  onDisconnect(socket) {
    const player = this.players.get(socket.id);
    if (!player) return;

    this.players.delete(socket.id);
    this.io.emit('s2c:player_left', { id: socket.id });

    if (this.phase === 'lobby' || this.phase === 'round_over') {
      this._broadcastLobbyState();
      const readyCount = this._countReadyPlayers();
      if (readyCount < MIN_PLAYERS_TO_START && this._countdownInterval) {
        this._stopCountdown();
        this._broadcastLobbyState();
      }
    } else if (this.phase === 'playing') {
      this._checkRoundOver();
    }
  }

  // ─── Shared fire helper (used by real players and bots) ──────────────────

  _fireFreeze(player, targetX, targetY, now) {
    const dx = targetX - player.x;
    const dy = targetY - player.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const proj = new Projectile({
      x: player.x, y: player.y,
      vx: (dx / len) * FREEZE_SPEED,
      vy: (dy / len) * FREEZE_SPEED,
      type: 'u_freeze',
      ownerId: player.id,
    });
    this.uProjectiles.set(proj.id, proj);
    player.lastFreezeFiredAt = now;
  }

  // ─── Bot management ──────────────────────────────────────────────────────

  _spawnBots(count) {
    for (let i = 0; i < count; i++) {
      const id  = `bot_${++_botIdCounter}`;
      const bot = new Player(id);
      bot.isBot = true;
      // Spread bots across the whole arena, not just the lower strip
      bot.x = 80 + Math.random() * (ARENA_W - 160);
      bot.y = 80 + Math.random() * (ARENA_H - 160);
      bot._wanderTarget = null;
      bot._wanderTimer  = 0;
      this.players.set(id, bot);
    }
  }

  _cleanupBots() {
    for (const [id, p] of this.players) {
      if (p.isBot) this.players.delete(id);
    }
  }

  _tickBots(inPause = false) {
    const now = Date.now();
    for (const bot of this.players.values()) {
      if (!bot.isBot || !bot.alive || bot.frozen) continue;

      const { dx, dy, fireTarget } = tickBot(bot, this.players, this.qProjectiles, now, inPause);

      bot.x = Math.max(0, Math.min(ARENA_W, bot.x + dx));
      bot.y = Math.max(0, Math.min(ARENA_H, bot.y + dy));

      if (fireTarget) {
        this._fireFreeze(bot, fireTarget.x, fireTarget.y, now);
      }
    }
  }

  // ─── Pickup management ──────────────────────────────────────────────────

  _spawnPickup(type) {
    const margin = 100;
    let x, y, attempts = 0;
    do {
      x = margin + Math.random() * (ARENA_W - margin * 2);
      y = margin + Math.random() * (ARENA_H - margin * 2);
      attempts++;
    } while ((this._tooCloseToAnyPlayer(x, y, 100) || this._tooCloseToBoss(x, y, 120)) && attempts < 30);

    const pickup = new Pickup({ x, y, type });
    this.pickups.set(pickup.id, pickup);
  }

  _checkPickups(now) {
    for (const [pickupId, pickup] of this.pickups) {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (!(this._roundParticipants.has(p.id) || p.isBot)) continue;
        const dx = p.x - pickup.x;
        const dy = p.y - pickup.y;
        if (dx * dx + dy * dy >= PICKUP_COLLECT_R * PICKUP_COLLECT_R) continue;

        // Collected!
        this.pickups.delete(pickupId);
        if (pickup.type === 'shield') {
          p.shieldUntil = now + SHIELD_DURATION_MS;
          this.io.emit('s2c:pickup_collected', { id: pickupId, type: 'shield', playerId: p.id, duration: SHIELD_DURATION_MS });
        } else if (pickup.type === 'speed') {
          p.speedUntil = now + SPEED_DURATION_MS;
          this.io.emit('s2c:pickup_collected', { id: pickupId, type: 'speed', playerId: p.id, duration: SPEED_DURATION_MS });
        }
        break; // one player per pickup per tick
      }
    }
  }

  // ─── Mine management ─────────────────────────────────────────────────────

  _spawnMines(count) {
    const margin = 80;
    for (let i = 0; i < count; i++) {
      let x, y, attempts = 0;
      do {
        x = margin + Math.random() * (ARENA_W - margin * 2);
        y = margin + Math.random() * (ARENA_H - margin * 2);
        attempts++;
      } while ((this._tooCloseToAnyPlayer(x, y, MINE_SAFE_SPAWN_R) || this._tooCloseToBoss(x, y, 120)) && attempts < 30);

      const mine = new Mine({ x, y });
      this.mines.set(mine.id, mine);
    }
  }

  _tooCloseToBoss(x, y, minDist) {
    const dx = this.boss.x - x;
    const dy = this.boss.y - y;
    return dx * dx + dy * dy < minDist * minDist;
  }

  _tooCloseToAnyPlayer(x, y, minDist) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
    return false;
  }

  _checkMines(now) {
    for (const [mineId, mine] of this.mines) {
      let triggered = false;
      let triggerX = mine.x;
      let triggerY = mine.y;

      // Check if any alive player is within trigger radius
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (!(this._roundParticipants.has(p.id) || p.isBot)) continue;
        const dx = p.x - mine.x;
        const dy = p.y - mine.y;
        if (dx * dx + dy * dy < MINE_TRIGGER_R * MINE_TRIGGER_R) {
          triggered = true;
          triggerX = mine.x;
          triggerY = mine.y;
          break;
        }
      }

      if (!triggered) continue;

      // Remove mine
      this.mines.delete(mineId);
      this.io.emit('s2c:mine_triggered', { id: mineId, x: triggerX, y: triggerY });

      // AOE damage to all players within blast radius
      const hitInBlast = new Set();
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (!(this._roundParticipants.has(p.id) || p.isBot)) continue;
        if (hitInBlast.has(p.id)) continue;
        const dx = p.x - triggerX;
        const dy = p.y - triggerY;
        if (dx * dx + dy * dy < MINE_AOE_R * MINE_AOE_R) {
          hitInBlast.add(p.id);
          if (now < p.shieldUntil) {
            this.io.emit('s2c:shield_hit', { targetId: p.id });
            continue;
          }
          p.hp = Math.max(0, p.hp - 1);
          this.io.emit('s2c:player_hit', { targetId: p.id, hp: p.hp, byId: 'mine' });
          if (p.hp <= 0) {
            p.alive = false;
            this.io.emit('s2c:player_eliminated', { id: p.id });
          }
        }
      }
    }
  }

  _getSoloRealPlayer() {
    return this.players.get(this._soloSocketId) || null;
  }

  // ─── Lobby / countdown logic ─────────────────────────────────────────────

  _countReadyPlayers() {
    let n = 0;
    for (const p of this.players.values()) if (p.ready && !p.isBot) n++;
    return n;
  }

  _countAlivePlayers() {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (!(this._roundParticipants.has(p.id) || p.isBot)) continue;
      n++;
    }
    return n;
  }

  _checkStartCountdown() {
    if (this._countdownInterval) return;
    if (this.phase !== 'lobby' && this.phase !== 'round_over') return;
    if (this._countReadyPlayers() >= MIN_PLAYERS_TO_START) this._startCountdown();
  }

  _startCountdown() {
    this._countdownRemaining = LOBBY_COUNTDOWN_S;
    this._broadcastLobbyState();

    this._countdownInterval = setInterval(() => {
      this._countdownRemaining--;
      this._broadcastLobbyState();
      if (this._countdownRemaining <= 0) {
        this._stopCountdown();
        this._startRound();
      }
    }, 1000);
  }

  _stopCountdown() {
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
    this._countdownRemaining = 0;
  }

  _broadcastLobbyState() {
    const players = [];
    for (const p of this.players.values()) {
      if (!p.isBot) players.push(p.toLobbyEntry()); // bots never show in lobby
    }
    this.io.emit('s2c:lobby_state', {
      players,
      countdown: this._countdownInterval ? this._countdownRemaining : null,
      gameInProgress: this.phase === 'playing',
    });
  }

  // ─── Round lifecycle ─────────────────────────────────────────────────────

  _startRound() {
    this.phase = 'playing';
    this.qProjectiles.clear();
    this.uProjectiles.clear();
    this.mines.clear();
    this.pickups.clear();
    this.boss.reset();
    this.wave = 1;
    this.roundElapsedTicks = 0;

    // Remove any leftover bots from a previous round
    this._cleanupBots();

    // Reset players — solo mode only resets the one player who clicked Solo
    this._roundParticipants.clear();
    this._roundStartPlayerCount = 0;

    if (this._soloMode && this._soloSocketId) {
      const soloPlayer = this.players.get(this._soloSocketId);
      if (soloPlayer) {
        soloPlayer.resetForRound();
        this._roundParticipants.add(soloPlayer.id);
        this._roundStartPlayerCount = 1;
      }
    } else {
      for (const p of this.players.values()) {
        if (p.ready && !p.isBot) {
          p.resetForRound();
          this._roundParticipants.add(p.id);
          this._roundStartPlayerCount++;
        }
      }
    }

    // Spawn wave-1 bots for solo mode
    if (this._soloMode) {
      this._spawnBots(SOLO_BOTS_PER_WAVE[0]);
    }

    // Build participant list for the round_start payload (clients self-filter)
    const playerList = [];
    for (const p of this.players.values()) {
      if (this._roundParticipants.has(p.id)) playerList.push(p.toLobbyEntry());
    }
    this.io.emit('s2c:round_start', { players: playerList });
    // Also update lobby state so spectators see "game in progress"
    this._broadcastLobbyState();
    this.io.emit('s2c:wave_announce', { wave: 1, label: 'Wave 1' });
    // Mines for Wave 1 (pickups are delayed until countdown finishes)
    this._spawnMines(MINES_PER_WAVE[0]);

    this._startTick();
  }

  _startTick() {
    if (this._tickInterval) clearInterval(this._tickInterval);
    this._tickInterval = setInterval(() => this._tick(), TICK_RATE_MS);
  }

  _stopTick() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  _tick() {
    if (this.phase !== 'playing') return;

    const now = Date.now();

    // 1. Unfreeze expired players — grant a 2 s re-freeze immunity on recovery
    for (const p of this.players.values()) {
      if (p.frozen && now >= p.frozenUntil) {
        p.frozen = false;
        p.frozenRecoveryUntil = now + 2000;
      }
    }

    const inWavePause = this.boss.isPausing();

    // 2. Bot AI: move + fire (held during grace period and wave pauses)
    if (this._soloMode && this.roundElapsedTicks >= ROUND_START_GRACE_TICKS) {
      this._tickBots(inWavePause);
    }

    // 3. Advance projectiles (skip during wave pause — clear them instead)
    if (inWavePause) {
      this.qProjectiles.clear();
      this.uProjectiles.clear();
    } else {
      for (const proj of this.qProjectiles.values()) proj.advance();
      for (const proj of this.uProjectiles.values()) proj.advance();

      // 4. Remove OOB projectiles
      for (const [id, proj] of this.qProjectiles) {
        if (proj.isOutOfBounds()) this.qProjectiles.delete(id);
      }
      for (const [id, proj] of this.uProjectiles) {
        if (proj.isOutOfBounds()) this.uProjectiles.delete(id);
      }

      // 5. Q-to-player collisions (shield blocks damage)
      const qHits = checkQToPlayers(this.qProjectiles, this.players);
      const hitPlayers = new Set();
      for (const { projectile, player } of qHits) {
        if (hitPlayers.has(player.id)) continue;
        hitPlayers.add(player.id);
        this.qProjectiles.delete(projectile.id);
        if (now < player.shieldUntil) {
          // Shield absorbs the hit — emit visual feedback but no HP loss
          this.io.emit('s2c:shield_hit', { targetId: player.id });
          continue;
        }
        player.hp = Math.max(0, player.hp - 1);
        this.io.emit('s2c:player_hit', { targetId: player.id, hp: player.hp, byId: 'boss' });
        if (player.hp <= 0) {
          player.alive = false;
          this.io.emit('s2c:player_eliminated', { id: player.id });
        }
      }

      // 6. U-to-player collisions (shield blocks freeze)
      const uHits = checkUToPlayers(this.uProjectiles, this.players);
      const frozenThisTick = new Set();
      for (const { projectile, player } of uHits) {
        if (frozenThisTick.has(player.id)) continue;
        // Skip players still in their post-unfreeze immunity window
        if (player.frozenRecoveryUntil && now < player.frozenRecoveryUntil) continue;
        this.uProjectiles.delete(projectile.id);
        if (now < player.shieldUntil) {
          this.io.emit('s2c:shield_hit', { targetId: player.id });
          continue;
        }
        frozenThisTick.add(player.id);
        player.frozen = true;
        player.frozenUntil = now + FREEZE_DURATION_MS;
        player.frozenRecoveryUntil = 0;
        this.io.emit('s2c:player_frozen', { id: player.id, duration: FREEZE_DURATION_MS });
      }
    }

    // 7. Check round-over
    this._checkRoundOver();
    if (this.phase !== 'playing') return;

    // 8. Boss tick — spawn Q projectiles + handle wave transitions
    // Hold fire during the grace period (while 3-2-1 countdown is showing)
    if (this.roundElapsedTicks < ROUND_START_GRACE_TICKS) {
      this.io.emit('s2c:game_state', this._buildSnapshot());
      this.roundElapsedTicks++;
      return;
    }

    // First tick after grace ends — spawn Wave 1 pickups now
    // tune: 4 shield + 4 speed for 2000×2000 world (was 2 + 2)
    if (this.roundElapsedTicks === ROUND_START_GRACE_TICKS) {
      this._spawnPickup('shield');
      this._spawnPickup('shield');
      this._spawnPickup('shield');
      this._spawnPickup('shield');
      this._spawnPickup('speed');
      this._spawnPickup('speed');
      this._spawnPickup('speed');
      this._spawnPickup('speed');
    }
    const newQProjectiles = this.boss.tick(
      this.roundElapsedTicks,
      this.players,
      (waveNum, label) => {
        this.wave = waveNum;
        this.io.emit('s2c:wave_announce', { wave: waveNum, label });
        // Spawn additional bots on each wave transition (waves 2–4)
        if (this._soloMode && waveNum >= 2 && waveNum <= 4) {
          this._spawnBots(SOLO_BOTS_PER_WAVE[waveNum - 1]);
        }
        // Spawn mines for the new wave
        const mineCount = MINES_PER_WAVE[waveNum - 1] ?? 0;
        if (mineCount > 0) this._spawnMines(mineCount);
      }
    );
    for (const proj of newQProjectiles) {
      this.qProjectiles.set(proj.id, proj);
    }

    // 8a. Spawn pickups when a between-wave countdown finishes
    // tune: 4 shield + 4 speed for 2000×2000 world (was 2 + 2)
    if (this.boss.didCountdownEnd()) {
      this._spawnPickup('shield');
      this._spawnPickup('shield');
      this._spawnPickup('shield');
      this._spawnPickup('shield');
      this._spawnPickup('speed');
      this._spawnPickup('speed');
      this._spawnPickup('speed');
      this._spawnPickup('speed');
    }

    // 8b. Mine collision check (only when not in wave pause)
    if (!this.boss.isPausing()) {
      this._checkMines(now);
      this._checkPickups(now);
    }

    // 9. Broadcast state
    this.io.emit('s2c:game_state', this._buildSnapshot());

    this.roundElapsedTicks++;
  }

  _buildSnapshot() {
    const players = [];
    for (const p of this.players.values()) {
      // Include only round participants and bots (excludes idle lobby players)
      if (this._roundParticipants.size === 0 || this._roundParticipants.has(p.id) || p.isBot) {
        players.push(p.toState());
      }
    }
    const qProjectiles = [];
    for (const p of this.qProjectiles.values()) qProjectiles.push(p.toState());
    const uProjectiles = [];
    for (const p of this.uProjectiles.values()) uProjectiles.push(p.toState());
    const mines = [];
    for (const m of this.mines.values()) mines.push(m.toState());
    const pickups = [];
    for (const pk of this.pickups.values()) pickups.push(pk.toState());
    const graceTicks = ROUND_START_GRACE_TICKS - this.roundElapsedTicks;
    return {
      tick: this.roundElapsedTicks,
      players,
      qProjectiles,
      uProjectiles,
      mines,
      pickups,
      boss: this.boss.toState(),
      wave: this.wave,
      nextWaveIn: this.boss.getNextWaveCountdown(this.roundElapsedTicks),
      graceRemaining: graceTicks > 0 ? Math.ceil(graceTicks / 20) : 0,
      eliminatedCount: [...this.players.values()].filter(
        (p) => (this._roundParticipants.has(p.id) || p.isBot) && !p.alive
      ).length,
    };
  }

  _checkRoundOver() {
    if (this.phase !== 'playing') return;

    if (this._soloMode) {
      const real = this._getSoloRealPlayer();
      if (!real || !real.alive) {
        this._endRound(null, 'eliminated');
      } else if (this.roundElapsedTicks >= SOLO_WIN_TICKS) {
        this._endRound(real.id, 'survived');
      }
      return;
    }

    // Multiplayer
    const aliveCount = this._countAlivePlayers();
    if (aliveCount > 1) return;
    if (aliveCount === 1 && this._roundStartPlayerCount === 1) return;

    let winnerId = null;
    let reason = 'all_eliminated';
    for (const p of this.players.values()) {
      if (p.alive) {
        winnerId = p.id;
        p.wins++;
        reason = 'last_standing';
        break;
      }
    }
    this._endRound(winnerId, reason);
  }

  _endRound(winnerId, reason) {
    this._stopTick();
    this.phase = 'round_over';

    if (winnerId && reason !== 'survived') {
      const winner = this.players.get(winnerId);
      if (winner) winner.wins++;
    }

    this.io.emit('s2c:round_over', { winnerId, reason });

    for (const p of this.players.values()) p.ready = false;

    this._roundOverTimeout = setTimeout(() => {
      this._cleanupBots();
      this._soloMode = false;
      this._soloSocketId = null;
      this._roundParticipants.clear();
      this.phase = 'lobby';
      this._broadcastLobbyState();
    }, 1500);
  }
}

module.exports = GameSession;
