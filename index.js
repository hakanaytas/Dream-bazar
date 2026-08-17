/**
 * Rüya Pazarı — Cloud Functions
 * ------------------------------------------------------------------
 * Ekonomiyi ilgilendiren HER işlem (jeton, envanter, gizli eşya değeri,
 * takas sonuçlandırma, tur ilerletme, final puanlama) burada, Admin SDK
 * ile ve transaction içinde yapılır. İstemciler bu verilere asla
 * doğrudan yazamaz (bkz. firestore.rules). Bu, "hileyi önlemek için
 * sunucu tarafında oyun doğrulaması" gereksinimini karşılar.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

setGlobalOptions({ region: "europe-west1", maxInstances: 20 });

// ---------------------------------------------------------------------------
// Oyun sabitleri
// ---------------------------------------------------------------------------
const TOTAL_ROUNDS = 10;
const ROUND_DURATION_MS = 90 * 1000; // her tur 90 sn
const STARTING_TOKENS = 24;

const RARITY = [
  { key: "common", label: "Sıradan", weight: 45, min: 1, max: 25 },
  { key: "uncommon", label: "Nadide", weight: 25, min: 5, max: 35 },
  { key: "rare", label: "Ender", weight: 15, min: 10, max: 55 },
  { key: "epic", label: "Efsanevi", weight: 10, min: 15, max: 80 },
  { key: "legendary", label: "Menkıbevi", weight: 5, min: 20, max: 120 },
];

const CATEGORIES = ["Tılsım", "Kadim Eser", "İksir", "Mücevher", "Harita", "Cilt", "Emanet", "Heykelcik"];

const ADJECTIVES = [
  "Kırık Aylı", "Sessiz", "Unutulmuş", "Üç Gözlü", "Kehribar", "Solgun",
  "Kayıp Kervanın", "Fısıldayan", "Paslı", "Yıldıztozlu", "Kör Falcının",
  "Denizfeneri", "Rüzgâr Yanıklı", "Gölge Dokulu", "Ay Işığında Islanmış",
  "Sürgündeki", "Tuzlu", "Kızıl Mühürlü", "Kadim", "Alacakaranlık",
];

const NOUNS = [
  "Pusula", "Yüzük", "Anahtar", "Kutu", "Ayna", "Tespih", "Fener", "Maske",
  "Heykelcik", "Şişe", "Tomar", "Kolye", "Kâse", "Zil", "Taş", "Kart Destesi",
  "Post", "Boynuz", "Kilit", "Mühür",
];

const DESCRIPTIONS = [
  "Pazarın en karanlık köşesinden, kimsenin sorgulamaya cesaret edemediği bir tüccardan geldi.",
  "Üzerindeki yazılar hiçbir bilinen dile benzemiyor; belki de hiçbir zaman benzemeyecek.",
  "Sahibi olduğunu iddia eden herkes farklı bir hikâye anlatıyor.",
  "Dokunduğunda hafif bir ürperti hissediliyor — belki hayal, belki değil.",
  "Bazı gezginler ona bakmaktan bile kaçınıyor.",
  "Eski bir kervansaray defterinde adı geçiyor, ama neden orada olduğu bir muamma.",
  "Ay ışığı altında farklı bir renk aldığı söyleniyor.",
  "Bir zamanlar bir kraliyet hazinesinin parçası olduğu rivayet ediliyor.",
  "Fiyatını soran herkese pazarcı aynı gizemli gülümsemeyle bakıyor.",
  "Üstündeki toz, onlarca pazarın tozunu taşıyor gibi.",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weightedRarity() {
  const total = RARITY.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of RARITY) {
    if (roll < r.weight) return r;
    roll -= r.weight;
  }
  return RARITY[0];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeItem(round) {
  const rarity = weightedRarity();
  const name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
  const midpoint = (rarity.min + rarity.max) / 2;
  // Fiyat (satın alma maliyeti), gerçek değerden BAĞIMSIZ ayrı bir zar —
  // bu sayede "ucuz ama değerli" ya da "pahalı ama değersiz" eşyalar çıkar.
  const cost = Math.max(1, Math.round(midpoint * (0.7 + Math.random() * 0.7)));
  const value = randomInt(rarity.min, rarity.max);
  return {
    name,
    description: pick(DESCRIPTIONS),
    category: pick(CATEGORIES),
    rarity: rarity.key,
    rarityLabel: rarity.label,
    cost,
    round,
    trueValue: value, // sadece marketSecrets'a yazılacak, market dokümanına DEĞİL
  };
}

function itemsForPlayerCount(playerCount) {
  return Math.max(3, Math.min(9, playerCount + 1));
}

async function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bu işlem için giriş yapmalısınız.");
  }
  return request.auth.uid;
}

async function requirePlayerInRoom(roomRef, uid) {
  const playerSnap = await roomRef.collection("players").doc(uid).get();
  if (!playerSnap.exists) {
    throw new HttpsError("permission-denied", "Bu odada oyuncu değilsiniz.");
  }
  return playerSnap;
}

// ---------------------------------------------------------------------------
// requestStart — Lobiden oyunu başlatır (1. turu üretir).
// Herhangi bir istemci çağırabilir (host'un "Hızlı Başlat"ı ya da geri sayım
// bittiğinde herhangi bir istemci), fakat sunucu şu koşulları KENDİSİ doğrular:
//  - oda hâlâ 'lobby' durumunda mı
//  - en az 2 oyuncu var mı
//  - (hızlı başlat DEĞİLSE) geri sayım gerçekten bitmiş mi VEYA herkes hazır mı
// ---------------------------------------------------------------------------
exports.requestStart = onCall(async (request) => {
  const uid = await requireAuth(request);
  const { roomId } = request.data || {};
  if (!roomId) throw new HttpsError("invalid-argument", "roomId gerekli.");

  const roomRef = db.collection("rooms").doc(roomId);
  await requirePlayerInRoom(roomRef, uid);

  await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) throw new HttpsError("not-found", "Oda bulunamadı.");
    const room = roomSnap.data();
    if (room.status !== "lobby") return; // zaten başlamış, sessizce çık (idempotent)

    const playersSnap = await tx.get(roomRef.collection("players"));
    const players = playersSnap.docs.map((d) => d.data());
    if (players.length < 2) {
      throw new HttpsError("failed-precondition", "Oyunun başlaması için en az 2 oyuncu gerekir.");
    }

    const allReady = players.every((p) => p.ready);
    const countdownOver = room.countdownEndsAt && room.countdownEndsAt.toMillis() <= Date.now();

    if (!allReady && !countdownOver) {
      throw new HttpsError("failed-precondition", "Henüz herkes hazır değil ve süre dolmadı.");
    }

    // 1. tur pazarını üret.
    const n = itemsForPlayerCount(players.length);
    for (let i = 0; i < n; i++) {
      const item = makeItem(1);
      const itemRef = roomRef.collection("market").doc();
      const { trueValue, ...publicItem } = item;
      tx.set(itemRef, { ...publicItem, status: "available", ownerUid: null, id: itemRef.id });
      tx.set(roomRef.collection("marketSecrets").doc(itemRef.id), { value: trueValue });
    }

    // Oyuncu jetonlarını sunucu tarafında ata (istemci asla kendi jetonunu yazamaz).
    for (const doc of playersSnap.docs) {
      tx.update(doc.ref, { tokens: STARTING_TOKENS, connected: true });
    }

    tx.update(roomRef, {
      status: "active",
      round: 1,
      startedAt: FieldValue.serverTimestamp(),
      roundEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + ROUND_DURATION_MS),
      countdownEndsAt: null,
    });

    tx.set(roomRef.collection("chat").doc(), {
      uid: "system",
      name: "Pazar Habercisi",
      type: "system",
      text: "Pazar kapılarını açtı. 1. Tur başladı!",
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true };
});

// ---------------------------------------------------------------------------
// advanceRound — Süresi dolan turu ilerletir ya da oyunu bitirir.
// İstemciler zamanlayıcı UI'sinde süre 0'a ulaştığında bunu çağırır; sunucu
// süresi gerçekten dolmuş mu diye KENDİSİ kontrol eder (idempotent).
// ---------------------------------------------------------------------------
exports.advanceRound = onCall(async (request) => {
  const uid = await requireAuth(request);
  const { roomId } = request.data || {};
  if (!roomId) throw new HttpsError("invalid-argument", "roomId gerekli.");
  const roomRef = db.collection("rooms").doc(roomId);
  await requirePlayerInRoom(roomRef, uid);

  const result = await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    const room = roomSnap.data();
    if (!room || room.status !== "active") return { changed: false };
    if (!room.roundEndsAt || room.roundEndsAt.toMillis() > Date.now()) return { changed: false };

    const nextRound = room.round + 1;

    if (nextRound > TOTAL_ROUNDS) {
      tx.update(roomRef, { status: "reveal", roundEndsAt: null });
      return { changed: true, finished: true };
    }

    const playersSnap = await tx.get(roomRef.collection("players"));
    const n = itemsForPlayerCount(playersSnap.size);
    for (let i = 0; i < n; i++) {
      const item = makeItem(nextRound);
      const itemRef = roomRef.collection("market").doc();
      const { trueValue, ...publicItem } = item;
      tx.set(itemRef, { ...publicItem, status: "available", ownerUid: null, id: itemRef.id });
      tx.set(roomRef.collection("marketSecrets").doc(itemRef.id), { value: trueValue });
    }

    tx.update(roomRef, {
      round: nextRound,
      roundEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + ROUND_DURATION_MS),
    });

    tx.set(roomRef.collection("chat").doc(), {
      uid: "system",
      name: "Pazar Habercisi",
      type: "system",
      text: `${nextRound}. Tur başladı — tezgâhlara yeni eşyalar geldi.`,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { changed: true, finished: false };
  });

  if (result.finished) {
    await finalizeGame(roomRef);
  }

  return { ok: true };
});

// ---------------------------------------------------------------------------
// buyItem — Pazardan doğrudan satın alma (jeton karşılığı).
// ---------------------------------------------------------------------------
exports.buyItem = onCall(async (request) => {
  const uid = await requireAuth(request);
  const { roomId, itemId } = request.data || {};
  if (!roomId || !itemId) throw new HttpsError("invalid-argument", "roomId ve itemId gerekli.");

  const roomRef = db.collection("rooms").doc(roomId);
  const playerRef = roomRef.collection("players").doc(uid);
  const itemRef = roomRef.collection("market").doc(itemId);

  await db.runTransaction(async (tx) => {
    const [roomSnap, playerSnap, itemSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(playerRef),
      tx.get(itemRef),
    ]);
    if (!roomSnap.exists || roomSnap.data().status !== "active") {
      throw new HttpsError("failed-precondition", "Oyun şu anda aktif değil.");
    }
    if (!playerSnap.exists) throw new HttpsError("permission-denied", "Bu odada oyuncu değilsiniz.");
    if (!itemSnap.exists) throw new HttpsError("not-found", "Eşya bulunamadı.");

    const item = itemSnap.data();
    const player = playerSnap.data();
    if (item.status !== "available") {
      throw new HttpsError("failed-precondition", "Bu eşya artık pazarda değil.");
    }
    if (player.tokens < item.cost) {
      throw new HttpsError("failed-precondition", "Yeterli jetonunuz yok.");
    }

    tx.update(itemRef, { status: "owned", ownerUid: uid });
    tx.update(playerRef, {
      tokens: player.tokens - item.cost,
      inventory: FieldValue.arrayUnion(itemId),
    });
    tx.set(roomRef.collection("chat").doc(), {
      uid: "system",
      name: "Pazar Habercisi",
      type: "system",
      text: `${player.name}, "${item.name}" eşyasını ${item.cost} jetona satın aldı.`,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true };
});

// ---------------------------------------------------------------------------
// respondTrade — Bir takas teklifini kabul/reddeder. Kabul edilirse envanter
// ve jeton aktarımı ATOMIK ve sunucu tarafında yapılır.
// ---------------------------------------------------------------------------
exports.respondTrade = onCall(async (request) => {
  const uid = await requireAuth(request);
  const { roomId, tradeId, accept } = request.data || {};
  if (!roomId || !tradeId || typeof accept !== "boolean") {
    throw new HttpsError("invalid-argument", "roomId, tradeId ve accept gerekli.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const tradeRef = roomRef.collection("trades").doc(tradeId);

  await db.runTransaction(async (tx) => {
    const [roomSnap, tradeSnap] = await Promise.all([tx.get(roomRef), tx.get(tradeRef)]);
    if (!roomSnap.exists || roomSnap.data().status !== "active") {
      throw new HttpsError("failed-precondition", "Oyun şu anda aktif değil.");
    }
    if (!tradeSnap.exists) throw new HttpsError("not-found", "Teklif bulunamadı.");
    const trade = tradeSnap.data();
    if (trade.status !== "pending") {
      throw new HttpsError("failed-precondition", "Bu teklif artık geçerli değil.");
    }
    if (trade.toUid !== uid) {
      throw new HttpsError("permission-denied", "Bu teklif size ait değil.");
    }

    if (!accept) {
      tx.update(tradeRef, { status: "rejected", resolvedAt: FieldValue.serverTimestamp() });
      return;
    }

    const fromRef = roomRef.collection("players").doc(trade.fromUid);
    const toRef = roomRef.collection("players").doc(trade.toUid);
    const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
    if (!fromSnap.exists || !toSnap.exists) {
      throw new HttpsError("failed-precondition", "Oyunculardan biri artık odada değil.");
    }
    const fromPlayer = fromSnap.data();
    const toPlayer = toSnap.data();

    const offeredItems = trade.offeredItems || [];
    const requestedItems = trade.requestedItems || [];
    const offeredTokens = trade.offeredTokens || 0;
    const requestedTokens = trade.requestedTokens || 0;

    const fromOwnsAll = offeredItems.every((id) => (fromPlayer.inventory || []).includes(id));
    const toOwnsAll = requestedItems.every((id) => (toPlayer.inventory || []).includes(id));
    if (!fromOwnsAll || !toOwnsAll) {
      tx.update(tradeRef, { status: "cancelled", resolvedAt: FieldValue.serverTimestamp() });
      throw new HttpsError("failed-precondition", "Eşyalardan biri artık uygun değil. Teklif iptal edildi.");
    }
    if (fromPlayer.tokens < offeredTokens || toPlayer.tokens < requestedTokens) {
      tx.update(tradeRef, { status: "cancelled", resolvedAt: FieldValue.serverTimestamp() });
      throw new HttpsError("failed-precondition", "Jeton yetersiz. Teklif iptal edildi.");
    }

    const newFromInventory = (fromPlayer.inventory || [])
      .filter((id) => !offeredItems.includes(id))
      .concat(requestedItems);
    const newToInventory = (toPlayer.inventory || [])
      .filter((id) => !requestedItems.includes(id))
      .concat(offeredItems);

    tx.update(fromRef, {
      inventory: newFromInventory,
      tokens: fromPlayer.tokens - offeredTokens + requestedTokens,
    });
    tx.update(toRef, {
      inventory: newToInventory,
      tokens: toPlayer.tokens - requestedTokens + offeredTokens,
    });

    for (const id of offeredItems) {
      tx.update(roomRef.collection("market").doc(id), { ownerUid: trade.toUid });
    }
    for (const id of requestedItems) {
      tx.update(roomRef.collection("market").doc(id), { ownerUid: trade.fromUid });
    }

    tx.update(tradeRef, { status: "accepted", resolvedAt: FieldValue.serverTimestamp() });
    tx.set(roomRef.collection("chat").doc(), {
      uid: "system",
      name: "Pazar Habercisi",
      type: "system",
      text: `${fromPlayer.name} ile ${toPlayer.name} bir takas anlaşmasına vardı.`,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true };
});

// ---------------------------------------------------------------------------
// finalizeGame — Tüm gizli değerleri açığa çıkarır, puanları hesaplar.
// ---------------------------------------------------------------------------
async function finalizeGame(roomRef) {
  const [playersSnap, marketSnap, secretsSnap] = await Promise.all([
    roomRef.collection("players").get(),
    roomRef.collection("market").get(),
    roomRef.collection("marketSecrets").get(),
  ]);

  const secretValues = {};
  secretsSnap.forEach((d) => (secretValues[d.id] = d.data().value));

  const ownedByPlayer = {};
  marketSnap.forEach((d) => {
    const item = d.data();
    if (item.ownerUid) {
      ownedByPlayer[item.ownerUid] = ownedByPlayer[item.ownerUid] || [];
      ownedByPlayer[item.ownerUid].push({ id: d.id, name: item.name, value: secretValues[d.id] || 0 });
    }
  });

  const batch = db.batch();
  let winnerUid = null;
  let winnerScore = -1;
  const standings = [];

  playersSnap.forEach((doc) => {
    const player = doc.data();
    const items = ownedByPlayer[doc.id] || [];
    const itemsValue = items.reduce((s, it) => s + it.value, 0);
    const score = itemsValue + (player.tokens || 0);
    batch.update(doc.ref, { score });
    standings.push({ uid: doc.id, name: player.name, avatar: player.avatar, score, tokens: player.tokens || 0, items });
    if (score > winnerScore) {
      winnerScore = score;
      winnerUid = doc.id;
    }
  });

  standings.sort((a, b) => b.score - a.score);

  batch.set(roomRef.collection("reveal").doc("result"), {
    standings,
    winnerUid,
    revealedAt: FieldValue.serverTimestamp(),
  });

  batch.update(roomRef, { status: "finished", winnerUid });

  batch.set(roomRef.collection("chat").doc(), {
    uid: "system",
    name: "Pazar Habercisi",
    type: "system",
    text: "Pazar kapandı. Tüm gerçek değerler açığa çıktı!",
    createdAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
}

// ---------------------------------------------------------------------------
// rematch — Odayı lobiye sıfırlar, aynı davet kodu ile tekrar oynanabilir.
// ---------------------------------------------------------------------------
exports.rematch = onCall(async (request) => {
  const uid = await requireAuth(request);
  const { roomId } = request.data || {};
  if (!roomId) throw new HttpsError("invalid-argument", "roomId gerekli.");
  const roomRef = db.collection("rooms").doc(roomId);
  await requirePlayerInRoom(roomRef, uid);

  const [marketSnap, secretsSnap, tradesSnap] = await Promise.all([
    roomRef.collection("market").get(),
    roomRef.collection("marketSecrets").get(),
    roomRef.collection("trades").get(),
  ]);

  const batch = db.batch();
  marketSnap.forEach((d) => batch.delete(d.ref));
  secretsSnap.forEach((d) => batch.delete(d.ref));
  tradesSnap.forEach((d) => batch.delete(d.ref));

  const playersSnap = await roomRef.collection("players").get();
  playersSnap.forEach((d) => {
    batch.update(d.ref, { ready: false, tokens: 0, inventory: [], score: 0 });
  });

  batch.update(roomRef, {
    status: "lobby",
    round: 0,
    roundEndsAt: null,
    countdownEndsAt: null,
    winnerUid: null,
  });

  await batch.commit();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// cleanupStaleRooms — 6 saatten eski, bitmiş/terk edilmiş odaları siler.
// ---------------------------------------------------------------------------
exports.cleanupStaleRooms = onSchedule("every 24 hours", async () => {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 6 * 60 * 60 * 1000);
  const staleSnap = await db.collection("rooms").where("createdAt", "<", cutoff).get();
  const deletions = [];
  for (const doc of staleSnap.docs) {
    deletions.push(deleteRoomRecursive(doc.ref));
  }
  await Promise.all(deletions);
});

async function deleteRoomRecursive(roomRef) {
  const subcollections = ["players", "market", "marketSecrets", "trades", "chat", "reveal"];
  for (const name of subcollections) {
    const snap = await roomRef.collection(name).get();
    const batch = db.batch();
    snap.forEach((d) => batch.delete(d.ref));
    if (!snap.empty) await batch.commit();
  }
  await roomRef.delete();
}
