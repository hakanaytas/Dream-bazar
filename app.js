import {
  ensureSignedIn, auth,
  createRoom, joinRoomByCode, quickJoin, leaveRoom, setReady, setPlayerHostFlag, updateRoomSettings,
  listenRoom, listenPlayers, listenMarket, listenTrades, listenChat, listenReveal,
  sendChat, proposeTrade, cancelTrade,
  callRequestStart, callAdvanceRound, callBuyItem, callRespondTrade, callRematch,
  getDocs, doc, db,
} from "./firebase.js";
import { collection } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ==========================================================================
   Durum
   ========================================================================== */
const AVATARS = ["🧙", "🦊", "🐺", "🦉", "🐍", "🦂", "🐫", "🦁", "🐉", "🕷️", "🦅", "🐐"];
const QUICK_MESSAGES = [
  "Bu paha biçilmez! 💎", "Sana özel fiyat 😉", "Anlaştık mı? 🤝", "Düşünüyorum… 🤔",
  "Hadi takas edelim 🔄", "Bu bir blöf değil! 😄", "Son fiyatım bu 🪙", "Vazgeçtim ❌",
];
const RARITY_LABEL = { common: "Sıradan", uncommon: "Nadide", rare: "Ender", epic: "Efsanevi", legendary: "Menkıbevi" };

const state = {
  me: { uid: null, name: "", avatar: "🧙" },
  roomId: null,
  room: null,
  players: [],
  market: [],
  trades: [],
  chatUnread: 0,
  unsubs: [],
  activeTab: "market",
  countdownTimer: null,
  roundTimer: null,
};

/* ==========================================================================
   Küçük yardımcılar
   ========================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function show(screenName) {
  $$(".screen").forEach((s) => s.classList.toggle("active", s.dataset.screen === screenName));
}

function toast(message, type = "info") {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function friendlyError(err) {
  const msg = err && err.message ? err.message.replace(/^Firebase:\s*/i, "").replace(/\(.*\)\.?$/, "").trim() : "Bir şeyler ters gitti.";
  return msg || "Bir şeyler ters gitti.";
}

/* ==========================================================================
   Ses efektleri (Web Audio — dış dosya gerektirmez)
   ========================================================================== */
let actx = null;
function audioCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === "suspended") actx.resume();
  return actx;
}
function tone(freq, start, dur, { type = "sine", gain = 0.15 } = {}) {
  const ctx = audioCtx();
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, ctx.currentTime + start);
  amp.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}
const sfx = {
  tap: () => tone(720, 0, 0.08, { type: "triangle", gain: 0.08 }),
  coin: () => { tone(880, 0, 0.12, { gain: 0.12 }); tone(1320, 0.06, 0.18, { gain: 0.1 }); },
  notify: () => tone(660, 0, 0.15, { type: "sine", gain: 0.1 }),
  crack: () => { tone(220, 0, 0.05, { type: "square", gain: 0.06 }); tone(90, 0.03, 0.12, { type: "sawtooth", gain: 0.08 }); },
  success: () => { tone(523, 0, 0.1, { gain: 0.1 }); tone(659, 0.08, 0.1, { gain: 0.1 }); tone(784, 0.16, 0.2, { gain: 0.12 }); },
  round: () => { tone(392, 0, 0.12, { gain: 0.1 }); tone(523, 0.1, 0.18, { gain: 0.12 }); },
};

/* ==========================================================================
   Kalıcı tercihler (isim / avatar / oda)
   ========================================================================== */
const STORAGE_KEY = "dream-bazaar/profile";
const ROOM_KEY = "dream-bazaar/room";

function loadProfile() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
}
function saveProfile(p) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }
function saveLastRoom(roomId) { localStorage.setItem(ROOM_KEY, roomId || ""); }
function loadLastRoom() { return localStorage.getItem(ROOM_KEY) || null; }

/* ==========================================================================
   Başlangıç
   ========================================================================== */
async function boot() {
  buildAvatarGrid();
  bindStaticEvents();
  registerServiceWorker();

  try {
    const user = await ensureSignedIn();
    state.me.uid = user.uid;
  } catch (e) {
    toast("Bağlantı kurulamadı: " + friendlyError(e), "error");
  }

  const profile = loadProfile();
  if (profile && profile.name) {
    state.me.name = profile.name;
    state.me.avatar = profile.avatar || "🧙";
    renderHomeChip();
    const lastRoom = loadLastRoom();
    if (lastRoom) {
      const reconnected = await tryReconnect(lastRoom);
      if (!reconnected) show("home");
    } else {
      show("home");
    }
  } else {
    show("auth");
  }
}

