// Rüya Pazarı — Firebase istemci katmanı
// Tüm ekonomi-kritik işlemler (satın alma, takas onayı, tur ilerletme,
// oyunu başlatma) Cloud Functions üzerinden çağrılır; bu dosya sadece
// "sosyal" verileri (isim, hazır durumu, sohbet) doğrudan Firestore'a yazar.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  runTransaction,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyBo8d4FnKicPT-XsU5BXWreT1GBg5rhggA",
  authDomain: "dream-f2ad5.firebaseapp.com",
  projectId: "dream-f2ad5",
  storageBucket: "dream-f2ad5.firebasestorage.app",
  messagingSenderId: "530907270454",
  appId: "1:530907270454:web:a642bcd3f76db321b8f797",
  measurementId: "G-63FX9Z46PB",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "europe-west1");

// ---------------------------------------------------------------------------
// Kimlik doğrulama
// ---------------------------------------------------------------------------
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsub();
          resolve(user);
        } else {
          signInAnonymously(auth).catch(reject);
        }
      },
      reject
    );
  });
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // I,O,0,1 çıkarıldı (karışmasın)

function randomCode(len = 5) {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

async function roomRefFromCode(code) {
  const ref = doc(db, "rooms", code.toUpperCase());
  const snap = await getDoc(ref);
  return snap.exists() ? ref : null;
}

// ---------------------------------------------------------------------------
// Oda oluşturma / katılma
// ---------------------------------------------------------------------------
export async function createRoom({ name, avatar, maxPlayers }) {
  const uid = auth.currentUser.uid;
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    const ref = doc(db, "rooms", code);
    const existing = await getDoc(ref);
    if (existing.exists()) continue;

    await setDoc(ref, {
      code,
      hostUid: uid,
      maxPlayers,
      status: "lobby",
      round: 0,
      quickStart: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      countdownEndsAt: Timestamp.fromMillis(Date.now() + 60 * 1000),
      roundEndsAt: null,
      winnerUid: null,
    });

    await setDoc(doc(db, "rooms", code, "players", uid), {
      uid,
      name,
      avatar,
      ready: true,
      connected: true,
      isHost: true,
      tokens: 0,
      score: 0,
      inventory: [],
      joinedAt: serverTimestamp(),
    });

    return code;
  }
  throw new Error("Oda kodu üretilemedi, lütfen tekrar deneyin.");
}

export async function joinRoomByCode(code, { name, avatar }) {
  const ref = await roomRefFromCode(code);
  if (!ref) throw new Error("Bu kodla bir pazar bulunamadı.");
  const roomSnap = await getDoc(ref);
  const room = roomSnap.data();
  if (room.status !== "lobby") throw new Error("Bu pazar zaten açıldı, katılamazsınız.");

  const uid = auth.currentUser.uid;
  const playersCol = collection(db, "rooms", ref.id, "players");
  // Kapasite kontrolü client tarafında yapılır; asıl güvence rules + oyun akışı.
  const existingPlayers = await getDocsCompat(playersCol);
  if (existingPlayers.length >= room.maxPlayers && !existingPlayers.find((p) => p.id === uid)) {
    throw new Error("Bu pazar dolu.");
  }

  await setDoc(doc(db, "rooms", ref.id, "players", uid), {
    uid,
    name,
    avatar,
    ready: false,
    connected: true,
    isHost: false,
    tokens: 0,
    score: 0,
    inventory: [],
    joinedAt: serverTimestamp(),
  });

  return ref.id;
}

// basit yardımcı: onSnapshot yerine tek seferlik okuma
async function getDocsCompat(colRef) {
  const snap = await getDocs(colRef);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function quickJoin({ name, avatar }) {
  const roomsCol = collection(db, "rooms");
  // "Hızlı Katıl": lobide, dolu olmayan en yakın zamanda açılmış odayı bul.
  const q = query(roomsCol, orderBy("createdAt", "desc"), limit(25));
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    const room = docSnap.data();
    if (room.status !== "lobby") continue;
    const players = await getDocsCompat(collection(db, "rooms", docSnap.id, "players"));
    if (players.length < room.maxPlayers) {
      return joinRoomByCode(docSnap.id, { name, avatar });
    }
  }
  // Uygun oda yoksa yeni bir tane aç (4 kişilik varsayılan).
  return createRoom({ name, avatar, maxPlayers: 4 });
}

export async function leaveRoom(roomId) {
  const uid = auth.currentUser.uid;
  await deleteDoc(doc(db, "rooms", roomId, "players", uid));
}

export async function setReady(roomId, ready) {
  const uid = auth.currentUser.uid;
  await updateDoc(doc(db, "rooms", roomId, "players", uid), { ready });
}

export async function setPlayerHostFlag(roomId, isHost) {
  const uid = auth.currentUser.uid;
  await updateDoc(doc(db, "rooms", roomId, "players", uid), { isHost });
}

export async function updateRoomSettings(roomId, data) {
  await updateDoc(doc(db, "rooms", roomId), data);
}

// ---------------------------------------------------------------------------
// Dinleyiciler (real-time)
// ---------------------------------------------------------------------------
export function listenRoom(roomId, cb) {
  return onSnapshot(doc(db, "rooms", roomId), (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null));
}

export function listenPlayers(roomId, cb) {
  return onSnapshot(collection(db, "rooms", roomId, "players"), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function listenMarket(roomId, cb) {
  return onSnapshot(collection(db, "rooms", roomId, "market"), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function listenTrades(roomId, cb) {
  return onSnapshot(collection(db, "rooms", roomId, "trades"), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function listenChat(roomId, cb) {
  const q = query(collection(db, "rooms", roomId, "chat"), orderBy("createdAt", "asc"), limit(200));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function listenReveal(roomId, cb) {
  return onSnapshot(doc(db, "rooms", roomId, "reveal", "result"), (snap) => {
    cb(snap.exists() ? snap.data() : null);
  });
}

// ---------------------------------------------------------------------------
// Sohbet & hızlı mesajlar
// ---------------------------------------------------------------------------
export async function sendChat(roomId, { name, avatar, text, type = "text" }) {
  const uid = auth.currentUser.uid;
  await addDoc(collection(db, "rooms", roomId, "chat"), {
    uid,
    name,
    avatar,
    text,
    type,
    createdAt: serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Takas teklifleri (oluşturma/iptal istemciden; SONUÇLANDIRMA sunucudan)
// ---------------------------------------------------------------------------
export async function proposeTrade(roomId, { toUid, offeredItems, offeredTokens, requestedItems, requestedTokens, message }) {
  const uid = auth.currentUser.uid;
  await addDoc(collection(db, "rooms", roomId, "trades"), {
    fromUid: uid,
    toUid,
    offeredItems,
    offeredTokens: offeredTokens || 0,
    requestedItems,
    requestedTokens: requestedTokens || 0,
    message: message || "",
    status: "pending",
    createdAt: serverTimestamp(),
    resolvedAt: null,
  });
}

export async function cancelTrade(roomId, tradeId) {
  await updateDoc(doc(db, "rooms", roomId, "trades", tradeId), { status: "cancelled" });
}

// ---------------------------------------------------------------------------
// Sunucu tarafı çağrılar (Cloud Functions)
// ---------------------------------------------------------------------------
export const callRequestStart = httpsCallable(functions, "requestStart");
export const callAdvanceRound = httpsCallable(functions, "advanceRound");
export const callBuyItem = httpsCallable(functions, "buyItem");
export const callRespondTrade = httpsCallable(functions, "respondTrade");
export const callRematch = httpsCallable(functions, "rematch");

export { getDocs, doc, updateDoc };
