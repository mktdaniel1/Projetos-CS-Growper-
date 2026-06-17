import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';

const CATEGORIAS = ['boleto', 'processo', 'acordo', 'documentos', 'pagamento', 'outro'];
const CLASSIFICACOES = ['novo_chamado', 'complemento', 'resolucao_sugerida', 'ruido'];

/**
 * Classifica uma mensagem do cliente.
 * @param {object} ctx
 * @param {string} ctx.texto             - texto da mensagem do cliente
 * @param {string} ctx.clienteNome
 * @param {object|null} ctx.chamadoAberto - { texto_abertura, minutos_aberto } se houver
 * @returns {Promise<{ classificacao: string, confianca: number, categoria: string }>}
 */
export async function classificar({ texto, clienteNome, chamadoAberto }) {
  // Heurística rápida sem chamar API para mensagens triviais (economiza ~70% das chamadas)
  const fastResult = tentarClassificacaoRapida(texto, chamadoAberto);
  if (fastResult) return fastResult;

  const prompt = montarPrompt({ texto, clienteNome, chamadoAberto });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = response.content[0]?.text?.trim() ?? '';
    return parseResposta(raw);
  } catch (err) {
    console.error('[classifier] erro:', err.message);
    return { classificacao: 'novo_chamado', confianca: 0.3, categoria: 'outro' };
  }
}

function tentarClassificacaoRapida(texto, chamadoAberto) {
  const t = (texto || '').trim().toLowerCase();
  if (!t) return { classificacao: 'ruido', confianca: 1.0, categoria: 'outro' };

  // Saudações puras
  const saudacoes = ['bom dia', 'boa tarde', 'boa noite', 'oi', 'olá', 'ola', 'tudo bem?', 'tudo bem'];
  if (saudacoes.some((s) => t === s || t === s + '!') && !chamadoAberto) {
    return { classificacao: 'ruido', confianca: 0.95, categoria: 'outro' };
  }

  // Confirmações simples quando há chamado em andamento
  if (chamadoAberto) {
    const okPhrases = ['ok', 'obrigado', 'obrigada', 'valeu', 'vlw', 'show', 'beleza', 'perfeito', 'top', 'resolvido', 'deu certo'];
    if (okPhrases.some((p) => t === p || t === p + '!' || t === p + '.')) {
      return { classificacao: 'resolucao_sugerida', confianca: 0.9, categoria: 'outro' };
    }
  }

  return null;
}

function montarPrompt({ texto, clienteNome, chamadoAberto }) {
  const ctxChamado = chamadoAberto
    ? `\nCHAMADO ABERTO: sim, há ${chamadoAberto.minutos_aberto} min.\nTEXTO DO CHAMADO ABERTO: "${chamadoAberto.texto_abertura}"\n`
    : '\nCHAMADO ABERTO: não.\n';

  return `Você classifica mensagens de WhatsApp recebidas no atendimento de uma assessoria financeira no Brasil (revisional bancária - revisão de juros abusivos).

CLIENTE: ${clienteNome}${ctxChamado}
MENSAGEM RECEBIDA: """${texto}"""

Classifique em UMA das categorias:
- novo_chamado: cliente está pedindo, perguntando, reclamando ou solicitando alguma coisa
- complemento: cliente está adicionando contexto a um chamado já aberto (só use se há chamado aberto)
- resolucao_sugerida: cliente está confirmando que resolveu / agradecendo ao final ("ok obrigado", "resolvido", "deu certo")
- ruido: cumprimento isolado, figurinha, sticker, mensagem sem demanda

REGRAS:
- Se há chamado aberto e o assunto for relacionado, prefira "complemento" sobre "novo_chamado".
- Se há chamado aberto e o assunto for CLARAMENTE diferente, use "novo_chamado".
- Se a mensagem tem informação útil (números, nomes, documentos), nunca é "ruido".

Também classifique a categoria do assunto:
${CATEGORIAS.join(', ')}

Responda APENAS UM JSON, sem markdown, sem texto antes ou depois:
{"classificacao":"...","confianca":0.0,"categoria":"..."}`;
}

function parseResposta(raw) {
  try {
    const limpo = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const obj = JSON.parse(limpo);
    const classificacao = CLASSIFICACOES.includes(obj.classificacao) ? obj.classificacao : 'novo_chamado';
    const categoria = CATEGORIAS.includes(obj.categoria) ? obj.categoria : 'outro';
    const confianca = typeof obj.confianca === 'number' ? Math.max(0, Math.min(1, obj.confianca)) : 0.5;
    return { classificacao, confianca, categoria };
  } catch (err) {
    console.error('[classifier] parse falhou:', raw);
    return { classificacao: 'novo_chamado', confianca: 0.3, categoria: 'outro' };
  }
}
