import { App } from './ui/app.ts';

const app = new App();
app.start();

// Hata ayiklama / gosteri sirasinda konsoldan bakabilmek icin.
// window.kama.debug() tum katmanlarin ham sayaclarini dokumler.
(globalThis as unknown as { kama: App }).kama = app;