async function tryReconnect(roomId) {
  try {
    const roomSnap = await getDocs(collection(db, "rooms", roomId, "players"));
    const mine = roomSnap.docs.find((d) => d.id === state.me.uid);
    if (!mine) return false;
    await enterRoom(roomId);
    toast("Kaldığın yere geri döndün.");
    return true;
  } catch {
    return false;
  }
}

/* ==========================================================================
   Statik UI olayları
   ========================================================================== */
function buildAvatarGrid() {
  const grid = $("#avatar-grid");
  grid.innerHTML = "";
  AVATARS.forEach((a, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-opt" + (i === 0 ? " selected" : "");
    btn.textContent = a;
    btn.dataset.avatar = a;
    btn.addEventListener("click", () => {
      $$(".avatar-opt", grid).forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.me.avatar = a;
      validateAuthForm();
    });
    grid.appendChild(btn);
  });
  state.me.avatar = AVATARS[0];
}

function validateAuthForm() {
  const name = $("#input-name").value.trim();
  $("#btn-enter-bazaar").disabled = name.length < 2;
}

function renderHomeChip() {
  $("#home-player-chip").innerHTML =
    `<span class="chip-avatar">${state.me.avatar}</span><span>${escapeHtml(state.me.name)}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function bindStaticEvents() {
  $("#input-name").addEventListener("input", validateAuthForm);

  $("#btn-enter-bazaar").addEventListener("click", () => {
    audioCtx(); // kullanıcı jesti ile ses bağlamını aç
    const name = $("#input-name").value.trim();
    if (name.length < 2) return;
    state.me.name = name.slice(0, 16);
    saveProfile({ name: state.me.name, avatar: state.me.avatar });
    renderHomeChip();
    sfx.tap();
    show("home");
  });

  $$("[data-nav]").forEach((el) => el.addEventListener("click", () => show(el.dataset.nav)));

  $("#btn-quick-join").addEventListener("click", async () => {
    sfx.tap();
    try {
      const roomId = await quickJoin({ name: state.me.name, avatar: state.me.avatar });
      await enterRoom(roomId);
    } catch (e) { toast(friendlyError(e), "error"); }
  });

  $("#btn-create-room").addEventListener("click", () => show("create"));
  $("#btn-join-code").addEventListener("click", () => show("join"));

  let selectedSize = 4;
  $$(".size-option", $("#max-players-grid")).forEach((btn) => {
    if (Number(btn.dataset.size) === selectedSize) btn.classList.add("selected");
    btn.addEventListener("click", () => {
      $$(".size-option", $("#max-players-grid")).forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedSize = Number(btn.dataset.size);
    });
  });
  $("#btn-confirm-create").addEventListener("click", async () => {
    try {
      const roomId = await createRoom({ name: state.me.name, avatar: state.me.avatar, maxPlayers: selectedSize });
      await enterRoom(roomId);
    } catch (e) { toast(friendlyError(e), "error"); }
  });

  $("#input-code").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  $("#btn-confirm-join").addEventListener("click", async () => {
    const code = $("#input-code").value.trim();
    $("#join-error").hidden = true;
    if (code.length < 4) { $("#join-error").textContent = "Lütfen geçerli bir kod gir."; $("#join-error").hidden = false; return; }
    try {
      const roomId = await joinRoomByCode(code, { name: state.me.name, avatar: state.me.avatar });
      await enterRoom(roomId);
    } catch (e) {
      $("#join-error").textContent = friendlyError(e);
      $("#join-error").hidden = false;
    }
  });

  $("#btn-leave-lobby").addEventListener("click", handleLeaveRoom);

  $("#room-code-display").addEventListener("click", () => {
    navigator.clipboard?.writeText(state.roomId).then(() => toast("Kod kopyalandı."));
  });

  $("#btn-ready").addEventListener("click", async () => {
    const me = state.players.find((p) => p.id === state.me.uid);
    await setReady(state.roomId, !(me && me.ready));
    sfx.tap();
  });

  $("#btn-quickstart").addEventListener("click", async () => {
    try { await callRequestStart({ roomId: state.roomId }); } catch (e) { toast(friendlyError(e), "error"); }
  });

  $("#lobby-chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitChat($("#lobby-chat-input"));
  });

  $$(".game-tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));

  $("#btn-open-chat").addEventListener("click", () => {
    $("#chat-drawer").classList.add("open");
    state.chatUnread = 0;
    $("#chat-badge").hidden = true;
  });
  $("#btn-close-chat").addEventListener("click", () => $("#chat-drawer").classList.remove("open"));
  $("#game-chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitChat($("#game-chat-input"));
  });
  buildQuickMessages();

  $("#btn-see-results").addEventListener("click", () => show("results"));

  $("#btn-rematch").addEventListener("click", async () => {
    try {
      await callRematch({ roomId: state.roomId });
      show("lobby");
    } catch (e) { toast(friendlyError(e), "error"); }
  });
  $("#btn-new-room").addEventListener("click", async () => {
    await handleLeaveRoom(true);
    show("create");
  });
  $("#btn-leave-results").addEventListener("click", () => handleLeaveRoom());
}

function buildQuickMessages() {
  const wrap = $("#quick-msgs");
  wrap.innerHTML = "";
  QUICK_MESSAGES.forEach((msg) => {
    const b = document.createElement("button");
    b.className = "quick-msg-btn";
    b.type = "button";
    b.textContent = msg;
    b.addEventListener("click", () => sendChat(state.roomId, { name: state.me.name, avatar: state.me.avatar, text: msg, type: "quick" }));
    wrap.appendChild(b);
  });
}

function submitChat(inputEl) {
  const text = inputEl.value.trim();
  if (!text) return;
  sendChat(state.roomId, { name: state.me.name, avatar: state.me.avatar, text });
  inputEl.value = "";
}

function switchTab(tabName) {
  state.activeTab = tabName;
  $$(".game-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
  $$(".game-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === tabName));
}

/* ==========================================================================
   Oda / lobi akışı
   ========================================================================== */
async function enterRoom(roomId) {
  clearRoomListeners();
  state.roomId = roomId;
  saveLastRoom(roomId);

  state.unsubs.push(listenRoom(roomId, onRoomUpdate));
  state.unsubs.push(listenPlayers(roomId, onPlayersUpdate));
  state.unsubs.push(listenMarket(roomId, onMarketUpdate));
  state.unsubs.push(listenTrades(roomId, onTradesUpdate));
  state.unsubs.push(listenChat(roomId, onChatUpdate("lobby-chat-log")));
}

function clearRoomListeners() {
  state.unsubs.forEach((u) => u && u());
  state.unsubs = [];
  clearInterval(state.countdownTimer);
  clearInterval(state.roundTimer);
}

async function handleLeaveRoom(silent) {
  try {
    if (state.roomId) {
      // Host lobiden ayrılıyorsa ve başka oyuncu varsa, host rolünü devret.
      const me = state.players.find((p) => p.id === state.me.uid);
      if (me && me.isHost && state.room?.status === "lobby") {
        const nextHost = state.players.find((p) => p.id !== state.me.uid);
        if (nextHost) {
          try { await updateRoomSettings(state.roomId, { hostUid: nextHost.id }); } catch { /* en kötü ihtimalle oda host'suz kalır, cleanup halleder */ }
        }
      }
      await leaveRoom(state.roomId);
    }
  } catch { /* no-op */ }
  clearRoomListeners();
  state.roomId = null;
  state.room = null;
  state.players = [];
  saveLastRoom(null);
  if (!silent) show("home");
}

let lastStatus = null;
function onRoomUpdate(room) {
  if (!room) { toast("Pazar artık mevcut değil.", "error"); handleLeaveRoom(); return; }
  const prevStatus = state.room?.status;
  state.room = room;

  // Host devri sonrası kendi oyuncu dokümanımdaki isHost bayrağını kendim düzeltirim
  // (kurallar sadece kendi dokümanımı yazmama izin veriyor).
  const me = state.players.find((p) => p.id === state.me.uid);
  if (me && room.hostUid === state.me.uid && !me.isHost) {
    setPlayerHostFlag(state.roomId, true);
  } else if (me && room.hostUid !== state.me.uid && me.isHost) {
    setPlayerHostFlag(state.roomId, false);
  }

  if (room.status !== lastStatus) {
    lastStatus = room.status;
    if (room.status === "lobby") show("lobby");
    if (room.status === "active" && prevStatus !== "active") { show("game"); sfx.round(); }
    if (room.status === "reveal" || room.status === "finished") {
      if (prevStatus === "active") startRevealSequence();
    }
  }

  $("#room-code-display").textContent = room.code;
  renderLobbyCountdown(room);
  renderRoundHeader(room);
}

function onPlayersUpdate(players) {
  state.players = players.sort((a, b) => (a.joinedAt?.toMillis?.() || 0) - (b.joinedAt?.toMillis?.() || 0));
  renderLobbyPlayers();
  renderGamePlayers();
  renderReadyButton();
  const me = players.find((p) => p.id === state.me.uid);
  if (me) $("#token-value").textContent = me.tokens ?? 0;
}

function renderReadyButton() {
  const me = state.players.find((p) => p.id === state.me.uid);
  const btn = $("#btn-ready");
  const ready = me && me.ready;
  btn.querySelector("span").textContent = ready ? "Hazırsın ✓" : "Hazırım";
  btn.classList.toggle("btn-secondary", ready);
  btn.classList.toggle("btn-primary", !ready);
  const allReady = state.players.length >= 2 && state.players.every((p) => p.ready);
  $("#btn-quickstart").hidden = !allReady;
}

function renderLobbyPlayers() {
  const wrap = $("#lobby-players");
  wrap.innerHTML = "";
  state.players.forEach((p) => {
    const card = document.createElement("div");
    card.className = "player-card" + (p.isHost ? " is-host" : "");
    card.innerHTML = `
      <span class="p-avatar">${p.avatar}</span>
      <span class="p-name">${escapeHtml(p.name)}</span>
      <span class="p-status ${p.ready ? "ready" : "waiting"}">${p.ready ? "Hazır" : "Bekliyor"}</span>
    `;
    wrap.appendChild(card);
  });
  const room = state.room;
  if (room) {
    $("#lobby-status-text").textContent = state.players.length < 2
      ? "Başlamak için en az 2 oyuncu gerekiyor…"
      : `${state.players.length} / ${room.maxPlayers} oyuncu odada.`;
  }
}

function renderLobbyCountdown(room) {
  if (room.status !== "lobby" || !room.countdownEndsAt) {
    clearInterval(state.countdownTimer);
    $("#countdown-text").textContent = "—";
    return;
  }
  clearInterval(state.countdownTimer);
  const circle = $("#countdown-ring svg circle");
  const totalMs = 60 * 1000;
  const tick = async () => {
    const remaining = Math.max(0, room.countdownEndsAt.toMillis() - Date.now());
    const secs = Math.ceil(remaining / 1000);
    $("#countdown-text").textContent = secs;
    const frac = Math.max(0, Math.min(1, remaining / totalMs));
    circle.style.strokeDashoffset = String(213.6 * (1 - frac));
    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      try {
        await callRequestStart({ roomId: state.roomId });
      } catch (e) {
        if (state.players.length < 2) {
          $("#lobby-status-text").textContent = "Yeterli oyuncu yok — pazar kapanıyor…";
          setTimeout(() => handleLeaveRoom(), 2200);
        }
      }
    }
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

/* ==========================================================================
   Oyun ekranı
   ========================================================================== */
function renderRoundHeader(room) {
  if (room.status !== "active") return;
  $("#round-value").textContent = `${room.round} / 10`;

  clearInterval(state.roundTimer);
  const totalMs = 90 * 1000;
  const tick = async () => {
    if (!room.roundEndsAt) return;
    const remaining = Math.max(0, room.roundEndsAt.toMillis() - Date.now());
    const secs = Math.ceil(remaining / 1000);
    $("#timer-text").textContent = secs;
    $("#timer-bar-fill").style.width = `${Math.max(0, Math.min(100, (remaining / totalMs) * 100))}%`;
    if (remaining <= 0) {
      clearInterval(state.roundTimer);
      try { await callAdvanceRound({ roomId: state.roomId }); sfx.round(); } catch { /* başka biri hallettti */ }
    }
  };
  tick();
  state.roundTimer = setInterval(tick, 1000);
}

function rarityTagHtml(item) {
  return `<span class="item-rarity-tag ${item.rarity}">${item.rarityLabel || RARITY_LABEL[item.rarity] || item.rarity}</span>`;
}

function buildItemCard(item, { context } = {}) {
  const tpl = $("#tpl-item-card").content.cloneNode(true);
  const card = tpl.querySelector(".item-card");
  card.querySelector(".item-rarity-tag").outerHTML = rarityTagHtml(item);
  card.querySelector(".item-name").textContent = item.name;
  card.querySelector(".item-category").textContent = item.category;
  card.querySelector(".item-cost-value").textContent = item.cost;
  card.dataset.itemId = item.id;

  const owner = state.players.find((p) => p.id === item.ownerUid);
  if (item.status === "owned") {
    card.classList.add(owner && owner.id === state.me.uid ? "owned" : "sold");
    card.querySelector(".item-owner").textContent = owner ? `${owner.avatar} ${owner.name}` : "";
  } else {
    card.querySelector(".item-owner").textContent = "Pazarda";
  }

  card.addEventListener("click", () => onItemCardClick(item, context));
  return card;
}

function renderMarket() {
  const grid = $("#market-grid");
  grid.innerHTML = "";
  const currentRoundItems = state.market.filter((it) => it.round === state.room?.round);
  const items = currentRoundItems.length ? currentRoundItems : state.market;
  items.forEach((item) => grid.appendChild(buildItemCard(item, { context: "market" })));

  const invGrid = $("#inventory-grid");
  invGrid.innerHTML = "";
  const mine = state.market.filter((it) => it.ownerUid === state.me.uid);
  $("#inventory-empty").hidden = mine.length > 0;
  mine.forEach((item) => invGrid.appendChild(buildItemCard(item, { context: "inventory" })));
}

function onMarketUpdate(items) {
  state.market = items;
  renderMarket();
}

function onItemCardClick(item, context) {
  if (item.status === "available" && !item.ownerUid) {
    openBuyModal(item);
  } else if (item.ownerUid && item.ownerUid !== state.me.uid) {
    openTradeModal({ targetUid: item.ownerUid, preselectRequested: item.id });
  } else {
    openTradeModal({ targetUid: null, preselectOffered: item.id });
  }
}

function renderGamePlayers() {
  const wrap = $("#game-players-list");
  wrap.innerHTML = "";
  state.players.forEach((p) => {
    const tpl = $("#tpl-player-row").content.cloneNode(true);
    const row = tpl.querySelector(".player-row");
    row.querySelector(".player-avatar").textContent = p.avatar;
    row.querySelector(".player-row-name").textContent = p.name + (p.id === state.me.uid ? " (sen)" : "");
    row.querySelector(".player-row-meta").textContent = `🪙 ${p.tokens ?? 0} · ${(p.inventory || []).length} eşya`;
    if (p.id !== state.me.uid && state.room?.status === "active") {
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary";
      btn.style.padding = "8px 12px";
      btn.style.fontSize = ".8rem";
      btn.textContent = "Teklif Ver";
      btn.addEventListener("click", () => openTradeModal({ targetUid: p.id }));
      row.querySelector(".player-row-status").replaceWith(btn);
    }
    wrap.appendChild(row);
  });
}

function onTradesUpdate(trades) {
  state.trades = trades;
  const incoming = trades.filter((t) => t.toUid === state.me.uid && t.status === "pending");
  const outgoing = trades.filter((t) => t.fromUid === state.me.uid && t.status === "pending");
  $("#offers-badge").hidden = incoming.length === 0;
  if (incoming.length) $("#offers-badge").textContent = incoming.length;

  const list = $("#offers-list");
  list.innerHTML = "";
  $("#offers-empty").hidden = incoming.length + outgoing.length > 0;

  incoming.forEach((t) => list.appendChild(buildOfferCard(t, "incoming")));
  outgoing.forEach((t) => list.appendChild(buildOfferCard(t, "outgoing")));
}

function itemName(id) {
  const it = state.market.find((m) => m.id === id);
  return it ? it.name : "Bilinmeyen eşya";
}
function playerName(uid) {
  const p = state.players.find((pl) => pl.id === uid);
  return p ? `${p.avatar} ${p.name}` : "Bir tüccar";
}

function buildOfferCard(trade, direction) {
  const card = document.createElement("div");
  card.className = "offer-card";
  const offeredList = (trade.offeredItems || []).map(itemName).concat(trade.offeredTokens ? [`${trade.offeredTokens} 🪙`] : []);
  const requestedList = (trade.requestedItems || []).map(itemName).concat(trade.requestedTokens ? [`${trade.requestedTokens} 🪙`] : []);

  card.innerHTML = `
    <div class="offer-head">
      <span>${direction === "incoming" ? playerName(trade.fromUid) + " sana teklif verdi" : "Teklifin: " + playerName(trade.toUid)}</span>
    </div>
    <div class="offer-body">
      <div><strong>Veriyor:</strong> ${offeredList.join(", ") || "—"}</div>
      <div><strong>İstiyor:</strong> ${requestedList.join(", ") || "—"}</div>
      ${trade.message ? `<div><em>"${escapeHtml(trade.message)}"</em></div>` : ""}
    </div>
  `;
  const actions = document.createElement("div");
  actions.className = "offer-actions";
  if (direction === "incoming") {
    const accept = document.createElement("button");
    accept.className = "btn btn-gold";
    accept.textContent = "Kabul Et";
    accept.addEventListener("click", async () => {
      try { await callRespondTrade({ roomId: state.roomId, tradeId: trade.id, accept: true }); sfx.success(); }
      catch (e) { toast(friendlyError(e), "error"); }
    });
    const reject = document.createElement("button");
    reject.className = "btn btn-ghost";
    reject.textContent = "Reddet";
    reject.addEventListener("click", async () => {
      try { await callRespondTrade({ roomId: state.roomId, tradeId: trade.id, accept: false }); }
      catch (e) { toast(friendlyError(e), "error"); }
    });
    actions.append(accept, reject);
  } else {
    const cancel = document.createElement("button");
    cancel.className = "btn btn-ghost";
    cancel.textContent = "Teklifi İptal Et";
    cancel.addEventListener("click", () => cancelTrade(state.roomId, trade.id));
    actions.append(cancel);
  }
  card.appendChild(actions);
  return card;
}

/* ==========================================================================
   Modallar: satın alma & takas
   ========================================================================== */
function openModal(html, onMount) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal-sheet">${html}</div></div>`;
  const backdrop = root.querySelector(".modal-backdrop");
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  onMount && onMount(root);
}
function closeModal() { $("#modal-root").innerHTML = ""; }

