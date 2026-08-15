# kama-engine

Tarayıcı içinde çalışan, **kendi paket katmanı ve kendi Reed-Solomon FEC'i olan**
gerçek zamanlı görüntü motoru. Aynı LAN'daki iki tarayıcı arasında, `RTCPeerConnection`'ın
medya track'lerine **hiç dokunmadan** görüntü taşır.

```
getUserMedia
  → VideoEncoder (WebCodecs)            ← tarayıcı codec'i
  → fragmentation                       ← BİZİM KODUMUZ
  → RS FEC encode                       ← BİZİM KODUMUZ
  → kayıp enjeksiyonu                   ← BİZİM KODUMUZ
  → yapay gecikme kuyruğu               ← BİZİM KODUMUZ
  → RTCDataChannel (güvenilmez)         ← ham datagram taşıyıcı
       ↓
  → grup birleştirme                    ← BİZİM KODUMUZ
  → RS FEC decode                       ← BİZİM KODUMUZ
  → ARQ: NACK / seçici retransmit       ← BİZİM KODUMUZ
  → chunk yeniden inşası                ← BİZİM KODUMUZ
  → VideoDecoder (WebCodecs)            ← tarayıcı codec'i
  → canvas
```

`addTrack` / `ontrack` kod tabanında hiçbir yerde geçmez. Kanal
`{ ordered: false, maxRetransmits: 0 }` ile açılır — SCTP retransmit devreye
girmez, sıra garantisi yoktur; gerçek bir güvenilmez datagram taşıyıcısıdır.

Ekranda **üç panel** yan yana durur: aynı kamera, aynı encoder, aynı fragman
listesi ve aynı kayıp deseniyle beslenen üç ayrı koruma stratejisi.

---

## Hızlı başlangıç

```bash
npm install
npm test          # 73 test: FEC + wire + kayıp modeli
npm run build
npm start
```

Sunucu **iki dinleyiciyi birden** açar ve hangi cihazın hangi adrese gireceğini yazar:

```
  ==> LAPTOP  (sertifika uyarisi YOK, dogrudan acilir)
      http://localhost:8080/

  ==> TELEFON  (HTTPS, sertifika kurulumu gerekli)
      https://192.168.1.179:8443/
```

### Laptop

Chrome'da **`http://localhost:8080/`** → **Başlat**. Hepsi bu.

Sertifika uyarısı çıkmaz: `localhost` düz HTTP'de de **güvenli bağlam** sayılır,
`getUserMedia` ve WebCodecs sorunsuz çalışır. Doğrulandı — `isSecureContext: true`.

Telefon olmasa da çalışır: eşleş yoksa taşıyıcı **loopback**'e düşer, datagramlar
yine fragmentation → FEC → kayıp enjeksiyonu → RS decode yolundan geçer ve iki panel
karşılaştırması aynen görünür.

### Telefon

Aşağıdaki "Telefondan bağlanma" bölümüne bakın. İki dinleyici **aynı oda kaydını
paylaşır**: laptop `http://localhost:8080`, telefon `https://LAN-IP:8443` üzerinde
olsa bile eşleşirler (doğrulandı). Medya zaten P2P DataChannel'dan akar, origin'den
bağımsızdır.

İki taraf da sayfayı açtığında eşleşme kendiliğinden kurulur; **Başlat**'a basınca
çift yönlü görüntü akar.

Laptop sayfası, eşleş bağlanana kadar üstte **telefonun gireceği adresi** gösterir
(sunucudan `/lan.json` ile alınır — laptop `localhost`'ta olduğu için LAN adresini
kendisi bilemez). Eşleş bağlanınca bu çubuk kaybolur.

> Portlar: `PORT` (HTTP, varsayılan 8080) ve `TLS_PORT` (HTTPS, varsayılan 8443).
> HTTPS yalnızca `server/certs/` varsa açılır.

### İki cihaz bağlanmıyorsa

Sırayla bunlara bakın — durum satırı zaten ne olduğunu yazar:

| Durum satırı | Anlamı | Çözüm |
|---|---|---|
| `eşleş bekleniyor` | Karşı taraf odaya hiç girmedi | Telefonda sayfa gerçekten açıldı mı? Adres doğru mu? |
| `başka bir cihaz bağlandı` | Bu sekme yenisi tarafından düşürüldü | Kullanmak istediğiniz sekmeyi **yenileyin** |
| `bağlanıyor` takılı kaldı | Sinyalleşme tamam, ICE kurulamıyor | İki cihaz aynı Wi-Fi'da mı? Misafir ağı / AP isolation olmasın |
| `bağlantı başarısız` | ICE başarısız | Aynı ağ, cihaz izolasyonu kapalı olmalı |
| Sayfa hiç açılmıyor (telefon) | Güvenlik duvarı ya da yanlış IP | Aşağıya bakın |

- **Oda iki eşleş alır, "son gelen kazanır".** Üçüncü bir sekme girerse oda
  kilitlenmez — **en eski eşleş düşürülür** ve yeni gelen içeri alınır. Düşen sekme
  `başka bir cihaz bağlandı` yazar ve kendiliğinden geri girmeye çalışmaz (yoksa iki
  sekme birbirini sürekli atardı). Böylece unutulmuş bir sekme yüzünden telefon
  dışarıda kalmaz; hangi sekmeyi kullanmak istiyorsanız onu yenilemeniz yeter.
- **Aynı Wi-Fi şart.** Telefon mobil veriye düşmüşse bağlanamaz. Misafir ağlarındaki
  *client isolation* cihazların birbirini görmesini engeller.
