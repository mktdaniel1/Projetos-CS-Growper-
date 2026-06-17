import { query } from './db.js';
import { emitirLembreteVencido, emitirLembretesAtualizados } from './ws.js';

const TICK_DISPARO_MS = 30_000;   // verifica vencidos a cada 30s
const TICK_GERACAO_MS = 2 * 60_000; // gera automáticos a cada 2min

let dispararTimer = null;
let geracaoTimer = null;

export function iniciarWorker() {
  console.log('[worker] iniciando ticks de lembretes');
  // Roda imediatamente uma vez e depois agenda
  dispararLembretesVencidos().catch(console.error);
  gerarLembretesAutomaticos().catch(console.error);

  dispararTimer = setInterval(() => {
    dispararLembretesVencidos().catch((err) => console.error('[worker] disparo erro:', err));
  }, TICK_DISPARO_MS);

  geracaoTimer = setInterval(() => {
    gerarLembretesAutomaticos().catch((err) => console.error('[worker] geração erro:', err));
  }, TICK_GERACAO_MS);
}

export function pararWorker() {
  if (dispararTimer) clearInterval(dispararTimer);
  if (geracaoTimer) clearInterval(geracaoTimer);
  dispararTimer = null;
  geracaoTimer = null;
}

// ============================================================
// 1) Disparo de lembretes vencidos
// ============================================================
async function dispararLembretesVencidos() {
  const r = await query(`
    update lembretes
    set status = 'disparado', disparado_em = now()
    where status = 'pendente' and disparar_em <= now()
    returning *
  `);

  if (r.rowCount === 0) return;

  // Para cada lembrete vencido, busca contexto e emite
  for (const lembrete of r.rows) {
    const ctx = await contextoLembrete(lembrete);
    emitirLembreteVencido({ lembrete, contexto: ctx });
  }

  emitirLembretesAtualizados();
  console.log(`[worker] ${r.rowCount} lembrete(s) disparado(s)`);
}

async function contextoLembrete(lembrete) {
  const r = await query(
    `select
       c.id, c.cliente_id, cl.nome as cliente_nome,
       c.status, c.aberto_em, c.aguardando_desde,
       (extract(epoch from (now() - c.aberto_em)) / 60)::int as minutos_aberto,
       case when c.aguardando_desde is null then 0
            else (extract(epoch from (now() - c.aguardando_desde)) / 60)::int
       end as aguardando_minutos,
       (select texto from mensagens m where m.chamado_id = c.id order by enviado_em desc limit 1) as ultima_mensagem
     from chamados c
     join clientes cl on cl.id = c.cliente_id
     where c.id = $1`,
    [lembrete.chamado_id]
  );
  return r.rows[0] || null;
}

// ============================================================
// 2) Geração de lembretes automáticos
// ============================================================
async function gerarLembretesAutomaticos() {
  await gerarSLAEstourado();
  await gerarClienteSilente();
  await gerarFossilizado();
  await resolverLembretesObsoletos();
}

/**
 * SLA estourado: cliente aguardando resposta há mais de 2h.
 * Cria 1 lembrete por chamado nesse estado, se ainda não houver ativo.
 */
async function gerarSLAEstourado() {
  await query(`
    insert into lembretes (chamado_id, cliente_id, tipo, disparar_em, texto)
    select c.id, c.cliente_id, 'sla_estourado', now(),
           'SLA estourou: cliente aguardando há mais de 2 horas'
    from chamados c
    where c.status in ('aberto','em_atendimento')
      and c.aguardando_desde is not null
      and c.aguardando_desde < now() - interval '2 hours'
    on conflict do nothing
  `);
}

/**
 * Cliente silente: time já respondeu (aguardando_desde IS NULL),
 * cliente não voltou a falar há 24h+. Lembrete pra reengajar.
 */
async function gerarClienteSilente() {
  await query(`
    insert into lembretes (chamado_id, cliente_id, tipo, disparar_em, texto)
    select c.id, c.cliente_id, 'cliente_silente', now(),
           'Cliente sem responder há 24h+. Considere cutucar.'
    from chamados c
    where c.status in ('aberto','em_atendimento')
      and c.aguardando_desde is null
      and c.primeira_resposta_em is not null
      and not exists (
        select 1 from mensagens m
        where m.chamado_id = c.id
          and m.origem = 'cliente'
          and m.enviado_em > now() - interval '24 hours'
      )
      and c.aberto_em < now() - interval '24 hours'
    on conflict do nothing
  `);
}

/**
 * Fossilizado: chamado aberto há mais de 3 dias sem nenhuma atividade
 * recente (mensagem de cliente ou time nas últimas 24h).
 */
async function gerarFossilizado() {
  await query(`
    insert into lembretes (chamado_id, cliente_id, tipo, disparar_em, texto)
    select c.id, c.cliente_id, 'fossilizado', now(),
           'Chamado aberto há mais de 3 dias sem atividade. Encerrar ou escalar?'
    from chamados c
    where c.status in ('aberto','em_atendimento')
      and c.aberto_em < now() - interval '3 days'
      and not exists (
        select 1 from mensagens m
        where m.chamado_id = c.id
          and m.enviado_em > now() - interval '24 hours'
      )
    on conflict do nothing
  `);
}

/**
 * Quando o chamado é fechado, resolve todos os lembretes pendentes/disparados dele.
 * E quando o cliente responde (limpa o silente), também resolve.
 */
async function resolverLembretesObsoletos() {
  // Chamado fechado -> resolve lembretes
  await query(`
    update lembretes
    set status = 'resolvido', resolvido_em = now(), resolucao = 'atendido'
    where status in ('pendente','disparado')
      and chamado_id in (
        select id from chamados where status in ('resolvido','descartado')
      )
  `);

  // Cliente silente que voltou a falar -> resolve
  await query(`
    update lembretes l
    set status = 'resolvido', resolvido_em = now(), resolucao = 'cliente_respondeu'
    where l.status in ('pendente','disparado')
      and l.tipo = 'cliente_silente'
      and exists (
        select 1 from mensagens m
        where m.chamado_id = l.chamado_id
          and m.origem = 'cliente'
          and m.enviado_em > l.criado_em
      )
  `);

  // SLA estourado que recebeu resposta -> resolve
  await query(`
    update lembretes l
    set status = 'resolvido', resolvido_em = now(), resolucao = 'atendido'
    where l.status in ('pendente','disparado')
      and l.tipo = 'sla_estourado'
      and exists (
        select 1 from chamados c
        where c.id = l.chamado_id and c.aguardando_desde is null
      )
  `);
}
