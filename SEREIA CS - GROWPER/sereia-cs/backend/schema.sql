-- ============================================================
-- SEREIA CS - schema inicial
-- ============================================================

create table if not exists clientes (
  id                    serial primary key,
  nome                  text not null,
  channel_phone_number  text,                 -- número 2chat (Alice) que atende o grupo
  remote_phone_number   text,                 -- identificador do grupo no formato 2chat (...@g.us)
  session_key           text unique not null, -- chave única do grupo no 2chat
  ativo                 boolean default true,
  criado_em             timestamptz default now()
);

create index if not exists idx_clientes_ativo on clientes(ativo);

-- ------------------------------------------------------------

create table if not exists funcionarios (
  id        serial primary key,
  nome      text not null,
  telefone  text unique not null, -- número internacional sem o '+' (ex: 5511999998888)
  setor     text default 'cs' check (setor in ('cs','marketing','financeiro','suporte','outro')),
  ativo     boolean default true,
  criado_em timestamptz default now()
);

create index if not exists idx_funcionarios_ativo on funcionarios(ativo);

-- ------------------------------------------------------------
-- Cache de contatos vistos em cada grupo (todo número que não é funcionário).
-- Útil pra auditoria e pra futuro: identificar quem do cliente falou.
-- ------------------------------------------------------------
create table if not exists contatos_grupo (
  id              serial primary key,
  cliente_id      int references clientes(id) on delete cascade,
  telefone        text not null,
  nome            text,
  primeiro_visto  timestamptz default now(),
  ultimo_visto    timestamptz default now(),
  total_mensagens int default 0,
  unique(cliente_id, telefone)
);

create index if not exists idx_contatos_grupo_cliente on contatos_grupo(cliente_id);

-- ------------------------------------------------------------

create table if not exists chamados (
  id                      bigserial primary key,
  cliente_id              int references clientes(id) on delete restrict,
  msg_abertura_uuid       text not null,
  texto_abertura          text,
  contato_telefone        text,                -- telefone do contato do cliente que abriu
  categoria_ia            text,                -- boleto | processo | acordo | documentos | outro
  aberto_em               timestamptz not null,
  aguardando_desde        timestamptz,         -- timestamp da última msg do cliente sem resposta. NULL = não aguardando
  primeira_resposta_em    timestamptz,
  primeiro_responsavel_id int references funcionarios(id),
  fechado_em              timestamptz,
  fechado_por_id          int references funcionarios(id),
  metodo_fechamento       text check (metodo_fechamento in ('reacao','comando','descartado','auto')),
  status                  text not null check (status in ('aberto','em_atendimento','resolvido','descartado')),
  reincidente_de_id       bigint references chamados(id),
  qtd_msgs_cliente        int default 1,
  qtd_msgs_funcionario    int default 0,
  qtd_msgs_bot            int default 0
);

create index if not exists idx_chamados_cliente_aberto
  on chamados(cliente_id)
  where status in ('aberto','em_atendimento');

create index if not exists idx_chamados_aberto_em on chamados(aberto_em desc);
create index if not exists idx_chamados_status    on chamados(status);
create index if not exists idx_chamados_fechado_em on chamados(fechado_em desc) where fechado_em is not null;
create index if not exists idx_chamados_aguardando on chamados(aguardando_desde) where aguardando_desde is not null;

-- ------------------------------------------------------------

create table if not exists mensagens (
  id                       bigserial primary key,
  chamado_id               bigint references chamados(id) on delete set null,
  cliente_id               int references clientes(id),
  msg_uuid                 text unique not null,
  remetente_telefone       text,
  origem                   text check (origem in ('cliente','funcionario','bot')),
  texto                    text,
  enviado_em               timestamptz not null,
  classificacao_ia         text,        -- novo_chamado | complemento | ruido | resolucao_sugerida
  classificacao_confianca  numeric
);

create index if not exists idx_mensagens_chamado    on mensagens(chamado_id);
create index if not exists idx_mensagens_cliente_dt on mensagens(cliente_id, enviado_em desc);

-- ------------------------------------------------------------
-- View do backlog ao vivo
-- A coluna `aguardando_minutos` é a métrica principal: tempo desde a
-- última mensagem do cliente que ainda não recebeu resposta.
-- ------------------------------------------------------------
create or replace view v_backlog as
select
  c.id,
  c.cliente_id,
  cl.nome as cliente_nome,
  c.aberto_em,
  c.aguardando_desde,
  c.primeira_resposta_em,
  c.primeiro_responsavel_id,
  f.nome as responsavel_nome,
  c.qtd_msgs_cliente,
  c.qtd_msgs_funcionario,
  c.status,
  c.texto_abertura,
  c.contato_telefone,
  (extract(epoch from (now() - c.aberto_em)) / 60)::int as minutos_aberto,
  case
    when c.aguardando_desde is null then 0
    else (extract(epoch from (now() - c.aguardando_desde)) / 60)::int
  end as aguardando_minutos,
  case
    when c.aguardando_desde is null then 'aguardando_cliente'  -- bola está com o cliente
    when (now() - c.aguardando_desde) > interval '2 hours'    then 'critico'
    when (now() - c.aguardando_desde) > interval '30 minutes' then 'atencao'
    else 'ok'
  end as semaforo,
  (
    select texto from mensagens m
    where m.chamado_id = c.id
    order by enviado_em desc
    limit 1
  ) as ultima_mensagem
from chamados c
join clientes cl on cl.id = c.cliente_id
left join funcionarios f on f.id = c.primeiro_responsavel_id
where c.status in ('aberto','em_atendimento');
