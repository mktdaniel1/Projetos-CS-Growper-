# --- Postgres (Railway autopopula DATABASE_URL) ---
DATABASE_URL=postgresql://user:pass@host:5432/sereia_cs

# --- Anthropic (classificação de mensagens) ---
ANTHROPIC_API_KEY=sk-ant-...
CLASSIFIER_MODEL=claude-haiku-4-5-20251001

# --- 2chat (Alice) ---
TWOCHAT_API_KEY=...
TWOCHAT_CHANNEL_UUID=WPN...
TWOCHAT_WEBHOOK_BASE_URL=https://sereia-cs.up.railway.app

# --- Auth do dashboard (header X-CS-Token) ---
CS_DASHBOARD_TOKEN=Revisao123@

# --- CORS / frontend ---
FRONTEND_URL=https://sereia-cs.netlify.app

# --- Server ---
PORT=3000
NODE_ENV=production

# --- Telefones da Alice e operadores que devem ser tratados como bot ---
# CSV, sem espaços, formato internacional sem o '+' (ex: 5511999998888)
BOT_PHONE_NUMBERS=
