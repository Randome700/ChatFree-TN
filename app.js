// app.js — Anon client logic
// Handles the intro sequence, entry flow, socket.io connections, filtering,
// typing indicators, read receipts, and the cold-message limit UI.

// ⚠️ Point this at your deployed backend URL once you have one.
const BACKEND_URL = "https://chatfree-tn.onrender.com";

const socket = io(BACKEND_URL, { autoConnect: false });

// ---- Persistent client identity -----------------------------------------
// A permanent per-browser ID, stored in localStorage so it survives
// refreshes. The server uses this to lock age/sex the first time this
// browser joins, and to ignore any different values sent afterward.
function getClientId() {
  let id = localStorage.getItem("anon_client_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem("anon_client_id", id);
  }
  return id;
}

function getSavedIdentity() {
  const raw = localStorage.getItem("anon_identity");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveIdentity(age, sex) {
  localStorage.setItem("anon_identity", JSON.stringify({ age, sex }));
}

const CLIENT_ID = getClientId();

// ---- DOM refs ------------------------------------------------------------
const introOverlay = document.getElementById("intro-overlay");

const entryOverlay = document.getElementById("entry-overlay");
const entryCard = document.getElementById("entry-card");
const entryForm = document.getElementById("entry-form");
const entrySubmit = document.getElementById("entry-submit");
const btnLabel = entrySubmit.querySelector(".btn-label");
const btnSpinner = entrySubmit.querySelector(".btn-spinner");
const entryError = document.getElementById("entry-error");
const inputAge = document.getElementById("input-age");

const dashboard = document.getElementById("dashboard");
const meDetail = document.getElementById("me-detail");
const filterButtons = document.querySelectorAll(".filter-pill");
const userListEl = document.getElementById("user-list");
const onlineCountEl = document.getElementById("online-count");
const emptyStateEl = document.getElementById("empty-state");

const chatWithEl = document.getElementById("chat-with");
const chatStatusEl = document.getElementById("chat-status");
const chatLogEl = document.getElementById("chat-log");
const limitBannerEl = document.getElementById("limit-banner");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const blockBtn = document.getElementById("block-btn");
const reportBtn = document.getElementById("report-btn");

// ---- Local state ----------------------------------------------------------
let me = null;
let onlineUsers = [];
let currentFilter = "all";
let activeConversation = null;
let conversationLogs = {}; // socketId -> [{ id, who, text, time, status }]
let disconnectedPeers = new Set();
let blockedPeers = new Set();
let typingTimers = {}; // socketId -> timeout for "they stopped typing"
let isTypingLocally = false;
let typingDebounce = null;
let remainingBySocket = {}; // socketId -> remaining cold messages (null = unlimited)

// ============================ INTRO SEQUENCE ==============================
window.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    introOverlay.classList.add("is-leaving");
  }, 1500);

  introOverlay.addEventListener("animationend", () => {
    introOverlay.hidden = true;
    entryOverlay.hidden = false;
    entryCard.classList.add("is-entering");
  });

  // If this browser already picked an identity before, lock the form to it
  // so the UI doesn't imply the user can pick something different.
  const saved = getSavedIdentity();
  if (saved) {
    inputAge.value = saved.age;
    inputAge.disabled = true;
    document.querySelectorAll('input[name="sex"]').forEach((radio) => {
      radio.checked = radio.value === saved.sex;
      radio.disabled = true;
    });
  }
});

// ============================ ENTRY FLOW ================================
entryForm.addEventListener("submit", (e) => {
  e.preventDefault();
  entryError.hidden = true;

  const confirmAdult = document.getElementById("confirm-adult");
  if (!confirmAdult.checked) {
    showEntryError("You must confirm you are 18 or older to continue.");
    return;
  }

  const saved = getSavedIdentity();
  const age = saved ? saved.age : Number(inputAge.value);
  const sex = saved ? saved.sex : document.querySelector('input[name="sex"]:checked').value;

  if (!Number.isInteger(age) || age < 18 || age > 99) {
    showEntryError("Please enter an age between 18 and 99.");
    return;
  }

  setConnecting(true);
  socket.connect();
  socket.once("connect", () => {
    socket.emit("join", { age, sex, clientId: CLIENT_ID });
  });
});

function setConnecting(isConnecting) {
  entrySubmit.disabled = isConnecting;
  btnLabel.textContent = isConnecting ? "Connecting" : "Connect";
  btnSpinner.hidden = !isConnecting;
}

function showEntryError(msg) {
  entryError.textContent = msg;
  entryError.hidden = false;
  setConnecting(false);
}

socket.on("join_error", ({ message }) => {
  showEntryError(message || "Something went wrong. Try again.");
});

socket.on("joined", (payload) => {
  me = payload;
  meDetail.textContent = `${capitalize(me.sex)}, ${me.age}`;

  // Lock this browser to whatever the server confirmed (may differ from
  // the form if this browser had already joined before).
  saveIdentity(me.age, me.sex);

  // Card exits, dashboard enters.
  entryCard.classList.add("is-leaving");
  entryCard.addEventListener(
    "animationend",
    () => {
      entryOverlay.hidden = true;
      dashboard.hidden = false;
      dashboard.classList.add("is-entering");
    },
    { once: true }
  );
});

