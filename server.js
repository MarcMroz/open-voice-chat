const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling', 'websocket']
});
const { ExpressPeerServer } = require('peer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ALLOWED_REACTION_AGES = ['base', 'adult'];
const REQUESTED_DEFAULT_REACTION_AGE = String(process.env.REACTIONS_AGE || 'base').toLowerCase();
const DEFAULT_REACTION_AGE = ALLOWED_REACTION_AGES.includes(REQUESTED_DEFAULT_REACTION_AGE) ? REQUESTED_DEFAULT_REACTION_AGE : 'base';
const PBKDF2_MIN_ITERATIONS = 600000;
const PBKDF2_KEY_LENGTH = 32;
const ROOM_AUTH_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;

function getPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Global State
const roomUsers = {};           // { roomId: { peerId: "Nickname" } }
const roomAvatarStyles = {};    // { roomId: { peerId: { set, bg } } }
const roomScreenShares = {};    // { roomId: peerId } -- Single Sharer Tracker
const roomVotes = {};           // { roomId: { targetId, targetName, yes, no, voters: Set(), timer, active: bool } }
const roomCooldowns = {};       // { roomId: timestamp }
const bannedIPs = {};           // { ip: expireTimestamp }
const roomAuthFailures = {};    // { roomId: { ip: { count, blockedUntil } } }
const socketMap = {};           // { socketId: { roomId, peerId } } -- Critical for Ghost User Fix
const VALID_AVATAR_SETS = ['set1', 'set2', 'set3', 'set4', 'set5'];
const VALID_AVATAR_BGS = ['none', 'bg1', 'bg2'];
const ROOM_PASSWORD_MAX_ATTEMPTS = getPositiveIntEnv('ROOM_PASSWORD_MAX_ATTEMPTS', 5);
const ROOM_PASSWORD_BLOCK_MINUTES = getPositiveIntEnv('ROOM_PASSWORD_BLOCK_MINUTES', 5);

// Helper: Robust IP Detection
function getClientIP(socket) {
  try {
    const headers = socket.handshake.headers || {};
    let ip = headers['cf-connecting-ip'] || headers['x-forwarded-for'] || socket.handshake.address;

    // Handle x-forwarded-for list
    if (ip && ip.includes(',')) {
      ip = ip.split(',')[0].trim();
    }

    // Handle IPv6 localhost
    if (ip === '::1') return '127.0.0.1';

    // Handle IPv4 mapped IPv6 (e.g., ::ffff:192.168.1.1)
    if (ip && ip.startsWith('::ffff:')) {
      ip = ip.substr(7);
    }

    return ip || '0.0.0.0';
  } catch (e) {
    console.error("Failed to detect IP:", e);
    return '0.0.0.0';
  }
}

function safeStringCompare(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyRoomPassword(room, providedPassword) {
  if (!room.password && !room.passwordHash) return true;
  if (room.passwordHash) {
    const hashParts = String(room.passwordHash).split('$');
    if (hashParts.length !== 4) return false;
    const [algorithm, iterationsRaw, saltHex, expectedHashHex] = hashParts;
    if (algorithm !== 'pbkdf2' || !iterationsRaw || !saltHex || !expectedHashHex) return false;
    const iterations = Number(iterationsRaw);
    if (!Number.isInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS) return false;
    if (!/^[a-f0-9]+$/i.test(saltHex) || !/^[a-f0-9]+$/i.test(expectedHashHex)) return false;

    const expectedHash = Buffer.from(expectedHashHex, 'hex');
    if (expectedHash.length !== PBKDF2_KEY_LENGTH) return false;
    const computedHash = crypto.pbkdf2Sync(String(providedPassword || ''), Buffer.from(saltHex, 'hex'), iterations, PBKDF2_KEY_LENGTH, 'sha256');
    return crypto.timingSafeEqual(expectedHash, computedHash);
  }
  return safeStringCompare(room.password, providedPassword);
}

// Load Rooms Config
let rooms = [];
function loadRooms() {
  const roomsFromEnv = process.env.ROOMS_JSON;
  if (roomsFromEnv) {
    try {
      rooms = JSON.parse(roomsFromEnv);
      console.log("Loaded Rooms from ROOMS_JSON:", rooms.map(r => r.name));
      return;
    } catch (err) {
      console.error("Error parsing ROOMS_JSON:", err);
    }
  }

  try {
    const data = fs.readFileSync(path.join(__dirname, 'config/rooms.json'), 'utf8');
    rooms = JSON.parse(data);
    console.log("Loaded Rooms:", rooms.map(r => r.name));
  } catch (err) {
    console.error("Error loading rooms.json:", err);
    rooms = [{ id: 'lobby', name: 'Lobby (Yedek)', password: null }];
  }
}
loadRooms();

// Middleware
app.use(express.static('public'));
app.use(express.json());

// PeerJS Server
const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/',
  allow_discovery: true
});