- **Windows Güvenlik Duvarı** `node.exe` için gelen bağlantıya izin vermeli. İlk
  çalıştırmada çıkan uyarıda izin verilmediyse kural eklenmemiş olur:
  ```
  netsh advfirewall firewall add rule name="kama-engine" dir=in action=allow protocol=TCP localport=8080,8443
  ```
- **IP değişirse** (Wi-Fi'a yeniden bağlanma, router yeniden başlatma) sertifikadaki
  SAN eşleşmez; `npm run cert` ile yeniden üretip telefondaki eski profili silin.

---

## Telefondan bağlanma

`getUserMedia` ve WebCodecs **güvenli bağlam** ister. `localhost` muaftır, ama
telefon LAN IP'sine bağlanacağı için düz HTTP'de kamera açılmaz. Hangi telefon
olduğuna göre yol değişiyor.

### Android Chrome — chrome://flags (hızlı)

1. `chrome://flags/#unsafely-treat-insecure-origin-as-secure` aç
2. Kutuya sunucunun yazdırdığı LAN adresini yaz: `http://192.168.1.179:8080`
3. **Enabled** yap, **Relaunch**'a bas
4. `http://192.168.1.179:8080/` adresine git

Sertifika uğraşı yok. Masaüstü Chrome'da da aynı flag ile LAN IP'si test edilebilir.

### iPhone / iPad — sertifika kurmak zorunlu

**iOS'ta `chrome://flags` yolu yoktur.** iOS'taki her tarayıcı (Chrome dahil)
WebKit kullanır, yani hepsi Safari'dir. Ayrıca iOS'ta sertifika uyarısını "Devam et"
ile geçmek **yetmez** — sertifika profil olarak kurulup *tam güven* verilmediği
sürece WebSocket bağlantısı bile açılmaz, dolayısıyla eşleşme kurulamaz.

```bash
npm run cert      # openssl gerekir (Windows'ta Git Bash içinden çalıştırın)
npm start         # artık HTTPS
```

Sonra telefonda, **sırasıyla**:

1. Safari ile `https://192.168.1.179:8443/kama-cert.crt` adresini aç
   → "Bu web sitesi bir yapılandırma profili indirmeye çalışıyor" → **İzin Ver**
2. **Ayarlar → Genel → VPN ve Aygıt Yönetimi** → indirilen profili **Yükle**
3. **Ayarlar → Genel → Hakkında → Sertifika Güveni Ayarları**
   → `kama-engine` anahtarını **AÇ**
   *(bu adım atlanırsa sayfa açılır ama kamera açılmaz — en sık yapılan hata)*
4. Safari ile `https://192.168.1.179:8443/` adresine git → **Başlat**

`npm start` HTTPS modunda açılışta bu adımları gerçek LAN adresinizle birlikte
zaten ekrana yazar.

> **iOS sürümü:** WebCodecs `VideoEncoder`/`VideoDecoder` iOS Safari **16.4+**
> ile geldi; iOS 16.3 ve öncesinde motor çalışmaz. Sayfa açılışta eksik API'leri
> ekranda listeler, tahmin etmenize gerek yok.
>
> **Kamera izni:** iOS 17.4+ bazı durumlarda kamera iznini her açılışta yeniden
> sorar; bu iOS'un davranışı.

### Sertifika olmadan iPhone'da denemek

Sertifikayla uğraşmak istemiyorsanız, telefonu **yalnızca alıcı** olarak
kullanamazsınız — güvenli bağlam olmadan sayfa hiç açılmaz. Alternatif, sunucuyu
gerçek bir HTTPS adresi arkasına koymaktır (ör. bir tünel servisi). Sinyalleşme
tünelden geçer, medya yine LAN üzerinde doğrudan akar — çünkü STUN yapılandırılmamıştır
ve ICE yalnızca host adaylarını kullanır.

---

## Arayüz

Tek sayfa, yan yana üç canvas, ortak kontrol paneli ve üstte tek satırlık durum.

| Kontrol | Aralık | Varsayılan |
|---|---|---|
| Paket kaybı | 0–50 % | 30 |
| **RTT (yapay)** | **0–400 ms** | **60** |
| Bitrate | 150–3000 kbps | 750 |
| Koruma oranı `r` | 0.2–1.2 | 0.8 |
| `K_target` | 4–32 | 16 |
| Kayıp modeli | i.i.d. / Gilbert-Elliott | i.i.d. |
| Görüntü kaynağı | Kamera / Test deseni | Kamera |

Slider'lar kontrol kanalı üzerinden eşleşe de gönderilir; iki cihaz aynı ayarda kalır,
gösteri tek bir ekrandan yönetilebilir.

Ortak durum satırı: `kayıp %X · RTT Y ms · K=Z · M=W · overhead %V · fec: TypeScriptRsCodec · Chrome 148 · Windows`.
FEC çekirdeğinin adı burada görünür — WASM takıldığında değiştiği görülür.

### Üç panel ne gösteriyor

| Panel | FEC | ARQ | Ne olduğunu gösterir |
|---|---|---|---|
| **KORUMASIZ** | kapalı | kapalı | Ham kayıp: bir source sembolü eksikse tüm grup düşer |
| **FEC** | açık | kapalı | RS'in tek başına ne kadarını topladığı, karşılığında ödenen overhead |
| **FEC + ARQ** | açık | açık | FEC'in kaçırdığını seçici retransmit'in toplayabildiği kısım |

Her panelde: gönderilen/düşürülen paket, gerçekleşen kayıp %, kurtarılan paket ve
kurtarma oranı, grup kaybı, donma sayısı ve süresi, çizilen frame ve fps, overhead %.
Panel 3'te ayrıca NACK gönderilen/yanıtlanan, alınan retransmit, ARQ ile kurtarılan
grup, RTX bütçe kullanımı; ve büyük punto ile **`max_retries`** ve **`nack_infeasible`**.

### Karşılaştırma neden dürüst

Üç panel **aynı kamerayı, aynı encoder'ı, aynı fragman listesini ve aynı kayıp
desenini** kullanır. `EncodedVideoChunk` üç kez fragmanlanmaz — bir kez fragmanlanır,
üç boru hattı aynı PU listesini alır. Kablodan **tek bir datagram akışı** geçer;
kayıp kararı paket sıra numarasına (ordinal) göre bir kez verilir ve aynı fiziksel
paket üç birleştiriciye birden beslenir:

- `GroupAssembler(useFec: false)` — parity'yi kurtarma için kullanmaz
- `GroupAssembler(useFec: true)` — aynı paketler + parity, RS decode
- `GroupAssembler(useFec: true)` + `NackController` — ek olarak retransmit ister

Retransmit paketleri **yalnız panel 3'e** verilir; yoksa panel 2 de ARQ'dan
yararlanır ve karşılaştırma anlamsızlaşırdı. Retransmit'ler **ayrı bir ordinal
uzayı** kullanır, böylece ARQ etkinken bile ana desen kaymaz.

Doğrulama: konsolda `kama.patternCheck()` üç panelin aldığı orijinal paketlerin
hash'ini karşılaştırır — üçü eşit olmalı.

```js
kama.patternCheck()
// { hashes: { plain: "7b3ccc62", fec: "7b3ccc62", arq: "7b3ccc62" }, equal: true }
```

---

## ARQ — deadline fizibilitesi

ARQ'yu kör retransmit yapan bir sistemden ayıran şey: **RTT büyüdükçe kendini
kapatır.** Bir grubun oynatma deadline'ına kalan süre bir gidiş-dönüşü
kaldırmıyorsa NACK hiç üretilmez.

```
remaining   = groupDeadline - now
rttEst      = artificialRttMs + measuredRttMs
feasible    = remaining > rttEst * 1.1 + 15          (DECODE_BUDGET_MS = 15)
maxRetries  = feasible ? min(3, floor((remaining - 15) / (rttEst * 1.1))) : 0
```

`feasible === false` → NACK üretilmez, grup doğrudan kayıp sayılır,
`nack_infeasible` artar.

**`groupDeadline` hakkında:** 600 ms'lik bütçe grubun yakalanma anında başlar,
alıcının onu ilk gördüğü anda değil — paket alıcıya ulaşana kadar tek yön gecikme
kadarı zaten harcanmıştır:

```
groupDeadline = ilkVarış + 600 ms − rttEst/2
```

Bu düzeltme olmadan 400 ms RTT'de bile bir tur "sığıyor" görünür ve ARQ kendini
kapatmaz; oysa gelen sembol oynatma penceresini zaten kaçırmış olur. Düzeltmeyle
`max_retries` RTT ile beklenen şekilde düşer:

| RTT | `max_retries` |
|---|---|
| 20 ms | 3 |
| 60 ms | 3 |
| 200 ms | 2 |
| 300 ms | 1 |
| **400 ms** | **0 — ARQ kapalı** |

### Amplifikasyon korumaları

Bunlar olmadan ARQ kötü ağda kendi kendini besler:

1. **`min_resend_interval = max(rttEst, 100 ms)`** — aynı `(group_id, index)` için
   bu süre geçmeden tekrar NACK yok. Ayrıca **tur düzeyinde** de uygulanır: önceki
   turun yanıt şansı olmadan yeni tur açılmaz. Yalnız indeks bazında beklemek
   yetmiyordu — farklı indeksleri hemen isteyerek NACK patlaması üretilebiliyordu.
2. **Grup başına en fazla 3 NACK turu.**
3. Gönderici, önbellekte olmayan index'i **sessizce yok sayar**.
4. Gönderici, deadline'ı geçmiş gruba (600 ms) **yanıt vermez**.
5. **RTX bütçesi:** giden retransmit baytı / toplam gönderilen bayt ≤ 0.15.
   Aşılırsa NACK'ler yanıtsız bırakılır, `rtxBudgetExceeded` artar.

### Gönderici sembol önbelleği

Kapanan her FEC grubunun tüm sembolleri (source + parity) tutulur. **Sınırlar
zorunlu — sınırsız önbellek bellek sızıntısıdır:** en fazla 8 grup, 600 ms yaş,
toplam 4 MB. Ölçülen: 5 dakikalık akışta önbellek 4–5 grup / ~130 KB'da sabit
kalıyor, sonsuza kadar büyümüyor.

---

## Ölçülen davranış

Test deseni kaynağı, VP8, 640×360 @ 20 fps, `K_target = 16`, loopback ve gerçek
DataChannel üzerinde aynı sonuçlar. Değerler ~16 sn'lik pencerelerin farkı:

| Senaryo | KORUMASIZ | FEC | FEC + ARQ |
|---|---|---|---|
| kayıp %0, RTT 60 | 177 frame, 19 fps | 177 frame, 19 fps, overhead %44.9 | 177 frame, 19 fps |
| kayıp %30, RTT 60 | **0 fps**, 94 grup kaybı | 22 fps, 2 grup kaybı | 22 fps, **0 grup kaybı** |
| kayıp %30, RTT **400** | 0 fps, 94 grup kaybı | 20 fps, 2 grup kaybı | **panel 2 ile birebir aynı** — ARQ kapalı |
| kayıp %30, RTT 20, **r=0.30** | 0 fps, 107 grup kaybı | 5 frame, **70 grup kaybı** | 62 frame, **4 grup kaybı** |
| kayıp %45, RTT 60 | 0 frame | 12 frame, 39 grup kaybı | 52 frame, 6 grup kaybı — **sistemin sınırı** |

`r = 0.8` ve %30 kayıpta FEC zaten neredeyse her şeyi topluyor, dolayısıyla ARQ'nun
katkısı küçük görünür. **ARQ'nun asıl değeri FEC'in marjinal kaldığı yerde ortaya
çıkar:** `r`'yi 0.30'a çekmek FEC'i 70 grup kaybına düşürürken ARQ bunu 4'e indiriyor.

`K_target`'ı 16'dan 4'e çekmek, koruma oranı aynı kalsa bile kurtarmayı zayıflatır:
küçük grupta kayıp sayısının varyansı yüksektir, `M` eşiğini aşma olasılığı artar.

Retransmit'ler kayba tabidir: %30 kayıpta talep edilen sembollerin **%30.7'si**
yanıtsız kalıyor (ölçülen retransmit kaybı %30.4).

---

## Demo senaryosu

Slider'ları bu sırayla kaydırın; hikâye kendiliğinden anlaşılır.

1. **Kayıp 0, RTT 60.** Üç panel de akıcı. Tek fark: FEC panellerinde `overhead %45`
   görünüyor. *Mesaj: koruma bedava değil.*
2. **Kayıp'ı 30'a çekin.** KORUMASIZ anında donar, `grup kaybı` sayacı patlar.
   FEC panelleri akmaya devam eder, `kurtarılan` sayacı artar.
   *Mesaj: RS gerçekten çalışıyor.*
3. **Koruma oranı `r`'yi 0.30'a çekin.** Şimdi FEC de yetişemez — grup kaybı 70'e
   çıkar. FEC+ARQ paneli 4'te kalır, `ARQ ile kurtarılan grup` sayacı dolar.
   *Mesaj: ARQ, FEC'in kaçırdığını topluyor.*
4. **RTT'yi yavaşça 400'e çekin.** Büyük punto `max_retries` 3 → 2 → 1 → 0 diye
   düşer. Sıfıra indiği anda `nack_infeasible` artmaya başlar, NACK üretimi durur
   ve panel 3'ün metrikleri panel 2 ile eşitlenir.
   *Mesaj: ARQ gecikme bütçesi yetmediğinde kendini kapatıyor — kör retransmit
   yapmıyor.* **Demonun asıl anı budur.**
5. **RTT'yi 20'ye geri çekin.** `max_retries` 3'e döner, ARQ yeniden devreye girer.
6. **Kayıp'ı 45'e çekin.** Üç panel de bozulur. *Mesaj: her sistemin bir sınırı var,
   bu da bizimki.*
7. **Kayıp modelini Gilbert-Elliott yapın.** Aynı ortalama kayıpta gruplar daha çok
   ölür — kayıpların kümelenmesi FEC için düz kayıptan zordur.

`K_target`'ı 4'e çekmek 2. adımda ek bir gösteri sağlar: grup küçülür, kurtarma
zayıflar.

---

## Mimari

```
server/
  signal.ts            WebSocket sinyalleşme + statik dosya sunucu (+ opsiyonel HTTPS)
  genCert.ts           LAN için self-signed sertifika üretici
src/
  fec/
    index.ts           FecCodec arayüzü + activeCodec  ← TÜM ÇAĞRILAR BURADAN
    gf256.ts           GF(2^8) tabloları, mul, inv, 256×256 çarpım tablosu
    cauchy.ts          Cauchy generator matrisi (K,M) önbellekli
    rs.ts              encode / decode (yalnız silinti) + Gauss-Jordan matris tersi
    rs.test.ts         MDS tam tarama ve uçtan uca doğrulama
    index.test.ts      arayüz soyutlaması ve çekirdek değiştirilebilirliği
  wire/
    protectedUnit.ts   PU inşası, CRC-16/CCITT-FALSE, padding
    datagram.ts        10 baytlık başlık, NACK ve ping/pong paketleri
    groupBuilder.ts    gönderici tarafı FEC grup yönetimi
    groupAssembler.ts  alıcı tarafı grup birleştirme, kurtarma, açık grup görüntüsü
    wire.test.ts       PU/CRC/datagram/grup birim testleri
  net/
    channel.ts         RTCDataChannel sarmalayıcı + backpressure, loopback taşıyıcı
    lossPattern.ts     ordinal tabanlı ortak kayıp deseni (üç panel için tek kaynak)
    delayQueue.ts      yapay gecikme kuyruğu (FIFO korumalı) + RTT ölçer
    arq.ts             sembol önbelleği, NACK üretimi, fizibilite, RTX bütçesi
    signaling.ts       WS istemcisi, offer/answer/ICE
    lossPattern.test.ts / delay.test.ts / arq.test.ts / loss.test.ts
  media/
    sender.ts          getUserMedia → VideoEncoder → fragmentation (tek liste)
    receiver.ts        chunk yeniden inşası → VideoDecoder → canvas
  ui/
    app.ts             üç panel, kontroller, boru hattı bağlantısı
    metrics.ts         canlı sayaçlar ve overlay (ARQ satırları dahil)
  main.ts
```

### FEC çekirdeği değiştirilebilir

`rs.ts` doğrudan çağrılmaz. Araya ince bir arayüz konmuştur:

```ts
export interface FecCodec {
  readonly name: string;
  encode(source: Uint8Array[], M: number): Uint8Array[];
  decode(present: Array<{index: number; symbol: Uint8Array}>, K: number, M: number): Uint8Array[];
}
```

`src/fec/index.ts` tek bir aktif codec tutar; `groupBuilder` ve `groupAssembler`
yalnız oradan alır. Üretim kodunda `fec/rs.ts`'i doğrudan import eden dosya yoktur.
İleride C++/WASM çekirdek takıldığında değişecek tek şey:

```ts
setCodec(new WasmRsCodec());
```

Codec adı durum satırında görünür (`fec: TypeScriptRsCodec`), böylece WASM
takıldığında değiştiği anlaşılır. `index.test.ts` sahte bir çekirdek takıp wire
katmanının gerçekten arayüzden geçtiğini doğrular.

### FEC çekirdeği

GF(2⁸), indirgenemez polinom `0x11D`, üreteç `0x02`. Sıcak döngü önceden üretilmiş
256×256 çarpım tablosundan lookup yapar (`mulScaleXor`), `mul()` çağırmaz.

Generator matrisi Cauchy: `G[r][j] = inv((K + r) XOR j)`. `(K+r) ≥ K > j` olduğundan
XOR asla 0 olmaz. Cauchy matrisinin her kare altmatrisi tekil değildir, dolayısıyla
`[I ; G]` sistematik üreteç matrisinin **her K×K altmatrisi tersinirdir** (MDS).
Vandermonde bu garantiyi vermez, kullanılmadı.

Decode yalnız silinti (erasure) kodlamasıdır: kayıp indeksleri bilinir, dolayısıyla
sendrom, hata konum polinomu ve Chien araması yoktur. Tek iş K×K matris tersidir.
Gelen semboller indekse göre sıralanır, **en küçük indeksli K tanesi** seçilir —
deterministik.

Testler `(2,3)`, `(4,4)`, `(6,4)`, `(6,5)` için **C(N,K) altmatrisin tamamını** tarar
ve her biri için `A · A⁻¹ = I` doğrular; `(16,13)`, `(32,8)`, `(80,24)` için 300
rastgele altmatris örnekler. Uçtan uca her `(K,M)` için 60 koşum, tam `M` silinti,
kurtarılan baytlar orijinalle birebir karşılaştırılır.

### Wire

**Protected Unit** (13 baytlık başlık + payload, `symbol_size`'a sıfır dolgulu):

```
0-1    pu_len        uint16 BE   = 12 + payload_len
2-5    chunk_id      uint32 BE
6      chunk_flags   uint8       bit7 = keyframe
7-8    frag_index    uint16 BE
9-10   frag_count    uint16 BE
11-12  pu_crc        uint16 BE   CRC-16/CCITT-FALSE
13-    payload
```

`pu_crc` bayt 0–10 **ve** payload üzerinden hesaplanır; crc alanının kendisi hesaba
girmez. Bilinen vektör doğrulanıyor: `"123456789"` → `0x29B1`. Kurtarılan her PU
teslim edilmeden önce CRC'den geçer; tutmazsa iskarta edilir ve `crcFailures` artar.
CRC olmadan bozuk bir sembolün tesadüfen geçme olasılığı ~%9; CRC ile 2⁻¹⁶.

**Datagram** (sabit 10 baytlık başlık, big-endian, mask/shift):

```
0      version       uint8    = 0x01
1      flags         uint8    bit7 = is_parity
2-3    group_id      uint16 BE
4      index         uint8    source: block_index, parity: r
5      K             uint8    1..80
6      M             uint8    0..32
7-8    symbol_size   uint16 BE
9      reserved      uint8    = 0
10-    symbol        symbol_size bayt
```

`K` ve `M` her datagramda taşınır; alıcı ilk gelen paketten grubu boyutlandırır,
repair paketini beklemez. En büyük paket 1178 bayt (≤ 1200).

Grup, `K_target` dolunca / keyframe chunk'ı tamamlanınca (anında) / `window_ms`
(200 ms) dolunca kapanır. `M = max(1, ceil(K · r))`, üst sınır 32.

Alıcıda karar: tüm K source geldi → doğrudan teslim, decode yok; gelen ≥ K → RS
decode; gelen < K → grup kaybı. Gruplar 600 ms sonra veya `group_id` 32 ilerleyince
temizlenir, en fazla 64 açık grup tutulur.

### Kayıp enjeksiyonu

`channel.send()` **öncesi** uygulanır — mobilde de çalışır, `tc` gerekmez.

Source paketlerinin kayıp kararları tek bir tohumlu akıştan gelir ve bu akış FEC
oranından bağımsızdır; parity ayrı bir akış kullanır. Böylece `r` veya `K_target`
değiştiğinde source kayıp deseni kaymaz. Her paket için `p = 0` olsa bile tam bir
çekiliş yapılır, akıştaki konum yalnızca paket sayısına bağlıdır.

Gilbert-Elliott: `pGoodToBad = p·r/(1−p)`, `pBadToGood = r = 0.632`, durgun
`P(Bad) = p`. Paket **içinde bulunduğu duruma** göre değerlendirilir, zincir sonra
ilerler; geçişi tetikleyen paketi de kayıp saymak durgun oranı `p`'nin üzerine
çıkarırdı. Ortalama burst ≈ 1.58 paket. Source ve parity kendi zincirlerini
ilerletir. Testlerle doğrulanıyor.

---

## Taşıma: medya UDP üzerinde, TCP yalnızca sinyalleşmede

Sık sorulan soru olduğu için ölçümle cevaplanıyor. `RTCDataChannel`'ın altındaki
yığın şudur:

```
uygulama (bizim datagramlarımız)
  → SCTP        ordered:false, maxRetransmits:0  → güvenilirlik KAPALI
  → DTLS        şifreleme
  → UDP         kablodaki gerçek protokol
```

`{ ordered: false, maxRetransmits: 0 }` SCTP'nin yeniden gönderim ve sıralama
mekanizmalarını devre dışı bırakır; geriye gerçek bir güvenilmez datagram
taşıyıcısı kalır. Kaybolan paket kaybolur — zaten FEC ve ARQ bunun için var.

**TCP nerede kullanılıyor:** yalnızca sinyalleşmede (WebSocket) ve sayfanın
kendisini indirirken (HTTP). Offer/answer/ICE alışverişi bittikten sonra medya
o bağlantıya hiç dokunmaz.

Bu tahmin değil — sayfa protokolü tarayıcının kendi istatistiklerinden
(`RTCPeerConnection.getStats()`, seçilen ICE aday çifti) okur ve üstteki satırda
gösterir:

```
SCTP/DTLS/UDP · ordered:false · maxRetransmits:0 · host/host · ağ RTT 1 ms
```

Satır UDP değilse **kırmızıya** döner. Konsoldan da bakılabilir:

```js
kama.debug().wire
// { protocol: "udp", localType: "host", remoteType: "host",
//   dtlsState: "connected", sctpState: "connected", rttMs: 1 }
```

ICE sunucusu tanımlı değildir; aynı LAN'da yalnızca `host` adayları kullanılır,
yani doğrudan UDP. (Bir TURN sunucusu tanımlanıp TCP yedeğine düşülseydi bu
satır `SCTP/DTLS/TCP` gösterirdi.)

> **Sınır:** Tarayıcıda ham UDP soketi yoktur. DataChannel UDP üzerine SCTP+DTLS
> çerçevelemesi ekler; dolayısıyla kabloda "çıplak UDP" değil, UDP taşıyan bir
> WebRTC akışıdır. Tarayıcı dışı bir UDP ucuyla (ör. C++ sunucu) doğrudan
> konuşmak gerekiyorsa iki yol var: sunucu tarafında bir WebRTC/SCTP köprüsü,
> ya da WebTransport (QUIC datagramları, yine UDP). Motorun kendisi taşıyıcıdan
> bağımsızdır — `DatagramTransport` arayüzünü uygulayan başka bir taşıyıcı
> takılabilir.

## Gecikme ve akıcılık: gönderim gruplamadan ayrıdır

İlk sürümde bir FEC grubunun **tamamı** (source + parity) grup kapanınca birlikte
gönderiliyordu. `K_target=16` ve ~4.6 fragman/kare ile bu, **~3.5 karelik bir yığın**
demekti: kayıp sıfır olsa bile kareler 4'erli patlamalar hâlinde çıkıyor, aralarda
~175 ms boşluk kalıyordu. `K_target` hem FEC blok boyu hem de gönderim yığın boyu
olarak çalışıyordu.

Artık ikisi ayrı:

- **Source datagramı** fragman üretilir üretilmez kabloya çıkar, grubu beklemez.
- **Parity** grup kapanınca gönderilir; yalnızca *eksikleri onarmak* için vardır.
- **Alıcı** gelen source sembolünü anında üst katmana iletir; grup kapanışında
  yalnızca RS ile *kurtarılanlar* eklenir (aynı PU iki kez teslim edilmez).
- Chunk'lar sırasız tamamlanabildiği için (kurtarma bekleyen chunk N dururken N+1
  hemen biter) decoder'a **sıralı besleme** yapan küçük bir yeniden sıralama
  tamponu var. Sırası gelmeyen chunk `CHUNK_TIMEOUT_MS` sonra atlanır.

`K/M/symbol_size`: source datagramları bunları **tahmin** olarak taşır (grup henüz
kapanmamıştır); parity gerçek değerleri taşır ve alıcıda **otoritedir**. Source
sembolleri kendi doğal boylarında gider — küçük fragman küçük paket olur, dolgu
israfı yoktur; alıcı RS decode öncesi grup `symbol_size`'ına sıfırla doldurur.

Ölçüm (test deseni, VP8 640×360@20fps, 750 kbps, kayıp %0, K=16), çizimler arası
boşluk dağılımı:

| | Önce | Sonra |
|---|---|---|
| medyan | 4.4 ms | **49.7 ms** (tam bir kare) |
| p90 | 176.6 ms | **56.1 ms** |
| en büyük | ~2079 ms | **72 ms** |
| 120 ms üstü boşluk | 160 / 569 | **0 / 957** |
| donma / grup kaybı | 9 / 8 | **0 / 0** |

Kayıp %30, RTT 60 ms, 20 sn (çizilen kare / grup kaybı):

| Panel | Kare | Grup kaybı | fps |
|---|---|---|---|
| KORUMASIZ | 4 | 118 | 0 |
| FEC | 313 | 4 | 18 |
| FEC + ARQ | 383 | 1 | 18 |

## Tasarım notları ve şartnameden sapmalar

1. **`pu_len` formülü.** Şartname `pu_len`'i `= 12 + payload_len` *ve* "byte 2'den
   sona" diye tarifliyor; bu iki ifade bir bayt kayıyor (bayt 2–12 = 11 bayt).
   Normatif olan formül alındı: `pu_len = 12 + payload_len`, çözümlemede
   `payload_len = pu_len − 12`.

2. **Tek kablo akışı.** Şartname sol panel için "parity üretilmez" diyor. Burada
   parity her zaman üretilir ve tek bir akış olarak gönderilir; sol panel onu
   *kurtarma için* kullanmaz. Sebep: şartnamenin asıl talebi olan "aynı kayıp
   deseni" ancak böyle **bit birebir** sağlanabilir. İki ayrı akış gönderilseydi
   iki farklı kayıp gerçekleşmesi olurdu. Sol panelin `overhead` metriği 0 kalır.
   Sol panel parity başlıklarını yalnızca grubun varlığını ve `K`'sini öğrenmek
   için okur (sembolü kullanmaz) — bu olmadan, source'u tamamen kaybolmuş gruplar
   sol panelde yalnızca `group_id` boşluğundan tahmin edilir ve iki panelin
   "beklenen" sayaçları birbirinden kayar.

3. **Chunk zaman damgası.** PU başlığı zaman damgası taşımıyor; `EncodedVideoChunk`
   damgası `chunk_id`'den türetilir (`chunk_id × 50000 µs`). Chunk tamamen düşse bile
   tek yönlü artan ve eşit aralıklı kalır.

4. **Keyframe kapısı.** Şartname "keyframe düşerse sonraki keyframe'e kadar delta
   chunk'lar da atılır" diyor. Burada daha sıkı davranılıyor: **herhangi** bir chunk
   düştüğünde referans zinciri kırık sayılır. Bozuk referansla beslenen VideoDecoder
   yalnız görsel çöp üretmiyor, hata verip kapanabiliyor.

5. **Test deseni kaynağı.** Kamerasız/izinsiz makinede motorun tam boru hattı yine
   koşabilsin diye hareketli bir canvas kaynağı eklendi. `getUserMedia` başarısız
   olursa otomatik olarak buna düşer, arayüzde açıkça belirtilir. Desen
   `setInterval` ile yapılandırılan framerate'te üretilir — `requestAnimationFrame`
   ekran tazeleme hızına bağlı ve arka plandaki sekmelerde tamamen durur.

6. **Loopback modu.** Eşleş yokken taşıyıcı loopback'e düşer. Datagramlar yine
   fragmentation → FEC → kayıp enjeksiyonu → RS decode yolundan geçer; yalnızca
   fiziksel ağ yoktur. Tek tarayıcıda gösteri/hata ayıklama için.

7. **Kare kaynağı.** `MediaStreamTrackProcessor` masaüstü Chrome'da kullanılır;
   Chrome Android ve iOS Safari'de bulunmadığı için `<video>` +
   `requestVideoFrameCallback` + `new VideoFrame(video)` yoluna düşülür. Aktif yol
   arayüzde gösterilir.

8. **Codec pazarlığı.** Alıcı, **karşı tarafın** encoder'ının bildirdiği gerçek
   `decoderConfig` ile yapılandırılır — kendi encoder'ının seçtiği codec'le değil.
   Codec dizesi ve (H.264 avcC gibi formatlarda gereken) `description` alanı,
   ilk chunk'ın metadata'sından alınıp güvenilir kontrol kanalından eşleşe
   gönderilir. Bu olmadan heterojen görüşme kesin kırılır: masaüstü Chrome VP8,
   iPhone Safari H.264 seçer ve iki taraf da karşısındakini çözemez.

9. **`rollup` → `@rollup/wasm-node` takması.** Bu makinede Windows Application
   Control, rollup'ın yerel `.node` ikilisini engelliyor. `package.json`'da
   `rollup` paketi WASM sürümüne takma ad ile bağlandı. Bu yalnızca **derleme
   aracını** ilgilendirir — FEC dahil motor kodunun tamamı saf TypeScript'tir,
   WASM kullanmaz. Engellemenin olmadığı makinelerde bu satır kaldırılabilir.

10. **ARQ deadline modeli.** Şartname `groupDeadline = ilkVarış + 600ms` diyor.
    Bu haliyle 400 ms RTT'de bile bir tur sığıyor ve ARQ kapanmıyor — oysa kabul
    kriteri 3 tam olarak kapanmasını istiyor. Çelişkiyi, bütçenin transit sırasında
    zaten harcanan kısmını düşerek çözdüm: `groupDeadline = ilkVarış + 600ms − rttEst/2`.
    Gerekçe README'nin ARQ bölümünde.

11. **`min_resend_interval` tur düzeyinde de uygulanıyor.** Şartname kuralı
    `(group_id, index)` bazında tanımlıyor. Yalnız bu haliyle, ilk turda istenmemiş
    *farklı* indeksler hemen istenebiliyor ve NACK patlaması oluşuyordu. Kural tur
    düzeyine genişletildi.

12. **NACK paketleri kayba tabi değil.** Yapay gecikmeden geçerler ama
    düşürülmezler. Böylece kabul kriteri 7'deki "yanıtsız NACK oranı ≈ kayıp oranı"
    ölçümü doğrudan retransmit kaybını yansıtır; ikisi de kayıplı olsaydı oran
    %51 çıkardı.

13. **Node tip sıyırma kısıtı.** `node --test` `.ts` dosyalarını doğrudan çalıştırır
    ama yalnız "silinebilir" TypeScript'i kabul eder: constructor parametre
    özellikleri (`private readonly x: T`) ve `enum` kullanılamaz. Test edilen
    modüller bunlardan kaçınır.

14. **Kaybolan paket ≠ kaybolan grup.** Şartname FEC kapalı yol için "gelen < K →
    grup kaybı, atla" diyordu. Burada gelen source PU'lar **teslim edilir**, yalnızca
    kaybolan gelmez; `groupsLost` sayacı yine artar. Gelmiş paketleri de çöpe atmak
    korumasız paneli iki kez cezalandırıyor ve kayıpsız durumda bile duraklamaya
    yol açıyordu — bkz. "Gecikme ve akıcılık".

15. **Bilinen sınır.** `K_target` / koruma oranı slider'ları akış ortasında hızlıca
    oynatılırken ~1000 grupta 1 kez korumasız panelde sahte bir grup kaybı
    görülebiliyor (grup parametreleri uçuştaki bir grubun ortasında değişiyor).
    Tek karelik bir etki, kendini toparlıyor; kovalanmadı.

16. **Testler.** Node 24 `.ts` dosyalarını doğrudan çalıştırır; `node --test` için
   ayrı bir derleme adımı yoktur.

---

## Bilinen sınırlar

Neyin **olmadığını** yazmak, olanın ne olduğunu netleştirir.

- **Interleaving yok.** Fragmanlar gruplara geldikleri sırayla girer. Bir burst
  tek bir grubun ardışık sembollerini vurur; serpiştirme olsaydı kayıp gruplara
  yayılır ve Gilbert-Elliott altında belirgin şekilde daha iyi dayanırdı. Bunun
  bedeli gecikmedir, o yüzden yapılmadı.
- **Adaptif bitrate yok.** Bitrate ve koruma oranı `r` elle ayarlanır. Gerçek bir
  sistem ölçülen kayba göre `r`'yi ve bitrate'i kendisi ayarlardı; burada
  parametrelerin etkisini görmek için sabit tutuluyorlar.
- **PLI / keyframe isteği yok.** Alıcı bir chunk kaybettiğinde referans zinciri
  kırılır ve sonraki keyframe'e kadar bekler (~2 sn). Gerçek sistem göndericiden
  anında keyframe isterdi. Donma sürelerinin uzun görünmesinin sebebi budur.
- **Ses yok.** `getUserMedia` yalnızca video ister. Ses ayrı bir hizalama ve
  jitter buffer problemi.
- **Jitter buffer / yeniden sıralama tamponu yok.** Chunk'lar tamamlanır
  tamamlanmaz decode edilir; oynatma saati yok.
- **Kongesyon kontrolü yok.** Yalnız `bufferedAmount` üzerinden basit backpressure
  var. Kayıp enjeksiyonu yapaydır, gerçek darboğaza tepki verilmez.
- **NACK paketleri kayba tabi değil.** Yapay gecikmeden geçerler ama düşürülmezler;
  yalnız retransmit'ler kayba uğrar. Böylece "yanıtsız NACK" oranı doğrudan
  retransmit kaybını ölçer.
- **Ping/pong ölçüm trafiği kayba ve yapay gecikmeye tabi değil.** `measuredRttMs`
  gerçek ağ turunu ölçer, yapay gecikme onun üstüne eklenir.
- **RTX bütçesi pratikte tetiklenmiyor.** Ölçülen kullanım %0.15–3 aralığında;
  %15 sınırı ancak çok agresif senaryolarda devreye girer. Mekanizma birim testiyle
  doğrulanmıştır (`KURAL 5`), canlı demoda tetiklendiği görülmez.
- **Tek oda, iki eşleş.** Üçüncü bir sekme girerse en eski eşleş düşürülür.

---

## Betikler

| Betik | Ne yapar |
|---|---|
| `npm run dev` | Vite dev sunucusu (:5173), `/ws` sinyalleşmeye proxy'lenir |
| `npm run build` | Tip kontrolü + `dist/` üretimi |
| `npm start` | Sinyalleşme + statik sunucu: HTTP :8080 (laptop) ve varsa HTTPS :8443 (telefon) |
| `npm run serve` | `build` + `start` |
| `npm test` | Tüm testler (132 adet) |
| `npm run test:fec` | FEC çekirdeği + arayüz soyutlaması |
| `npm run test:arq` | ARQ, gecikme kuyruğu, kayıp deseni |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run cert` | LAN için self-signed sertifika |

`npm run dev` kullanırken sinyalleşme sunucusunu ayrı bir terminalde
`npm start` ile çalıştırın; Vite `/ws` isteklerini ona proxy'ler.

---

## Hata ayıklama

```js
kama.debug()        // tüm katmanların ham sayaçları: taşıyıcı, kayıp deseni,
                    // RTT, gecikme kuyruğu, sender, ARQ, üç panel
kama.patternCheck() // üç panelin aldığı orijinal paketlerin hash'i — üçü eşit olmalı
```

`kama.debug().arq` içinde `raw` (NACK sayaçları), `cache` (önbellek boyutu ve
tahliye sayaçları) ve `txBytes` bulunur. Önbellek boyutunun sabit kalıp kalmadığını
buradan izleyebilirsiniz.

---

## Gereksinimler

| Platform | Durum |
|---|---|
| Masaüstü Chrome 111+ | ✅ doğrulandı (VP8, `MediaStreamTrackProcessor`) |
| Chrome Android | Beklenen: `<video>` + `requestVideoFrameCallback` yolu |
| iOS Safari 16.4+ | WebCodecs video arayüzleri var; sertifika kurulumu şart |
| iOS Safari ≤ 16.3 | ❌ WebCodecs yok |
| Safari masaüstü 26+ | Tam WebCodecs desteği |

Node 20+ (geliştirildiği sürüm: 24.19).

Sayfa açılışta eksik API'leri (`VideoEncoder`, `VideoDecoder`, `getUserMedia`,
güvenli bağlam) ekranda listeler — cihazın destekleyip desteklemediğini tahmin
etmenize gerek yok.
