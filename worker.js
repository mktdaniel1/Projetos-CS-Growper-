import { Server } from 'socket.io';

let io = null;

export function attachSocketServer(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || '*',
      methods: ['GET', 'POST']
    }
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.['x-cs-token'];
    if (token !== process.env.CS_DASHBOARD_TOKEN) {
      return next(new Error('unauthorized'));
    }
    next();
  });

  io.on('connection', (socket) => {
    console.log('[ws] dashboard conectou:', socket.id);
    socket.on('disconnect', () => console.log('[ws] dashboard desconectou:', socket.id));
  });

  return io;
}

export function emitirBacklogAtualizado() {
  if (!io) return;
  io.emit('backlog:atualizado', { at: Date.now() });
}

export function emitirNovoChamado(payload) {
  if (!io) return;
  io.emit('chamado:novo', payload);
}

export function emitirChamadoFechado(payload) {
  if (!io) return;
  io.emit('chamado:fechado', payload);
}

export function emitirContatoNovo(payload) {
  if (!io) return;
  io.emit('contato:novo', payload);
}

export function emitirContatoClassificado(payload) {
  if (!io) return;
  io.emit('contato:classificado', payload);
}

export function emitirLembreteVencido(payload) {
  if (!io) return;
  io.emit('lembrete:vencido', payload);
}

export function emitirLembretesAtualizados() {
  if (!io) return;
  io.emit('lembretes:atualizados', { at: Date.now() });
}

export function emitirMensagemEnviada(payload) {
  if (!io) return;
  io.emit('mensagem:enviada', payload);
}
