/**
 * LAN icin self-signed sertifika uretir (server/certs/{key,cert}.pem).
 * openssl gerekir — Windows'ta Git for Windows ile birlikte gelir.
 *
 *   npm run cert
 *
 * Sertifika, makinenin tum LAN IPv4 adresleri icin SAN icerir; telefon
 * "gelismis -> devam et" diyerek kabul edebilir.
 *
 * openssl yoksa: README'deki chrome://flags yolunu kullanin (daha hizli).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(__dirname, 'certs');

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const addrs = lanAddresses();
if (addrs.length === 0) console.warn('uyari: LAN IPv4 adresi bulunamadi, yalniz localhost eklenecek');

fs.mkdirSync(CERT_DIR, { recursive: true });

const sans = ['DNS:localhost', 'IP:127.0.0.1', ...addrs.map((a) => `IP:${a}`)].join(',');
const confPath = path.join(CERT_DIR, 'openssl.cnf');

fs.writeFileSync(
  confPath,
  [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = ext',
    'prompt = no',
    '',
    '[dn]',
    'CN = kama-engine',
    '',
    '[ext]',
    // iOS, sertifikayi "Sertifika Guveni Ayarlari"nda gosterebilmek icin
    // CA:TRUE ister. Sadece uyariyi gecmek iOS'ta yetmez — profil olarak
    // kurulup tam guven verilmesi gerekir, yoksa WebSocket bile acilmaz.
    'basicConstraints = critical, CA:TRUE',
    'keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${sans}`,
    '',
  ].join('\n'),
  'utf8',
);

try {
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-keyout', path.join(CERT_DIR, 'key.pem'),
      '-out', path.join(CERT_DIR, 'cert.pem'),
      '-config', confPath,
    ],
    { stdio: 'inherit' },
  );
  console.log('');
  console.log('Sertifika uretildi:', CERT_DIR);
  console.log('SAN:', sans);
  console.log('Artik "npm start" HTTPS ile calisacak.');
  console.log('');
  console.log('iPhone/iPad icin (uyariyi gecmek YETMEZ):');
  console.log('  1. Telefonda Safari ile  https://<LAN-IP>:8443/kama-cert.crt  adresini ac');
  console.log('  2. "Izin Ver" -> profil indirilir');
  console.log('  3. Ayarlar > Genel > VPN ve Aygit Yonetimi > profili Yukle');
  console.log('  4. Ayarlar > Genel > Hakkinda > Sertifika Guveni Ayarlari');
  console.log('     -> "kama-engine" anahtarini AC  (bu adim atlanirsa kamera acilmaz)');
  console.log('  5. Safari ile  https://<LAN-IP>:8443/  adresine gir');
} catch (err) {
  console.error('');
  console.error('openssl calistirilamadi. Iki secenek var:');
  console.error('  1) Git for Windows kurulu ise Git Bash icinden "npm run cert" deneyin.');
  console.error('  2) Sertifikayi hic uretmeyin; README\'deki chrome://flags');
  console.error('     #unsafely-treat-insecure-origin-as-secure yolunu kullanin (daha hizli).');
  process.exitCode = 1;
  void err;
}
