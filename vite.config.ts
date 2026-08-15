import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const CERT_DIR = path.resolve(__dirname, 'server/certs');
const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');
const hasCert = fs.existsSync(keyPath) && fs.existsSync(certPath);

// Dev sunucusu: sinyallesme ayri portta kosar, /ws proxy ile ayni
// origin'den gorunur — istemci her iki modda da location.host kullanir.
const SIGNAL_PORT = Number(process.env.SIGNAL_PORT ?? 8443);
const signalTarget = `${hasCert ? 'https' : 'http'}://127.0.0.1:${SIGNAL_PORT}`;

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: hasCert ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) } : undefined,
    proxy: {
      '/ws': {
        target: signalTarget,
        ws: true,
        secure: false,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
