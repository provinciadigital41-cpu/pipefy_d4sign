// ============================================================================
// PIPEFY + D4SIGN (logs detalhados + trigger tolerante)
// ============================================================================

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
app.use(express.json({ limit: '2mb' })); // aumenta limite p/ log

// ---------------------------
// LOG GLOBAL DE REQUISIÇÕES
// ---------------------------
app.use((req, res, next) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const bodyPreview = raw ? raw.slice(0, 4000) : '';
    console.log(`[REQ] ${req.method} ${req.originalUrl} ip=${req.headers['x-forwarded-for'] || req.ip}`);
    console.log(`[REQ-H] content-type=${req.headers['content-type'] || ''}`);
    if (bodyPreview) console.log(`[REQ-BODY<=4KB] ${bodyPreview}`);
    next();
  });
});

// Keep-Alive
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 60_000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 60_000 });

// ============================================================================
// VARIÁVEIS DE AMBIENTE
// ============================================================================
const {
  PORT = 3000,
  PIPE_API_KEY,
  PIPE_GRAPHQL_ENDPOINT = 'https://api.pipefy.com/graphql',

  // D4Sign
  D4SIGN_CRYPT_KEY,
  D4SIGN_TOKEN,
  TEMPLATE_UUID_CONTRATO,

  // Pipefy
  PHASE_ID_CONTRATO_ENVIADO,

  // Cofres por vendedor (uuid do SAFE)
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

const FIELD_ID_CHECKBOX_DISPARO = 'gerar_contrato'; // select/checkbox "Sim"
const FIELD_ID_LINKS_D4 = 'd4_contrato';

// ============================================================================
// Cofres por vendedor
// ============================================================================
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
// Idempotência: lock curto + janela de reprocesso por card
// ============================================================================
const inFlight = new Set();
const lastProcessed = new Map(); // cardId -> timestamp
const LOCK_RELEASE_MS = 30_000;
const REPROCESS_COOLDOWN_MS = 3 * 60 * 1000; // 3 min

function acquireLock(key) {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  setTimeout(() => inFlight.delete(key), LOCK_RELEASE_MS).unref?.();
  return true;
}
function releaseLock(key) { inFlight.delete(key); }

// ============================================================================
// HELPERS REDE/HTTP
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
      const res = await fetch(url, { ...options, agent, signal: controller.signal });
      clearTimeout(to);
      return res;
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      const code = e.code || e.errno || e.type;
      const transient = TRANSIENT_CODES.has(code) || e.name === 'AbortError';
      const isLast = i === attempts;
      console.warn(`[HTTP-RETRY] ${u.host} tentativa ${i}/${attempts} → ${code || e.message}`);
      if (!transient || isLast) throw e;
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
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PIPE_API_KEY}` },
    body: JSON.stringify({ query, variables: vars })
  }, { attempts: 5, baseDelayMs: 500, timeoutMs: 20000 });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    console.error('[Pipefy GraphQL ERRO]', json.errors || res.statusText);
    throw new Error(JSON.stringify(json.errors || res.statusText));
  }
  return json.data;
}

async function setCardFieldText(cardId, fieldId, text) {
  const q = `
    mutation($input: UpdateCardFieldInput!) {
      updateCardField(input: $input) { card { id } }
    }
  `;
  const vars = { input: { card_id: cardId, field_id: fieldId, new_value: { string_value: String(text) } } };
  await gql(q, vars);
}

async function moveCardToPhaseSafe(card, destPhaseId) {
  if (card?.current_phase?.id === destPhaseId) return;
  const q = `
    mutation($input: MoveCardToPhaseInput!) {
      moveCardToPhase(input: $input) { card { id current_phase { id name } } }
    }
  `;
  const vars = { input: { card_id: card.id, destination_phase_id: destPhaseId } };
  try {
    await gql(q, vars);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('The card is already in the destination phase')) return;
    throw err;
  }
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

// tokens Word
function montarADDWord(d) {
  return {
    contratante_1: d.nome || '',
    dados_para_contato: `${d.email || ''} / ${d.telefone || ''}`,
    numero_de_parcelas_da_assessoria: String(d.parcelas || '1'),
    valor_da_parcela_da_assessoria: String(d.valor || '')
  };
}

function montarSigners(d) {
  return [{ email: d.email, name: d.nome, act: '1', foreign: '0', send_email: '1' }];
}

// ============================================================================
// D4SIGN – WORD
// ============================================================================
async function makeDocFromWordTemplate(tokenAPI, cryptKey, uuidSafe, templateId, title, varsObj) {
  const base = 'https://secure.d4sign.com.br';
  const url = new URL(`/api/v1/documents/${uuidSafe}/makedocumentbytemplateword`, base);
  url.searchParams.set('tokenAPI', tokenAPI);
  url.searchParams.set('cryptKey', cryptKey);
  const body = { name_document: title, templates: { [templateId]: varsObj } };

  const res = await fetchWithRetry(url.toString(), {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, { attempts: 5, baseDelayMs: 600, timeoutMs: 20000 });

  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !(json && (json.uuid || json.uuid_document))) {
    console.error('[ERRO D4SIGN WORD]', res.status, text);
    throw new Error(`Falha D4Sign(WORD): ${res.status}`);
  }
  return json.uuid || json.uuid_document;
}

async function cadastrarSignatarios(tokenAPI, cryptKey, uuidDocument, signers) {
  const base = 'https://secure.d4sign.com.br';
  const url = new URL(`/api/v1/documents/${uuidDocument}/createlist`, base);
  url.searchParams.set('tokenAPI', tokenAPI);
  url.searchParams.set('cryptKey', cryptKey);
  const body = { signers: signers.map(s => ({ email: s.email, name: s.name, act: s.act || '1', foreign: s.foreign || '0', send_email: s.send_email || '1' })) };

  const res = await fetchWithRetry(url.toString(), {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, { attempts: 5, baseDelayMs: 600, timeoutMs: 20000 });

  const text = await res.text();
  if (!res.ok) {
    console.error('[ERRO D4SIGN createlist]', res.status, text);
    throw new Error(`Falha ao cadastrar signatários: ${res.status}`);
  }
  return text;
}

async function criarDocumentoD4(tokenAPI, cryptKey, uuidSafe, templateId, title, varsObj, signers) {
  const uuidDoc = await makeDocFromWordTemplate(tokenAPI, cryptKey, uuidSafe, templateId, title, varsObj);
  await cadastrarSignatarios(tokenAPI, cryptKey, uuidDoc, signers);
  return uuidDoc;
}

// ============================================================================
// Edge trigger: detecta marcação para "Sim" com tolerância
// ============================================================================
function wasJustMarked(reqBody) {
  // 1) action.field
  const f1 = reqBody?.data?.action?.field;
  if (f1 && (f1.id === FIELD_ID_CHECKBOX_DISPARO || f1.internal_id === FIELD_ID_CHECKBOX_DISPARO)) {
    const prev = normalizeCheck(f1.previous_value);
    const now  = normalizeCheck(f1.value);
    if (now === 'sim' && prev !== 'sim') return true;
  }
  // 2) action.fields array
  const arr = reqBody?.data?.action?.fields;
  if (Array.isArray(arr)) {
    for (const itm of arr) {
      const idok = itm?.field?.id === FIELD_ID_CHECKBOX_DISPARO || itm?.field?.internal_id === FIELD_ID_CHECKBOX_DISPARO;
      if (!idok) continue;
      const prev = normalizeCheck(itm.previous_value);
      const now  = normalizeCheck(itm.value);
      if (now === 'sim' && prev !== 'sim') return true;
    }
  }
  // 3) fallback com name/new_value
  const maybe = reqBody?.data?.action?.name === FIELD_ID_CHECKBOX_DISPARO &&
                normalizeCheck(reqBody?.data?.action?.new_value) === 'sim';
  if (maybe) return true;

  return false;
}

function normalizeCheck(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'sim' : '';
  if (Array.isArray(v)) {
    const s = v.map(x => String(x || '').toLowerCase()).join(',');
    return s.includes('sim') ? 'sim' : s;
  }
  const s = String(v).toLowerCase().trim();
  if (s === 'true' || s === 'yes') return 'sim';
  return s;
}

// ============================================================================
// ROTAS
// ============================================================================

// Endpoint para debugar payload bruto, se quiser apontar o webhook aqui temporariamente
app.post('/webhook-dump', (req, res) => {
  console.log('[DUMP] corpo normalizado:', JSON.stringify(req.body).slice(0, 4000));
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('Servidor ativo e rodando'));
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/pipefy', async (req, res) => {
  console.log('[PIPEFY] webhook recebido em /pipefy');
  const cardId = req.body?.data?.action?.card?.id;
  if (!cardId) {
    console.warn('[PIPEFY] sem cardId no payload');
    return res.status(400).json({ error: 'Sem cardId' });
  }

  // edge trigger principal
  let triggerNow = wasJustMarked(req.body);

  // lock de clique simultâneo
  const lockKey = `card:${cardId}`;
  if (!acquireLock(lockKey)) {
    return res.status(200).json({ ok: true, message: 'Processamento em andamento' });
  }

  try {
    preflightDNS().catch(() => {});

    const data = await gql(
      `query($cardId: ID!) {
        card(id: $cardId) {
          id title assignees { name }
          current_phase { id name }
          fields { name value report_value field { id internal_id id } }
        }
      }`,
      { cardId }
    );
    const card = data.card;

    // fallback tolerante: se o campo estiver "Sim" no card e não processamos nos últimos 3min, processa
    if (!triggerNow) {
      const f = card.fields || [];
      const val = normalizeCheck(getField(f, FIELD_ID_CHECKBOX_DISPARO));
      if (val === 'sim') {
        const last = lastProcessed.get(card.id) || 0;
        if (Date.now() - last > REPROCESS_COOLDOWN_MS) {
          triggerNow = true;
          console.log('[PIPEFY] fallback: campo está Sim e cooldown ok; processando mesmo assim');
        }
      }
    }

    if (!triggerNow) {
      releaseLock(lockKey);
      return res.status(200).json({ ok: true, message: 'Evento ignorado (sem transição/condição)' });
    }

    // monta dados e executa
    const dados = montarDados(card);
    const add = montarADDWord(dados);
    const signers = montarSigners(dados);
    const uuidSafe = COFRES_UUIDS[dados.vendedor];
    if (!uuidSafe) throw new Error(`Cofre não configurado para vendedor: ${dados.vendedor}`);

    const d4uuid = await criarDocumentoD4(
      D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, uuidSafe,
      TEMPLATE_UUID_CONTRATO, card.title, add, signers
    );

    const link = `https://secure.d4sign.com.br/Plus/${d4uuid}`;
    await setCardFieldText(card.id, FIELD_ID_LINKS_D4, link);
    await moveCardToPhaseSafe(card, PHASE_ID_CONTRATO_ENVIADO);

    lastProcessed.set(card.id, Date.now());
    console.log(`[SUCESSO] Documento ${card.title} enviado para D4Sign com UUID ${d4uuid}`);
    releaseLock(lockKey);
    return res.json({ ok: true, d4uuid, link });

  } catch (e) {
    console.error('[ERRO PIPEFY-D4SIGN]', e.code || e.message || e);
    releaseLock(lockKey);
    return res.status(200).json({ ok: false, error: e.code || e.message || 'Erro desconhecido' });
  }
});

// ============================================================================
// START
// ============================================================================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  preflightDNS().catch(() => {});
});
