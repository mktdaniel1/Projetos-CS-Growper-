-- ============================================================
-- SEREIA CS - schema v2
--
-- Modelo unificado: tabela `contatos` global por telefone, com
-- tipo classificável (funcionario | cliente | ignorado | NULL).
-- A relação contato × cliente fica em `contatos_grupo` (frequência
-- de mensagens em cada grupo).
--
-- ATENÇÃO: este schema dropa as tabelas antigas se existirem.
-- Use apenas em base vazia ou de teste.
-- ============================================================

drop view  if exists v_backlog       cascade;
drop table if exists reacoes         cascade;
drop table if exists lembretes       cascade;
drop table if exists mensagens       cascade;
drop table if exists chamados        cascade;
drop table if exists contatos_grupo  cascade;
drop table if exists funcionarios    cascade;
drop table if exists contatos        cascade;

-- ------------------------------------------------------------
-- Clientes (grupos de WhatsApp)
-- ------------------------------------------------------------
create table if not exists clientes (
  id                    serial primary key,
  nome                  text not null,
  channel_phone_number  text,
  remote_phone_number   text,
  session_key           text unique not null,
  link_whatsapp         text,                     -- link do grupo (chat.whatsapp.com/...) p/ botão "abrir grupo"
  ativo                 boolean default true,
  criado_em             timestamptz default now()
);

create index if not exists idx_clientes_ativo on clientes(ativo);

-- ------------------------------------------------------------
-- Contatos (todo número visto, classificado ou não)
-- ------------------------------------------------------------
create table contatos (
  id                     serial primary key,
  telefone               text unique not null,            -- internacional sem +
  nome                   text,
  tipo                   text check (tipo in ('funcionario','cliente','ignorado')),  -- NULL = não classificado
  setor                  text check (setor in ('cs','marketing','financeiro','suporte','outro')),
  cargo                  text,
  cliente_principal_id   int references clientes(id) on delete set null,  -- só pra tipo='cliente'
  twochat_channel_phone  text,                            -- pra funcionário: número conectado ao 2chat (envia em seu nome)
  twochat_channel_uuid   text,                            -- opcional, UUID do canal no 2chat
  primeiro_visto         timestamptz default now(),
  ultimo_visto           timestamptz default now(),
  classificado_em        timestamptz,
  ativo                  boolean default true
);

create index idx_contatos_tipo               on contatos(tipo);
create index idx_contatos_telefone           on contatos(telefone);
create index idx_contatos_cliente_principal  on contatos(cliente_principal_id);
create index idx_contatos_nao_classificados  on contatos(ultimo_visto desc) where tipo is null;

-- ------------------------------------------------------------
-- Relação contato × cliente (frequência por grupo)
-- ------------------------------------------------------------
create table contatos_grupo (
  id              serial primary key,
  contato_id      int references contatos(id) on delete cascade,
  cliente_id      int references clientes(id) on delete cascade,
  total_mensagens int default 0,
  primeiro_visto  timestamptz default now(),
  ultimo_visto    timestamptz default now(),
  unique(contato_id, cliente_id)
);

create index idx_contatos_grupo_contato on contatos_grupo(contato_id);
create index idx_contatos_grupo_cliente on contatos_grupo(cliente_id);

-- ------------------------------------------------------------
-- Chamados
-- ------------------------------------------------------------
create table chamados (
  id                      bigserial primary key,
  cliente_id              int references clientes(id) on delete restrict,
  contato_abertura_id     int references contatos(id),     -- quem do cliente abriu
  msg_abertura_uuid       text not null,
  texto_abertura          text,
  categoria_ia            text,
  aberto_em               timestamptz not null,
  aguardando_desde        timestamptz,                     -- última msg do cliente sem resposta. NULL = não aguardando
  primeira_resposta_em    timestamptz,
  primeiro_responsavel_id int references contatos(id),     -- funcionário que respondeu primeiro
  fechado_em              timestamptz,
  fechado_por_id          int references contatos(id),     -- funcionário que fechou
  metodo_fechamento       text check (metodo_fechamento in ('reacao','comando','descartado','auto')),
  status                  text not null check (status in ('aberto','em_atendimento','resolvido','descartado')),
  reincidente_de_id       bigint references chamados(id),
  qtd_msgs_cliente        int default 1,
  qtd_msgs_funcionario    int default 0,
  qtd_msgs_bot            int default 0,
  prioridade              text check (prioridade in ('alta','media','baixa')),  -- NULL = sem prioridade definida
  prioridade_definida_em  timestamptz,
  prioridade_definida_por_id int references contatos(id)
);

create index idx_chamados_prioridade on chamados(prioridade) where prioridade is not null;

create index idx_chamados_cliente_aberto on chamados(cliente_id)
  where status in ('aberto','em_atendimento');
create index idx_chamados_aberto_em  on chamados(aberto_em desc);
create index idx_chamados_status     on chamados(status);
create index idx_chamados_fechado_em on chamados(fechado_em desc) where fechado_em is not null;
create index idx_chamados_aguardando on chamados(aguardando_desde) where aguardando_desde is not null;