app.use('/peerjs', peerServer);

// API: Get Rooms
app.get('/rooms', (req, res) => {
  loadRooms();
  const sanitizedRooms = rooms.map(r => ({
    id: r.id,
    name: r.name,
    isLocked: !!r.password
  }));
  res.json(sanitizedRooms);
});

function getReactionFilesFromDir(baseDir, relativeDir) {
  const dirPath = path.join(baseDir, relativeDir);
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter(file => file.endsWith('.mp3'))
    .map(file => ({ file, relativeDir }));
}

function getSupportedReactionLanguages(reactionsPath) {
  if (!fs.existsSync(reactionsPath)) return [];
  return fs.readdirSync(reactionsPath).filter(dirName => {
    const fullPath = path.join(reactionsPath, dirName);
    return dirName !== 'base' && fs.statSync(fullPath).isDirectory();
  });
}

// API: Get Reactions
function getReactions(req, res) {
  try {
    const reactionsPath = path.join(__dirname, 'public/reactions');
    const rawLanguage = String(req.query.lang || '').toLowerCase();
    const requestedLanguage = rawLanguage ? rawLanguage.split('-')[0] : '';
    const supportedLanguages = getSupportedReactionLanguages(reactionsPath);
    const language = supportedLanguages.includes(requestedLanguage) ? requestedLanguage : 'en';
    const requestedAge = String(req.query.age || DEFAULT_REACTION_AGE).toLowerCase();
    const age = ALLOWED_REACTION_AGES.includes(requestedAge) ? requestedAge : 'base';

    const files = [
      ...getReactionFilesFromDir(reactionsPath, 'base'),
      ...getReactionFilesFromDir(reactionsPath, `${language}/base`),
      ...(age === 'adult' ? getReactionFilesFromDir(reactionsPath, `${language}/adult`) : [])
    ];
    
    const reactions = files
      .map(({ file, relativeDir }) => {
        // Convert filename to display name
        // "ya-sabir.mp3" -> "Ya Sabir"
        const nameWithoutExt = file.replace('.mp3', '');
        const displayName = nameWithoutExt
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
        
        return {
          id: `${relativeDir}/${file}`,
          name: displayName,
          url: `/reactions/${relativeDir}/${file}`
        };
      });
    
    res.json(reactions);
  } catch (err) {
    console.error('Error loading reactions:', err);
    res.json([]);
  }
}

app.get('/api/reactions', getReactions);
app.get('/api/tepkiler', getReactions);

