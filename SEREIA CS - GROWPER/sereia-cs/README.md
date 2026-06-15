# Sereia CS

Sistema de ticketing observacional sobre WhatsApp para o time de Customer Success da operação revisional. Lê mensagens dos 180 grupos via webhooks do 2chat (Alice), classifica via Claude Haiku, fecha chamados por reação ✅, e expõe métricas + backlog ao vivo num dashboard.

## Visão geral

```
180 grupos WhatsApp
        │
        ▼
  2chat (Alice)  ─────►  Alice (continua intocada)
        │
        ▼ webhook subscription paralela
  sereia-cs-backend (Railway)
        │
        ├─► Postgres (chamados, mensagens)
        ├─► Claude Haiku (classifica msg do cliente)
        └─► Socket.IO (atualiza dashboard ao vivo)
                │
                ▼
        sereia-cs-frontend (Netlify)
```

## Repositórios sugeridos

- `mktdaniel1/sereia-cs-backend` — pasta `backend/`
- `mktdaniel1/sereia-cs-frontend` — pasta `frontend/`

## Ordem de deploy

1. **Backend no Railway**
   - Subir o conteúdo de `backend/`
   - Adicionar Postgres ao projeto
   - Configurar variáveis (ver `backend/.env.example`)
   - Rodar `npm run migrate` na shell
   - Rodar `npm run subscribe` para registrar webhooks no 2chat

2. **Cadastrar grupos e funcionários**
   - **Funcionários PRIMEIRO**: todos os números do time do Growper (CS, marketing, financeiro, suporte) via `POST /api/funcionarios`. **Esquecer um funcionário = mensagens dele viram chamados-fantasma.**
   - 180 grupos via `POST /api/clientes`
   - Confirmar com `GET /api/funcionarios` antes de virar a chave

3. **Frontend no Netlify**
   - Subir o conteúdo de `frontend/`
   - Ajustar `API_BASE` no `app.js` para a URL do Railway
   - Adicionar a URL do Netlify em `FRONTEND_URL` do backend (CORS)

## Cadastro em massa dos 180 clientes

Sugestão: exportar do 2chat a lista de grupos (session_keys), e rodar um for loop:

```bash
# clientes.csv com colunas: nome,session_key
while IFS=, read -r nome session_key; do
  curl -s -X POST https://sereia-cs.up.railway.app/api/clientes \
    -H "X-CS-Token: $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"nome\":\"$nome\",\"session_key\":\"$session_key\"}"
done < clientes.csv
```

## Próximos passos (pós-MVP)

- **F2 — Aba SLA**: p50/p90 do T1R e TTR, comparativo por operador
- **F3 — Aba Reincidência**: clientes que voltaram em <24h, ranking pré-churn
- **F4 — Categorização visível**: gráfico de pizza do mix de assuntos (a categoria já é capturada pelo classificador, falta exibir)
- **F5 — Alertas**: webhook Slack/Telegram quando backlog > X ou SLA estourar
- **Integração com Sereia CRM**: unificar login e tabela de operadores

## Notas técnicas

### Heurística rápida no classificador
Para economizar custo da API Anthropic, mensagens curtas e óbvias (saudações puras, "ok", "obrigado") são classificadas sem chamar a API. Isso elimina ~60-70% das chamadas em grupos ativos.

### Idempotência
Webhooks do 2chat podem ser reenviados em caso de falha de entrega. Toda inserção em `mensagens` é protegida por `msg_uuid unique`, então duplicidade é tratada graciosamente.

### Reincidência automática
Quando um chamado é aberto, o backend verifica se houve outro chamado **resolvido** do mesmo cliente nas últimas 24h. Se houver, o novo chamado é marcado com `reincidente_de_id`, alimentando a aba Reincidência.

### Fechamento por reação
Operador reage com ✅ em qualquer mensagem do chamado → backend identifica o chamado pela mensagem reagida → marca como `resolvido`. Reação 🚫 marca como `descartado` (não conta nas métricas — útil pra ruído).

### Mensagens da Alice (bot)
Configure `BOT_PHONE_NUMBERS` no `.env` com os telefones que devem ser tratados como bot. Essas mensagens entram no banco com `origem='bot'` e **não** disparam SLA de primeira resposta (só atendimento humano dispara).