-- ------------------------------------------------------------
-- Mensagens
-- ------------------------------------------------------------
create table mensagens (
  id                       bigserial primary key,
  chamado_id               bigint references chamados(id) on delete set null,
  cliente_id               int references clientes(id),
  contato_id               int references contatos(id),
  msg_uuid                 text unique not null,
  remetente_telefone       text,
  origem                   text check (origem in ('cliente','funcionario','bot','nao_classificado','ignorado')),
  texto                    text,
  -- Mídia (texto = null em todos)
  tipo_midia               text check (tipo_midia in ('imagem','audio','video','documento','sticker','localizacao')),
  midia_url                text,
  midia_nome               text,
  midia_mime               text,
  -- Reply (citação)
  reply_to_uuid            text,
  reply_preview            text,                      -- preview de até 100 chars da msg citada
  -- Origem do envio (pra distinguir mensagens enviadas pelo painel Sereia)
  enviado_pelo_painel      boolean default false,
  funcionario_remetente_id int references contatos(id),  -- quando enviado_pelo_painel: quem do time escreveu
  -- Status do 2chat (✓✓)
  status_entrega           text,                      -- sent | delivered | read | failed
  -- Classificação IA
  enviado_em               timestamptz not null,
  classificacao_ia         text,
  classificacao_confianca  numeric
);

create index idx_mensagens_chamado     on mensagens(chamado_id);
create index idx_mensagens_cliente_dt  on mensagens(cliente_id, enviado_em desc);
create index idx_mensagens_contato_dt  on mensagens(contato_id, enviado_em desc);
create index idx_mensagens_reply       on mensagens(reply_to_uuid) where reply_to_uuid is not null;

-- ------------------------------------------------------------
-- Reações (todas, não só ✅/🚫)
-- ------------------------------------------------------------
create table reacoes (
  id           bigserial primary key,
  msg_uuid     text not null,
  cliente_id   int references clientes(id) on delete cascade,
  contato_id   int references contatos(id),
  emoji        text not null,
  criada_em    timestamptz default now(),
  removida_em  timestamptz
);

create index idx_reacoes_msg     on reacoes(msg_uuid) where removida_em is null;
create index idx_reacoes_cliente on reacoes(cliente_id);

-- ------------------------------------------------------------
-- Lembretes & alertas
--
-- Tipos:
--   sla_estourado   - automático: cliente esperando resposta há muito tempo
--   cliente_silente - automático: time respondeu, cliente sumiu há 24h+
--   fossilizado     - automático: chamado aberto há 3+ dias sem atividade
--   manual          - criado por um funcionário, com texto livre
--
-- Resolução do lembrete:
--   atendido         - alguém foi atender o chamado
--   adiado           - mover disparar_em pra frente, status volta a pendente
--   cancelado        - ignorar este lembrete
--   cliente_respondeu - cliente respondeu sozinho (auto-resolve em alguns casos)
-- ------------------------------------------------------------
create table lembretes (
  id                bigserial primary key,
  chamado_id        bigint references chamados(id) on delete cascade,
  cliente_id        int references clientes(id) on delete cascade,
  tipo              text not null check (tipo in ('sla_estourado','cliente_silente','fossilizado','manual')),
  disparar_em       timestamptz not null,
  disparado_em      timestamptz,
  resolvido_em      timestamptz,
  resolvido_por_id  int references contatos(id),
  resolucao         text check (resolucao in ('atendido','adiado','cancelado','cliente_respondeu')),
  texto             text,
  criado_por_id     int references contatos(id),
  criado_por_nome   text,   -- denormalizado pra exibir "lembrete da Cristina"
  criado_em         timestamptz default now(),
  status            text default 'pendente' check (status in ('pendente','disparado','resolvido','cancelado'))
);

create index idx_lembretes_disparar  on lembretes(disparar_em) where status = 'pendente';
create index idx_lembretes_disparados on lembretes(disparado_em desc) where status = 'disparado';
create index idx_lembretes_chamado   on lembretes(chamado_id);
create index idx_lembretes_status    on lembretes(status);

-- Evita duplicar lembretes automáticos: 1 por (chamado, tipo) enquanto ativo
create unique index idx_lembretes_auto_unique
  on lembretes(chamado_id, tipo)
  where status in ('pendente','disparado') and tipo <> 'manual';

-- ------------------------------------------------------------
-- View do backlog ao vivo
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
  resp.nome as responsavel_nome,
  resp.cargo as responsavel_cargo,
  c.qtd_msgs_cliente,
  c.qtd_msgs_funcionario,
  c.status,
  c.prioridade,
  c.texto_abertura,
  abre.telefone as contato_telefone,
  abre.nome as contato_nome,
  abre.cargo as contato_cargo,
  (extract(epoch from (now() - c.aberto_em)) / 60)::int as minutos_aberto,
  case
    when c.aguardando_desde is null then 0
    else (extract(epoch from (now() - c.aguardando_desde)) / 60)::int
  end as aguardando_minutos,
  case
    when c.aguardando_desde is null then 'aguardando_cliente'
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
left join contatos resp on resp.id = c.primeiro_responsavel_id
left join contatos abre on abre.id = c.contato_abertura_id
where c.status in ('aberto','em_atendimento');
