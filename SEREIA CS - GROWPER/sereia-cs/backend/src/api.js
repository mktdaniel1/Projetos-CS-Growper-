import { Router } from 'express';
import { query } from './db.js';

const router = Router();

// Middleware de auth simples - header X-CS-Token
router.use((req, res, next) => {
  const token = req.header('X-CS-Token') || req.query.token;
  if (token !== process.env.CS_DASHBOARD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ----------------------------------------------------------
// OVERVIEW - cards de hoje / semana / mês com delta
// ----------------------------------------------------------
router.get('/metrics/overview', async (req, res) => {
  try {
    const r = await query(`
      with periodos as (
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
      )
      select * from periodos
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

// ----------------------------------------------------------
// SÉRIE TEMPORAL - chamados/dia últimos N dias
// ----------------------------------------------------------
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
        select aberto_em::date as dia, count(*) as q
        from chamados where aberto_em::date >= current_date - $1::int * interval '1 day'
          and status <> 'descartado'
        group by 1
      ),
      resolvidos as (
        select fechado_em::date as dia, count(*) as q
        from chamados where fechado_em is not null and fechado_em::date >= current_date - $1::int * interval '1 day'
          and metodo_fechamento <> 'descartado'
        group by 1
      )
      select s.dia,
             coalesce(a.q, 0) as abertos,
             coalesce(r.q, 0) as resolvidos
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

// ----------------------------------------------------------
// HEATMAP - dia da semana × hora (últimos 30 dias)
// ----------------------------------------------------------
router.get('/metrics/heatmap', async (req, res) => {
  try {
    // dow: 0=domingo ... 6=sábado (no Postgres)
    const r = await query(`
      select extract(dow from aberto_em)::int as dow,
             extract(hour from aberto_em)::int as hora,
             count(*)::int as q
      from chamados
      where aberto_em >= current_date - interval '30 days' and status <> 'descartado'
      group by 1, 2
    `);

    // Reformata para matriz 7×24
    const matriz = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const row of r.rows) matriz[row.dow][row.hora] = row.q;
    res.json(matriz);
  } catch (err) {
    console.error('[api] heatmap erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

// ----------------------------------------------------------
// TOP CLIENTES - quem mais abriu no período
// ----------------------------------------------------------
router.get('/metrics/top-clientes', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const period = req.query.period === 'semana' ? "date_trunc('week', current_date)" : "date_trunc('month', current_date)";

    const r = await query(`
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
        from chamados
        where aberto_em >= current_date - interval '30 days' and status <> 'descartado'
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
    `, [limit]);

    res.json(r.rows);
  } catch (err) {
    console.error('[api] top-clientes erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

// ----------------------------------------------------------
// BACKLOG AO VIVO
// ----------------------------------------------------------
router.get('/backlog', async (req, res) => {
  try {
    const r = await query(`
      select * from v_backlog
      order by case semaforo
                 when 'critico' then 0
                 when 'atencao' then 1
                 when 'ok' then 2
                 else 3
               end,
               aguardando_minutos desc,
               aberto_em asc
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

// ----------------------------------------------------------
// CADASTRO de clientes / operadores (admin básico)
// ----------------------------------------------------------
router.post('/clientes', async (req, res) => {
  try {
    const { nome, session_key, channel_phone_number, remote_phone_number } = req.body;
    if (!nome || !session_key) return res.status(400).json({ error: 'nome e session_key são obrigatórios' });
    const r = await query(
      `insert into clientes (nome, session_key, channel_phone_number, remote_phone_number)
       values ($1, $2, $3, $4)
       on conflict (session_key) do update set nome = excluded.nome, ativo = true
       returning id, nome, session_key, ativo`,
      [nome, session_key, channel_phone_number || null, remote_phone_number || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[api] cliente erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/funcionarios', async (req, res) => {
  try {
    const { nome, telefone, setor } = req.body;
    if (!nome || !telefone) return res.status(400).json({ error: 'nome e telefone obrigatórios' });
    const normal = telefone.replace(/\D/g, '');
    const setorVal = ['cs','marketing','financeiro','suporte','outro'].includes(setor) ? setor : 'cs';
    const r = await query(
      `insert into funcionarios (nome, telefone, setor)
       values ($1, $2, $3)
       on conflict (telefone) do update set nome = excluded.nome, setor = excluded.setor, ativo = true
       returning id, nome, telefone, setor, ativo`,
      [nome, normal, setorVal]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[api] funcionario erro:', err);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/clientes', async (req, res) => {
  const r = await query('select id, nome, session_key, ativo from clientes order by nome');
  res.json(r.rows);
});

router.get('/funcionarios', async (req, res) => {
  const r = await query('select id, nome, telefone, setor, ativo from funcionarios order by setor, nome');
  res.json(r.rows);
});

router.get('/contatos/:clienteId', async (req, res) => {
  const r = await query(
    `select telefone, nome, total_mensagens, primeiro_visto, ultimo_visto
     from contatos_grupo
     where cliente_id = $1
     order by total_mensagens desc, ultimo_visto desc`,
    [req.params.clienteId]
  );
  res.json(r.rows);
});

// ----------------------------------------------------------
function pct(atual, anterior) {
  const a = Number(atual), b = Number(anterior);
  if (!b) return null;
  return Math.round(((a - b) / b) * 100);
}

export default router;
