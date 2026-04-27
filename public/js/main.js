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
// Whether the first lobby_state has arrived — used to dismiss the connecting spinner
let playersLoaded = false;

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
const spectatorBanner   = document.getElementById('spectator-banner');
const spectatorLeave    = document.getElementById('spectator-leave');
const btnStopWatch      = document.getElementById('btn-stop-watch');
const lobbyLoadingEl    = document.getElementById('lobby-loading');
const btnRowEl          = document.querySelector('.btn-row');
const btnHowToPlayEl    = document.getElementById('btn-how-to-play');

// ── Connect to server ────────────────────────────────────────────────────────
function connect() {
  // eslint-disable-next-line no-undef
  socket = io();

  // Tell the server we're leaving the moment the tab unloads or hides.
  // Without this the old player would linger in the lobby until the
  // server's pingTimeout caught up, which made refreshes look like new
  // ghost players in the list.
  const disconnectImmediately = () => {
    try { socket?.disconnect(); } catch { /* ignore */ }
  };
  window.addEventListener('pagehide',     disconnectImmediately);
  window.addEventListener('beforeunload', disconnectImmediately);

  wireSocketEvents(socket, {
    onAssigned(data) {
      localPlayerId = data.id;
      localPlayerColor = data.color;
    },

    onLobbyState(data) {
      if (!playersLoaded) {
        playersLoaded = true;
        lobbyLoadingEl.classList.add('hidden');
        playerListEl.classList.remove('hidden');
        btnRowEl.classList.remove('hidden');
        btnHowToPlayEl.classList.remove('hidden');
      }
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
btnStopWatch.addEventListener('click', stopSpectating);

// ── Lobby rendering ──────────────────────────────────────────────────────────

// U-character SVG template — fetched once, cached, inlined per player so each
// entry can override the fill gradient stops via inline CSS vars.
let _uSvgTemplate = null;
fetch('/assets/svg/u-hero.svg')
  .then((r) => r.text())
  .then((t) => {
    _uSvgTemplate = t;
    // Re-render any already-visible list entries with placeholder thumbnails.
    if (playerListEl.children.length > 0 && _lastPlayers) {
      renderLobbyPlayerList(_lastPlayers);
    }
  })
  .catch(() => {
    /* Fallback silently — renderLobbyPlayerList handles a null template. */
  });

let _lastPlayers = null;

/** Darken/lighten a #rrggbb by a 0..1 factor. */
function shiftHex(hex, factor) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c) => {
    if (factor >= 0) return Math.round(c + (255 - c) * factor);
    return Math.round(c * (1 + factor));
  };
  const to2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

function renderLobbyPlayerList(players) {
  _lastPlayers = players;
  playerListEl.innerHTML = '';
  if (players.length === 0) {
    playerListEl.innerHTML = '<p style="color:#666;font-size:13px;text-align:center">No players yet</p>';
    return;
  }
  for (const p of players) {
    const entry = document.createElement('div');
    entry.className = 'player-entry';

    // U thumbnail — inline the SVG so the per-player CSS vars cascade into it.
    const thumb = document.createElement('span');
    thumb.className = 'player-u';
    const body  = p.color;
    const shade = shiftHex(body, -0.4);
    const hi    = shiftHex(body,  0.4);
    thumb.style.setProperty('--uvq-u-hero-body', body);
    thumb.style.setProperty('--uvq-u-hero-shade', shade);
    thumb.style.setProperty('--uvq-u-hero-hi', hi);
    if (_uSvgTemplate) {
      thumb.innerHTML = _uSvgTemplate;
    } else {
      // Pre-load fallback: solid circle in the player color.
      thumb.style.background = body;
      thumb.style.borderRadius = '50%';
      thumb.style.width = '12px';
      thumb.style.height = '12px';
    }
    entry.appendChild(thumb);

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

// ── How to Play modal ────────────────────────────────────────────────────────
const btnHowToPlay   = document.getElementById('btn-how-to-play');
const howToPlayModal = document.getElementById('how-to-play-modal');
const btnCloseModal  = document.getElementById('btn-close-modal');

btnHowToPlay.addEventListener('click', () => howToPlayModal.classList.remove('hidden'));
btnCloseModal.addEventListener('click', () => howToPlayModal.classList.add('hidden'));
howToPlayModal.addEventListener('click', (e) => {
  if (e.target === howToPlayModal) howToPlayModal.classList.add('hidden');
});

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
