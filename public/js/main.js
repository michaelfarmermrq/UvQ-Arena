import { ScreenManager } from './ScreenManager.js';
import { wireSocketEvents } from './socket.js';
import { GameClient } from './GameClient.js';

// Socket.io is loaded as a global from the CDN script tag in index.html.
// We connect lazily after the user clicks "Join".

const screens = new ScreenManager();
let socket = null;
let gameClient = null;
let localPlayerId = null;
let localPlayerColor = null;

// Whether the local player is an active participant in the current round
let localInRound = false;
// Whether we're currently in spectator mode (watching without playing)
let isSpectating = false;

// ── Detect test mode ─────────────────────────────────────────────────────────
const IS_TEST_MODE = new URLSearchParams(window.location.search).get('testmode') === 'true';

// ── Lobby DOM refs ───────────────────────────────────────────────────────────
const btnReady          = document.getElementById('btn-ready');
const btnSolo           = document.getElementById('btn-solo');
const playerListEl      = document.getElementById('lobby-player-list');
const countdownEl       = document.getElementById('lobby-countdown');
const testmodeBadge     = document.getElementById('testmode-badge');
const waveOverlay       = document.getElementById('wave-overlay');
const waveLabel         = document.getElementById('wave-label');
const roundOverTitle    = document.getElementById('round-over-title');
const roundOverSub      = document.getElementById('round-over-sub');
const gameInProgress    = document.getElementById('game-in-progress');
const btnWatch          = document.getElementById('btn-watch');
const btnBackLobby      = document.getElementById('btn-back-lobby');
const spectatorBanner   = document.getElementById('spectator-banner');
const spectatorLeave    = document.getElementById('spectator-leave');
const btnStopWatch      = document.getElementById('btn-stop-watch');

// ── Connect to server ────────────────────────────────────────────────────────
function connect() {
  // eslint-disable-next-line no-undef
  socket = io();

  wireSocketEvents(socket, {
    onAssigned(data) {
      localPlayerId = data.id;
      localPlayerColor = data.color;
    },

    onLobbyState(data) {
      renderLobbyPlayerList(data.players);
      if (data.countdown !== null) {
        countdownEl.textContent = `Starting in ${data.countdown}s…`;
        countdownEl.classList.remove('hidden');
      } else {
        countdownEl.classList.add('hidden');
      }

      // Show/hide game-in-progress panel
      if (data.gameInProgress && !localInRound) {
        gameInProgress.classList.remove('hidden');
        btnReady.disabled = true;
        btnSolo.disabled = true;
      } else {
        gameInProgress.classList.add('hidden');
        if (!localInRound) {
          btnReady.disabled = false;
          btnSolo.disabled = false;
        }
      }
    },

    onRoundStart(data) {
      // Only enter game if this player is a round participant
      const participating = data.players.some((p) => p.id === localPlayerId);
      if (!participating) {
        // Another player started solo — ignore (stay on lobby)
        return;
      }

      localInRound = true;
      isSpectating = false;
      spectatorBanner.classList.add('hidden');
      spectatorLeave.classList.add('hidden');
      gameInProgress.classList.add('hidden');
      screens.show('game');
      if (!gameClient) {
        const canvas = document.getElementById('game-canvas');
        gameClient = new GameClient(canvas, localPlayerId, socket);
        gameClient.start();
      } else {
        gameClient.reset();
      }
    },

    onGameState(snapshot) {
      if (localInRound || isSpectating) {
        gameClient?.receiveSnapshot(snapshot);
      }
    },

    onWaveAnnounce(data) {
      if (localInRound || isSpectating) showWaveOverlay(data.label);
    },

    onPlayerHit(data) {
      gameClient?.onPlayerHit(data);
    },

    onPlayerEliminated(data) {
      gameClient?.onPlayerEliminated(data);
    },

    onPlayerFrozen(data) {
      gameClient?.onPlayerFrozen(data);
    },

    onRoundOver(data) {
      localInRound = false;

      if (isSpectating) {
        // Spectators just go back to lobby quietly
        stopSpectating();
        return;
      }

      screens.show('round-over');
      if (data.reason === 'survived') {
        roundOverTitle.textContent = 'You survived!';
      } else if (data.winnerId === localPlayerId) {
        roundOverTitle.textContent = 'You Win!';
      } else if (data.winnerId) {
        roundOverTitle.textContent = 'Round Over';
      } else {
        roundOverTitle.textContent = 'Eliminated!';
      }
      roundOverSub.textContent = 'Returning to lobby…';
      gameClient?.stop();

      // Re-enable both action buttons for the next round
      localReady = false;
      btnReady.disabled = false;
      btnReady.textContent = 'Ready Up';
      btnReady.classList.remove('btn-ready-active');
      btnSolo.disabled = false;

      // Auto-transition to lobby after 2s so players can see result briefly
      setTimeout(() => screens.show('lobby'), 2000);
    },

    onPlayerLeft(data) {
      gameClient?.onPlayerLeft(data);
    },

    onMineTriggered(data) {
      gameClient?.onMineTriggered(data);
    },

    onPickupCollected(data) {
      if (data.playerId === localPlayerId) {
        gameClient?.hud.onPickupCollected(data.type, data.duration);
      }
    },

    onShieldHit(data) {
      if (data.targetId === localPlayerId) {
        gameClient?.hud.triggerShieldFlash();
      }
    },

    onMeleeHit(data) {
      gameClient?.onMeleeHit(data);
    },

    onCooldownRejected() {
      gameClient?.onCooldownRejected();
    },
  });

  // Tell server we joined
  socket.emit('c2s:join');
}

