import { Router } from 'express';
import { query } from './db.js';
import { invalidarCacheContato } from './webhook.js';
import { emitirContatoClassificado, emitirLembretesAtualizados, emitirChamadoFechado, emitirBacklogAtualizado, emitirMensagemEnviada } from './ws.js';
import { enviarMensagem, reagirMensagem } from './twochat.js';

const router = Router();

router.use((req, res, next) => {
  const token = req.header('X-CS-Token') || req.query.token;
  if (token !== process.env.CS_DASHBOARD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ============================================================
// MÉTRICAS DE VOLUME
// ============================================================
router.get('/metrics/overview', async (req, res) => {
  try {
    const r = await query(`
      select
        count(*) filter (where aberto_em::date = current_date)                                            as hoje,
        count(*) filter (where aberto_em::date = current_date - 1)                                       as ontem,
        count(*) filter (where aberto_em >= date_trunc('week', current_date))                            as semana,
        count(*) filter (where aberto_em >= date_trunc('week', current_date - interval '7 days')
                            and aberto_em <  date_trunc('week', current_date))                           as semana_passada,
        count(*) filter (where aberto_em >= date_trunc('month', current_date))                           as mes,
        count(*) filter (where aberto_em >= date_trunc('month', current_date - interval '1 month')
                            and aberto_em <  date_trunc('month', current_date))                          as mes_passado
      from chamados
      where status <> 'descartado'
    `);
    const row = r.rows[0];
    res.json({
      hoje: { valor: Number(row.hoje), delta_abs: Number(row.hoje) - Number(row.ontem) },
      semana: { valor: Number(row.semana), delta_pct: pct(row.semana, row.semana_passada) },
      mes: { valor: Number(row.mes), delta_pct: pct(row.mes, row.mes_passado) }
    });
  } catch (err) {
    console.error('[api] overview erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/metrics/timeseries', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 180);
    const r = await query(
      `
      with serie as (
        select generate_series(
          current_date - ($1::int - 1) * interval '1 day',
          current_date,
          interval '1 day'
        )::date as dia
      ),
      abertos as (
        select aberto_em::date as dia, count(*) as q from chamados
        where aberto_em::date >= current_date - $1::int * interval '1 day' and status <> 'descartado'
        group by 1
      ),
      resolvidos as (
        select fechado_em::date as dia, count(*) as q from chamados
        where fechado_em is not null and fechado_em::date >= current_date - $1::int * interval '1 day'
          and metodo_fechamento <> 'descartado'
        group by 1
      )
      select s.dia, coalesce(a.q, 0) as abertos, coalesce(r.q, 0) as resolvidos
      from serie s
      left join abertos a on a.dia = s.dia
      left join resolvidos r on r.dia = s.dia
      order by s.dia
      `,
      [days]
    );
    res.json(r.rows.map((row) => ({ dia: row.dia, abertos: Number(row.abertos), resolvidos: Number(row.resolvidos) })));
  } catch (err) {
    console.error('[api] timeseries erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/metrics/heatmap', async (req, res) => {
  try {
    const r = await query(`
      select extract(dow from aberto_em)::int as dow,
             extract(hour from aberto_em)::int as hora,
             count(*)::int as q
      from chamados
      where aberto_em >= current_date - interval '30 days' and status <> 'descartado'
      group by 1, 2
    `);
    const matriz = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const row of r.rows) matriz[row.dow][row.hora] = row.q;
    res.json(matriz);
  } catch (err) {
    console.error('[api] heatmap erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/metrics/top-clientes', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const period =
      req.query.period === 'semana' ? "date_trunc('week', current_date)" : "date_trunc('month', current_date)";

    const r = await query(
      `
      with periodo as (
        select c.cliente_id,
               count(*) as total,
               sum(case when c.status = 'resolvido' then 1 else 0 end) as resolvidos
        from chamados c
        where c.aberto_em >= ${period} and c.status <> 'descartado'
        group by c.cliente_id
        order by total desc
        limit $1
      ),
      spark as (
        select cliente_id, aberto_em::date as dia, count(*)::int as q
        from chamados where aberto_em >= current_date - interval '30 days' and status <> 'descartado'
        group by 1, 2
      )
      select cl.nome,
             p.total::int,
             p.resolvidos::int,
             round(100.0 * p.resolvidos / nullif(p.total, 0))::int as pct_resolvido,
             (select array_agg(s.q order by s.dia) from spark s where s.cliente_id = p.cliente_id) as sparkline
      from periodo p
      join clientes cl on cl.id = p.cliente_id
      order by p.total desc
      `,
      [limit]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[api] top-clientes erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

// ============================================================
// BACKLOG
// ============================================================
router.get('/backlog', async (req, res) => {
  try {
    const r = await query(`
      select * from v_backlog
      order by case prioridade
                 when 'alta' then 0
                 when 'media' then 1
                 when 'baixa' then 3
                 else 2
               end,
               case semaforo
                 when 'critico' then 0
                 when 'atencao' then 1
                 when 'ok' then 2
                 else 3
               end,
               aguardando_minutos desc, aberto_em asc
    `);
    const list = r.rows;
    const aguardando = list.filter((x) => x.aguardando_desde !== null);
    const resumo = {
      ok: aguardando.filter((x) => x.semaforo === 'ok').length,
      atencao: aguardando.filter((x) => x.semaforo === 'atencao').length,
      critico: aguardando.filter((x) => x.semaforo === 'critico').length,
      aguardando_cliente: list.filter((x) => x.semaforo === 'aguardando_cliente').length,
      tempo_medio_aguardando_min: aguardando.length
        ? Math.round(aguardando.reduce((s, x) => s + Number(x.aguardando_minutos), 0) / aguardando.length)
        : 0,
      total: list.length
    };
    res.json({ resumo, chamados: list });
  } catch (err) {
    console.error('[api] backlog erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

// ============================================================
// CLIENTES (CRUD básico)
// ============================================================
router.post('/clientes', async (req, res) => {
  try {
    const { nome, session_key, channel_phone_number, remote_phone_number, link_whatsapp } = req.body;
    if (!nome || !session_key) return res.status(400).json({ error: 'nome e session_key obrigatórios' });
    const r = await query(
      `insert into clientes (nome, session_key, channel_phone_number, remote_phone_number, link_whatsapp)
       values ($1, $2, $3, $4, $5)
       on conflict (session_key) do update set
         nome = excluded.nome,
         ativo = true,
         link_whatsapp = coalesce(excluded.link_whatsapp, clientes.link_whatsapp)
       returning id, nome, session_key, ativo, link_whatsapp`,
      [nome, session_key, channel_phone_number || null, remote_phone_number || null, link_whatsapp || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[api] cliente erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.put('/clientes/:id/link-whatsapp', async (req, res) => {
  try {
    const { link_whatsapp } = req.body;
    const r = await query(
      'update clientes set link_whatsapp = $1 where id = $2 returning id, link_whatsapp',
      [link_whatsapp || null, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'cliente não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/clientes', async (req, res) => {
  const r = await query('select id, nome, session_key, ativo from clientes order by nome');
  res.json(r.rows);
});

// ============================================================
// CONTATOS — sistema unificado
// ============================================================

/**
 * GET /api/contatos?status=nao_classificado|funcionario|cliente|ignorado|todos&limit=50
 * Lista contatos com agregações (qtd grupos, qtd mensagens) e sugestão automática
 */
router.get('/contatos', async (req, res) => {
  try {
    const status = req.query.status || 'todos';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    let whereTipo = '';
    if (status === 'nao_classificado') whereTipo = 'where c.tipo is null';
    else if (status === 'funcionario') whereTipo = "where c.tipo = 'funcionario'";
    else if (status === 'cliente')     whereTipo = "where c.tipo = 'cliente'";
    else if (status === 'ignorado')    whereTipo = "where c.tipo = 'ignorado'";

    const r = await query(
      `
      with agg as (
        select cg.contato_id,
               count(distinct cg.cliente_id)::int as total_grupos,
               sum(cg.total_mensagens)::int as total_mensagens,
               (
                 select cliente_id from contatos_grupo
                 where contato_id = cg.contato_id
                 order by total_mensagens desc, ultimo_visto desc
                 limit 1
               ) as grupo_principal_id
        from contatos_grupo cg
        group by cg.contato_id
      )
      select
        c.id, c.telefone, c.nome, c.tipo, c.setor, c.cargo,
        c.cliente_principal_id, c.ultimo_visto, c.primeiro_visto, c.classificado_em,
        cl_p.nome as cliente_principal_nome,
        coalesce(a.total_grupos, 0) as total_grupos,
        coalesce(a.total_mensagens, 0) as total_mensagens,
        cl_g.id as grupo_principal_id,
        cl_g.nome as grupo_principal_nome,
        (
          select texto from mensagens m
          where m.contato_id = c.id and m.texto is not null
          order by enviado_em desc limit 1
        ) as ultima_mensagem
      from contatos c
      left join agg a       on a.contato_id = c.id
      left join clientes cl_p on cl_p.id = c.cliente_principal_id
      left join clientes cl_g on cl_g.id = a.grupo_principal_id
      ${whereTipo}
      order by c.ultimo_visto desc nulls last
      limit $1
      `,
      [limit]
    );

    const list = r.rows.map((c) => {
      const grupos = c.total_grupos || 0;
      const msgs = c.total_mensagens || 0;
      let sugestao = 'incerto';
      let confianca = 0.5;
      if (grupos >= 3) {
        sugestao = 'funcionario';
        confianca = 0.9;
      } else if (grupos === 1 && msgs >= 3) {
        sugestao = 'cliente';
        confianca = 0.85;
      } else if (grupos === 2 && msgs >= 5) {
        sugestao = 'funcionario';
        confianca = 0.6;
      } else if (msgs < 3) {
        sugestao = 'pouca_atividade';
        confianca = 0.3;
      }
      return { ...c, sugestao, confianca };
    });

    res.json(list);
  } catch (err) {
    console.error('[api] contatos erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/contatos/stats', async (req, res) => {
  try {
    const r = await query(`
      select
        count(*) filter (where tipo is null)              as nao_classificados,
        count(*) filter (where tipo = 'funcionario')      as funcionarios,
        count(*) filter (where tipo = 'cliente')          as clientes,
        count(*) filter (where tipo = 'ignorado')         as ignorados
      from contatos
    `);
    const row = r.rows[0];
    res.json({
      nao_classificados: Number(row.nao_classificados),
      funcionarios: Number(row.funcionarios),
      clientes: Number(row.clientes),
      ignorados: Number(row.ignorados)
    });
  } catch (err) {
    console.error('[api] contatos stats erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/contatos/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await query(
      `select c.*,
              cl.nome as cliente_principal_nome,
              (
                select json_agg(json_build_object(
                  'cliente_id', cg.cliente_id,
                  'cliente_nome', cg_cl.nome,
                  'total_mensagens', cg.total_mensagens,
                  'primeiro_visto', cg.primeiro_visto,
                  'ultimo_visto', cg.ultimo_visto
                ) order by cg.total_mensagens desc)
                from contatos_grupo cg
                join clientes cg_cl on cg_cl.id = cg.cliente_id
                where cg.contato_id = c.id
              ) as grupos
       from contatos c
       left join clientes cl on cl.id = c.cliente_principal_id
       where c.id = $1`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[api] contato detalhe erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/contatos/:id/classificar
 * body: { tipo, nome?, setor?, cargo?, cliente_principal_id? }
 */
router.post('/contatos/:id/classificar', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { tipo, nome, setor, cargo, cliente_principal_id } = req.body;

    if (!['funcionario', 'cliente', 'ignorado'].includes(tipo)) {
      return res.status(400).json({ error: 'tipo deve ser funcionario, cliente ou ignorado' });
    }
    if (tipo === 'funcionario') {
      if (!setor) return res.status(400).json({ error: 'setor obrigatório para funcionario' });
      if (!['cs', 'marketing', 'financeiro', 'suporte', 'outro'].includes(setor)) {
        return res.status(400).json({ error: 'setor inválido' });
      }
    }
    if (tipo === 'cliente' && !cliente_principal_id) {
      return res.status(400).json({ error: 'cliente_principal_id obrigatório para cliente' });
    }

    const r = await query(
      `update contatos set
         tipo = $1,
         nome = coalesce($2, nome),
         setor = $3,
         cargo = $4,
         cliente_principal_id = $5,
         classificado_em = now()
       where id = $6
       returning *`,
      [
        tipo,
        nome || null,
        tipo === 'funcionario' ? setor : null,
        cargo || null,
        tipo === 'cliente' ? cliente_principal_id : null,
        id
      ]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: 'não encontrado' });
    const contato = r.rows[0];

    invalidarCacheContato(contato.telefone);
    emitirContatoClassificado({ contatoId: id, tipo });

    res.json(contato);
  } catch (err) {
    console.error('[api] classificar erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/contatos/:id/desclassificar — volta pra "não classificado"
 */
router.post('/contatos/:id/desclassificar', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await query(
      `update contatos set
         tipo = null, setor = null, cargo = null, cliente_principal_id = null, classificado_em = null
       where id = $1 returning telefone`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'não encontrado' });
    invalidarCacheContato(r.rows[0].telefone);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] desclassificar erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

// ============================================================
// LEMBRETES & ALERTAS
// ============================================================

/**
 * GET /api/lembretes/ativos
 * Lembretes disparados que ainda não foram resolvidos + agendados pra breve.
 * Esses são os "alertas ativos" do topo do dashboard.
 */
router.get('/lembretes/ativos', async (req, res) => {
  try {
    const r = await query(`
      select
        l.id, l.chamado_id, l.cliente_id, l.tipo, l.disparar_em, l.disparado_em,
        l.texto, l.criado_por_nome, l.status,
        cl.nome as cliente_nome,
        c.aguardando_desde,
        case when c.aguardando_desde is null then 0
             else (extract(epoch from (now() - c.aguardando_desde)) / 60)::int
        end as aguardando_minutos,
        case when l.disparado_em is null
             then (extract(epoch from (l.disparar_em - now())) / 60)::int
             else 0
        end as vence_em_minutos,
        (select texto from mensagens m where m.chamado_id = l.chamado_id order by enviado_em desc limit 1) as ultima_mensagem
      from lembretes l
      join clientes cl on cl.id = l.cliente_id
      join chamados c on c.id = l.chamado_id
      where l.status = 'disparado'
         or (l.status = 'pendente' and l.disparar_em <= now() + interval '10 minutes')
      order by
        case l.tipo
          when 'sla_estourado' then 0
          when 'manual' then 1
          when 'cliente_silente' then 2
          when 'fossilizado' then 3
        end,
        l.disparar_em asc
      limit 50
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[api] lembretes ativos erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/lembretes/agendados-hoje
 * Conta lembretes manuais agendados pra hoje (pra KPI).
 */
router.get('/lembretes/agendados-hoje', async (req, res) => {
  try {
    const r = await query(`
      select count(*)::int as total
      from lembretes
      where status = 'pendente'
        and disparar_em::date = current_date
        and tipo = 'manual'
    `);
    res.json({ total: r.rows[0].total });
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/chamados/:chamadoId/lembretes
 * Lembretes ativos de um chamado específico (pra mostrar no backlog).
 */
router.get('/chamados/:chamadoId/lembretes', async (req, res) => {
  try {
    const r = await query(
      `select id, tipo, disparar_em, texto, criado_por_nome, status,
              case when disparado_em is null
                   then (extract(epoch from (disparar_em - now())) / 60)::int
                   else 0
              end as vence_em_minutos
       from lembretes
       where chamado_id = $1 and status in ('pendente','disparado')
       order by disparar_em asc`,
      [req.params.chamadoId]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/lembretes
 * Cria lembrete manual.
 * body: { chamado_id, disparar_em, texto, criado_por_nome }
 */
router.post('/lembretes', async (req, res) => {
  try {
    const { chamado_id, disparar_em, texto, criado_por_nome } = req.body;
    if (!chamado_id || !disparar_em) {
      return res.status(400).json({ error: 'chamado_id e disparar_em obrigatórios' });
    }

    const chRes = await query('select cliente_id, status from chamados where id = $1', [chamado_id]);
    if (chRes.rowCount === 0) return res.status(404).json({ error: 'chamado não encontrado' });
    if (['resolvido', 'descartado'].includes(chRes.rows[0].status)) {
      return res.status(400).json({ error: 'chamado já fechado' });
    }

    const r = await query(
      `insert into lembretes (chamado_id, cliente_id, tipo, disparar_em, texto, criado_por_nome)
       values ($1, $2, 'manual', $3, $4, $5)
       returning *`,
      [chamado_id, chRes.rows[0].cliente_id, disparar_em, texto || null, criado_por_nome || null]
    );

    emitirLembretesAtualizados();
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[api] criar lembrete erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/lembretes/:id/resolver
 * body: { resolucao: 'atendido' | 'adiado' | 'cancelado', adiar_para? }
 */
router.post('/lembretes/:id/resolver', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { resolucao, adiar_para, resolvido_por_nome } = req.body;

    if (!['atendido', 'adiado', 'cancelado'].includes(resolucao)) {
      return res.status(400).json({ error: 'resolucao inválida' });
    }

    if (resolucao === 'adiado') {
      if (!adiar_para) return res.status(400).json({ error: 'adiar_para obrigatório' });
      const r = await query(
        `update lembretes
         set status = 'pendente', disparar_em = $1, disparado_em = null
         where id = $2 returning *`,
        [adiar_para, id]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'não encontrado' });
      emitirLembretesAtualizados();
      return res.json(r.rows[0]);
    }

    const r = await query(
      `update lembretes
       set status = $1, resolvido_em = now(), resolucao = $2
       where id = $3 returning *`,
      [resolucao === 'cancelado' ? 'cancelado' : 'resolvido', resolucao, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'não encontrado' });
    emitirLembretesAtualizados();
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[api] resolver lembrete erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

// ============================================================
// CHAT — histórico do grupo, lista de chamados ativos, envio
// ============================================================

/**
 * PUT /api/chamados/:id/prioridade
 * Headers: X-CS-Funcionario-Id (quem definiu)
 * body: { prioridade: 'alta' | 'media' | 'baixa' | null }
 */
router.put('/chamados/:id/prioridade', async (req, res) => {
  try {
    const funcionarioId = parseInt(req.headers['x-cs-funcionario-id']) || null;
    const { prioridade } = req.body;
    if (prioridade !== null && !['alta','media','baixa'].includes(prioridade)) {
      return res.status(400).json({ error: 'prioridade inválida' });
    }
    const r = await query(
      `update chamados
       set prioridade = $1,
           prioridade_definida_em = case when $1 is null then null else now() end,
           prioridade_definida_por_id = case when $1 is null then null else $2 end
       where id = $3
       returning id, prioridade`,
      [prioridade || null, funcionarioId, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'chamado não encontrado' });
    emitirBacklogAtualizado();
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[api] prioridade erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * POST /api/chamados/:id/fechar
 * Fecha o chamado direto pelo painel (sem precisar reagir com ✅ no WhatsApp).
 * Usado pelo botão "Resolver" no header do chat.
 */
router.post('/chamados/:id/fechar', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await query(
      `update chamados
       set status = 'resolvido', fechado_em = now(), metodo_fechamento = 'comando', aguardando_desde = null
       where id = $1 and status in ('aberto','em_atendimento')
       returning id, cliente_id`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'chamado não encontrado ou já fechado' });
    emitirChamadoFechado({ chamadoId: r.rows[0].id, clienteId: r.rows[0].cliente_id, status: 'resolvido' });
    emitirBacklogAtualizado();
    emitirLembretesAtualizados();
    res.json({ ok: true, ...r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

// ============================================================
// CHAT — histórico do grupo, lista de chamados ativos
// ============================================================

/**
 * GET /api/clientes/:id/mensagens?antes_de=ISO&limit=50
 * Histórico do grupo (todas as mensagens do cliente_id), paginado por timestamp.
 * `antes_de` opcional pra carregar mais ao rolar pra cima.
 */
router.get('/clientes/:id/mensagens', async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const antesDe = req.query.antes_de || null;

    const r = await query(
      `select
         m.id, m.msg_uuid, m.chamado_id, m.cliente_id, m.contato_id,
         m.remetente_telefone, m.origem, m.texto, m.enviado_em,
         m.tipo_midia, m.midia_url, m.midia_nome, m.midia_mime,
         m.reply_to_uuid, m.reply_preview,
         m.enviado_pelo_painel, m.status_entrega,
         c.nome   as contato_nome,
         c.tipo   as contato_tipo,
         c.setor  as contato_setor,
         c.cargo  as contato_cargo,
         f.nome   as funcionario_remetente_nome,
         f.setor  as funcionario_remetente_setor,
         (
           select json_agg(json_build_object(
             'emoji', emoji,
             'contato_id', contato_id,
             'criada_em', criada_em
           ))
           from reacoes
           where msg_uuid = m.msg_uuid and removida_em is null
         ) as reacoes
       from mensagens m
       left join contatos c on c.id = m.contato_id
       left join contatos f on f.id = m.funcionario_remetente_id
       where m.cliente_id = $1
         and ($2::timestamptz is null or m.enviado_em < $2)
       order by m.enviado_em desc
       limit $3`,
      [clienteId, antesDe, limit]
    );

    res.json(r.rows.reverse());
  } catch (err) {
    console.error('[api] mensagens do grupo erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/chamados/ativos
 * Lista compacta de chamados em aberto/em_atendimento pra alimentar a aba Chamados.
 */
router.get('/chamados/ativos', async (req, res) => {
  try {
    const r = await query(`
      select
        c.id, c.cliente_id, c.status, c.aberto_em, c.aguardando_desde, c.prioridade,
        cl.nome as cliente_nome,
        case when c.aguardando_desde is null then 0
             else (extract(epoch from (now() - c.aguardando_desde)) / 60)::int
        end as aguardando_minutos,
        (extract(epoch from (now() - c.aberto_em)) / 60)::int as minutos_aberto,
        (select texto from mensagens m where m.cliente_id = c.cliente_id order by enviado_em desc limit 1) as ultima_mensagem,
        (select enviado_em from mensagens m where m.cliente_id = c.cliente_id order by enviado_em desc limit 1) as ultima_em,
        case
          when c.aguardando_desde is null then 'aguardando_cliente'
          when (now() - c.aguardando_desde) > interval '2 hours' then 'critico'
          when (now() - c.aguardando_desde) > interval '30 minutes' then 'atencao'
          else 'ok'
        end as semaforo
      from chamados c
      join clientes cl on cl.id = c.cliente_id
      where c.status in ('aberto','em_atendimento')
      order by
        case c.prioridade when 'alta' then 0 when 'media' then 1 when 'baixa' then 3 else 2 end,
        case when c.aguardando_desde is null then 1 else 0 end,
        c.aguardando_desde desc nulls last,
        c.aberto_em desc
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[api] chamados ativos erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /api/chamados/:id  - detalhe pra abrir no drawer/chat
 */
router.get('/chamados/:id', async (req, res) => {
  try {
    const r = await query(
      `select c.*, cl.nome as cliente_nome, cl.session_key, cl.remote_phone_number, cl.link_whatsapp,
              ab.nome as contato_abertura_nome, ab.telefone as contato_abertura_telefone,
              ab.cargo as contato_abertura_cargo,
              resp.nome as responsavel_nome
       from chamados c
       join clientes cl on cl.id = c.cliente_id
       left join contatos ab on ab.id = c.contato_abertura_id
       left join contatos resp on resp.id = c.primeiro_responsavel_id
       where c.id = $1`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

// ============================================================
// FUNCIONÁRIOS — login e envio
// ============================================================

/**
 * GET /api/contatos/funcionarios
 * Lista os contatos classificados como funcionário (cards do login).
 */
router.get('/contatos/funcionarios', async (req, res) => {
  try {
    const r = await query(`
      select id, nome, telefone, setor, cargo, twochat_channel_phone,
             (twochat_channel_phone is not null) as conectado
      from contatos
      where tipo = 'funcionario' and ativo = true
      order by setor nulls last, nome
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[api] funcionarios erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * PUT /api/contatos/:id/twochat-channel
 * body: { twochat_channel_phone, twochat_channel_uuid? }
 * Cadastra o número que esse funcionário usa pra responder via 2chat.
 */
router.put('/contatos/:id/twochat-channel', async (req, res) => {
  try {
    const { twochat_channel_phone, twochat_channel_uuid } = req.body;
    const r = await query(
      `update contatos
       set twochat_channel_phone = $1, twochat_channel_uuid = $2
       where id = $3 and tipo = 'funcionario'
       returning id, nome, twochat_channel_phone`,
      [twochat_channel_phone || null, twochat_channel_uuid || null, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'funcionário não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

// ============================================================
// MENSAGENS — envio pelo painel (usa número do funcionário logado)
// ============================================================

/**
 * POST /api/mensagens/enviar
 * Headers: X-CS-Token (já validado pelo middleware) + X-CS-Funcionario-Id (id do funcionário)
 * body: { cliente_id, texto?, midia_url?, midia_tipo?, midia_nome?, reply_to_uuid?, reply_preview? }
 */
router.post('/mensagens/enviar', async (req, res) => {
  try {
    const funcionarioId = parseInt(req.headers['x-cs-funcionario-id']);
    if (!funcionarioId) return res.status(400).json({ error: 'header X-CS-Funcionario-Id obrigatório' });

    const fnRes = await query(
      `select id, nome, setor, telefone, twochat_channel_phone
       from contatos where id = $1 and tipo = 'funcionario'`,
      [funcionarioId]
    );
    if (fnRes.rowCount === 0) return res.status(404).json({ error: 'funcionário não encontrado' });
    const funcionario = fnRes.rows[0];

    if (!funcionario.twochat_channel_phone) {
      return res.status(400).json({
        error: `${funcionario.nome} ainda não tem número conectado ao 2chat. Cadastre em Contatos > funcionário > Conectar 2chat.`
      });
    }

    const { cliente_id, texto, midia_url, midia_tipo, midia_nome, midia_mime,
            reply_to_uuid, reply_preview } = req.body;
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id obrigatório' });
    if (!texto && !midia_url) return res.status(400).json({ error: 'texto ou midia_url obrigatório' });

    const clRes = await query(
      'select id, nome, session_key, remote_phone_number from clientes where id = $1',
      [cliente_id]
    );
    if (clRes.rowCount === 0) return res.status(404).json({ error: 'cliente não encontrado' });
    const cliente = clRes.rows[0];

    const groupUuid = extrairGroupUuid(cliente.session_key) || cliente.remote_phone_number;
    if (!groupUuid) return res.status(500).json({ error: 'grupo do cliente sem UUID/número resolvido' });

    const from = formatarComMais(funcionario.twochat_channel_phone);

    const resposta = await enviarMensagem({
      from,
      to_group_uuid: groupUuid,
      text: texto || undefined,
      url: midia_url || undefined,
      reply_to_uuid: reply_to_uuid || undefined
    });

    const msgUuid = resposta?.message_uuid || resposta?.uuid || resposta?.id || `local-${Date.now()}`;
    const agora = new Date().toISOString();

    const chRes = await query(
      `select id from chamados where cliente_id = $1 and status in ('aberto','em_atendimento')
       order by aberto_em desc limit 1`,
      [cliente_id]
    );
    const chamadoId = chRes.rows[0]?.id || null;

    await query(
      `insert into mensagens
        (chamado_id, cliente_id, contato_id, msg_uuid, remetente_telefone, origem, texto, enviado_em,
         tipo_midia, midia_url, midia_nome, midia_mime,
         reply_to_uuid, reply_preview,
         enviado_pelo_painel, funcionario_remetente_id, status_entrega)
       values ($1, $2, $3, $4, $5, 'funcionario', $6, $7, $8, $9, $10, $11, $12, $13, true, $14, 'sent')
       on conflict (msg_uuid) do nothing`,
      [chamadoId, cliente_id, funcionarioId, msgUuid, funcionario.telefone, texto || null, agora,
       midia_tipo || null, midia_url || null, midia_nome || null, midia_mime || null,
       reply_to_uuid || null, reply_preview || null, funcionarioId]
    );

    if (chamadoId) {
      await query(
        `update chamados
         set qtd_msgs_funcionario = qtd_msgs_funcionario + 1,
             aguardando_desde = null,
             status = case when status = 'aberto' then 'em_atendimento' else status end,
             primeira_resposta_em = coalesce(primeira_resposta_em, now()),
             primeiro_responsavel_id = coalesce(primeiro_responsavel_id, $1)
         where id = $2`,
        [funcionarioId, chamadoId]
      );
      emitirBacklogAtualizado();
    }

    emitirMensagemEnviada({ cliente_id, msg_uuid: msgUuid });
    res.json({ ok: true, msg_uuid: msgUuid });
  } catch (err) {
    console.error('[api] enviar mensagem erro:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mensagens/:uuid/reagir
 * Headers: X-CS-Funcionario-Id
 * body: { cliente_id, emoji }
 */
router.post('/mensagens/:uuid/reagir', async (req, res) => {
  try {
    const funcionarioId = parseInt(req.headers['x-cs-funcionario-id']);
    if (!funcionarioId) return res.status(400).json({ error: 'header X-CS-Funcionario-Id obrigatório' });

    const fnRes = await query(
      `select twochat_channel_phone from contatos where id = $1 and tipo = 'funcionario'`,
      [funcionarioId]
    );
    if (fnRes.rowCount === 0) return res.status(404).json({ error: 'funcionário não encontrado' });

    const msgUuid = req.params.uuid;
    const { cliente_id, emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji obrigatório' });

    const clRes = await query(
      'select id, session_key, remote_phone_number from clientes where id = $1',
      [cliente_id]
    );
    if (clRes.rowCount === 0) return res.status(404).json({ error: 'cliente não encontrado' });
    const cliente = clRes.rows[0];

    const channelPhone = fnRes.rows[0].twochat_channel_phone;
    if (channelPhone) {
      try {
        const from = formatarComMais(channelPhone);
        const groupUuid = extrairGroupUuid(cliente.session_key) || cliente.remote_phone_number;
        await reagirMensagem({ from, to_group_uuid: groupUuid, message_uuid: msgUuid, emoji });
      } catch (err) {
        console.warn('[api] reagir via 2chat falhou (segue registro local):', err.message);
      }
    }

    await query(
      `insert into reacoes (msg_uuid, cliente_id, contato_id, emoji) values ($1, $2, $3, $4)`,
      [msgUuid, cliente_id, funcionarioId, emoji]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[api] reagir erro:', err);
    res.status(500).json({ error: err.message });
  }
});

function formatarComMais(num) {
  if (!num) return null;
  const n = String(num).replace(/\D/g, '');
  return n ? '+' + n : null;
}

function extrairGroupUuid(sessionKey) {
  if (!sessionKey) return null;
  const m = String(sessionKey).match(/WAG[0-9a-f-]+/i);
  return m ? m[0] : null;
}

// ============================================================
function pct(atual, anterior) {
  const a = Number(atual),
    b = Number(anterior);
  if (!b) return null;
  return Math.round(((a - b) / b) * 100);
}

export default router;
