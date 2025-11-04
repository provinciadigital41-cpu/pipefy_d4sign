// ============================================================================
// PIPEFY + D4SIGN (link público externo + confirmação e geração sob demanda)
// Modelo alinhado ao "CONTRATO NOVO MODELO D4.docx"
// ============================================================================

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const app = express();

// Logs leves
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl} ip=${req.headers['x-forwarded-for'] || req.ip}`);
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { console.log(`[REQ-BODY<=2KB] ${JSON.stringify(req.body).slice(0, 2000)}`); } catch {}
  }
  next();
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

  D4SIGN_CRYPT_KEY,
  D4SIGN_TOKEN,
  TEMPLATE_UUID_CONTRATO,

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

  PUBLIC_BASE_URL,
  PUBLIC_LINK_SECRET
} = process.env;

if (!PUBLIC_BASE_URL || !PUBLIC_LINK_SECRET) {
  console.warn('[AVISO] Defina PUBLIC_BASE_URL e PUBLIC_LINK_SECRET nas variáveis de ambiente');
}

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

// Idempotência
const inFlight = new Set();
const LOCK_RELEASE_MS = 30_000;
function acquireLock(key) { if (inFlight.has(key)) return false; inFlight.add(key); setTimeout(()=>inFlight.delete(key), LOCK_RELEASE_MS).unref?.(); return true; }
function releaseLock(key) { inFlight.delete(key); }

// ============================================================================
// HELPERS
// ============================================================================
async function preflightDNS() {
  const hosts = ['api.pipefy.com', 'secure.d4sign.com.br', 'google.com'];
  for (const host of hosts) {
    try { const { address } = await dns.lookup(host, { family: 4 }); console.log(`[DNS] ${host} → ${address}`); }
    catch (e) { console.warn(`[DNS-AVISO] Falha ao resolver ${host}: ${e.code || e.message}`); }
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const TRANSIENT_CODES = new Set(['EAI_AGAIN','ENOTFOUND','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH']);

async function fetchWithRetry(url, options = {}, { attempts = 5, baseDelayMs = 400, timeoutMs = 15000 } = {}) {
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
      if (!transient || i === attempts) throw e;
      await sleep(baseDelayMs * Math.pow(2, i - 1));
    }
  }
  throw lastErr;
}

// Pipefy base
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

// unwrap: aceita string direta, objetos tipo { string_value: "..." } ou strings estilo '{"string_value"=>"..."}'
function unwrapValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') {
    try {
      // casos que vêm com => do Ruby
      if (v.includes('string_value') && v.includes('=>')) {
        const fixed = v.replace(/=>/g, ':').replace(/:(\s*)([a-zA-Z_]+)/g, ': "$2"');
        const parsed = JSON.parse(fixed);
        if (parsed && parsed.string_value) return String(parsed.string_value);
      }
      // string normal
      return v;
    } catch { return v; }
  }
  if (typeof v === 'object' && v.string_value) return String(v.string_value);
  return String(v);
}

async function setCardFieldText(cardId, fieldId, text) {
  // grava só string_value para manter o campo limpo (apenas o link)
  const q = `
    mutation($input: UpdateCardFieldInput!) {
      updateCardField(input: $input) { card { id } }
    }
  `;
  const vars = { input: { card_id: cardId, field_id: fieldId, new_value: { string_value: String(text) } } };
  await gql(q, vars);
}

async function moveCardToPhaseSafe(cardId, destPhaseId) {
  const q = `mutation($input: MoveCardToPhaseInput!) { moveCardToPhase(input: $input) { card { id } } }`;
  await gql(q, { input: { card_id: cardId, destination_phase_id: destPhaseId } }).catch(err => {
    const msg = String(err?.message || err);
    if (!msg.includes('already in the destination phase')) throw err;
  });
}

function getField(fields, id) {
  const f = fields.find(x => x.field.id === id || x.field.internal_id === id);
  if (!f) return null;
  const v = f.value ?? f.report_value ?? null;
  return unwrapValue(v);
}

// moeda BR
function onlyNumberBR(v) {
  const s = String(v ?? '').replace(/[^\d.,-]/g,'').replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : 0;
}
function moneyBRNoSymbol(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Normalização select/checkbox de "Sim"
function normalizeCheck(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'sim' : '';
  if (Array.isArray(v)) return v.map(x => String(x||'').toLowerCase()).includes('sim') ? 'sim' : '';
  let s = String(v).trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    try { const arr = JSON.parse(s); if (Array.isArray(arr)) return arr.map(x => String(x||'').toLowerCase()).includes('sim') ? 'sim' : ''; } catch {}
  }
  s = s.toLowerCase();
  return (s === 'true' || s === 'yes' || s === 'sim' || s === 'checked') ? 'sim' : '';
}
function logDecision(step, obj) {
  try { console.log(`[DECISION] ${step} :: ${JSON.stringify(obj)}`); } catch { console.log(`[DECISION] ${step}`); }
}

// ============================================================================
// D4Sign
// ============================================================================
async function makeDocFromWordTemplate(tokenAPI, cryptKey, uuidSafe, templateId, title, varsObj) {
  const base = 'https://secure.d4sign.com.br';
  const url = new URL(`/api/v1/documents/${uuidSafe}/makedocumentbytemplateword`, base);
  url.searchParams.set('tokenAPI', tokenAPI);
  url.searchParams.set('cryptKey', cryptKey);
  const body = { name_document: title, templates: { [templateId]: varsObj } };
  const res = await fetchWithRetry(url.toString(), {
    method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
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
    method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, { attempts: 5, baseDelayMs: 600, timeoutMs: 20000 });
  const text = await res.text();
  if (!res.ok) { console.error('[ERRO D4SIGN createlist]', res.status, text); throw new Error(`Falha ao cadastrar signatários: ${res.status}`); }
  return text;
}

// ============================================================================
// Montagem de dados e tokens compatíveis com o DOCX novo
// ============================================================================
function montarDados(card) {
  const f = card.fields || [];

  // serviços pode vir array ou string JSON
  const serviziRaw = getField(f, 'servi_os_de_contratos') || [];
  let servicos = Array.isArray(serviziRaw) ? serviziRaw : [];
  if (typeof serviziRaw === 'string') {
    try { const tmp = JSON.parse(serviziRaw); if (Array.isArray(tmp)) servicos = tmp; } catch {}
  }

  return {
    // Identificação e endereço
    nome: getField(f, 'nome_do_contato') || '',
    estado_civil: getField(f, 'estado_civil') || '',
    rua: getField(f, 'rua') || '',
    bairro: getField(f, 'bairro') || '',
    numero: getField(f, 'numero') || '',
    cidade: getField(f, 'cidade') || '',
    uf: getField(f, 'uf') || '',
    cep: getField(f, 'cep') || '',
    rg: getField(f, 'rg') || '',
    cpf: getField(f, 'cpf_cnpj') || '',

    // Contato
    email: getField(f, 'email_profissional') || '',
    telefone: getField(f, 'telefone') || '',

    // Serviços
    servicos,
    nome_marca: getField(f, 'nome_marca') || '',
    classe: getField(f, 'classe') || '',
    risco: getField(f, 'risco') || '',

    // Remuneração (assessoria)
    valor_total: getField(f, 'valor_do_neg_cio') || '',
    parcelas: Number(getField(f, 'quantidade_de_parcelas') || 1),

    // Pesquisa de viabilidade (select id "paga": paga | isenta)
    pesquisa_status: String(getField(f, 'paga') || '').toLowerCase(),

    // Taxa de encaminhamento (select id "copy_of_pesquisa")
    taxa_faixa: String(getField(f, 'copy_of_pesquisa') || '').toLowerCase(),

    // Local e data do rodapé
    dia: getField(f, 'dia') || '',
    mes: getField(f, 'mes') || '',
    ano: getField(f, 'ano') || '',

    // Vendedor p/ cofre
    vendedor: card.assignees?.[0]?.name || 'Desconhecido'
  };
}

function montarADDWord(d) {
  // parcelas e valor da parcela (sem "R$")
  const parcelas = Math.max(1, Number(d.parcelas || 1));
  const totalN = onlyNumberBR(d.valor_total);
  const parcelaN = totalN / parcelas;
  const valorParcelaSemRS = moneyBRNoSymbol(parcelaN);

  // pesquisa: se isenta, deixamos o token numérico vazio (seu DOCX usa "R$ ${Valor da Pesquisa},00")
  const valorPesquisaSemRS = d.pesquisa_status === 'isenta' ? '' : '';

  // taxa
  let valorTaxaSemRS = '';
  const taxa = String(d.taxa_faixa);
  if (taxa.includes('440')) valorTaxaSemRS = '440,00';
  else if (taxa.includes('880')) valorTaxaSemRS = '880,00';

  // serviços: pedido de registro de marca
  const temMarca = d.servicos.some(s =>
    String(s).toLowerCase().includes('pedido de registro de marca') ||
    String(s).toLowerCase().includes('registro de marca') ||
    String(s).toLowerCase().includes('marca')
  );
  const qtdMarca = temMarca ? '1' : '';
  const descMarca = temMarca
    ? [
        d.nome_marca ? `Marca: ${d.nome_marca}` : '',
        d.classe ? `Classe: ${d.classe}` : ''
      ].filter(Boolean).join(', ')
    : '';

  // Retorna com os nomes literais dos TOKENS no DOCX
  return {
    'Contratante 1': d.nome,
    'Estado Civíl': d.estado_civil,
    'rua': d.rua,
    'Bairro': d.bairro,
    'Numero': d.numero,
    'Nome da cidade': d.cidade,
    'UF': d.uf,
    'CEP': d.cep,
    'RG': d.rg,
    'CPF': d.cpf,
    'Telefone': d.telefone,
    'E-mail': d.email,

    'Risco': d.risco,

    'Quantidade depósitos/processos de MARCA': qtdMarca,
    'Nome da Marca': d.nome_marca,
    'Classe': d.classe,

    'Número de parcelas da Assessoria': String(parcelas),
    'Valor da parcela da Assessoria': valorParcelaSemRS, // ex.: "123,45" (sem R$)
    'Forma de pagamento da Assessoria': '',
    'Data de pagamento da Assessoria': '',

    'Valor da Pesquisa': valorPesquisaSemRS,            // vazio quando isenta
    'Forma de pagamento da Pesquisa': '',
    'Data de pagamento da pesquisa': '',

    'Valor da Taxa': valorTaxaSemRS,                    // "440,00" ou "880,00"
    'Forma de pagamento da Taxa': '',
    'Data de pagamento da Taxa': '',

    'Cidade': d.cidade,
    'Dia': d.dia,
    'Mês': d.mes,
    'Ano': d.ano
  };
}

function montarSigners(d) {
  return [{ email: d.email, name: d.nome, act: '1', foreign: '0', send_email: '1' }];
}

// ============================================================================
// LINK PÚBLICO
// ============================================================================
function b64u(b) { return b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function mkLeadToken(cardId, ttlSec = 60 * 60 * 24 * 7) {
  const payload = JSON.stringify({ cardId, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+ttlSec });
  const sig = crypto.createHmac('sha256', PUBLIC_LINK_SECRET).update(payload).digest();
  return `${b64u(Buffer.from(payload))}.${b64u(sig)}`;
}
function parseLeadToken(token) {
  const [p,s] = (token||'').split('.');
  if (!p || !s) throw new Error('token inválido');
  const payload = Buffer.from(p.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
  const sig = Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64');
  const good = crypto.createHmac('sha256', PUBLIC_LINK_SECRET).update(payload).digest();
  if (!crypto.timingSafeEqual(sig, good)) throw new Error('assinatura inválida');
  const obj = JSON.parse(payload);
  if (obj.exp && Date.now()/1000 > obj.exp) throw new Error('token expirado');
  return obj;
}

// ============================================================================
// ROTAS PÚBLICAS
// ============================================================================
app.get('/lead/:token', async (req, res) => {
  try {
    const { cardId } = parseLeadToken(req.params.token);
    const data = await gql(
      `query($cardId: ID!) {
        card(id: $cardId) {
          id title assignees { name }
          fields { name value report_value field { id internal_id id } }
        }
      }`,
      { cardId }
    );
    const card = data.card;
    const d = montarDados(card);

    const html = `
