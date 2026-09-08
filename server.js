// server.js
// Anonymous 1-on-1 DM platform — backend
// Node.js + Express + Socket.io, fully in-memory (no database required).

const geoip = require("geoip-lite");
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// --- Report logging --------------------------------------------------
const LOG_FILE = path.join(__dirname, "reports.log");

function logReport(entry) {
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + "\n", (err) => {
    if (err) console.error("Failed to write report log:", err);
  });
}

// --- In-memory state ----------------------------------------------------
// activeUsers: { [socketId]: { socketId, age, sex, clientId } }
const activeUsers = {};

// persistentIdentities: { [clientId]: { age, sex } }
// Once a clientId has joined once, its age/sex is locked forever (until the
// server restarts), regardless of what the client sends afterward.
const persistentIdentities = {};

// clientIdBySocket: { [socketId]: clientId } — used for cleanup on disconnect.
const clientIdBySocket = {};

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "anon-chat-backend",
    onlineUsers: Object.keys(activeUsers).length,
  });
});

const conversations = {};

const MAX_COLD_MESSAGES = 2;
const messageGates = {};

function gateState(senderId, targetId) {
  if (!messageGates[senderId]) messageGates[senderId] = {};
  if (!messageGates[senderId][targetId]) {
    messageGates[senderId][targetId] = { count: 0, unlocked: false };
  }
  return messageGates[senderId][targetId];
}

function canSend(senderId, targetId) {
  const state = gateState(senderId, targetId);
  return state.unlocked || state.count < MAX_COLD_MESSAGES;
}

function recordSend(senderId, targetId) {
  const state = gateState(senderId, targetId);
  if (!state.unlocked) state.count += 1;
}

function unlockReverseGate(senderId, targetId) {
  const state = gateState(targetId, senderId);
  state.unlocked = true;
}

function remainingColdMessages(senderId, targetId) {
  const state = gateState(senderId, targetId);
  if (state.unlocked) return null;
  return Math.max(0, MAX_COLD_MESSAGES - state.count);
}

function clearGatesFor(socketId) {
  delete messageGates[socketId];
  Object.values(messageGates).forEach((targets) => {
    delete targets[socketId];
  });
}

function addConversationLink(a, b) {
  if (!conversations[a]) conversations[a] = new Set();
  if (!conversations[b]) conversations[b] = new Set();
  conversations[a].add(b);
  conversations[b].add(a);
}

function removeUserEverywhere(socketId) {
  delete activeUsers[socketId];
  delete clientIdBySocket[socketId];

  const partners = conversations[socketId];
  if (partners) {
    partners.forEach((partnerId) => {
      if (conversations[partnerId]) {
        conversations[partnerId].delete(socketId);
      }
      io.to(partnerId).emit("partner_disconnected", { socketId });
    });
  }
  delete conversations[socketId];
  clearGatesFor(socketId);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function publicUserList() {
  return Object.values(activeUsers).map((u) => ({
    socketId: u.socketId,
    age: u.age,
    sex: u.sex,
    country: u.country,
  }));
}

function broadcastUserList() {
  io.emit("update_user_list", publicUserList());
}

io.on("connection", (socket) => {
  socket.on("join", (payload) => {
    const clientId = payload && String(payload.clientId || "").trim();
    if (!clientId) {
      socket.emit("join_error", { message: "Missing client identity. Please reload." });
      return;
    }

    let age;
    let sex;

    const existing = persistentIdentities[clientId];

    if (existing) {
      // Identity already locked for this browser — ignore whatever the
      // client submitted this time and reuse the original values.
      age = existing.age;
      sex = existing.sex;
    } else {
      // First time we see this clientId — validate and lock it in.
      age = Number(payload && payload.age);
      sex = payload && String(payload.sex || "").toLowerCase();

      if (!Number.isInteger(age) || age < 18 || age > 99) {
        socket.emit("join_error", { message: "Age must be between 18 and 99." });
        return;
      }
      if (sex !== "male" && sex !== "female") {
        socket.emit("join_error", { message: "Sex must be 'male' or 'female'." });
        return;
      }

      persistentIdentities[clientId] = { age, sex };
    }

    let country = null;
    try {
      const ip = socket.handshake.address;
      const geo = geoip.lookup(ip);
      if (geo && geo.country) country = geo.country; // e.g. "TN", "US"
    } catch (e) {
      country = null;
    }

    activeUsers[socket.id] = { socketId: socket.id, age, sex, clientId, country };
    clientIdBySocket[socket.id] = clientId;

    socket.emit("joined", { socketId: socket.id, age, sex, country });
    broadcastUserList();
  });

  socket.on("private_message", ({ targetSocketId, text }) => {
    const sender = activeUsers[socket.id];
    if (!sender) return;
    if (!targetSocketId || !activeUsers[targetSocketId]) {
      socket.emit("message_error", { message: "That user is no longer online." });
      return;
    }

    if (!canSend(socket.id, targetSocketId)) {
      socket.emit("message_blocked", {
        targetSocketId,
        message:
          "You've sent enough messages without a reply. Wait for them to respond before sending more.",
      });
      return;
    }

    const clean = escapeHtml(String(text || "")).slice(0, 2000);
    if (!clean.trim()) return;

    addConversationLink(socket.id, targetSocketId);
    recordSend(socket.id, targetSocketId);
    unlockReverseGate(socket.id, targetSocketId);

    const messageId = `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const messagePayload = {
      messageId,
      fromSocketId: socket.id,
      fromAge: sender.age,
      fromSex: sender.sex,
      text: clean,
      timestamp: Date.now(),
    };

    io.to(targetSocketId).emit("private_message", messagePayload);

    socket.emit("private_message_sent", {
      ...messagePayload,
      remaining: remainingColdMessages(socket.id, targetSocketId),
    });
  });

  socket.on("typing", ({ targetSocketId, isTyping }) => {
    if (!targetSocketId || !activeUsers[targetSocketId]) return;
    io.to(targetSocketId).emit("typing", {
      fromSocketId: socket.id,
      isTyping: Boolean(isTyping),
    });
  });

  socket.on("mark_seen", ({ peerSocketId }) => {
    if (!peerSocketId || !activeUsers[peerSocketId]) return;
    io.to(peerSocketId).emit("seen_by", { socketId: socket.id, at: Date.now() });
  });

  // --- report_user: log a reported conversation for safety/legal purposes ---
  socket.on("report_user", ({ targetSocketId, conversation }) => {
    const reporter = activeUsers[socket.id];
    if (!reporter) return;

    const entry = {
      timestamp: new Date().toISOString(),
      reporterSocketId: socket.id,
      reporterIp: socket.handshake.address,
      reportedSocketId: targetSocketId || null,
      reportedIp: targetSocketId && activeUsers[targetSocketId]
        ? io.sockets.sockets.get(targetSocketId)?.handshake.address
        : null,
      conversation: Array.isArray(conversation) ? conversation.slice(-200) : [],
    };

    logReport(entry);
  });

  socket.on("disconnect", () => {
    removeUserEverywhere(socket.id);
    broadcastUserList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Anon chat backend listening on port ${PORT}`);
});







