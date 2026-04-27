'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const GameSession = require('./GameSession');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // permessage-deflate: compresses WebSocket frames. ~3–5× bandwidth reduction on
  // snapshot payloads with negligible CPU overhead. Threshold skips tiny messages.
  perMessageDeflate: {
    threshold: 1024, // only compress frames ≥ 1 KB (snapshots qualify, small events don't)
  },
  // Default pingTimeout (20 s) was leaving stale lobby entries behind on
  // page refresh — the old socket lingered until heartbeat finally timed
  // out. Tighter values catch dropped tabs in ~5 s.
  pingTimeout: 5000,
  pingInterval: 2000,
});

app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const session = new GameSession(io);

io.on('connection', (socket) => {
  session.onConnect(socket);

  socket.on('c2s:join',       ()     => session.onJoin(socket));
  socket.on('c2s:ready',      ()     => session.onReady(socket));
  socket.on('c2s:unready',    ()     => session.onUnready(socket));
  socket.on('c2s:solo_start', ()     => session.onSoloStart(socket));
  socket.on('c2s:move',       (data) => session.onMove(socket, data));
  socket.on('c2s:fire_freeze',(data) => session.onFireFreeze(socket, data));
  socket.on('c2s:melee',      (data) => session.onMelee(socket, data));
  socket.on('disconnect',     ()     => session.onDisconnect(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`U vs Q listening on :${PORT}`));
