#!/usr/bin/env node
/**
 * UvQ load test — spawns N fake socket.io-client connections against a
 * running server, simulates joins + readies + moves, and reports:
 *
 *   • avg bytes/sec received per client (packet payload, pre-framing)
 *   • avg snapshots/sec received per client
 *   • total outbound bandwidth the server had to push
 *   • ready-up → first-game-state latency per client
 *   • max time between consecutive snapshots (tick jitter)
 *
 * Usage:
 *   node scripts/loadtest.js [--host=http://localhost:3000] [--n=50] [--secs=30]
 *
 * To measure compression savings: run with and without perMessageDeflate
 * enabled in server/index.js and compare the bytes/sec numbers.
 */
'use strict';

const { io } = require('socket.io-client');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v = 'true'] = a.replace(/^--/, '').split('=');
      return [k, v];
    })
);

const HOST = args.host || 'http://localhost:3000';
const N    = parseInt(args.n    || '50', 10);
const SECS = parseInt(args.secs || '30', 10);

console.log(`[loadtest] host=${HOST}  clients=${N}  duration=${SECS}s`);

const clients = [];
let connected = 0;
let firstGameStateAt = new Map(); // id → ms from ready → first snapshot

function mkClient(i) {
  const socket = io(HOST, {
    transports: ['websocket'],
    reconnection: false,
  });

  const stats = {
    id: i,
    connected: false,
    assignedAt: 0,
    readyAt: 0,
    firstGameStateAt: 0,
    bytesIn: 0,
    snapshotsIn: 0,
    lastSnapshotAt: 0,
    maxGapMs: 0,
  };

  // Measure payload size. socket.io-client doesn't expose raw frame bytes,
  // so we approximate via JSON.stringify of the payload. This undercounts
  // by framing overhead but mirrors what the server serialised.
  const onAny = (eventName, data) => {
    try {
      const s = JSON.stringify(data);
      stats.bytesIn += (eventName.length + s.length);
    } catch { /* ignore */ }
  };
  socket.onAny(onAny);

  socket.on('connect', () => {
    stats.connected = true;
    connected++;
    socket.emit('c2s:join');
  });

  socket.on('s2c:assigned', () => {
    stats.assignedAt = Date.now();
    // Ready up immediately
    stats.readyAt = Date.now();
    socket.emit('c2s:ready');
  });

  socket.on('s2c:round_start', () => {
    // Start sending move updates ~20Hz
    stats.moveInterval = setInterval(() => {
      socket.emit('c2s:move', {
        x: 200 + Math.random() * 1600,
        y: 200 + Math.random() * 1500,
      });
    }, 50);
  });

  socket.on('s2c:game_state', (_snap) => {
    const now = Date.now();
    if (stats.firstGameStateAt === 0) {
      stats.firstGameStateAt = now - stats.readyAt;
    }
    if (stats.lastSnapshotAt > 0) {
      const gap = now - stats.lastSnapshotAt;
      if (gap > stats.maxGapMs) stats.maxGapMs = gap;
    }
    stats.lastSnapshotAt = now;
    stats.snapshotsIn++;
  });

  clients.push({ socket, stats });
}

// Stagger connection starts to avoid thrashing the server with 100
// simultaneous TCP handshakes.
let spawned = 0;
const spawnTimer = setInterval(() => {
  if (spawned >= N) { clearInterval(spawnTimer); return; }
  mkClient(spawned++);
}, 20);

// Report + exit after SECS seconds of real measurement
const startAt = Date.now();
setTimeout(() => {
  const elapsedSec = (Date.now() - startAt) / 1000;
  const active = clients.filter((c) => c.stats.snapshotsIn > 0);
  const avgBytesPerSec = active.reduce((s, c) => s + c.stats.bytesIn / elapsedSec, 0) / Math.max(1, active.length);
  const avgSnapsPerSec = active.reduce((s, c) => s + c.stats.snapshotsIn / elapsedSec, 0) / Math.max(1, active.length);
  const ttfs = active.map((c) => c.stats.firstGameStateAt).filter((v) => v > 0);
  const maxGap = Math.max(0, ...active.map((c) => c.stats.maxGapMs));
  const totalBytesDown = active.reduce((s, c) => s + c.stats.bytesIn, 0);

  console.log('\n=== RESULTS =================================================');
  console.log(`clients connected:            ${active.length}/${N}`);
  console.log(`elapsed:                      ${elapsedSec.toFixed(1)}s`);
  console.log(`avg snapshots/sec per client: ${avgSnapsPerSec.toFixed(1)} Hz  (ideal ≈ 20)`);
  console.log(`avg bytes/sec per client:     ${(avgBytesPerSec / 1024).toFixed(1)} KB/s`);
  console.log(`server total outbound:        ${(totalBytesDown / elapsedSec / 1024 / 1024).toFixed(2)} MB/s`);
  console.log(`ready → first snapshot p50:   ${median(ttfs)} ms`);
  console.log(`ready → first snapshot p95:   ${percentile(ttfs, 0.95)} ms`);
  console.log(`worst snapshot gap observed:  ${maxGap} ms  (ideal ≤ 100)`);
  console.log('=============================================================');

  for (const c of clients) {
    clearInterval(c.stats.moveInterval);
    c.socket.close();
  }
  process.exit(0);
}, (SECS + 3) * 1000); // +3s grace for ramp-up

function median(arr) {
  if (!arr.length) return '-';
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
function percentile(arr, p) {
  if (!arr.length) return '-';
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length * p)];
}

process.on('SIGINT', () => {
  console.log('\ninterrupted');
  process.exit(1);
});
