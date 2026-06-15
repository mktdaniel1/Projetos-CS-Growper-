import { Router } from 'express';
import { query } from './db.js';
import { classificar } from './classifier.js';
import { emitirBacklogAtualizado, emitirNovoChamado, emitirChamadoFechado } from './ws.js';

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
// Cache simples de funcionarios em memória (recarrega a cada 60s)
// ============================================================
let cacheFuncionarios = new Map(); // telefone -> { id, nome, setor }
let cacheTs = 0;

async function getFuncionarios() {
  const agora = Date.now();
  if (agora - cacheTs > 60_000) {
    const r = await query('select id, nome, telefone, setor from funcionarios where ativo = true');
    cacheFuncionarios = new Map(r.rows.map((f) => [f.telefone, f]));
    cacheTs = agora;
  }
  return cacheFuncionarios;
}

async function ehFuncionario(phone) {
  const n = normalizaFone(phone);
  if (!n) return null;
  const map = await getFuncionarios();
  return map.get(n) || null;
}

// ============================================================
// Endpoint único do 2chat
// ============================================================
router.post('/2chat', async (req, res) => {
  res.sendStatus(200); // responde rápido, processa async

  try {
    const event = req.body;

    if (event.reaction) {
      await processarReacao(event);
    } else if (event.message) {
      await processarMensagem(event);
    } else {
      console.warn('[webhook] evento ignorado:', JSON.stringify(event).slice(0, 200));
    }
  } catch (err) {
    console.error('[webhook] erro:', err);
  }
});

