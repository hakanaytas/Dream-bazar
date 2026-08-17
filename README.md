# Rüya Pazarı (Dream Bazaar)

Gerçek zamanlı, çok oyunculu bir pazarlık / blöf / takas PWA'sı. Firebase
Authentication (Anonymous), Cloud Firestore, Cloud Functions ve Firebase
Hosting üzerine kurulmuştur.

## Dosya yapısı

```
index.html          Uygulama kabuğu — tüm ekranlar (giriş, lobi, oyun, sonuç)
style.css            Tasarım sistemi ("Değer Perdesi" imza motifiyle)
app.js               İstemci mantığı: ekran yönlendirme, gerçek zamanlı bağlar, ses
firebase.js          Firebase istemci SDK sarmalayıcısı
manifest.json        PWA manifesti
service-worker.js    Çevrimdışı app-shell önbelleği
firestore.rules      Güvenlik kuralları (ekonomiyi istemciden korur)
functions/index.js   Sunucu tarafı oyun doğrulamaları (Cloud Functions)
icons/               Tüm PWA/iOS/Android ikon boyutları (üretildi, hazır)
```

## Neden Cloud Functions?

Brief'te "hileyi önlemek için sunucu tarafında oyun doğrulamaları" isteniyor.
Sadece Firestore kurallarıyla bunu tam olarak sağlamak mümkün değil: rastgele
eşya değerlerini bir istemci üretirse, o istemci (host) değerleri baştan
bilir. Bu yüzden ekonomiyi ilgilendiren her şey — eşya değeri üretimi, satın
alma, takas sonuçlandırma, tur ilerletme, final puanlama — `functions/index.js`
içinde, Admin SDK ile ve transaction içinde yapılır. İstemciler bu verilere
`firestore.rules` sayesinde asla doğrudan yazamaz. Detaylar için her iki
dosyanın başındaki yorumlara bakabilirsin.

## Kurulum

```bash
npm install -g firebase-tools
firebase login
cd dream-bazaar
firebase use dream-f2ad5   # firebaseConfig'teki proje

# Cloud Functions bağımlılıkları
cd functions && npm install && cd ..
```

Firebase Console'da (proje: `dream-f2ad5`):
1. **Authentication → Sign-in method → Anonymous** özelliğini etkinleştir.
2. **Firestore Database** oluştur (production mode).
3. **Cloud Functions**, Blaze (pay-as-you-go) planı gerektirir — konsoldan
   planı yükselt (ücretsiz kotalar bu ölçekte bir oyun için genelde yeterlidir).

`firebase.json` dosyası yoksa (ilk kurulum) proje kökünde şunu oluştur:

```json
{
  "hosting": {
    "public": ".",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**", "functions/**", "gen_icons.py"],
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  },
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions" }
}
```

> Not: `rewrites` tek sayfa yönlendirmesi için var; ama uygulama zaten tek
> `index.html` kullandığından bu satır opsiyoneldir, isterseniz kaldırabilirsiniz.

## Dağıtım (deploy)

```bash
firebase deploy --only firestore:rules
firebase deploy --only functions
firebase deploy --only hosting
```

## Oyun tasarımı — önemli varsayımlar

Brief bazı oyun-içi sayısal detayları (tur süresi, başlangıç jetonu, puanlama
formülü) belirtmediği için makul varsayımlarla dolduruldu; bunları
`functions/index.js` en üstündeki sabitlerden kolayca değiştirebilirsin:

- **10 tur**, her turda pazara `oyuncu sayısı + 1` (3–9 arası) yeni eşya gelir.
- **Her turun süresi 90 saniye** — süre dolunca herhangi bir istemci
  `advanceRound` fonksiyonunu tetikler, sunucu süresi gerçekten dolmuş mu diye
  kendisi doğrular (idempotent, yarış durumu yok).
- **Başlangıç jetonu: 24.**
- **Eşya fiyatı ≠ gerçek değeri.** Fiyat, nadirlik ortalamasına yakın ayrı bir
  zar; gerçek değer nadirlik aralığında ayrı bir zar. Bu yüzden ucuz-ama-
  değerli ya da pahalı-ama-değersiz eşyalar çıkabilir — blöf ve pazarlığın
  kaynağı budur.
- **Final puanı = elindeki eşyaların gerçek değerleri toplamı + kalan jeton.**
- Takaslar tam serbest: birden fazla eşya + jeton aynı teklifte olabilir.

## Ses efektleri

Dış ses dosyası kullanılmadı (telif ve boyut kaygısıyla); tüm efektler
(`app.js` içindeki `sfx` nesnesi) Web Audio API ile anlık sentezlenir — küçük,
hızlı yüklenir ve düşük donanımlı telefonlarda sorunsuz çalışır.

## Bilinen sınırlamalar / sıradaki adımlar

- Oda kapasitesi kontrolü istemci tarafında yapılıyor; eşzamanlı katılımlarda
  nadir bir yarış durumu olabilir. Yüksek trafik beklenirse `joinRoomByCode`
  bir Cloud Function'a taşınabilir.
- Host lobiden ayrılırsa host rolü otomatik devrediliyor; oda tamamen boş
  kalırsa `cleanupStaleRooms` zamanlanmış fonksiyonu 24 saatte bir 6 saatten
  eski odaları temizler.
- Gerçek cihazlarda performans/pil testleri yapılmadı; büyük oda sayılarında
  (8 kişi) Firestore okuma sayısını izlemek faydalı olur.
