import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';

import webhookRouter from './webhook.js';
import apiRouter from './api.js';
import uploadsRouter, { UPLOAD_DIR, limparAntigos } from './uploads.js';
import { attachSocketServer } from './ws.js';
import { iniciarWorker } from './worker.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || true,
    credentials: true
  })
);

app.get('/', (req, res) => res.json({ ok: true, service: 'sereia-cs', version: '0.1.0' }));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/webhook', webhookRouter);
app.use('/api', apiRouter);
app.use('/api/mensagens', uploadsRouter);   // upload de anexo (multipart)
app.use('/files', express.static(UPLOAD_DIR, { maxAge: '7d' })); // 2chat baixa daqui

app.use((err, req, res, next) => {
  console.error('[server] erro não tratado:', err);
  res.status(500).json({ error: 'internal' });
});

const httpServer = createServer(app);
attachSocketServer(httpServer);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[server] sereia-cs rodando em :${PORT}`);
  iniciarWorker();
  setInterval(limparAntigos, 6 * 60 * 60 * 1000); // a cada 6h
});
