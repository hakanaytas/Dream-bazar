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

## Sorun giderme — "oyun başlamıyor" / "butonlar çalışmıyor"

Bu genelde tek bir kök nedene çıkar: **Cloud Functions henüz deploy edilmemiş
ya da proje Blaze planına geçirilmemiş.** Oyunun ekonomiyle ilgili HER
işlemi (oyunu başlatma, satın alma, takas onaylama, tur ilerletme, hızlı
eşleştirme) `functions/index.js`'teki sunucu fonksiyonlarını çağırıyor;
bunlar deploy edilmeden lobi ekranındaki "Hazırım", pazar ekranındaki
"Satın Al" gibi butonlar tıklanınca artık **ekranda kırmızı bir toast olarak
hatayı gösteriyor** (önceden sessizce yutuyordu — bu değişti).

**Önemli:** Artık `window.onerror` ve `unhandledrejection` da yakalanıp
toast olarak gösteriliyor, yani JS tarafında ne patlarsa patlasın ekranda
görünecek. Bir sorun yaşarsan lütfen tarayıcıda **F12 → Console**'u aç,
kırmızı hatayı ya da ekranda çıkan toast metnini bana ilet — kesin teşhis
için en hızlı yol bu.

Kontrol listesi:
1. Firebase Console → proje **Blaze (pay-as-you-go)** planında mı?
2. `functions/` klasöründe `npm install` yapıldı mı, sonra
   `firebase deploy --only functions` çalıştırıldı mı?
3. Authentication → Sign-in method → **Anonymous** açık mı?
4. `firebase deploy --only firestore:rules` en güncel `firestore.rules` ile
   çalıştırıldı mı?
5. Tarayıcı konsolunda kırmızı bir hata var mı?

### "Hızlı Katıl" ile iki kişi eşleşmiyordu — düzeltildi

Önceki sürümde "Hızlı Katıl" istemci tarafında "boş oda var mı?" diye
sorup öyle katılıyordu. İki kişi neredeyse aynı anda bastığında ikisi de
henüz oda göremediği için **ayrı ayrı yeni oda açıyor**, hiç eşleşmiyor ve
60 saniye sonra "yeterli oyuncu yok" diyerek kendi kendine kapanıyordu.

Artık `quickJoin` tamamen `functions/index.js` içinde, tek bir Firestore
transaction'ı içinde çalışıyor: küçük bir "kuyruk" dokümanı (`matchmaking/
quickJoin`) üzerinden atomik olarak eşleştiriyor, bu yüzden iki oyuncu aynı
anda bassa bile aynı odada buluşmaları garanti.

### "Ana menüye dönme" özelliği eklendi

Oyun ve açılış (reveal) ekranlarının sol üstüne 🏠 **Ana Menü** butonu
eklendi. Buna basınca odadan tamamen ayrılmıyorsun (jetonların/eşyaların
korunur) — ana sayfada "Devam Eden Pazarın Var → Devam Et" bandı çıkar,
istediğin an kaldığın yerden geri dönebilirsin. Uygulamayı kapatıp tekrar
açsan bile bu bilgi tarayıcıda saklanır ve otomatik olarak kaldığın yere
döndürür.

### Genel dayanıklılık iyileştirmeleri

- Tüm buton bağlamaları artık birbirinden bağımsız (`on()` yardımcı
  fonksiyonu ile) — biri bir sebeple patlarsa diğerleri çalışmaya devam
  eder. Önceden bir buton bağlanırken hata fırlatsaydı, ondan SONRA
  bağlanacak tüm butonlar sessizce ölü kalıyordu.
- Açılış ekranı artık en fazla ~9 saniye bekliyor; bağlantı kurulamazsa
  sonsuza kadar dönen bir yükleme ekranında takılı kalmak yerine hatayı
  gösterip devam ediyor.
- Firebase CDN sürümü güncel stabil sürüme (`12.17.1`) yükseltildi.



- Oda kapasitesi kontrolü istemci tarafında yapılıyor; eşzamanlı katılımlarda
  nadir bir yarış durumu olabilir. Yüksek trafik beklenirse `joinRoomByCode`
  bir Cloud Function'a taşınabilir.
- Host lobiden ayrılırsa host rolü otomatik devrediliyor; oda tamamen boş
  kalırsa `cleanupStaleRooms` zamanlanmış fonksiyonu 24 saatte bir 6 saatten
  eski odaları temizler.
- Gerçek cihazlarda performans/pil testleri yapılmadı; büyük oda sayılarında
  (8 kişi) Firestore okuma sayısını izlemek faydalı olur.