function openBuyModal(item) {
  const me = state.players.find((p) => p.id === state.me.uid);
  const canAfford = me && me.tokens >= item.cost;
  openModal(`
    <button class="icon-btn modal-close" id="modal-close">✕</button>
    <h3 class="modal-title">${escapeHtml(item.name)}</h3>
    ${rarityTagHtml(item)}
    <p style="color:var(--ink-dim); margin:12px 0; font-size:.92rem; line-height:1.5;">${escapeHtml(item.description || "")}</p>
    <p style="font-family:var(--font-mono); color:var(--gold-light); font-size:1.1rem;">🪙 ${item.cost} jeton</p>
    <button class="btn btn-gold btn-block btn-large" id="modal-buy" ${canAfford ? "" : "disabled"}>
      ${canAfford ? "Satın Al" : "Yetersiz jeton"}
    </button>
  `, (root) => {
    root.querySelector("#modal-close").addEventListener("click", closeModal);
    root.querySelector("#modal-buy").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await callBuyItem({ roomId: state.roomId, itemId: item.id });
        sfx.coin();
        closeModal();
        toast("Satın alındı: " + item.name);
      } catch (err) {
        toast(friendlyError(err), "error");
        e.target.disabled = false;
      }
    });
  });
}

function openTradeModal({ targetUid, preselectOffered, preselectRequested } = {}) {
  const me = state.players.find((p) => p.id === state.me.uid);
  const others = state.players.filter((p) => p.id !== state.me.uid);
  if (!others.length) { toast("Takas yapacak başka oyuncu yok."); return; }

  let selectedTarget = targetUid || others[0].id;
  const myItems = () => state.market.filter((it) => it.ownerUid === state.me.uid);
  const theirItems = () => state.market.filter((it) => it.ownerUid === selectedTarget);

  const offered = new Set(preselectOffered ? [preselectOffered] : []);
  const requested = new Set(preselectRequested ? [preselectRequested] : []);
  let offeredTokens = 0;
  let requestedTokens = 0;

  openModal(`
    <button class="icon-btn modal-close" id="modal-close">✕</button>
    <h3 class="modal-title">Takas Teklifi</h3>
    <p class="field-label">Kime</p>
    <select id="trade-target" class="text-input">
      ${others.map((p) => `<option value="${p.id}" ${p.id === selectedTarget ? "selected" : ""}>${p.avatar} ${escapeHtml(p.name)}</option>`).join("")}
    </select>

    <p class="field-label">Verdiğin eşyalar</p>
    <div class="pick-grid" id="pick-mine"></div>
    <p class="field-label">+ Jeton veriyorsun</p>
    <div class="token-stepper">
      <button type="button" id="offered-minus">−</button>
      <span id="offered-tokens-val">0</span>
      <button type="button" id="offered-plus">+</button>
    </div>

    <p class="field-label">İstediğin eşyalar</p>
    <div class="pick-grid" id="pick-theirs"></div>
    <p class="field-label">+ Jeton istiyorsun</p>
    <div class="token-stepper">
      <button type="button" id="requested-minus">−</button>
      <span id="requested-tokens-val">0</span>
      <button type="button" id="requested-plus">+</button>
    </div>

    <input id="trade-message" class="text-input" style="margin-top:14px;" maxlength="80" placeholder="Kısa bir mesaj ekle (opsiyonel)" />
    <button class="btn btn-primary btn-block btn-large" id="modal-send-trade">Teklifi Gönder</button>
  `, (root) => {
    root.querySelector("#modal-close").addEventListener("click", closeModal);

    function renderPickGrid(container, items, selectedSet) {
      container.innerHTML = "";
      if (!items.length) { container.innerHTML = `<p class="empty-hint" style="padding:12px;">Uygun eşya yok.</p>`; return; }
      items.forEach((it) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pick-item" + (selectedSet.has(it.id) ? " selected" : "");
        btn.innerHTML = `<b>${escapeHtml(it.name)}</b>${RARITY_LABEL[it.rarity] || ""}`;
        btn.addEventListener("click", () => {
          if (selectedSet.has(it.id)) selectedSet.delete(it.id); else selectedSet.add(it.id);
          btn.classList.toggle("selected");
        });
        container.appendChild(btn);
      });
    }
    renderPickGrid(root.querySelector("#pick-mine"), myItems(), offered);
    renderPickGrid(root.querySelector("#pick-theirs"), theirItems(), requested);

    root.querySelector("#trade-target").addEventListener("change", (e) => {
      selectedTarget = e.target.value;
      requested.clear();
      renderPickGrid(root.querySelector("#pick-theirs"), theirItems(), requested);
    });

    const offVal = root.querySelector("#offered-tokens-val");
    const reqVal = root.querySelector("#requested-tokens-val");
    root.querySelector("#offered-plus").addEventListener("click", () => {
      if (offeredTokens < (me?.tokens ?? 0)) offVal.textContent = ++offeredTokens;
    });
    root.querySelector("#offered-minus").addEventListener("click", () => {
      if (offeredTokens > 0) offVal.textContent = --offeredTokens;
    });
    root.querySelector("#requested-plus").addEventListener("click", () => {
      requestedTokens++; reqVal.textContent = requestedTokens;
    });
    root.querySelector("#requested-minus").addEventListener("click", () => {
      if (requestedTokens > 0) requestedTokens--; reqVal.textContent = requestedTokens;
    });

    root.querySelector("#modal-send-trade").addEventListener("click", async (e) => {
      if (!offered.size && !requested.size && !offeredTokens && !requestedTokens) {
        toast("En az bir eşya veya jeton seç.", "error"); return;
      }
      e.target.disabled = true;
      try {
        await proposeTrade(state.roomId, {
          toUid: selectedTarget,
          offeredItems: [...offered],
          offeredTokens,
          requestedItems: [...requested],
          requestedTokens,
          message: root.querySelector("#trade-message").value.trim(),
        });
        sfx.notify();
        closeModal();
        toast("Teklif gönderildi.");
      } catch (err) {
        toast(friendlyError(err), "error");
        e.target.disabled = false;
      }
    });
  });
}