app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Socket.io Logic
io.on('connection', socket => {

  // 1. IP Detection & Debug Log
  const ip = getClientIP(socket);
  console.log(`New Connection: Socket ID ${socket.id} - IP: ${ip}`);

  // 2. Ban Check (Immediate)
  if (bannedIPs[ip] && Date.now() < bannedIPs[ip]) {
    const timeLeft = Math.ceil((bannedIPs[ip] - Date.now()) / 60000);
    console.log(`Blocked Banned Connection from: ${ip}`);

    // Emit error then disconnect
    socket.emit('error', `Bu odadan uzaklaştırıldınız. ${timeLeft} dakika sonra tekrar deneyin.`);
    setTimeout(() => socket.disconnect(true), 1000); // Give 1s to receive message
    return;
  }

  socket.on('join-room', ({ roomId, peerId, nickname, password, avatarStyle }) => {

    // Double Check Ban (Just in case)
    if (bannedIPs[ip] && Date.now() < bannedIPs[ip]) {
      socket.disconnect(true);
      return;
    }

    const room = rooms.find(r => r.id === roomId);

    if (!room) {
      socket.emit('error', 'Oda bulunamadı');
      return;
    }
    const roomFailures = roomAuthFailures[roomId] || (roomAuthFailures[roomId] = {});
    const now = Date.now();
    Object.keys(roomFailures).forEach((failureIp) => {
      const state = roomFailures[failureIp];
      if (state && (now - state.lastAttempt > ROOM_AUTH_FAILURE_RETENTION_MS) && now >= state.blockedUntil) {
        delete roomFailures[failureIp];
      }
    });
    const authState = roomFailures[ip] || (roomFailures[ip] = { count: 0, blockedUntil: 0, lastAttempt: now });
    authState.lastAttempt = now;

    if (now < authState.blockedUntil) {
      socket.emit('error', 'Çok fazla hatalı şifre denemesi. Lütfen daha sonra tekrar deneyin.');
      return;
    }

    if (!verifyRoomPassword(room, password)) {
      authState.count += 1;
      if (authState.count >= ROOM_PASSWORD_MAX_ATTEMPTS) {
        authState.blockedUntil = now + (ROOM_PASSWORD_BLOCK_MINUTES * 60 * 1000);
        authState.count = 0;
      }
      socket.emit('error', 'INVALID_PASSWORD');
      return;
    }
    authState.count = 0;
    authState.blockedUntil = 0;

    console.log(`[Socket] User ${nickname} joining ${roomId}`);
    socket.join(roomId);
    socket.peerId = peerId; // STORE PEER ID ON SOCKET FOR BAN LOGIC

    // TRACK SOCKET
    socketMap[socket.id] = { roomId, peerId };

    // Track User
    if (!roomUsers[roomId]) roomUsers[roomId] = {};

    // --- UNIQUE NAME LOGIC ---
    let safeName = nickname;
    const existingNames = Object.values(roomUsers[roomId]);
    while (existingNames.includes(safeName)) {
      safeName = `${nickname}_${Math.floor(Math.random() * 1000)}`;
    }
    // Update the local variable so chat uses the new name
    nickname = safeName;

    roomUsers[roomId][peerId] = safeName;

    // Track avatar style
    if (!roomAvatarStyles[roomId]) roomAvatarStyles[roomId] = {};
    const safeAvatarStyle = {
      set: (avatarStyle && VALID_AVATAR_SETS.includes(avatarStyle.set)) ? avatarStyle.set : 'set1',
      bg: (avatarStyle && VALID_AVATAR_BGS.includes(avatarStyle.bg)) ? avatarStyle.bg : 'bg1'
    };
    roomAvatarStyles[roomId][peerId] = safeAvatarStyle;

    // Send existing users to new joiner
    socket.emit('existing-users', roomUsers[roomId]);
    socket.emit('existing-users-avatars', roomAvatarStyles[roomId]);

    // Broadcast to others
    socket.to(roomId).emit('user-connected', peerId, safeName, safeAvatarStyle);

    // Confirm join (Send back cleaned name)
    socket.emit('joined-room', { roomId, nickname: safeName });

    // If someone is already sharing, tell the new user
    if (roomScreenShares[roomId]) {
      socket.emit('share-started', roomScreenShares[roomId]);
    }

    // Chat Handler
    socket.on('chat-message', (msg) => {
      const cleanMsg = String(msg).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      io.to(roomId).emit('chat-message', {
        user: nickname,
        text: cleanMsg,
        time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now()
      });
    });

    // Reaction Handler
    socket.on('play-reaction', (reactionUrl) => {
      // Broadcast to everyone in the room including sender
      io.to(roomId).emit('reaction-played', {
        user: nickname,
        url: reactionUrl,
        time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
      });
    });

    socket.on('rename-user', (nextNickname) => {
      if (!roomUsers[roomId]) return;
      const requestedName = String(nextNickname || '').trim();
      if (!requestedName) return;

      let safeNewName = requestedName;
      let suffix = 1;
      const existingNames = new Set(Object.entries(roomUsers[roomId])
        .filter(([id]) => id !== peerId)
        .map(([, name]) => name));
      while (existingNames.has(safeNewName)) {
        safeNewName = `${requestedName}_${suffix++}`;
      }

      nickname = safeNewName;
      roomUsers[roomId][peerId] = safeNewName;
      io.to(roomId).emit('user-renamed', peerId, safeNewName);
    });

    socket.on('avatar-changed', (style) => {
      if (!roomAvatarStyles[roomId]) return;
      if (!style || !VALID_AVATAR_SETS.includes(style.set) || !VALID_AVATAR_BGS.includes(style.bg)) return;
      roomAvatarStyles[roomId][peerId] = { set: style.set, bg: style.bg };
      io.to(roomId).emit('user-avatar-changed', peerId, { set: style.set, bg: style.bg });
    });

    // --- Screen Share Lock Logic ---
    socket.on('request-share', () => {
      const currentSharer = roomScreenShares[roomId];
      if (currentSharer && currentSharer !== peerId) {
        // Someone else is sharing
        socket.emit('share-denied');
      } else {
        // Available or already me
        roomScreenShares[roomId] = peerId;
        socket.emit('share-approved');
        io.to(roomId).emit('share-started', peerId);
      }
    });

    socket.on('stop-share', () => {
      if (roomScreenShares[roomId] === peerId) {
        delete roomScreenShares[roomId];
        io.to(roomId).emit('share-ended');
      }
    });

    // --- Vote Kick Logic V2 ---
    socket.on('start-vote', (targetId) => {
      // Validation
      if (roomCooldowns[roomId] && Date.now() < roomCooldowns[roomId]) {
        const timeLeft = Math.ceil((roomCooldowns[roomId] - Date.now()) / 1000);
        return socket.emit('error', `Oylama için ${timeLeft}sn beklemelisiniz.`);
      }
      if (roomVotes[roomId] && roomVotes[roomId].active) {
        return socket.emit('error', 'Şu an devam eden bir oylama var.');
      }

      const targetName = roomUsers[roomId][targetId] || "Kullanıcı";

      // Init Vote (Target Auto-No)
      roomVotes[roomId] = {
        targetId,
        targetName,
        yes: 0,
        no: 1, // Target votes NO automatically
        voters: new Set(),
        active: true
      };

      io.to(roomId).emit('vote-started', { targetName, targetId, yes: 0, no: 1 });

      // Vote Timer (30s)
      setTimeout(() => {
        endVote(roomId);
      }, 30000);
    });

    socket.on('submit-vote', (vote) => { // vote: true (yes) or false (no)
      const currentVote = roomVotes[roomId];
      if (!currentVote || !currentVote.active) return;

      // Target cannot vote manually (already counted as NO)
      if (peerId === currentVote.targetId) return;

      if (currentVote.voters.has(peerId)) return; // Already voted

      currentVote.voters.add(peerId);
      if (vote) currentVote.yes++;
      else currentVote.no++;
      io.to(roomId).emit('vote-updated', { targetId: currentVote.targetId, yes: currentVote.yes, no: currentVote.no });
    });

    socket.on('disconnect', () => {
      const info = socketMap[socket.id];
      if (info) {
        const { roomId, peerId } = info;

        // Cleanup User
        if (roomUsers[roomId]) delete roomUsers[roomId][peerId];
        if (roomAvatarStyles[roomId]) delete roomAvatarStyles[roomId][peerId];

        // Check Screen Share
        if (roomScreenShares[roomId] === peerId) {
          delete roomScreenShares[roomId];
          io.to(roomId).emit('share-ended');
        }

        // Notify others
        socket.to(roomId).emit('user-disconnected', peerId);

        // Cleanup Map
        delete socketMap[socket.id];
      }
    });
  });
});