// ── Spectator mode ───────────────────────────────────────────────────────────
function startSpectating() {
  isSpectating = true;
  gameInProgress.classList.add('hidden');
  spectatorBanner.classList.remove('hidden');
  spectatorLeave.classList.remove('hidden');
  screens.show('game');

  if (!gameClient) {
    const canvas = document.getElementById('game-canvas');
    // Spectators create a GameClient but never send movement
    gameClient = new GameClient(canvas, localPlayerId, socket);
    gameClient.startSpectator();
  } else {
    gameClient.startSpectator();
  }
}

function stopSpectating() {
  isSpectating = false;
  spectatorBanner.classList.add('hidden');
  spectatorLeave.classList.add('hidden');
  gameClient?.stop();
  screens.show('lobby');
}

btnWatch.addEventListener('click', startSpectating);
btnBackLobby.addEventListener('click', () => {
  gameInProgress.classList.add('hidden');
});
btnStopWatch.addEventListener('click', stopSpectating);

// ── Lobby rendering ──────────────────────────────────────────────────────────
function renderLobbyPlayerList(players) {
  playerListEl.innerHTML = '';
  if (players.length === 0) {
    playerListEl.innerHTML = '<p style="color:#555;font-size:13px;text-align:center">No players yet</p>';
    return;
  }
  for (const p of players) {
    const entry = document.createElement('div');
    entry.className = 'player-entry';

    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = p.color;
    entry.appendChild(dot);

    const name = document.createElement('span');
    name.textContent = p.id === localPlayerId ? 'You' : 'Player';
    entry.appendChild(name);

    const badge = document.createElement('span');
    if (p.ready) {
      badge.className = 'player-ready-badge';
      badge.textContent = '✓ Ready';
    } else {
      badge.className = 'player-not-ready-badge';
      badge.textContent = '● Not ready';
    }
    entry.appendChild(badge);

    playerListEl.appendChild(entry);
  }
}

// ── Wave overlay ─────────────────────────────────────────────────────────────
let waveOverlayTimeout = null;
function showWaveOverlay(label) {
  waveLabel.textContent = label;
  waveOverlay.classList.remove('hidden');
  if (waveOverlayTimeout) clearTimeout(waveOverlayTimeout);
  waveOverlayTimeout = setTimeout(() => {
    waveOverlay.classList.add('hidden');
  }, 2000);
}

// ── Ready button (toggles between ready and unready) ─────────────────────────
let localReady = false;

btnReady.addEventListener('click', () => {
  if (localReady) {
    localReady = false;
    socket.emit('c2s:unready');
    btnReady.textContent = 'Ready Up';
    btnReady.classList.remove('btn-ready-active');
  } else {
    localReady = true;
    socket.emit('c2s:ready');
    btnReady.textContent = 'Cancel';
    btnReady.classList.add('btn-ready-active');
  }
  screens.show('lobby');
});

// ── Solo Play button ──────────────────────────────────────────────────────────
btnSolo.addEventListener('click', launchSolo);

function launchSolo() {
  socket.emit('c2s:solo_start');
  btnSolo.disabled = true;
  btnReady.disabled = true;
  screens.show('lobby'); // stay on lobby until s2c:round_start fires
}

// ── Testmode via URL param (?testmode=true) ───────────────────────────────────
if (IS_TEST_MODE) {
  testmodeBadge.classList.remove('hidden');
}

// Connect immediately so we can show the live player count before ready.
// If testmode is active, fire solo_start as soon as we have an identity.
connect();

if (IS_TEST_MODE) {
  // Wait for s2c:assigned (confirms we have a server identity) then auto-launch.
  socket.once('s2c:assigned', () => launchSolo());
}