/* ==========================================================================
   Sohbet render
   ========================================================================== */
function onChatUpdate(logElId) {
  return (messages) => {
    [$("#" + logElId), $("#game-chat-log")].forEach((log) => {
      if (!log) return;
      log.innerHTML = "";
      messages.forEach((m) => {
        const tpl = $("#tpl-chat-line").content.cloneNode(true);
        const line = tpl.querySelector(".chat-line");
        if (m.type === "system") {
          line.classList.add("system");
          line.querySelector(".chat-avatar").remove();
          line.querySelector(".chat-name").remove();
          line.querySelector(".chat-text").textContent = m.text;
        } else {
          line.querySelector(".chat-avatar").textContent = m.avatar || "🙂";
          line.querySelector(".chat-name").textContent = m.name;
          line.querySelector(".chat-text").textContent = m.text;
        }
        log.appendChild(line);
      });
      log.scrollTop = log.scrollHeight;
    });
    if (messages.length && !$("#chat-drawer").classList.contains("open") && state.room?.status === "active") {
      const last = messages[messages.length - 1];
      if (last.uid !== state.me.uid && last.uid !== "system") {
        state.chatUnread++;
        $("#chat-badge").hidden = false;
        $("#chat-badge").textContent = state.chatUnread;
        sfx.notify();
      }
    }
  };
}

