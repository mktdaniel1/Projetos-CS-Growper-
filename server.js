import { Router } from 'express';
import { query } from './db.js';
import { classificar } from './classifier.js';
import {
  emitirBacklogAtualizado,
  emitirNovoChamado,
  emitirChamadoFechado,
  emitirContatoNovo
} from './ws.js';

const router = Router();

const BOT_NUMBERS = (process.env.BOT_PHONE_NUMBERS || '')
  .split(',')
  .map((s) => s.trim().replace(/\D/g, ''))
  .filter(Boolean);

function normalizaFone(phone) {
  return (phone || '').replace(/\D/g, '');
}

function ehBot(phone) {
  const n = normalizaFone(phone);
  return n && BOT_NUMBERS.includes(n);
}

// ============================================================
// Cache de contatos (telefone -> {id, tipo, setor, ...})
// Invalida em 30s ou na chamada de classificação
// ============================================================
const cacheContatos = new Map();
let cacheTs = 0;

async function getContatoByPhone(phone) {
  const n = normalizaFone(phone);
  if (!n) return null;

  // Expiração global de 30s
  if (Date.now() - cacheTs > 30_000) {
    cacheContatos.clear();
    cacheTs = Date.now();
  }

  if (cacheContatos.has(n)) return cacheContatos.get(n);

  const r = await query(
    'select id, telefone, nome, tipo, setor, cargo, cliente_principal_id from contatos where telefone = $1',
    [n]
  );
  const c = r.rows[0] || null;
  cacheContatos.set(n, c);
  return c;
}

export function invalidarCacheContato(telefone) {
  if (!telefone) return;
  cacheContatos.delete(normalizaFone(telefone));
}

// ============================================================
// Upserts
// ============================================================
async function upsertContato(telefone, enviadoEm) {
  const n = normalizaFone(telefone);
  if (!n) return null;
  const r = await query(
    `insert into contatos (telefone, ultimo_visto)
     values ($1, $2)
     on conflict (telefone) do update set ultimo_visto = excluded.ultimo_visto
     returning id, tipo`,
    [n, enviadoEm]
  );
  return r.rows[0];
}

async function upsertContatoGrupo(contatoId, clienteId, enviadoEm) {
  if (!contatoId || !clienteId) return;
  await query(
    `insert into contatos_grupo (contato_id, cliente_id, total_mensagens, ultimo_visto)
     values ($1, $2, 1, $3)
     on conflict (contato_id, cliente_id) do update
       set total_mensagens = contatos_grupo.total_mensagens + 1,
           ultimo_visto = excluded.ultimo_visto`,
    [contatoId, clienteId, enviadoEm]
  );
}

// ============================================================
// Endpoint do 2chat
// ============================================================
router.post('/2chat', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    if (event.reaction) {
      await processarReacao(event);
    } else if (event.message) {
      await processarMensagem(event);
    }
  } catch (err) {
    console.error('[webhook] erro:', err);
  }
});