socket.on("connect_error", () => {
  showEntryError("Couldn't reach the server. Please try again shortly.");
});

// ============================ USER DIRECTORY ============================
socket.on("update_user_list", (list) => {
  onlineUsers = list.filter((u) => !me || u.socketId !== me.socketId);
  renderUserList();
});

filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    filterButtons.forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    currentFilter = btn.dataset.filter;
    renderUserList();
  });
});

function initials(sex) {
  return sex === "male" ? "M" : "F";
}

function renderUserList() {
  const filtered = onlineUsers.filter((u) =>
    currentFilter === "all" ? true : u.sex === currentFilter
  );

  onlineCountEl.textContent = onlineUsers.length;
  userListEl.innerHTML = "";

  if (filtered.length === 0) {
    emptyStateEl.style.display = "block";
    return;
  }
  emptyStateEl.style.display = "none";

  filtered.forEach((u) => {
    const li = document.createElement("li");
    li.className = "user-card";
    if (u.socketId === activeConversation) li.classList.add("is-selected");
    li.innerHTML = `
      <span class="uc-avatar">${initials(u.sex)}</span>
      <div>
        <div class="uc-detail">${capitalize(u.sex)}, ${u.age} y/o</div>
        <div class="uc-tag">#${u.socketId.slice(0, 6)}</div>
      </div>
    `;
    li.addEventListener("click", () => selectUser(u.socketId));
    userListEl.appendChild(li);
  });
}

// ============================ CONVERSATION SELECT ========================
function selectUser(socketId) {
  activeConversation = socketId;
  disconnectedPeers.delete(socketId);
  if (!conversationLogs[socketId]) conversationLogs[socketId] = [];

  const user = onlineUsers.find((u) => u.socketId === socketId);
  chatWithEl.textContent = user
    ? `Chatting with ${capitalize(user.sex)}, ${user.age}`
    : "This user has left";

  chatStatusEl.textContent = "";
  chatStatusEl.classList.remove("is-gone", "is-typing");

  messageInput.disabled = false;
  sendBtn.disabled = false;
  messageInput.placeholder = "Type a message…";

  blockBtn.disabled = false;
  reportBtn.disabled = false;
  updateBlockButton();

  renderUserList();
  renderChatLog();
  renderLimitBanner();

  // Tell the server we've now seen everything from this peer.
  socket.emit("mark_seen", { peerSocketId: socketId });
}

// ============================ MESSAGING ==================================
messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener("input", () => {
  if (!activeConversation) return;
  if (!isTypingLocally) {
    isTypingLocally = true;
    socket.emit("typing", { targetSocketId: activeConversation, isTyping: true });
  }
  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => {
    isTypingLocally = false;
    socket.emit("typing", { targetSocketId: activeConversation, isTyping: false });
  }, 1200);
});

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !activeConversation) return;
  if (disconnectedPeers.has(activeConversation)) return;
  if (blockedPeers.has(activeConversation)) return;

  socket.emit("private_message", { targetSocketId: activeConversation, text });
  messageInput.value = "";

  isTypingLocally = false;
  clearTimeout(typingDebounce);
  socket.emit("typing", { targetSocketId: activeConversation, isTyping: false });
}

socket.on("private_message_sent", (payload) => {
  appendToLog(activeConversation, {
    id: payload.messageId,
    who: "me",
    text: payload.text,
    time: payload.timestamp,
    status: "sent",
  });
  remainingBySocket[activeConversation] = payload.remaining;
  renderLimitBanner();
});

socket.on("private_message", (payload) => {
  const from = payload.fromSocketId;
  if (blockedPeers.has(from)) return; // silently drop messages from blocked users
  if (!conversationLogs[from]) conversationLogs[from] = [];

  appendToLog(from, {
    id: payload.messageId,
    who: "them",
    text: payload.text,
    time: payload.timestamp,
    status: "received",
  });

  // Receiving a message from someone unlocks unlimited sending to them.
  remainingBySocket[from] = null;

  if (activeConversation !== from) {
    selectUser(from);
  } else {
    socket.emit("mark_seen", { peerSocketId: from });
  }
});

socket.on("message_error", ({ message }) => {
  appendToLog(activeConversation, { who: "system", text: message, time: Date.now() });
});

socket.on("message_blocked", ({ targetSocketId, message }) => {
  appendToLog(targetSocketId, { who: "system", text: message, time: Date.now() });
  if (targetSocketId === activeConversation) {
    limitBannerEl.textContent = message;
    limitBannerEl.classList.add("is-blocked");
    limitBannerEl.hidden = false;
  }
});

function appendToLog(socketId, entry) {
  if (!conversationLogs[socketId]) conversationLogs[socketId] = [];
  conversationLogs[socketId].push(entry);
  if (socketId === activeConversation) renderChatLog();
}