/* ==========================================================================
   Açılış (reveal) sahnesi
   ========================================================================== */
async function startRevealSequence() {
  show("reveal");
  $("#btn-see-results").hidden = true;
  const grid = $("#reveal-grid");
  grid.innerHTML = "";

  let secretsMap = {};
  try {
    const secretsSnap = await getDocs(collection(db, "rooms", state.roomId, "marketSecrets"));
    secretsSnap.forEach((d) => (secretsMap[d.id] = d.data().value));
  } catch { /* henüz okunabilir değilse boş kalır */ }

  const cards = state.market.map((item) => {
    const card = buildItemCard(item, { context: "reveal" });
    card.replaceChildren(...Array.from(card.children)); // etkileşimi kaldır
    card.style.pointerEvents = "none";
    const valueEl = document.createElement("span");
    valueEl.className = "item-value-reveal";
    valueEl.textContent = "🪙 " + (secretsMap[item.id] ?? "?");
    card.appendChild(valueEl);
    grid.appendChild(card);
    return card;
  });

  await new Promise((r) => setTimeout(r, 400));
  cards.forEach((card, i) => {
    setTimeout(() => {
      card.classList.add("revealed");
      sfx.crack();
    }, i * 160);
  });

  const revealUnsub = listenReveal(state.roomId, (result) => {
    if (!result) return;
    renderResults(result);
    revealUnsub && revealUnsub();
  });
  state.unsubs.push(revealUnsub);

  setTimeout(() => { $("#btn-see-results").hidden = false; }, cards.length * 160 + 700);
}