// ============================================================
// PROCESSAR MENSAGEM
// ============================================================
async function processarMensagem(event) {
  const sessionKey = event.session_key;
  const cliente = await findClienteBySessionKey(sessionKey);
  if (!cliente) {
    console.warn('[webhook] grupo não cadastrado:', sessionKey);
    return;
  }

  const msgUuid = event.message.uuid || event.message.id;
  if (!msgUuid) return;

  const existing = await query('select id from mensagens where msg_uuid = $1', [msgUuid]);
  if (existing.rowCount > 0) return;

  const texto = extrairTexto(event.message);
  const midia = extrairMidia(event.message);
  const reply = extrairReply(event.message);
  const enviadoEm = event.message.created_at || new Date().toISOString();
  const sentBy = event.sent_by;
  const remetenteFone = extrairRemetente(event);
  const remetenteNome = extrairRemetenteNome(event);

  // Identifica origem
  let origem;
  let contatoId = null;
  let contato = null;

  if (sentBy === 'api' || ehBot(remetenteFone)) {
    origem = 'bot';
  } else if (remetenteFone) {
    // Upsert contato + relação com o grupo
    const c = await upsertContato(remetenteFone, enviadoEm);
    contatoId = c.id;
    await upsertContatoGrupo(contatoId, cliente.id, enviadoEm);

    // Se contato veio com nome no payload e ainda não tem nome salvo, salva
    if (remetenteNome && c.tipo === null) {
      await query(
        'update contatos set nome = coalesce(nome, $1) where id = $2 and nome is null',
        [remetenteNome, contatoId]
      );
    }

    contato = await getContatoByPhone(remetenteFone);
    if (!contato || !contato.tipo) origem = 'nao_classificado';
    else origem = contato.tipo; // funcionario | cliente | ignorado
  } else {
    origem = 'nao_classificado';
  }

  const chamadoAberto = await findChamadoAberto(cliente.id);

  // Insere mensagem (link com chamado é resolvido depois pra cliente classificado)
  const insertRes = await query(
    `insert into mensagens
      (chamado_id, cliente_id, contato_id, msg_uuid, remetente_telefone, origem, texto, enviado_em,
       tipo_midia, midia_url, midia_nome, midia_mime, reply_to_uuid, reply_preview)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [chamadoAberto?.id || null, cliente.id, contatoId, msgUuid, remetenteFone, origem, texto, enviadoEm,
     midia?.tipo || null, midia?.url || null, midia?.nome || null, midia?.mime || null,
     reply?.uuid || null, reply?.preview || null]
  );
  const mensagemId = insertRes.rows[0].id;

  // === FUNCIONÁRIO ===
  if (origem === 'funcionario') {
    await registrarRespostaFuncionario(chamadoAberto, contatoId, enviadoEm);
    return;
  }

  // === BOT ===
  if (origem === 'bot') {
    if (chamadoAberto) {
      await query('update chamados set qtd_msgs_bot = qtd_msgs_bot + 1 where id = $1', [chamadoAberto.id]);
    }
    return;
  }

  // === IGNORADO ===
  if (origem === 'ignorado') {
    return;
  }

  // === NÃO CLASSIFICADO ===
  // Não abre chamado nem altera SLA. Aparece na aba Contatos pra você classificar.
  if (origem === 'nao_classificado') {
    emitirContatoNovo({ contatoId, clienteId: cliente.id, clienteNome: cliente.nome });
    return;
  }

  // === CLIENTE ===
  // Mesma lógica anterior: complementa chamado aberto OU classifica + abre chamado novo
  if (chamadoAberto) {
    await query(
      `update chamados
       set qtd_msgs_cliente = qtd_msgs_cliente + 1,
           aguardando_desde = $1
       where id = $2`,
      [enviadoEm, chamadoAberto.id]
    );
    emitirBacklogAtualizado();
    classificarBg(mensagemId, cliente, chamadoAberto, texto);
    return;
  }

  classificarBg(mensagemId, cliente, null, texto, async (cls) => {
    if (cls.classificacao === 'ruido' || cls.classificacao === 'resolucao_sugerida') return;
    const novoId = await abrirChamado(cliente.id, contatoId, msgUuid, texto, enviadoEm, cls.categoria);
    await query('update mensagens set chamado_id = $1 where id = $2', [novoId, mensagemId]);
    emitirNovoChamado({ chamadoId: novoId, clienteId: cliente.id, clienteNome: cliente.nome });
    emitirBacklogAtualizado();
  });
}

function classificarBg(mensagemId, cliente, chamadoAberto, texto, onDone) {
  classificar({
    texto,
    clienteNome: cliente.nome,
    chamadoAberto: chamadoAberto
      ? { texto_abertura: chamadoAberto.texto_abertura, minutos_aberto: chamadoAberto.minutos_aberto }
      : null
  })
    .then(async (cls) => {
      await query(
        'update mensagens set classificacao_ia = $1, classificacao_confianca = $2 where id = $3',
        [cls.classificacao, cls.confianca, mensagemId]
      );
      if (onDone) await onDone(cls);
    })
    .catch((err) => console.error('[webhook] classificação falhou:', err));
}

async function registrarRespostaFuncionario(chamadoAberto, contatoId, enviadoEm) {
  if (!chamadoAberto) return;

  await query(
    `update chamados set
       qtd_msgs_funcionario = qtd_msgs_funcionario + 1,
       aguardando_desde = null,
       status = case when status = 'aberto' then 'em_atendimento' else status end,
       primeira_resposta_em = coalesce(primeira_resposta_em, $1),
       primeiro_responsavel_id = coalesce(primeiro_responsavel_id, $2)
     where id = $3`,
    [enviadoEm, contatoId, chamadoAberto.id]
  );
  emitirBacklogAtualizado();
}

async function abrirChamado(clienteId, contatoId, msgUuid, texto, enviadoEm, categoria) {
  const reincRes = await query(
    `select id from chamados
     where cliente_id = $1 and status = 'resolvido' and fechado_em > now() - interval '24 hours'
     order by fechado_em desc limit 1`,
    [clienteId]
  );
  const reincidenteDeId = reincRes.rowCount > 0 ? reincRes.rows[0].id : null;

  const r = await query(
    `insert into chamados
       (cliente_id, contato_abertura_id, msg_abertura_uuid, texto_abertura, categoria_ia,
        aberto_em, aguardando_desde, status, reincidente_de_id)
     values ($1, $2, $3, $4, $5, $6, $6, 'aberto', $7)
     returning id`,
    [clienteId, contatoId, msgUuid, texto, categoria, enviadoEm, reincidenteDeId]
  );
  return r.rows[0].id;
}

// ============================================================
// REAÇÃO
// ============================================================
async function processarReacao(event) {
  const emoji = event.reaction;
  if (!emoji) return;

  const msgReagidaUuid = event.message?.uuid || event.message?.id;
  if (!msgReagidaUuid) return;

  const reactorPhone = event.reacted_by || event.reacted_by_phone || event.from || event.sender;
  const contato = await getContatoByPhone(reactorPhone);
  const sessionKey = event.session_key;
  const cliente = await findClienteBySessionKey(sessionKey);

  // Grava a reação na tabela reacoes (todas, não só ✅/🚫)
  if (cliente) {
    await query(
      `insert into reacoes (msg_uuid, cliente_id, contato_id, emoji) values ($1, $2, $3, $4)`,
      [msgReagidaUuid, cliente.id, contato?.id || null, emoji]
    );
    emitirBacklogAtualizado();
  }

  // Ações de fechamento/descarte só pra ✅/🚫 feita por funcionário
  if (!['✅', '🚫'].includes(emoji)) return;
  if (!contato || contato.tipo !== 'funcionario') {
    console.warn('[webhook] reação ignorada (não-funcionário ou contato desconhecido):', reactorPhone);
    return;
  }

  const msgRes = await query('select chamado_id, cliente_id from mensagens where msg_uuid = $1', [msgReagidaUuid]);
  if (msgRes.rowCount === 0) return;

  const { chamado_id: chamadoId, cliente_id: clienteId } = msgRes.rows[0];
  if (!chamadoId) return;

  const chRes = await query('select status from chamados where id = $1', [chamadoId]);
  if (chRes.rowCount === 0) return;
  if (['resolvido', 'descartado'].includes(chRes.rows[0].status)) return;

  const novoStatus = emoji === '✅' ? 'resolvido' : 'descartado';
  const metodo = emoji === '✅' ? 'reacao' : 'descartado';

  await query(
    `update chamados
     set status = $1, fechado_em = now(), fechado_por_id = $2,
         metodo_fechamento = $3, aguardando_desde = null
     where id = $4`,
    [novoStatus, contato.id, metodo, chamadoId]
  );

  emitirChamadoFechado({ chamadoId, clienteId, status: novoStatus });
  emitirBacklogAtualizado();
}

// ============================================================
// Helpers
// ============================================================
function extrairTexto(message) {
  if (!message) return null;
  if (typeof message.text === 'string') return message.text;
  if (message.message && typeof message.message.text === 'string') return message.message.text;
  return null;
}

function extrairMidia(message) {
  if (!message) return null;
  // 2chat marca tipo no campo `type` ou objeto aninhado
  const tipo = message.type || message.media_type;
  const url = message.media_url || message.url || message.attachment_url;
  if (!url || tipo === 'text' || tipo === 'chat') return null;

  const tiposValidos = ['imagem', 'audio', 'video', 'documento', 'sticker', 'localizacao'];
  const tipoNorm = ({
    image: 'imagem', img: 'imagem',
    audio: 'audio', ptt: 'audio', voice: 'audio',
    video: 'video',
    document: 'documento', doc: 'documento', file: 'documento',
    sticker: 'sticker',
    location: 'localizacao'
  })[tipo] || (tiposValidos.includes(tipo) ? tipo : 'documento');

  return {
    tipo: tipoNorm,
    url,
    nome: message.filename || message.file_name || null,
    mime: message.mime_type || message.mimetype || null
  };
}

function extrairReply(message) {
  if (!message) return null;
  const quoted = message.quoted_message || message.context;
  if (!quoted) return null;
  return {
    uuid: quoted.uuid || quoted.id || quoted.message_id || null,
    preview: (quoted.text || quoted.body || '').slice(0, 100)
  };
}

function extrairRemetente(event) {
  return (
    event.remote_phone_number_from_user ||
    event.from ||
    event.sender ||
    event.message?.sent_by_phone ||
    event.remote_phone_number ||
    null
  );
}

function extrairRemetenteNome(event) {
  return (
    event.sender_name ||
    event.from_name ||
    event.message?.sender_name ||
    event.profile_name ||
    null
  );
}

async function findClienteBySessionKey(sessionKey) {
  if (!sessionKey) return null;
  const r = await query('select id, nome from clientes where session_key = $1 and ativo = true', [sessionKey]);
  return r.rows[0] || null;
}

async function findChamadoAberto(clienteId) {
  const r = await query(
    `select id, texto_abertura, aberto_em, aguardando_desde, primeira_resposta_em,
            (extract(epoch from (now() - aberto_em)) / 60)::int as minutos_aberto
     from chamados
     where cliente_id = $1 and status in ('aberto','em_atendimento')
     order by aberto_em desc limit 1`,
    [clienteId]
  );
  return r.rows[0] || null;
}

export default router;
