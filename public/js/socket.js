/**
 * Wires all socket.io events from the server to callbacks.
 * The caller (main.js) provides handlers via the `handlers` object.
 */
export function wireSocketEvents(socket, handlers) {
  socket.on('s2c:assigned',        (d) => handlers.onAssigned?.(d));
  socket.on('s2c:lobby_state',     (d) => handlers.onLobbyState?.(d));
  socket.on('s2c:round_start',     (d) => handlers.onRoundStart?.(d));
  socket.on('s2c:game_state',      (d) => handlers.onGameState?.(d));
  socket.on('s2c:wave_announce',   (d) => handlers.onWaveAnnounce?.(d));
  socket.on('s2c:player_hit',      (d) => handlers.onPlayerHit?.(d));
  socket.on('s2c:player_eliminated',(d) => handlers.onPlayerEliminated?.(d));
  socket.on('s2c:player_frozen',   (d) => handlers.onPlayerFrozen?.(d));
  socket.on('s2c:round_over',      (d) => handlers.onRoundOver?.(d));
  socket.on('s2c:lobby_countdown', (d) => handlers.onLobbyCountdown?.(d));
  socket.on('s2c:player_left',      (d) => handlers.onPlayerLeft?.(d));
  socket.on('s2c:mine_triggered',    (d) => handlers.onMineTriggered?.(d));
  socket.on('s2c:pickup_collected',  (d) => handlers.onPickupCollected?.(d));
  socket.on('s2c:shield_hit',        (d) => handlers.onShieldHit?.(d));
  socket.on('s2c:melee_hit',         (d) => handlers.onMeleeHit?.(d));
  socket.on('s2c:cooldown_rejected', ()  => handlers.onCooldownRejected?.());
}