function renderChatLog() {
  const log = conversationLogs[activeConversation] || [];
  chatLogEl.innerHTML = "";

  if (log.length === 0) {
    const p = document.createElement("p");
    p.className = "chat-placeholder";
    p.textContent = "Say hello — messages appear here in real time.";
    chatLogEl.appendChild(p);
    return;
  }

  log.forEach((entry) => {
    if (entry.who === "system") {
      const row = document.createElement("div");
      row.className = "msg-row system";
      row.innerHTML = `<div class="msg">${entry.text}</div>`;
      chatLogEl.appendChild(row);
      return;
    }

    const row = document.createElement("div");
    row.className = `msg-row ${entry.who === "me" ? "out" : "in"}`;
    row.dataset.messageId = entry.id || "";

    const seenMark =
      entry.who === "me" && entry.status === "seen"
        ? `<span class="seen-check">✓ Seen</span>`
        : entry.who === "me"
        ? `<span>Sent</span>`
        : "";

    row.innerHTML = `
      <div class="msg">${entry.text}</div>
      <div class="msg-meta">
        <span>${formatTime(entry.time)}</span>
        ${seenMark}
      </div>
    `;
    chatLogEl.appendChild(row);
  });

  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// ============================ READ RECEIPTS ==============================
socket.on("seen_by", ({ socketId }) => {
  const log = conversationLogs[socketId];
  if (!log) return;
  let changed = false;
  log.forEach((entry) => {
    if (entry.who === "me" && entry.status !== "seen") {
      entry.status = "seen";
      changed = true;
    }
  });
  if (changed && socketId === activeConversation) renderChatLog();
});

// ============================ TYPING INDICATOR ============================
socket.on("typing", ({ fromSocketId, isTyping }) => {
  if (fromSocketId !== activeConversation) return;

  if (isTyping) {
    chatStatusEl.textContent = "typing…";
    chatStatusEl.classList.add("is-typing");
  } else {
    chatStatusEl.textContent = "";
    chatStatusEl.classList.remove("is-typing");
  }
});

// ============================ COLD-MESSAGE LIMIT UI ========================
function renderLimitBanner() {
  limitBannerEl.classList.remove("is-blocked");
  const remaining = remainingBySocket[activeConversation];

  if (remaining === undefined || remaining === null) {
    limitBannerEl.hidden = true;
    return;
  }
  if (remaining <= 0) {
    limitBannerEl.textContent =
      "You've used your free messages. Wait for a reply before sending more.";
    limitBannerEl.classList.add("is-blocked");
    limitBannerEl.hidden = false;
  } else {
    limitBannerEl.textContent = `${remaining} message${remaining === 1 ? "" : "s"} left until they reply.`;
    limitBannerEl.hidden = false;
  }
}

// ============================ DISCONNECTS ================================
socket.on("partner_disconnected", ({ socketId }) => {
  disconnectedPeers.add(socketId);
  appendToLog(socketId, {
    who: "system",
    text: "This user has disconnected.",
    time: Date.now(),
  });

  if (activeConversation === socketId) {
    chatStatusEl.textContent = "Offline — this user has left";
    chatStatusEl.classList.remove("is-typing");
    chatStatusEl.classList.add("is-gone");
    messageInput.disabled = true;
    sendBtn.disabled = true;
    messageInput.placeholder = "This user has disconnected";
    limitBannerEl.hidden = true;
  }
});

socket.on("disconnect", () => {
  chatStatusEl.textContent = "Connection lost. Refresh to rejoin.";
  chatStatusEl.classList.add("is-gone");
  messageInput.disabled = true;
  sendBtn.disabled = true;
});

// ============================ BLOCK / REPORT ==============================
function updateBlockButton() {
  if (!activeConversation) return;
  const isBlocked = blockedPeers.has(activeConversation);
  blockBtn.textContent = isBlocked ? "Unblock" : "Block";
  blockBtn.classList.toggle("chat-action-btn--danger", isBlocked);
}

blockBtn.addEventListener("click", () => {
  if (!activeConversation) return;
  if (blockedPeers.has(activeConversation)) {
    blockedPeers.delete(activeConversation);
  } else {
    blockedPeers.add(activeConversation);
    appendToLog(activeConversation, {
      who: "system",
      text: "You have blocked this user. You will no longer see messages from them.",
      time: Date.now(),
    });
  }
  updateBlockButton();
});

reportBtn.addEventListener("click", () => {
  if (!activeConversation) return;
  const log = conversationLogs[activeConversation] || [];
  socket.emit("report_user", {
    targetSocketId: activeConversation,
    conversation: log.map((m) => ({ who: m.who, text: m.text, time: m.time })),
  });
  appendToLog(activeConversation, {
    who: "system",
    text: "Report sent. Thank you — our team will review this conversation.",
    time: Date.now(),
  });
});

// ============================ HELPERS =====================================
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}








