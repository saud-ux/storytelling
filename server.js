const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------
const TURN_SECONDS = 30;                 // per-player writing time
const MAX_LINE_LEN = 150;                // max chars per sentence
const MIN_NAME_LEN = 2;
const MAX_NAME_LEN = 20;
const SHOW_AUTHORS_DURING_VOTING = false;// hide who wrote each line while voting
const VOTING_SECONDS = 0;                // 0 = host ends voting manually; >0 = countdown
const RECONNECT_GRACE_MS = 20000;        // keep a disconnected player's slot this long
const SFX_ENABLED = true;                // subtle UI sounds only - NO voice/TTS

// Max length for the host's opening sentence (spec is silent - reuse a generous cap)
const MAX_SEED_LEN = 300;

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// App / server setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
/**
 * rooms: roomCode -> room object (see §7 of the spec)
 * Extra runtime-only fields kept on the room object (not sent to clients):
 *   timerInterval, removalTimers, joinUrl, qrDataUrl
 */
const rooms = {};

// socket.id -> { roomCode, isHost, playerId }
const socketMeta = {};

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid ambiguous chars

function makeRoomCode() {
  let code;
  do {
    const len = Math.random() < 0.5 ? 4 : 5;
    code = '';
    for (let i = 0; i < len; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms[code]);
  return code;
}

function makePlayerId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function createRoom(hostSocketId, joinUrl, qrDataUrl, code) {
  const room = {
    code,
    hostSocketId,
    phase: 'lobby', // 'lobby' | 'writing' | 'reveal' | 'voting' | 'results'
    players: {},
    queue: [],
    turnPointer: 0,
    story: [],
    pending: null,
    turnDeadline: 0,
    votes: {},
    results: null,
    paused: false,
    // runtime-only:
    timerInterval: null,
    removalTimers: {},
    joinUrl,
    qrDataUrl
  };
  rooms[code] = room;
  return room;
}

// ---------------------------------------------------------------------------
// Timer helpers
// ---------------------------------------------------------------------------
function clearRoomTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

// Begin (or resume) the writing turn for whoever is currently pointed at.
function startTurn(room) {
  clearRoomTimer(room);
  if (room.queue.length === 0) {
    room.paused = true;
    room.turnDeadline = 0;
    broadcastState(room);
    return;
  }
  room.paused = false;
  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  room.timerInterval = setInterval(() => tickRoom(room.code), 1000);
  broadcastState(room);
}

function advanceTurn(room) {
  room.pending = null;
  if (room.queue.length === 0) {
    room.turnPointer = 0;
    return;
  }
  room.turnPointer = (room.turnPointer + 1) % room.queue.length;
}

function tickRoom(code) {
  const room = rooms[code];
  if (!room) return;

  if (room.phase === 'writing') {
    if (room.paused) return;
    const secondsLeft = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
    io.to(room.code).emit('turn:tick', { secondsLeft });
    if (secondsLeft <= 0) {
      // Timeout -> auto-skip the current player.
      advanceTurn(room);
      startTurn(room);
    }
    return;
  }

  if (room.phase === 'voting' && VOTING_SECONDS > 0) {
    const secondsLeft = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
    io.to(room.code).emit('turn:tick', { secondsLeft });
    if (secondsLeft <= 0) {
      finishVoting(room);
    }
    return;
  }

  // Phase no longer needs ticking.
  clearRoomTimer(room);
}

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------
function authorsRevealed(room) {
  // Authors are hidden only while actively voting (unless the constant says otherwise).
  return !(room.phase === 'voting' && !SHOW_AUTHORS_DURING_VOTING);
}

function publicPlayers(room) {
  return room.queue.map(id => ({
    id,
    name: room.players[id] ? room.players[id].name : '???',
    connected: room.players[id] ? room.players[id].connected : false
  }));
}

function storyForClient(room, viewerPlayerId) {
  const reveal = authorsRevealed(room);
  return room.story.map(line => {
    let authorName = null;
    if (line.authorId) {
      const author = room.players[line.authorId];
      authorName = author ? author.name : 'مجهول';
    }
    return {
      lineNo: line.lineNo,
      text: line.text,
      authorName: reveal ? authorName : null,
      isOwn: viewerPlayerId ? line.authorId === viewerPlayerId : false
    };
  });
}

function baseSnapshot(room) {
  const currentTurnPlayerId =
    room.phase === 'writing' && !room.paused ? room.queue[room.turnPointer] || null : null;

  let secondsLeft = 0;
  if (room.phase === 'writing' && !room.paused) {
    secondsLeft = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
  } else if (room.phase === 'voting' && VOTING_SECONDS > 0) {
    secondsLeft = Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000));
  }

  let voteProgress = null;
  if (room.phase === 'voting') {
    const total = room.queue.filter(id => room.players[id] && room.players[id].connected).length;
    voteProgress = { voted: Object.keys(room.votes).length, total };
  }

  return {
    roomCode: room.code,
    phase: room.phase,
    paused: room.paused,
    players: publicPlayers(room),
    currentTurnPlayerId,
    secondsLeft,
    voteProgress,
    results: room.results,
    config: {
      turnSeconds: TURN_SECONDS,
      maxLineLen: MAX_LINE_LEN,
      maxSeedLen: MAX_SEED_LEN,
      minNameLen: MIN_NAME_LEN,
      maxNameLen: MAX_NAME_LEN,
      sfxEnabled: SFX_ENABLED,
      showAuthorsDuringVoting: SHOW_AUTHORS_DURING_VOTING,
      votingSeconds: VOTING_SECONDS
    }
  };
}

