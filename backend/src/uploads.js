/**
 * Storage temporário pra anexos enviados pelo painel.
 *
 * Fluxo:
 *   1. Frontend envia arquivo pra POST /api/mensagens/upload (multipart)
 *   2. Backend salva em /data/uploads (volume Railway) ou ./uploads (dev)
 *   3. Devolve URL pública
 *   4. Backend usa essa URL no `url` do send-message do 2chat
 *   5. 2chat baixa e envia ao WhatsApp
 *   6. Arquivos com mais de 7 dias são removidos pelo worker
 */

import { Router } from 'express';
import { mkdirSync, existsSync, createWriteStream, statSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const UPLOAD_DIR = process.env.UPLOAD_DIR
  || (existsSync('/data') ? '/data/uploads' : resolve(process.cwd(), 'uploads'));

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
console.log('[uploads] diretório:', UPLOAD_DIR);

const router = Router();

/**
 * POST /api/mensagens/upload
 * Recebe um arquivo (multipart simples, primeiro arquivo do form).
 * Retorna: { url, nome, tipo, mime, tamanho }
 */
router.post('/upload', async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) {
    return res.status(400).json({ error: 'Content-Type deve ser multipart/form-data' });
  }
  const boundary = '--' + boundaryMatch[1];

  let raw = Buffer.alloc(0);
  req.on('data', (chunk) => { raw = Buffer.concat([raw, chunk]); });
  req.on('end', () => {
    try {
      const parts = splitBuffer(raw, Buffer.from('\r\n' + boundary));
      for (const part of parts.slice(1)) {
        const headerEndIdx = part.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEndIdx === -1) continue;
        const rawHeaders = part.slice(0, headerEndIdx).toString('utf8');
        const fileNameMatch = rawHeaders.match(/filename="([^"]+)"/);
        if (!fileNameMatch) continue;

        const mimeMatch = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i);
        const mime = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
        const originalName = fileNameMatch[1];

        let body = part.slice(headerEndIdx + 4);
        if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);

        const ext = extname(originalName) || '';
        const id = randomUUID() + ext;
        const dest = join(UPLOAD_DIR, id);

        const stream = createWriteStream(dest);
        stream.write(body);
        stream.end();

        const base = (process.env.TWOCHAT_WEBHOOK_BASE_URL || '').replace(/\/+$/, '');
        return res.json({
          url: `${base}/files/${id}`,
          nome: originalName,
          tipo: classificarMime(mime),
          mime,
          tamanho: body.length
        });
      }
      res.status(400).json({ error: 'Nenhum arquivo no upload' });
    } catch (err) {
      console.error('[uploads] erro:', err);
      res.status(500).json({ error: 'falha no upload' });
    }
  });
});

function splitBuffer(buf, sep) {
  const parts = [];
  let from = 0;
  let idx;
  while ((idx = buf.indexOf(sep, from)) !== -1) {
    parts.push(buf.slice(from, idx));
    from = idx + sep.length;
  }
  parts.push(buf.slice(from));
  return parts;
}

function classificarMime(mime) {
  if (mime.startsWith('image/')) return 'imagem';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'documento';
}

export function limparAntigos() {
  const limite = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const f of readdirSync(UPLOAD_DIR)) {
      const path = join(UPLOAD_DIR, f);
      try {
        const st = statSync(path);
        if (st.mtimeMs < limite) {
          unlinkSync(path);
          console.log('[uploads] removido:', f);
        }
      } catch { /* ignora */ }
    }
  } catch (err) { console.error('[uploads] limpeza falhou:', err); }
}

export { UPLOAD_DIR };
export default router;