// ============================================================
// PROCESSAR MENSAGEM (unificado - decide pelo telefone)
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

  // Idempotência
  const existing = await query('select id from mensagens where msg_uuid = $1', [msgUuid]);
  if (existing.rowCount > 0) return;

  const texto = extrairTexto(event.message);
  const enviadoEm = event.message.created_at || new Date().toISOString();
  const sentBy = event.sent_by;

  // Identificar o remetente
  const remetenteFone = extrairRemetente(event);

  // Quem é o remetente?
  // 1. sent_by === 'api' -> disparo automático via API (bot)
  // 2. telefone é da Alice ou bot configurado -> bot
  // 3. telefone está em funcionarios -> funcionario
  // 4. resto -> cliente
  let origem;
  let funcionario = null;

  if (sentBy === 'api' || ehBot(remetenteFone)) {
    origem = 'bot';
  } else {
    funcionario = await ehFuncionario(remetenteFone);
    origem = funcionario ? 'funcionario' : 'cliente';
  }

  const chamadoAberto = await findChamadoAberto(cliente.id);

  // Insere mensagem (chamado_id pode ser preenchido depois pra cliente)
  const insertRes = await query(
    `insert into mensagens (chamado_id, cliente_id, msg_uuid, remetente_telefone, origem, texto, enviado_em)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [chamadoAberto?.id || null, cliente.id, msgUuid, remetenteFone, origem, texto, enviadoEm]
  );
  const mensagemId = insertRes.rows[0].id;

  // ========== FUNCIONARIO ==========
  if (origem === 'funcionario') {
    await registrarRespostaFuncionario(chamadoAberto, funcionario, enviadoEm);
    return;
  }

  // ========== BOT (Alice) ==========
  if (origem === 'bot') {
    if (chamadoAberto) {
      await query('update chamados set qtd_msgs_bot = qtd_msgs_bot + 1 where id = $1', [chamadoAberto.id]);
    }
    return; // bot não interfere no SLA
  }

  // ========== CLIENTE ==========
  // Atualiza cache de contatos do grupo
  if (remetenteFone) {
    await query(
      `insert into contatos_grupo (cliente_id, telefone, ultimo_visto, total_mensagens)
       values ($1, $2, $3, 1)
       on conflict (cliente_id, telefone) do update
         set ultimo_visto = excluded.ultimo_visto,
             total_mensagens = contatos_grupo.total_mensagens + 1`,
      [cliente.id, remetenteFone, enviadoEm]
    );
  }

  // Se já tem chamado aberto, é complemento (e atualiza aguardando)
  if (chamadoAberto) {
    await query(
      `update chamados
       set qtd_msgs_cliente = qtd_msgs_cliente + 1,
           aguardando_desde = $1
       where id = $2`,
      [enviadoEm, chamadoAberto.id]
    );
    emitirBacklogAtualizado();
    // ainda classifica em background pra ver se é resolucao_sugerida
    classificarBg(mensagemId, cliente, chamadoAberto, texto);
    return;
  }

  // Sem chamado aberto -> precisa classificar antes de abrir
  classificarBg(mensagemId, cliente, null, texto, async (cls) => {
    if (cls.classificacao === 'ruido' || cls.classificacao === 'resolucao_sugerida') return;

    const novoId = await abrirChamado(cliente.id, msgUuid, texto, enviadoEm, cls.categoria, remetenteFone);
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

async function registrarRespostaFuncionario(chamadoAberto, funcionario, enviadoEm) {
  if (!chamadoAberto) return;

  // Primeira resposta?
  const primeira = !chamadoAberto.primeira_resposta_em;

  await query(
    `update chamados set
       qtd_msgs_funcionario = qtd_msgs_funcionario + 1,
       aguardando_desde = null,
       status = case when status = 'aberto' then 'em_atendimento' else status end,
       primeira_resposta_em = coalesce(primeira_resposta_em, $1),
       primeiro_responsavel_id = coalesce(primeiro_responsavel_id, $2)
     where id = $3`,
    [enviadoEm, funcionario.id, chamadoAberto.id]
  );

  emitirBacklogAtualizado();
}

async function abrirChamado(clienteId, msgUuid, texto, enviadoEm, categoria, contatoFone) {
  // Reincidência: chamado resolvido nas últimas 24h?
  const reincRes = await query(
    `select id from chamados
     where cliente_id = $1 and status = 'resolvido' and fechado_em > now() - interval '24 hours'
     order by fechado_em desc limit 1`,
    [clienteId]
  );
  const reincidenteDeId = reincRes.rowCount > 0 ? reincRes.rows[0].id : null;

  const r = await query(
    `insert into chamados
       (cliente_id, msg_abertura_uuid, texto_abertura, contato_telefone, categoria_ia,
        aberto_em, aguardando_desde, status, reincidente_de_id)
     values ($1, $2, $3, $4, $5, $6, $6, 'aberto', $7)
     returning id`,
    [clienteId, msgUuid, texto, contatoFone, categoria, enviadoEm, reincidenteDeId]
  );
  return r.rows[0].id;
}

// ============================================================
// REAÇÃO
// ============================================================
async function processarReacao(event) {
  const emoji = event.reaction;
  if (!['✅', '🚫'].includes(emoji)) return;

  const msgReagidaUuid = event.message?.uuid || event.message?.id;
  if (!msgReagidaUuid) return;

  // Quem reagiu - tentamos os campos mais prováveis
  const reactorPhone = event.reacted_by || event.reacted_by_phone || event.from || event.sender;
  const funcionario = await ehFuncionario(reactorPhone);
  if (!funcionario) {
    console.warn('[webhook] reação ignorada - reator não é funcionario:', reactorPhone);
    return;
  }

  const msgRes = await query('select chamado_id, cliente_id from mensagens where msg_uuid = $1', [msgReagidaUuid]);
  if (msgRes.rowCount === 0) return;

  const { chamado_id: chamadoId, cliente_id: clienteId } = msgRes.rows[0];
  if (!chamadoId) return;

  const chRes = await query('select * from chamados where id = $1', [chamadoId]);
  if (chRes.rowCount === 0) return;
  const chamado = chRes.rows[0];

  if (['resolvido', 'descartado'].includes(chamado.status)) return;

  const novoStatus = emoji === '✅' ? 'resolvido' : 'descartado';
  const metodo = emoji === '✅' ? 'reacao' : 'descartado';

  await query(
    `update chamados
     set status = $1, fechado_em = now(), fechado_por_id = $2,
         metodo_fechamento = $3, aguardando_desde = null
     where id = $4`,
    [novoStatus, funcionario.id, metodo, chamadoId]
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

function extrairRemetente(event) {
  // 2chat usa campos diferentes dependendo do evento. Tentamos vários.
  return (
    event.remote_phone_number_from_user ||  // mensagem de grupo: telefone do participante
    event.from ||
    event.sender ||
    event.message?.sent_by_phone ||
    event.remote_phone_number ||
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