function buildHostState(room) {
  const snap = baseSnapshot(room);
  snap.story = storyForClient(room, null);
  snap.pending = room.pending
    ? {
        authorId: room.pending.authorId,
        authorName: room.players[room.pending.authorId]
          ? room.players[room.pending.authorId].name
          : 'مجهول',
        text: room.pending.text
      }
    : null;
  snap.joinUrl = room.joinUrl;
  snap.qrDataUrl = room.qrDataUrl;
  return snap;
}

function buildPlayerState(room, playerId) {
  const snap = baseSnapshot(room);
  const player = room.players[playerId];
  snap.story = storyForClient(room, playerId);
  snap.you = {
    id: playerId,
    name: player ? player.name : '',
    isYourTurn: snap.currentTurnPlayerId === playerId,
    hasSubmitted: !!(room.pending && room.pending.authorId === playerId),
    hasVoted: Object.prototype.hasOwnProperty.call(room.votes, playerId),
    yourVote: Object.prototype.hasOwnProperty.call(room.votes, playerId) ? room.votes[playerId] : null
  };
  return snap;
}

function broadcastState(room) {
  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('state', buildHostState(room));
  }
  for (const pid of room.queue) {
    const p = room.players[pid];
    if (p && p.connected && p.socketId) {
      io.to(p.socketId).emit('state', buildPlayerState(room, pid));
    }
  }
}

// ---------------------------------------------------------------------------
// Queue / player management
// ---------------------------------------------------------------------------
function removePlayerFromRoom(room, playerId) {
  const idx = room.queue.indexOf(playerId);
  if (idx === -1) return;

  room.queue.splice(idx, 1);
  delete room.players[playerId];
  delete room.votes[playerId];
  if (room.pending && room.pending.authorId === playerId) {
    room.pending = null;
  }
  if (room.removalTimers[playerId]) {
    clearTimeout(room.removalTimers[playerId]);
    delete room.removalTimers[playerId];
  }

  if (room.queue.length === 0) {
    room.turnPointer = 0;
    if (room.phase === 'writing') {
      room.paused = true;
      clearRoomTimer(room);
    }
    return;
  }

  // Keep turnPointer aimed at the same logical player after the splice.
  if (idx < room.turnPointer) {
    room.turnPointer -= 1;
  } else if (idx === room.turnPointer) {
    if (room.turnPointer >= room.queue.length) room.turnPointer = 0;
  }
  if (room.turnPointer >= room.queue.length) room.turnPointer = 0;

  // If writing was paused (queue had emptied) and we now have players again, resume.
  if (room.phase === 'writing' && room.paused) {
    startTurn(room);
  } else if (room.phase === 'writing' && idx === room.turnPointer) {
    // The removed player was up next / current - restart their turn cleanly.
    startTurn(room);
  }
}

