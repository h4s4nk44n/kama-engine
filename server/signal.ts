/**
 * WebSocket sinyallesme + statik dosya sunucusu.
 *
 * Tek oda, iki esles. offer/answer/ICE mesajlari oldugu gibi karsi
 * tarafa iletilir; sunucu icerige bakmaz.
 *
 * Ayni sunucu `dist/` altindaki Vite build ciktisini da servis eder.
 * server/certs/{key,cert}.pem varsa HTTPS, yoksa HTTP ile calisir.
 * (getUserMedia ve WebCodecs guvenli baglam ister — README'ye bak.)
 *
 *   node server/signal.ts
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CERT_DIR = path.join(__dirname, 'certs');

/** Laptop bu porttan girer — localhost duz HTTP'de guvenli baglam sayilir. */
const HTTP_PORT = Number(process.env.PORT ?? 8080);
/** Telefon bu porttan girer — LAN IP'si icin HTTPS sart. */
const TLS_PORT = Number(process.env.TLS_PORT ?? 8443);

const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // iOS/Android'in sertifikayi profil olarak kurabilmesi icin indirme
  // ucu. MIME turu onemli: iOS bunu gorunce profil yukleme akisini acar.
  if (urlPath === '/kama-cert.crt' || urlPath === '/cert.pem') {
    if (!fs.existsSync(certPath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Sertifika yok — once "npm run cert" calistirin.');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="kama-engine.crt"',
    });
    fs.createReadStream(certPath).pipe(res);
    return;
  }

  // Sayfanin "telefon bu adrese girsin" satirini gosterebilmesi icin.
  // Laptop localhost'ta oldugundan LAN adresini kendisi bilemez.
  if (urlPath === '/lan.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      JSON.stringify({
        addresses: lanAddresses(),
        httpPort: HTTP_PORT,
        tlsPort: TLS_PORT,
        https: hasCert,
      }),
    );
    return;
  }

  let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);

  // Dizin disina cikma korumasi
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dist/ bulunamadi — once "npm run build" calistirin.');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

// --- HTTP ve HTTPS ayni anda ---
//
// Laptop  : http://localhost:PORT       sertifika uyarisi YOK
//           (localhost duz HTTP'de de guvenli baglam sayilir, getUserMedia calisir)
// Telefon : https://<LAN-IP>:TLS_PORT   sertifika kurulumu gerekli
//
// Iki dinleyici ayni oda kaydini paylasir; farkli origin'lerden gelen iki
// esles yine de eslesir. Medya zaten P2P DataChannel uzerinden akar.

const hasCert = fs.existsSync(keyPath) && fs.existsSync(certPath);
const httpServer = http.createServer(serveStatic);
const httpsServer = hasCert
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, serveStatic)
  : null;

// --- Sinyallesme ---

interface Room {
  peers: Set<WebSocket>;
}

const rooms = new Map<string, Room>();

function attachSignaling(srv: http.Server | https.Server): void {
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  wss.on('connection', onSignalingConnection);
}

function onSignalingConnection(ws: WebSocket): void {
  let roomName: string | null = null;

  ws.on('message', (raw) => {
    let msg: { type?: string; room?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      roomName = msg.room ?? 'kama';
      let room = rooms.get(roomName);
      if (!room) {
        room = { peers: new Set() };
        rooms.set(roomName, room);
      }
      // Oda doluysa KILITLEME — en eski eslesi dusur, yeni gelen girsin.
      // Unutulmus bir tarayici sekmesi yuzunden gercek cihazin disarida
      // kalmasi gosteriyi bozuyordu. "Son gelen kazanir" davranisi,
      // telefonu her acisinda calismasini garanti eder.
      while (room.peers.size >= 2) {
        const oldest = room.peers.values().next().value as WebSocket | undefined;
        if (!oldest) break;
        room.peers.delete(oldest);
        console.log(`[oda:${roomName}] oda doluydu, en eski esles dusuruldu`);
        try {
          oldest.send(JSON.stringify({ type: 'evicted' }));
        } catch {
          /* zaten kapali */
        }
      }

      room.peers.add(ws);
      console.log(`[oda:${roomName}] esles katildi (${room.peers.size}/2)`);

      if (room.peers.size === 2) {
        // Ikinci gelen initiator olur; ilk gelen teklifi bekler.
        const [first, second] = [...room.peers];
        first.send(JSON.stringify({ type: 'ready', initiator: false }));
        second.send(JSON.stringify({ type: 'ready', initiator: true }));
      }
      return;
    }

    // offer / answer / ice — icerige bakmadan diger eslese ilet
    if (!roomName) return;
    const room = rooms.get(roomName);
    if (!room) return;
    for (const peer of room.peers) {
      if (peer !== ws && peer.readyState === peer.OPEN) peer.send(raw.toString());
    }
  });

  ws.on('close', () => {
    if (!roomName) return;
    const room = rooms.get(roomName);
    if (!room) return;
    room.peers.delete(ws);
    console.log(`[oda:${roomName}] esles ayrildi (${room.peers.size}/2)`);
    for (const peer of room.peers) {
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ type: 'peer-left' }));
    }
    if (room.peers.size === 0) rooms.delete(roomName);
  });
}

// --- Baslat ---

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

attachSignaling(httpServer);
if (httpsServer) attachSignaling(httpsServer);

const addrs = lanAddresses();
const lan = addrs[0] ?? '<LAN-IP>';

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  kama-engine sinyallesme + statik sunucu');
  console.log('');
  console.log('  ==> LAPTOP  (sertifika uyarisi YOK, dogrudan acilir)');
  console.log(`      http://localhost:${HTTP_PORT}/`);
  console.log('');

  if (!httpsServer) {
    console.log('  ==> TELEFON');
    console.log(`      http://${lan}:${HTTP_PORT}/`);
    console.log('      Android Chrome : chrome://flags/#unsafely-treat-insecure-origin-as-secure');
    console.log(`                       kutuya  http://${lan}:${HTTP_PORT}  yaz, Enabled, Relaunch`);
    console.log('      iPhone / iPad  : bu yol YOK, once  npm run cert  calistirin.');
    console.log('');
  }
});

if (httpsServer) {
  httpsServer.listen(TLS_PORT, '0.0.0.0', () => {
    console.log('  ==> TELEFON  (HTTPS, sertifika kurulumu gerekli)');
    console.log(`      https://${lan}:${TLS_PORT}/`);
    console.log('');
    console.log('      iPhone / iPad ilk kurulum (uyariyi gecmek YETMEZ):');
    console.log(`        1. Safari ile ac : https://${lan}:${TLS_PORT}/kama-cert.crt`);
    console.log('        2. Ayarlar > Genel > VPN ve Aygit Yonetimi > profili Yukle');
    console.log('        3. Ayarlar > Genel > Hakkinda > Sertifika Guveni Ayarlari > kama-engine AC');
    console.log(`        4. Safari ile ac : https://${lan}:${TLS_PORT}/`);
    console.log('');
    console.log('      Android Chrome bu adresi dogrudan acabilir (uyariyi gecmek yeterli).');
    console.log('');
  });
}