function endVote(roomId) {
  const v = roomVotes[roomId];
  if (!v || !v.active) return;

  v.active = false;
  roomCooldowns[roomId] = Date.now() + 60000; // 1 min cooldown

  console.log(`Vote Result for Room ${roomId}: Yes:${v.yes} No:${v.no}`);

  // Notify Frontend to close modals
  io.to(roomId).emit('vote-ended', {});

  // Rule: Yes > No
  if (v.yes > v.no) {
    io.to(roomId).emit('chat-message', {
      user: "Sistem",
      text: `⚠️ **${v.targetName}** oy çoğunluğu ile uzaklaştırıldı.`,
      time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    });

    io.to(roomId).emit('kick-user', v.targetId);

    // --- BAN LOGIC IMPLEMENTATION ---

    // Find Target Socket to get IP
    // We know v.targetId is the PeerID.
    // But SocketIO doesn't map PeerID -> Socket natively.
    // We need to find the socket that joined with this PeerID in this room.
    // Since we didn't store PeerID -> SocketID, we have to iterate sockets.
    // Efficient enough for small rooms.

    io.sockets.sockets.forEach((s) => {
      // We need to know if 's' is the target.
      // But we didn't store peerID on the socket object explicitly in 'roomUsers' map logic above.
      // Oh, wait, we don't attach peerId to socket in join-room.
      // Let's rely on roomUsers state or just iterate.

      // Actually, we can't easily identify the socket unless we tagged it.
      // BUT, we can't modify 'io.on' logic inside 'endVote'.
      // FIX: We need to modify 'join-room' to attach peerId to the socket object.
      // Checking above... 'join-room' has 'peerId'. 
      // We can add `socket.peerId = peerId` in `join-room`.
    });

    // RE-CHECKING `join-room` above... I didn't add `socket.peerId = peerId`.
    // I will fix this NOW by adding it to the `join-room` handler in the code I am generating.
    // See below.

    const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.peerId === v.targetId);

    if (targetSocket) {
      const targetIP = getClientIP(targetSocket);
      bannedIPs[targetIP] = Date.now() + (5 * 60 * 1000); // 5 min
      console.log(`Banning IP: ${targetIP} for User: ${v.targetName}`);

      // Disconnect them immediately (kick-user event is polite, this is force)
      targetSocket.emit('error', 'Oylama sonucu odadan atıldınız.');
      setTimeout(() => targetSocket.disconnect(true), 200);
    } else {
      console.log("Could not find target socket to ban IP. User might have disconnected already.");
    }

  } else {
    io.to(roomId).emit('chat-message', {
      user: "Sistem",
      text: `ℹ️ Oylama başarısız. ${v.targetName} kalıyor. (Evet: ${v.yes}, Hayır: ${v.no})`,
      time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    });
  }

  delete roomVotes[roomId];
}

// BIND to 0.0.0.0 for Docker
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// IMPORTANT: Updated join-room to store peerId on socket for finding it later!
// Find the io.on block above and see the tweak.