function scheduleRemoval(room, playerId) {
  if (room.removalTimers[playerId]) {
    clearTimeout(room.removalTimers[playerId]);
  }
  room.removalTimers[playerId] = setTimeout(() => {
    delete room.removalTimers[playerId];
    const player = room.players[playerId];
    if (player && !player.connected) {
      removePlayerFromRoom(room, playerId);
      broadcastState(room);
    }
  }, RECONNECT_GRACE_MS);
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------
function finishVoting(room) {
  clearRoomTimer(room);
  const tallies = {};
  for (const line of room.story) {
    if (line.lineNo === 0) continue;
    tallies[line.lineNo] = 0;
  }
  for (const voterId of Object.keys(room.votes)) {
    const lineNo = room.votes[voterId];
    if (Object.prototype.hasOwnProperty.call(tallies, lineNo)) {
      tallies[lineNo] += 1;
    }
  }
  let max = -1;
  for (const lineNo of Object.keys(tallies)) {
    if (tallies[lineNo] > max) max = tallies[lineNo];
  }
  const winners = [];
  if (max > 0) {
    for (const lineNo of Object.keys(tallies)) {
      if (tallies[lineNo] === max) winners.push(Number(lineNo));
    }
  }
  room.results = { tallies, winners };
  room.phase = 'results';
  broadcastState(room);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendError(socket, code, text) {
  socket.emit('error:msg', { code, text });
}

function getRoomForSocket(socket) {
  const meta = socketMeta[socket.id];
  if (!meta) return null;
  return rooms[meta.roomCode] || null;
}

function buildJoinUrl(socket, roomCode) {
  const headers = socket.handshake.headers || {};
  const proto = (headers['x-forwarded-proto'] || '').split(',')[0] || (socket.handshake.secure ? 'https' : 'http');
  const host = headers['x-forwarded-host'] || headers.host || `localhost:${PORT}`;
  return `${proto}://${host}/play?room=${roomCode}`;
}

// ---------------------------------------------------------------------------
// Socket.IO wiring
// ---------------------------------------------------------------------------
io.on('connection', socket => {
  // ---- Host events -------------------------------------------------------
  socket.on('host:create', async (_data, callback) => {
    const code = makeRoomCode();
    const joinUrl = buildJoinUrl(socket, code);
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, scale: 6 });
    } catch (err) {
      qrDataUrl = '';
    }
    const room = createRoom(socket.id, joinUrl, qrDataUrl, code);
    socketMeta[socket.id] = { roomCode: code, isHost: true, playerId: null };
    socket.join(code);

    if (typeof callback === 'function') {
      callback({ roomCode: code, qrDataUrl, joinUrl });
    }
    broadcastState(room);
  });

  socket.on('host:reconnect', ({ roomCode } = {}) => {
    const room = rooms[String(roomCode || '').toUpperCase()];
    if (!room) {
      sendError(socket, 'ROOM_NOT_FOUND', 'لم يتم العثور على هذه الجلسة.');
      return;
    }
    room.hostSocketId = socket.id;
    socketMeta[socket.id] = { roomCode: room.code, isHost: true, playerId: null };
    socket.join(room.code);
    broadcastState(room);
  });

  socket.on('host:start', ({ seedSentence } = {}) => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;
    if (room.phase !== 'lobby') {
      sendError(socket, 'BAD_PHASE', 'لا يمكن بدء القصة الآن.');
      return;
    }
    const seed = String(seedSentence || '').trim();
    if (!seed) {
      sendError(socket, 'EMPTY_SEED', 'يرجى كتابة الجملة الافتتاحية للقصة.');
      return;
    }
    if (seed.length > MAX_SEED_LEN) {
      sendError(socket, 'SEED_TOO_LONG', `الجملة الافتتاحية طويلة جداً (الحد الأقصى ${MAX_SEED_LEN} حرفاً).`);
      return;
    }
    if (room.queue.length === 0) {
      sendError(socket, 'NO_PLAYERS', 'لا يوجد لاعبون في الانتظار بعد.');
      return;
    }

    room.story = [{ lineNo: 0, text: seed, authorId: null }];
    room.pending = null;
    room.votes = {};
    room.results = null;
    room.turnPointer = 0;
    room.phase = 'writing';
    startTurn(room);
  });

  socket.on('host:approve', () => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;
    if (room.phase !== 'writing' || !room.pending) return;

    const lineNo = room.story.length;
    room.story.push({ lineNo, text: room.pending.text, authorId: room.pending.authorId });
    advanceTurn(room);
    startTurn(room);
  });

  socket.on('host:skip', () => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;
    if (room.phase !== 'writing') return;

    advanceTurn(room);
    startTurn(room);
  });

  socket.on('host:endStory', () => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;
    if (room.phase !== 'writing') return;

    clearRoomTimer(room);
    room.pending = null;
    room.paused = false;
    room.phase = 'reveal';
    broadcastState(room);
  });

  socket.on('host:startVoting', () => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;
    if (room.phase !== 'reveal') return;

    room.votes = {};
    room.results = null;
    room.phase = 'voting';
    if (VOTING_SECONDS > 0) {
      room.turnDeadline = Date.now() + VOTING_SECONDS * 1000;
      clearRoomTimer(room);
      room.timerInterval = setInterval(() => tickRoom(room.code), 1000);
    }
    broadcastState(room);
  });

  socket.on('host:endVoting', () => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;
    if (room.phase !== 'voting') return;

    finishVoting(room);
  });

  socket.on('host:newStory', () => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;

    clearRoomTimer(room);
    room.story = [];
    room.pending = null;
    room.votes = {};
    room.results = null;
    room.turnPointer = 0;
    room.turnDeadline = 0;
    room.paused = false;
    room.phase = 'lobby';
    broadcastState(room);
  });

  socket.on('host:endSession', () => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;

    clearRoomTimer(room);
    for (const timer of Object.values(room.removalTimers)) clearTimeout(timer);

    // Tell everyone the session is over before tearing the room down.
    io.to(room.code).emit('session:ended');

    for (const pid of Object.keys(room.players)) {
      const p = room.players[pid];
      if (p.socketId) delete socketMeta[p.socketId];
    }
    delete socketMeta[socket.id];
    delete rooms[room.code];
  });

  socket.on('host:removePlayer', ({ playerId } = {}) => {
    const room = getRoomForSocket(socket);
    if (!room || socketMeta[socket.id].isHost !== true) return;
    if (!playerId || !room.players[playerId]) return;

    const target = room.players[playerId];
    if (target.socketId) {
      io.to(target.socketId).emit('session:ended');
      delete socketMeta[target.socketId];
    }
    removePlayerFromRoom(room, playerId);
    broadcastState(room);
  });

  // ---- Player events ------------------------------------------------------
  socket.on('player:join', ({ roomCode, name } = {}) => {
    const code = String(roomCode || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) {
      sendError(socket, 'ROOM_NOT_FOUND', 'رمز الجلسة غير صحيح.');
      return;
    }

    const trimmedName = String(name || '').trim();
    if (trimmedName.length < MIN_NAME_LEN || trimmedName.length > MAX_NAME_LEN) {
      sendError(socket, 'BAD_NAME', `الاسم يجب أن يكون بين ${MIN_NAME_LEN} و ${MAX_NAME_LEN} حرفاً.`);
      return;
    }

    const lower = trimmedName.toLowerCase();
    const taken = Object.values(room.players).some(p => p.name.toLowerCase() === lower);
    if (taken) {
      sendError(socket, 'NAME_TAKEN', 'هذا الاسم مستخدم بالفعل، اختر اسماً آخر.');
      return;
    }

    const playerId = makePlayerId();
    room.players[playerId] = { id: playerId, name: trimmedName, socketId: socket.id, connected: true };
    room.queue.push(playerId);

    socketMeta[socket.id] = { roomCode: room.code, isHost: false, playerId };
    socket.join(room.code);

    socket.emit('player:joined', { playerId, roomCode: room.code, name: trimmedName });

    // Late joiner during writing: if the queue had emptied out, resume play.
    if (room.phase === 'writing' && room.paused) {
      startTurn(room);
    } else {
      broadcastState(room);
    }
  });

  socket.on('player:reconnect', ({ roomCode, playerId } = {}) => {
    const code = String(roomCode || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room || !room.players[playerId]) {
      sendError(socket, 'PLAYER_NOT_FOUND', 'تعذر استعادة جلستك، يرجى الانضمام من جديد.');
      return;
    }

    const player = room.players[playerId];
    player.connected = true;
    player.socketId = socket.id;
    if (room.removalTimers[playerId]) {
      clearTimeout(room.removalTimers[playerId]);
      delete room.removalTimers[playerId];
    }

    socketMeta[socket.id] = { roomCode: room.code, isHost: false, playerId };
    socket.join(room.code);

    socket.emit('player:joined', { playerId, roomCode: room.code, name: player.name });

    if (room.phase === 'writing' && room.paused) {
      startTurn(room);
    } else {
      broadcastState(room);
    }
  });

  socket.on('player:submitLine', ({ text } = {}) => {
    const meta = socketMeta[socket.id];
    const room = getRoomForSocket(socket);
    if (!room || !meta || meta.isHost) return;
    if (room.phase !== 'writing' || room.paused) {
      sendError(socket, 'BAD_PHASE', 'لا يمكن إرسال جملة الآن.');
      return;
    }
    const currentPlayerId = room.queue[room.turnPointer];
    if (currentPlayerId !== meta.playerId) {
      sendError(socket, 'NOT_YOUR_TURN', 'ليس دورك الآن.');
      return;
    }
    if (room.pending) {
      sendError(socket, 'ALREADY_SUBMITTED', 'لقد أرسلت جملتك بالفعل، بانتظار موافقة المضيف.');
      return;
    }
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      sendError(socket, 'EMPTY_LINE', 'لا يمكن إرسال جملة فارغة.');
      return;
    }
    if (trimmed.length > MAX_LINE_LEN) {
      sendError(socket, 'LINE_TOO_LONG', `الجملة طويلة جداً (الحد الأقصى ${MAX_LINE_LEN} حرفاً).`);
      return;
    }

    room.pending = { authorId: meta.playerId, text: trimmed };
    broadcastState(room);
  });

  socket.on('player:vote', ({ lineNo } = {}) => {
    const meta = socketMeta[socket.id];
    const room = getRoomForSocket(socket);
    if (!room || !meta || meta.isHost) return;
    if (room.phase !== 'voting') {
      sendError(socket, 'BAD_PHASE', 'التصويت غير متاح الآن.');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(room.votes, meta.playerId)) {
      sendError(socket, 'ALREADY_VOTED', 'لقد قمت بالتصويت بالفعل.');
      return;
    }
    const line = room.story.find(l => l.lineNo === lineNo);
    if (!line || line.lineNo === 0) {
      sendError(socket, 'BAD_LINE', 'سطر التصويت غير صالح.');
      return;
    }
    if (line.authorId === meta.playerId) {
      sendError(socket, 'SELF_VOTE', 'لا يمكنك التصويت لجملتك الخاصة.');
      return;
    }

    room.votes[meta.playerId] = lineNo;
    broadcastState(room);

    if (VOTING_SECONDS === 0) {
      const total = room.queue.filter(id => room.players[id] && room.players[id].connected).length;
      if (total > 0 && Object.keys(room.votes).length >= total) {
        // Everyone voted - host can still tap "show result" manually, but
        // there's nothing left to wait for, so leave it for the host.
      }
    }
  });

  // ---- Disconnect ----------------------------------------------------------
  socket.on('disconnect', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    delete socketMeta[socket.id];

    const room = rooms[meta.roomCode];
    if (!room) return;

    if (meta.isHost) {
      if (room.hostSocketId === socket.id) room.hostSocketId = null;
      return;
    }

    const player = room.players[meta.playerId];
    if (!player) return;
    player.connected = false;
    player.socketId = null;

    if (room.phase === 'writing' && !room.paused && room.queue[room.turnPointer] === meta.playerId) {
      advanceTurn(room);
      startTurn(room);
    } else {
      broadcastState(room);
    }

    scheduleRemoval(room, meta.playerId);
  });
});

server.listen(PORT, () => {
  console.log(`قصة جماعية server listening on port ${PORT}`);
});