function renderResults(result) {
  const standings = result.standings || [];
  const winner = standings[0];
  if (winner) {
    $("#winner-banner").innerHTML = `
      <span class="w-avatar">${winner.avatar}</span>
      <div class="w-name">${escapeHtml(winner.name)} kazandı!</div>
      <div class="w-score">🪙 ${winner.score} puan</div>
    `;
  }
  const list = $("#standings-list");
  list.innerHTML = "";
  standings.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "standing-row" + (i === 0 ? " rank-1" : "");
    row.innerHTML = `
      <span class="standing-rank">#${i + 1}</span>
      <span class="standing-avatar">${s.avatar}</span>
      <div class="standing-main">
        <span class="standing-name">${escapeHtml(s.name)}${s.uid === state.me.uid ? " (sen)" : ""}</span>
      </div>
      <span class="standing-score">${s.score}</span>
    `;
    list.appendChild(row);
  });
}

/* ==========================================================================
   PWA: Service worker + kurulum daveti
   ========================================================================== */
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => { /* sessizce yut */ });
    });
  }
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const chip = $("#home-player-chip");
  if (chip && !$("#btn-install")) {
    const btn = document.createElement("button");
    btn.id = "btn-install";
    btn.className = "btn btn-ghost";
    btn.style.marginLeft = "8px";
    btn.style.padding = "6px 12px";
    btn.textContent = "📲 Yükle";
    btn.addEventListener("click", async () => {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      btn.remove();
    });
    chip.after(btn);
  }
});

window.addEventListener("beforeunload", () => {
  clearInterval(state.countdownTimer);
  clearInterval(state.roundTimer);
});

boot();
