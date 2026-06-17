import 'dotenv/config';

const API = 'https://api.p.2chat.io/open/webhooks/subscribe';
const KEY = process.env.TWOCHAT_API_KEY;
const CHANNEL_UUID = process.env.TWOCHAT_CHANNEL_UUID;
const BASE = process.env.TWOCHAT_WEBHOOK_BASE_URL;

if (!KEY || !BASE) {
  console.error('Defina TWOCHAT_API_KEY e TWOCHAT_WEBHOOK_BASE_URL no .env');
  process.exit(1);
}

const HOOK_URL = `${BASE.replace(/\/+$/, '')}/webhook/2chat`;

// Eventos do 2chat que vamos assinar.
// Obs: o nome do evento de reação pode variar - cheque os logs do 2chat
// no painel se o evento esperado não chegar.
const EVENTOS = [
  'whatsapp.message.received',
  'whatsapp.message.sent',
  'whatsapp.message.reaction' // pode precisar de ajuste conforme docs vigentes
];

async function subscribe(event) {
  const url = `${API}/${event}`;
  const body = { hook_url: HOOK_URL };
  if (CHANNEL_UUID) body.waweb_uuid = CHANNEL_UUID;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-User-API-Key': KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  console.log(`[${event}] status ${res.status} -> ${text.slice(0, 200)}`);
}

async function run() {
  for (const ev of EVENTOS) {
    try {
      await subscribe(ev);
    } catch (err) {
      console.error(`Falha em ${ev}:`, err.message);
    }
  }
}

run();
