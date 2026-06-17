# Sereia CS — Backend

Sistema de ticketing observacional sobre WhatsApp para o time de Customer Success. Lê mensagens dos grupos via webhooks do 2chat, classifica via Claude Haiku, e expõe métricas + backlog ao vivo.

## Stack

- Node 20 + Express + Socket.IO
- Postgres
- Claude Haiku (classificador)
- 2chat (captura WhatsApp)
- Railway (hospedagem)

## Estrutura

```
src/
  server.js       Entry point (Express + Socket.IO)
  db.js           Pool Postgres + helper query/tx
  webhook.js      Handler unificado dos eventos do 2chat
  classifier.js   Classificação via Claude com heurística rápida no front
  api.js          Endpoints REST para o dashboard
  ws.js           Setup Socket.IO + helpers de emissão
  migrate.js      Aplica schema.sql
  scripts/
    subscribe-webhooks.js  Cadastra os webhooks no 2chat
schema.sql        DDL completo
```

## Setup local

```bash
cp .env.example .env
# edite .env com suas credenciais
npm install
npm run migrate
npm run dev
```

## Deploy no Railway

1. Crie um novo projeto e adicione um Postgres.
2. Suba este diretório como serviço (conecte ao GitHub `mktdaniel1/sereia-cs-backend`).
3. Configure as variáveis:
   - `DATABASE_URL` (Railway autopopula)
   - `ANTHROPIC_API_KEY`
   - `TWOCHAT_API_KEY`
   - `TWOCHAT_CHANNEL_UUID` (uuid da instância Alice no 2chat)
   - `TWOCHAT_WEBHOOK_BASE_URL` (URL pública do serviço Railway)
   - `CS_DASHBOARD_TOKEN` (token que o dashboard vai enviar)
   - `FRONTEND_URL` (URL Netlify do dashboard)
   - `BOT_PHONE_NUMBERS` (CSV - números da Alice e outros bots)
4. Após primeiro deploy, rode `npm run migrate` na shell do Railway.
5. Cadastre os webhooks no 2chat: `npm run subscribe`.

## Cadastro inicial dos 180 clientes

```bash
curl -X POST https://sereia-cs.up.railway.app/api/clientes \
  -H "X-CS-Token: $CS_DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nome": "Platino Assessoria",
    "session_key": "WW-WPN...-...@g.us",
    "channel_phone_number": "+555199...",
    "remote_phone_number": "...@g.us"
  }'
```

Pra obter o `session_key` de cada grupo, olhe o campo `session_key` que vem nos webhooks do 2chat (formato `WW-WPN{uuid}-{remote}@g.us`).

## Cadastro de funcionários

Todo número da equipe interna do Growper (CS, marketing, financeiro, suporte) que participa dos grupos via WhatsApp pessoal precisa estar cadastrado. **É por essa lista que o sistema distingue quem é equipe vs quem é cliente** — qualquer número não cadastrado falando num grupo é tratado como cliente.

```bash
curl -X POST https://sereia-cs.up.railway.app/api/funcionarios \
  -H "X-CS-Token: $CS_DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"nome": "Brenda", "telefone": "5511999998888", "setor": "cs"}'
```

`setor` aceita: `cs`, `marketing`, `financeiro`, `suporte`, `outro`.

Operadores que só usam o painel do 2chat (não falam pelo WhatsApp pessoal) também podem ser cadastrados — não obrigatório, mas ajuda a atribuir corretamente a reação ✅.

## Endpoints

| Método | Rota                          | Descrição                              |
|--------|-------------------------------|----------------------------------------|
| GET    | `/health`                     | Health check                           |
| POST   | `/webhook/2chat`              | Recebe webhooks do 2chat               |
| GET    | `/api/metrics/overview`       | Cards de hoje / semana / mês           |
| GET    | `/api/metrics/timeseries`     | Série temporal (?days=30)              |
| GET    | `/api/metrics/heatmap`        | Heatmap dia × hora (30d)               |
| GET    | `/api/metrics/top-clientes`   | Top N clientes do período              |
| GET    | `/api/backlog`                | Chamados em aberto + resumo            |
| POST   | `/api/clientes`               | Cadastra/atualiza grupo-cliente        |
| GET    | `/api/clientes`               | Lista grupos cadastrados               |
| POST   | `/api/funcionarios`           | Cadastra/atualiza funcionário interno  |
| GET    | `/api/funcionarios`           | Lista funcionários                     |
| GET    | `/api/contatos/:clienteId`    | Contatos vistos num grupo              |

Todos os endpoints `/api/*` exigem header `X-CS-Token`.

## Identificação cliente vs funcionário

**Esta é a regra mais importante do sistema.** O mesmo número da Alice está em grupos de várias áreas (marketing, financeiro, CS). Dentro de cada grupo há funcionários do Growper falando pelo WhatsApp pessoal + pessoas do cliente.

A classificação acontece **por telefone do remetente**:

1. `sent_by === 'api'` ou telefone em `BOT_PHONE_NUMBERS` → **bot** (Alice)
2. Telefone na tabela `funcionarios` → **funcionario** (resposta da equipe)
3. Qualquer outro telefone → **cliente** (potencial demanda)

Por isso o cadastro completo dos funcionários é pré-requisito. Esquecer um funcionário = todas as mensagens dele viram chamados-fantasma de "cliente". Use `GET /api/contatos/:clienteId` periodicamente pra ver se aparece algum telefone com muitas mensagens que devia ser funcionário.

## Métrica de tempo: aguardando vs aberto

A coluna `aguardando_desde` em `chamados` guarda o timestamp da última mensagem do cliente que ainda não foi respondida.

- Cliente fala → seta `aguardando_desde = enviado_em`
- Funcionário responde → `aguardando_desde = null` (bola está com o cliente)
- Cliente fala de novo → `aguardando_desde = enviado_em` (bola volta pra equipe)

O semáforo do backlog usa `aguardando_desde`, não `aberto_em`. Um chamado de 8h pode estar verde (foi respondido recentemente e o cliente está pensando) e um de 30min pode estar vermelho (cliente mandou 3 mensagens há 30min sem resposta).

## Reincidência

Se um cliente abre um chamado novo em até 24h após o fechamento do anterior, o novo chamado é marcado com `reincidente_de_id` apontando pro original. Isso alimenta a aba Reincidência do dashboard.
