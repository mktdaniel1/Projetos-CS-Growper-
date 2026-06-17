/**
 * Wrapper das chamadas pra API do 2chat.
 * Doc: https://developers.2chat.co/
 *
 * IMPORTANTE: na v6, o `from` agora é o número do FUNCIONÁRIO logado,
 * não o número da Alice. Isso significa que cada funcionário precisa estar
 * conectado ao 2chat com seu próprio canal (~US$15/canal/mês).
 *
 * Alice continua existindo como canal separado, usada só para:
 *   - escutar webhooks (monitoramento)
 *   - disparos de comunicados pelo Daniel/heads (futuro)
 */

const BASE = 'https://api.p.2chat.io';

function headers() {
  return {
    'X-User-API-Key': process.env.TWOCHAT_API_KEY,
    'Content-Type': 'application/json'
  };
}

/**
 * Envia mensagem de texto, com opção de anexo URL e reply.
 * - from: número do funcionário logado (ex: +5511999998888)
 * - to_group_uuid: UUID do grupo no WhatsApp
 * - to_number: alternativa pra envio 1-a-1
 */
export async function enviarMensagem({
  from,
  to_number,
  to_group_uuid,
  text,
  url,
  reply_to_uuid
}) {
  if (!from) throw new Error('campo "from" obrigatório (número do funcionário no 2chat)');
  const body = { from_number: from };
  if (to_group_uuid) body.to_group_uuid = to_group_uuid;
  else if (to_number) body.to_number = to_number;
  else throw new Error('to_group_uuid ou to_number obrigatório');

  if (text) body.text = text;
  if (url) body.url = url;
  if (reply_to_uuid) body.quoted_message_uuid = reply_to_uuid;

  const r = await fetch(`${BASE}/open/whatsapp/send-message`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });

  const txt = await r.text();
  if (!r.ok) throw new Error(`2chat ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

/**
 * Envia reação (emoji) a uma mensagem específica.
 * Path pode variar conforme o 2chat ajusta a API.
 */
const PATH_REAGIR = '/open/whatsapp/send-reaction';

export async function reagirMensagem({ from, to_group_uuid, message_uuid, emoji }) {
  if (!from) throw new Error('campo "from" obrigatório');
  const body = { from_number: from, message_uuid, emoji };
  if (to_group_uuid) body.to_group_uuid = to_group_uuid;

  const r = await fetch(`${BASE}${PATH_REAGIR}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`2chat reaction ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}
