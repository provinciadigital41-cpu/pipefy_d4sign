// ============================================================================
// PIPEFY + D4SIGN INTEGRAÇÃO - SERVER PRINCIPAL (com retries e DNS preflight)
// ============================================================================

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Keep-Alive agents para conexões mais estáveis
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 60_000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 60_000 });

// ============================================================================
// VARIÁVEIS DE AMBIENTE
// ============================================================================
const {
  PORT = 3000,
  PIPE_API_KEY,
  PIPE_GRAPHQL_ENDPOINT = 'https://api.pipefy.com/graphql',
  D4SIGN_CRYPT_KEY,
  D4SIGN_TOKEN,
  TEMPLATE_UUID_CONTRATO,
  PHASE_ID_PROPOSTA,
  PHASE_ID_CONTRATO_ENVIADO,
  COFRE_UUID_EDNA,
  COFRE_UUID_GREYCE,
  COFRE_UUID_MARIANA,
  COFRE_UUID_VALDEIR,
  COFRE_UUID_DEBORA,
  COFRE_UUID_MAYKON,
  COFRE_UUID_JEFERSON,
  COFRE_UUID_RONALDO,
  COFRE_UUID_BRENDA,
  COFRE_UUID_MAURO,
} = process.env;

const FIELD_ID_CHECKBOX_DISPARO = 'gerar_contrato';
const FIELD_ID_LINKS_D4 = 'd4_contrato';

const COFRES_UUIDS = {
  'EDNA BERTO DA SILVA': COFRE_UUID_EDNA,
  'Greyce Maria Candido Souza': COFRE_UUID_GREYCE,
  'mariana cristina de oliveira': COFRE_UUID_MARIANA,
  'Valdeir Almedia': COFRE_UUID_VALDEIR,
  'Débora Gonçalves': COFRE_UUID_DEBORA,
  'Maykon Campos': COFRE_UUID_MAYKON,
  'Jeferson Andrade Siqueira': COFRE_UUID_JEFERSON,
  'RONALDO SCARIOT DA SILVA': COFRE_UUID_RONALDO,
  'BRENDA ROSA DA SILVA': COFRE_UUID_BRENDA,
  'Mauro Furlan Neto': COFRE_UUID_MAURO
};

// ============================================================================
// HELPERS: DNS preflight + fetch com retry/backoff/timeout
// ============================================================================

async function preflightDNS() {
  const hosts = ['api.pipefy.com', 'secure.d4sign.com.br', 'google.com'];
  for (const host of hosts) {
    try {
      const { address } = await dns.lookup(host, { family: 4 });
      console.log(`[DNS] ${host} → ${address}`);
    } catch (e) {
      console.warn(`[DNS-AVISO] Falha ao resolver ${host}: ${e.code || e.message}`);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const TRANSIENT_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'
]);

async function fetchWithRetry(url, options = {}, {
  attempts = 5,
  baseDelayMs = 400,
  timeoutMs = 15000
} = {}) {

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    const u = new URL(url);
    const agent = u.protocol === 'http:' ? httpAgent : httpsAgent;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        agent,
        signal: controller.signal
      });
      clearTimeout(to);
      return res;
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      const code = e.code || e.errno || e.type;

      const transient = TRANSIENT_CODES.has(code) || e.name === 'AbortError';
      const isLast = i === attempts;

      console.warn(`[HTTP-RETRY] ${u.host} tentativa ${i}/${attempts} → ${code || e.message}`);

      if (!transient || isLast) {
        throw e;
      }
      const delay = baseDelayMs * Math.pow(2, i - 1);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ============================================================================