<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revisar contrato</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;margin:0;background:#f7f7f7;color:#111}
  .wrap{max-width:860px;margin:24px auto;padding:0 16px}
  .card{background:#fff;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08);padding:24px;margin-bottom:16px}
  h1{font-size:22px;margin:0 0 12px}
  h2{font-size:16px;margin:24px 0 8px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .btn{display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;border:0;background:#111;color:#fff;font-weight:600;cursor:pointer}
  .muted{color:#666}
  .label{font-weight:700}
</style>
<div class="wrap">
  <div class="card">
    <h1>Revisar dados do contrato</h1>
    <div class="muted">Card #${card.id}</div>

    <h2>Contratante(s)</h2>
    <div class="grid">
      <div><div class="label">Nome</div><div>${d.nome||'-'}</div></div>
      <div><div class="label">CPF</div><div>${d.cpf||'-'}</div></div>
      <div><div class="label">RG</div><div>${d.rg||'-'}</div></div>
    </div>

    <h2>Contato</h2>
    <div class="grid">
      <div><div class="label">E-mail</div><div>${d.email||'-'}</div></div>
      <div><div class="label">Telefone</div><div>${d.telefone||'-'}</div></div>
    </div>

    <h2>Serviços</h2>
    <div>${(d.servicos||[]).join(', ') || '-'}</div>

    <h2>Remuneração</h2>
    <div class="grid">
      <div><div class="label">Parcelas</div><div>${String(d.parcelas||'1')}</div></div>
      <div><div class="label">Valor total</div><div>${moneyBRNoSymbol(onlyNumberBR(d.valor_total))}</div></div>
    </div>

    <form method="POST" action="/lead/${encodeURIComponent(req.params.token)}/generate" style="margin-top:24px">
      <button class="btn" type="submit">Gerar contrato</button>
    </form>
    <p class="muted" style="margin-top:12px">Ao clicar, o documento será criado no D4Sign e o card será movido para "Contrato enviado".</p>
  </div>
</div>
`;
    res.setHeader('content-type','text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    return res.status(400).send('Link inválido ou expirado.');
  }
});

app.post('/lead/:token/generate', async (req, res) => {
  try {
    const { cardId } = parseLeadToken(req.params.token);
    const lockKey = `lead:${cardId}`;
    if (!acquireLock(lockKey)) return res.status(200).send('Processando, tente novamente em instantes.');

    preflightDNS().catch(()=>{});

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
    const d = montarDados(card);
    const add = montarADDWord(d);
    const signers = montarSigners(d);
    const uuidSafe = COFRES_UUIDS[d.vendedor];
    if (!uuidSafe) throw new Error(`Cofre não configurado para vendedor: ${d.vendedor}`);

    const uuidDoc = await makeDocFromWordTemplate(D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, uuidSafe, TEMPLATE_UUID_CONTRATO, card.title, add);
    await cadastrarSignatarios(D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, uuidDoc, signers);
    await moveCardToPhaseSafe(card.id, PHASE_ID_CONTRATO_ENVIADO);

    releaseLock(lockKey);

    const okHtml = `
<!doctype html><meta charset="utf-8"><title>Contrato gerado</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;background:#f7f7f7} .box{background:#fff;padding:24px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-width:560px}</style>
<div class="box">
  <h2>Contrato gerado com sucesso</h2>
  <p>Documento criado no D4Sign e card movido para “Contrato enviado”.</p>
  <p>UUID: ${uuidDoc}</p>
  <p><a href="${PUBLIC_BASE_URL}/lead/${encodeURIComponent(req.params.token)}">Voltar</a></p>
</div>`;
    return res.status(200).send(okHtml);

  } catch (e) {
    console.error('[ERRO LEAD-GENERATE]', e.message || e);
    return res.status(400).send('Falha ao gerar o contrato.');
  }
});

// ============================================================================
// WEBHOOK PIPEFY: cria o link público no campo do card (apenas a URL pura)
// ============================================================================
app.post('/pipefy', async (req, res) => {
  console.log('[PIPEFY] webhook recebido em /pipefy');
  const cardId = req.body?.data?.action?.card?.id;
  if (!cardId) return res.status(400).json({ error: 'Sem cardId' });

  const lockKey = `card:${cardId}`;
  if (!acquireLock(lockKey)) return res.status(200).json({ ok: true, message: 'Processamento em andamento' });

  try {
    preflightDNS().catch(()=>{});

    const data = await gql(
      `query($cardId: ID!) {
        card(id: $cardId) {
          id title assignees { name }
          fields { name value report_value field { id internal_id id } }
        }
      }`,
      { cardId }
    );
    const card = data.card;
    const f = card.fields || [];

    const disparo = normalizeCheck(getField(f, FIELD_ID_CHECKBOX_DISPARO));
    const already = getField(f, FIELD_ID_LINKS_D4);
    logDecision('estado_atual', { cardId, disparo, rawLink: already });

    if (disparo !== 'sim') {
      releaseLock(lockKey);
      return res.status(200).json({ ok: true, message: 'Campo gerar_contrato != Sim' });
    }

    // Gera link público e grava apenas o texto puro
    const token = mkLeadToken(card.id);
    const leadUrl = `${PUBLIC_BASE_URL.replace(/\/$/,'')}/lead/${encodeURIComponent(token)}`;
    await setCardFieldText(card.id, FIELD_ID_LINKS_D4, leadUrl);

    releaseLock(lockKey);
    logDecision('link_publico_gerado', { leadUrl });
    return res.json({ ok: true, leadUrl });

  } catch (e) {
    console.error('[ERRO PIPEFY-D4SIGN]', e.code || e.message || e);
    releaseLock(lockKey);
    return res.status(200).json({ ok: false, error: e.code || e.message || 'Erro desconhecido' });
  }
});

// Saúde
app.get('/', (req, res) => res.send('Servidor ativo e rodando'));
app.get('/health', (req, res) => res.json({ ok: true }));

// Start
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  preflightDNS().catch(()=>{});
});