// GRAPHQL / PIPEFY
// ============================================================================
async function gql(query, vars) {
  const res = await fetchWithRetry(PIPE_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PIPE_API_KEY}`
    },
    body: JSON.stringify({ query, variables: vars })
  }, { attempts: 5, baseDelayMs: 500, timeoutMs: 20000 });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    console.error('[Pipefy GraphQL ERRO]', json.errors || res.statusText);
    throw new Error(JSON.stringify(json.errors || res.statusText));
  }
  return json.data;
}

function getField(fields, id) {
  const f = fields.find(x => x.field.id === id || x.field.internal_id === id);
  return f ? (f.value ?? f.report_value ?? null) : null;
}

function montarDados(card) {
  const f = card.fields || [];
  return {
    nome: getField(f, 'nome_do_contato'),
    email: getField(f, 'email_profissional'),
    telefone: getField(f, 'telefone'),
    cnpj: getField(f, 'cpf_cnpj'),
    servicos: getField(f, 'servi_os_de_contratos') || '',
    valor: getField(f, 'valor_do_neg_cio') || '',
    parcelas: getField(f, 'quantidade_de_parcelas') || '1',
    vendedor: card.assignees?.[0]?.name || 'Desconhecido'
  };
}

function montarADD(d) {
  return {
    'Contratante 1': d.nome,
    'Dados para contato': `${d.email} / ${d.telefone}`,
    'CNPJ/CPF': d.cnpj,
    'Valor da Assessoria': d.valor,
    'Número de parcelas da Assessoria': d.parcelas,
    'Vendedor': d.vendedor
  };
}

function montarSigners(d) {
  return [{
    email: d.email,
    name: d.nome,
    foreign: '0',
    auths: ['assinatura'],
    languagem: 'pt-BR',
    type_signer: 'sign',
    doc_type: '0'
  }];
}

// ============================================================================
// D4SIGN
// ============================================================================
async function criarDocumentoD4(token, cryptKey, uuidTemplate, title, add, signers, cofreUuid) {
  const url = `https://secure.d4sign.com.br/api/v1/documents/${uuidTemplate}/templates`;

  const body = {
    uuid_safe: token,
    uuid_cofre: cofreUuid,
    templates: [{
      title,
      email_signer: false,
      workflow: 0,
      block_physical: 1,
      block_sms: 0,
      skip_email: 0,
      block_foreign: 0,
      block_ip: 0,
      signers,
      add
    }]
  };

  console.log(`[D4SIGN] POST ${url}`);
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'tokenAPI': token,
      'cryptKey': cryptKey
    },
    body: JSON.stringify(body)
  }, { attempts: 5, baseDelayMs: 600, timeoutMs: 20000 });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok || !Array.isArray(data) || !data[0]?.uuid_document) {
    console.error(`[ERRO D4SIGN] HTTP ${res.status} → ${text}`);
    throw new Error(`Falha D4Sign: ${res.status}`);
  }

  console.log(`[D4SIGN] OK uuid=${data[0].uuid_document}`);
  return data[0].uuid_document;
}

// ============================================================================
// ROTAS
// ============================================================================
app.get('/', (req, res) => res.send('Servidor ativo e rodando'));
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/pipefy', async (req, res) => {
  const cardId = req.body?.data?.action?.card?.id;
  if (!cardId) return res.status(400).json({ error: 'Sem cardId' });

  try {
    preflightDNS().catch(() => {});

    const data = await gql(
      `query($cardId: ID!) {
        card(id: $cardId) {
          id title assignees { name }
          current_phase { id name }
          fields { name value report_value field { id internal_id } }
        }
      }`,
      { cardId }
    );

    const card = data.card;
    const f = card.fields || [];

    const disparo = getField(f, FIELD_ID_CHECKBOX_DISPARO);
    if (!disparo) return res.status(200).json({ ok: true, message: 'Checkbox não marcado' });

    const dados = montarDados(card);
    const add = montarADD(dados);
    const signers = montarSigners(dados);
    const cofreUuid = COFRES_UUIDS[dados.vendedor];

    if (!cofreUuid) throw new Error(`Cofre não configurado para vendedor: ${dados.vendedor}`);

    const d4uuid = await criarDocumentoD4(
      D4SIGN_TOKEN, D4SIGN_CRYPT_KEY,
      TEMPLATE_UUID_CONTRATO, card.title,
      add, signers, cofreUuid
    );

    const link = `https://secure.d4sign.com.br/Plus/${d4uuid}`;
    await gql(
      `mutation($input: SetFieldValueInput!) {
        setFieldValue(input: $input) { card { id } }
      }`,
      { input: { card_id: card.id, field_id: FIELD_ID_LINKS_D4, value: link } }
    );

    await gql(
      `mutation($input: MoveCardToPhaseInput!) {
        moveCardToPhase(input: $input) { card { id current_phase { id name } } }
      }`,
      { input: { card_id: card.id, destination_phase_id: PHASE_ID_CONTRATO_ENVIADO } }
    );

    console.log(`[SUCESSO] Documento ${card.title} enviado para D4Sign com UUID ${d4uuid}`);
    return res.json({ ok: true, d4uuid });

  } catch (e) {
    console.error('[ERRO PIPEFY-D4SIGN]', e.code || e.message || e);
    return res.status(502).json({ error: e.code || e.message || 'Erro desconhecido' });
  }
});

// ============================================================================
// START
// ============================================================================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  preflightDNS().catch(() => {});
});
