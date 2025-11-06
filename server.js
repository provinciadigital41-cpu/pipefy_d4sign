// server.js — Node 18+, CommonJS
// npm i express
const express = require('express');
const crypto = require('crypto');

const app = express();

// ===== Middlewares =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logger simples p/ qualquer request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ua="${req.get('user-agent')}" ip=${req.ip}`);
  next();
});

// ===== Variáveis de ambiente =====
const env = process.env;
let {
  PORT,
  PIPE_API_KEY,
  PIPE_GRAPHQL_ENDPOINT,
  D4SIGN_CRYPT_KEY,
  D4SIGN_TOKEN,
  TEMPLATE_UUID_CONTRATO,
  NOVO_PIPE_ID,
  FASE_VISITA_ID,
  PHASE_ID_CONTRATO_ENVIADO,
  PIPEFY_FIELD_LINK_CONTRATO,
  FIELD_ID_CONNECT_MARCA_NOME,
  FIELD_ID_CONNECT_CLASSE,
  CONTACTS_TABLE_ID,
  MARCAS_TABLE_ID,
  CLASSES_TABLE_ID,
  PUBLIC_BASE_URL,
  PUBLIC_LINK_SECRET,
  EMAIL_ASSINATURA_EMPRESA,
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
} = env;

// Defaults
PORT = PORT || 3000;
PIPE_GRAPHQL_ENDPOINT = PIPE_GRAPHQL_ENDPOINT || 'https://api.pipefy.com/graphql';
FIELD_ID_CONNECT_MARCA_NOME = FIELD_ID_CONNECT_MARCA_NOME || 'marcas_1'; // Nome da marca + Contatos
FIELD_ID_CONNECT_CLASSE = FIELD_ID_CONNECT_CLASSE || 'marcas_2';         // Classe (DB Marcas e serviços)
CLASSES_TABLE_ID = CLASSES_TABLE_ID || '306572615';
const FIELD_ID_LINKS_D4 = PIPEFY_FIELD_LINK_CONTRATO || 'd4_contrato';

if (!PIPE_API_KEY) console.warn('[AVISO] PIPE_API_KEY não definido');
if (!D4SIGN_CRYPT_KEY || !D4SIGN_TOKEN) console.warn('[AVISO] D4SIGN_* não definidos');
if (!PUBLIC_BASE_URL || !PUBLIC_LINK_SECRET) console.warn('[AVISO] Defina PUBLIC_BASE_URL e PUBLIC_LINK_SECRET');

// Cofres por responsável
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
  'Mauro Furlan Neto': COFRE_UUID_MAURO,
};

// ===== Assinatura de links (HMAC) =====
function makeSignedURL(path, params) {
  const url = new URL(path, PUBLIC_BASE_URL);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const payload = [...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&');
  const sig = crypto.createHmac('sha256', PUBLIC_LINK_SECRET).update(payload).digest('hex');
  url.searchParams.set('sig', sig);
  return url.toString();
}
function validateSignature(req) {
  const full = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  const gotSig = full.searchParams.get('sig') || '';
  full.searchParams.delete('sig');
  const payload = [...full.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&');
  const expected = crypto.createHmac('sha256', PUBLIC_LINK_SECRET).update(payload).digest('hex');
  return gotSig === expected;
}

// ===== Pipefy GraphQL =====
async function pipefyGraphQL(query, variables) {
  const res = await fetch(PIPE_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PIPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`Pipefy GraphQL error: ${res.status} ${JSON.stringify(json.errors || {})}`);
  }
  return json.data;
}
async function getCardFields(cardId) {
  const q = `
    query($id: ID!) {
      card(id: $id) {
        id
        title
        fields { name value field { id type } }
        current_phase { id name }
        pipe { id name }
      }
    }`;
  const data = await pipefyGraphQL(q, { id: cardId });
  return data.card;
}
async function updateCardField(cardId, fieldId, newValue) {
  const m = `
    mutation($input: UpdateCardFieldInput!) {
      updateCardField(input: $input) { card { id } }
    }`;
  await pipefyGraphQL(m, {
    input: { card_id: Number(cardId), field_id: fieldId, new_value: newValue },
  });
}
async function getTableRecord(recordId) {
  const q = `
    query($id: ID!) {
      table_record(id: $id) {
        id
        title
        record_fields { name value field { id type } }
      }
    }`;
  const data = await pipefyGraphQL(q, { id: recordId });
  return data.table_record;
}
async function listTableRecords(tableId, first = 100, after = null) {
  const q = `
    query($tableId: ID!, $first: Int!, $after: String) {
      table(id: $tableId) {
        id
        table_records(first: $first, after: $after) {
          edges {
            node {
              id
              title
              record_fields { name value field { id type } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
  const data = await pipefyGraphQL(q, { tableId, first, after });
  const edges = data?.table?.table_records?.edges || [];
  const pageInfo = data?.table?.table_records?.pageInfo || {};
  return { records: edges.map(e => e.node), pageInfo };
}

// ===== Utils =====
function toByIdFromCard(card) {
  const by = {};
  for (const f of card?.fields || []) if (f?.field?.id) by[f.field.id] = f.value;
  return by;
}
function normalizePhone(s) { return String(s || '').replace(/\D/g, ''); }
function onlyDigits(s) { return String(s||'').replace(/\D/g,''); }
function parseMaybeJsonArray(value) {
  try { return Array.isArray(value) ? value : JSON.parse(value); }
  catch { return value ? [String(value)] : []; }
}
function getValueByName(card, nameSubstr) {
  const target = String(nameSubstr).toLowerCase();
  const hit = (card.fields || []).find(f => String(f?.name || '').toLowerCase().includes(target));
  return hit?.value ?? '';
}
function getFirstByNames(card, names=[]) {
  for (const n of names) {
    const v = getValueByName(card, n);
    if (v) return v;
  }
  return '';
}
function parseNumberBR(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const br = s.match(/^\d{1,3}(\.\d{3})*,\d{2}$/);
  if (br) return Number(s.replace(/\./g,'').replace(',','.'));
  const en = s.match(/^\d+(\.\d+)?$/);
  if (en) return Number(s);
  return Number(s.replace(/[^\d.,-]/g,'').replace(/\./g,'').replace(',','.'));
}
function toBRL(n) { return (n==null || isNaN(n)) ? '' : n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function pickParcelas(card) {
  const by = toByIdFromCard(card);
  let raw = by['sele_o_de_lista'] || by['numero_de_parcelas'] || '';
  if (!raw) raw = getFirstByNames(card, ['parcela', 'parcelas', 'nº parcelas', 'numero de parcelas', 'número de parcelas']);
  const m = String(raw||'').match(/(\d+)/);
  return m ? m[1] : '1';
}
function pickValorAssessoria(card) {
  const by = toByIdFromCard(card);
  let raw = by['valor_da_assessoria'] || by['valor_assessoria'] || '';
  if (!raw) raw = getFirstByNames(card, ['valor da assessoria', 'assessoria']);
  if (!raw) {
    const hit = (card.fields||[]).find(f => String(f?.field?.type||'').toLowerCase()==='currency');
    raw = hit?.value || '';
  }
  const n = parseNumberBR(raw);
  return isNaN(n) ? null : n;
}

// ===== Marca (nome/contato) via marcas_1 =====
async function resolveMarcaRecordFromCard(card) {
  const by = toByIdFromCard(card);
  const v = by[FIELD_ID_CONNECT_MARCA_NOME]; // 'marcas_1'
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  if (!arr.length) return null;

  const first = String(arr[0]);

  if (/^\d+$/.test(first)) {
    try { return await getTableRecord(first); } catch { /* fallback título */ }
  }
  if (!MARCAS_TABLE_ID) return null;
  let after = null;
  for (let i = 0; i < 50; i++) {
    const { records, pageInfo } = await listTableRecords(MARCAS_TABLE_ID, 100, after);
    const hit = records.find(r => String(r.title || '').trim().toLowerCase() === first.trim().toLowerCase());
    if (hit) return hit;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor || null;
  }
  return null;
}
function extractEmailPhoneFromRecord(record) {
  let email = '', telefone = '';
  for (const f of record?.record_fields || []) {
    const t = (f?.field?.type || '').toLowerCase();
    const label = (f?.name || '').toLowerCase();
    if (!email && (t === 'email' || label.includes('email'))) email = String(f.value || '');
    if (!telefone && (t === 'phone' || t === 'tel' || label.includes('telefone') || label.includes('celular') || label.includes('whats'))) {
      telefone = String(f.value || '');
    }
  }
  return { email, telefone };
}
async function listFindContato({ phoneCandidate, emailCandidate, maxPages = 100, pageSize = 100 }) {
  if (!CONTACTS_TABLE_ID) return null;
  let after = null;
  const wantedPhone = normalizePhone(phoneCandidate);
  const wantedEmail = (emailCandidate || '').toLowerCase();
  for (let i = 0; i < maxPages; i++) {
    const { records, pageInfo } = await listTableRecords(CONTACTS_TABLE_ID, pageSize, after);
    for (const rec of records) {
      const { email, telefone } = extractEmailPhoneFromRecord(rec);
      const nodePhone = normalizePhone(telefone);
      const nodeEmail = (email || '').toLowerCase();
      const phoneMatch = wantedPhone && nodePhone && (nodePhone.endsWith(wantedPhone) || wantedPhone.endsWith(nodePhone));
      const emailMatch = wantedEmail && nodeEmail && nodeEmail === wantedEmail;
      if (phoneMatch || emailMatch) return { record: rec, email, telefone };
    }
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor || null;
  }
  return null;
}
async function resolveContatoFromMarcaRecord(marcaRecord) {
  const conn = (marcaRecord?.record_fields || []).find(f => f?.field?.id === 'contatos' || String(f?.name||'').toLowerCase().includes('contato'));
  if (!conn) return { email: '', telefone: '' };

  if (Array.isArray(conn.value)) {
    const first = conn.value[0];
    if (first) {
      const contato = await getTableRecord(first);
      return extractEmailPhoneFromRecord(contato);
    }
  }
  const mirrored = parseMaybeJsonArray(conn.value);
  let email = mirrored.find(x => String(x).includes('@')) || '';
  let telefone = mirrored.find(x => normalizePhone(x).length >= 10) || '';
  if (email && telefone) return { email: String(email), telefone: String(telefone) };

  const found = await listFindContato({ phoneCandidate: telefone, emailCandidate: email });
  if (found?.record) {
    const { email: em, telefone: tel } = extractEmailPhoneFromRecord(found.record);
    return { email: em || email, telefone: tel || telefone };
  }
  return { email: String(email || ''), telefone: String(telefone || '') };
}

// ===== Documento & Classe =====
function pickDocumento(card) {
  // prioriza campos de fase (CPF/CNPJ)
  const prefer = ['cpf', 'cnpj', 'documento', 'doc', 'cpf/cnpj', 'cpf cnpj', 'cnpj/cpf'];
  for (const key of prefer) {
    const v = getFirstByNames(card, [key]);
    const digits = onlyDigits(v);
    if (digits.length === 11 || digits.length === 14) {
      return { tipo: digits.length === 11 ? 'CPF' : 'CNPJ', valor: v || '' };
    }
  }
  // fallback: CNPJ do start form
  const by = toByIdFromCard(card);
  const cnpjStart = by['cnpj'] || getFirstByNames(card, ['cnpj']);
  if (cnpjStart) return { tipo: 'CNPJ', valor: cnpjStart };
  return { tipo: '', valor: '' };
}
async function resolveClasseFromCard(card, marcaRecordFallback) {
  const by = toByIdFromCard(card);

  // 1) Conector de CLASSE na fase (marcas_2)
  const v = by[FIELD_ID_CONNECT_CLASSE];
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  if (arr.length) {
    const first = String(arr[0]);
    if (/^\d+$/.test(first)) {
      try {
        const rec = await getTableRecord(first); // record no DB 306572615
        const classeField = (rec.record_fields || []).find(f =>
          String(f?.name || '').toLowerCase().includes('classe')
        );
        if (classeField?.value) return String(classeField.value);
        if (rec?.title) return String(rec.title);
      } catch { /* espelho */ }
    }
    try {
      const mirrored = Array.isArray(v) ? v : JSON.parse(v);
      if (Array.isArray(mirrored) && mirrored.length) return String(mirrored[0] || '');
    } catch {}
  }

  // 2) Campo de fase com label “classe”
  const fromPhase = getFirstByNames(card, ['classe', 'classes', 'classificação']);
  if (fromPhase) return String(fromPhase);

  // 3) Fallback: marcaRecord antigo (se existir)
  if (marcaRecordFallback) {
    const classeField = (marcaRecordFallback.record_fields || []).find(f =>
      String(f?.name || '').toLowerCase().includes('classe')
    );
    if (classeField?.value) return String(classeField.value);
  }
  return '';
}

// ===== Tokens do template =====
function nowParts() {
  const d = new Date();
  return { dd: String(d.getDate()).padStart(2, '0'), MM: String(d.getMonth() + 1).padStart(2, '0'), yyyy: String(d.getFullYear()) };
}
async function buildTemplateVariablesAsync(card) {
  const by = toByIdFromCard(card);
  const np = nowParts();

  // Marca & Nome da Marca
  const marcaRecordNomeContato = await resolveMarcaRecordFromCard(card); // via marcas_1
  const nomeMarca = card.title || '';

  // Contato — prioridade: conector de contatos na fase
  let contatoEmail = '', contatoTelefone = '';
  const contatoConnectorOnPhase = (card.fields || []).find(f =>
    (f.field?.type === 'connector' || f.field?.type === 'table_connection') &&
    String(f.name || '').toLowerCase().includes('contato')
  );
  if (contatoConnectorOnPhase?.value) {
    try {
      const arr = Array.isArray(contatoConnectorOnPhase.value)
        ? contatoConnectorOnPhase.value
        : JSON.parse(contatoConnectorOnPhase.value);
      const first = arr && arr[0];
      if (first && /^\d+$/.test(String(first))) {
        const rec = await getTableRecord(first);
        const ex = extractEmailPhoneFromRecord(rec);
        contatoEmail = ex.email || '';
        contatoTelefone = ex.telefone || '';
      } else if (Array.isArray(arr)) {
        const em = arr.find(s => String(s).includes('@'));
        const ph = arr.find(s => normalizePhone(s).length >= 10);
        if (em) contatoEmail = String(em);
        if (ph) contatoTelefone = String(ph);
      }
    } catch { /* segue */ }
  }
  // Fallback 1: marcas_1
  if ((!contatoEmail || !contatoTelefone) && marcaRecordNomeContato) {
    const contato = await resolveContatoFromMarcaRecord(marcaRecordNomeContato);
    contatoEmail    = contatoEmail    || contato.email || '';
    contatoTelefone = contatoTelefone || contato.telefone || '';
  }
  // Fallback 2: qualquer campo do card
  if (!contatoEmail)    contatoEmail    = getFirstByNames(card, ['email','e-mail']);
  if (!contatoTelefone) contatoTelefone = getFirstByNames(card, ['telefone','celular','whats','whatsapp']);

  // Documento (CPF/CNPJ)
  const doc = pickDocumento(card);
  const cpf  = doc.tipo === 'CPF'  ? doc.valor : '';
  const cnpj = doc.tipo === 'CNPJ' ? doc.valor : '';

  // Classe via marcas_2 (fase)
  const classe = await resolveClasseFromCard(card, marcaRecordNomeContato);

  // Endereço
  const rua    = by['rua']      || getFirstByNames(card, ['rua','logradouro','endereço']);
  const numero = by['n_mero_1'] || getFirstByNames(card, ['numero','número','nº']);
  const bairro = by['bairro']   || getFirstByNames(card, ['bairro']);
  const cidade = by['cidade']   || getFirstByNames(card, ['cidade','município']);
  const uf     = by['uf']       || getFirstByNames(card, ['uf','estado']);
  const cep    = by['cep']      || getFirstByNames(card, ['cep']);

  // Assessoria
  const nParc = pickParcelas(card);
  const valorAssess = pickValorAssessoria(card);
  const valorParcelaAssess = (valorAssess && Number(nParc)>0) ? toBRL(valorAssess/Number(nParc)) : '';

  // Pesquisa (Isenta padrão)
  const pesquisa = by['pesquisa'] || getFirstByNames(card, ['pesquisa']);
  const valorPesquisa = (pesquisa === 'Isenta') ? 'R$ 00,00' : '';
  const formaPesquisa = (pesquisa === 'Isenta') ? '---' : '';
  const dataPesquisa  = (pesquisa === 'Isenta') ? '00/00/00' : '';

  // Forma/Data assessoria
  const formaAssess = by['adiantamento_da_primeira_parcela'] || getFirstByNames(card, ['forma de pagamento','adiantamento']);
  const dataAssess  = by['data_da_venda_1'] || getFirstByNames(card, ['data da venda','data de pagamento']);

  return {
    // Identificação / endereço
    contratante_1: by['r_social_ou_n_completo'] || getFirstByNames(card, ['razão social','nome completo','nome do cliente']) || '',
    cpf, cnpj,
    rg: by['rg'] || getFirstByNames(card, ['rg']) || '',

    rua, bairro, numero, nome_da_cidade: cidade, cidade, uf, cep,

    // Contato
    'E-mail': contatoEmail || '',
    telefone: contatoTelefone || '',

    // Marca
    nome_da_marca: nomeMarca,
    classe: String(classe || ''),

    // Assessoria
    numero_de_parcelas_da_assessoria: nParc,
    valor_da_parcela_da_assessoria: valorParcelaAssess,
    forma_de_pagamento_da_assessoria: formaAssess || '',
    data_de_pagamento_da_assessoria: dataAssess || '',

    // Pesquisa
    valor_da_pesquisa: valorPesquisa,
    forma_de_pagamento_da_pesquisa: formaPesquisa,
    data_de_pagamento_da_pesquisa: dataPesquisa,

    // Taxa (placeholders)
    valor_da_taxa: '',
    forma_de_pagamento_da_taxa: by['tipo_de_pagamento_benef_cio'] || getFirstByNames(card, ['tipo de pagamento']) || '',
    data_de_pagamento_da_taxa: '',

    // Datas
    dia: np.dd, mes: np.MM, ano: np.yyyy,

    // Aux
    TEMPLATE_UUID_CONTRATO: by['TEMPLATE_UUID_CONTRATO'] || TEMPLATE_UUID_CONTRATO || '',
  };
}

// ===== Cofre por responsável (vendedor_respons_vel) =====
function resolveCofreUuidByCard(card) {
  const by = toByIdFromCard(card);
  const candidatos = [];
  if (by['vendedor_respons_vel']) candidatos.push(by['vendedor_respons_vel']);
  if (by['respons_vel_5']) candidatos.push(by['respons_vel_5']);       // fallback
  if (by['representante']) candidatos.push(by['representante']);       // fallback

  const nomes = []
    .concat(candidatos)
    .filter(Boolean)
    .flatMap(v => Array.isArray(v) ? v : [v])
    .map(v => (typeof v === 'string' ? v : (v?.name || v?.email || '')))
    .filter(Boolean);

  for (const nome of nomes) {
    if (COFRES_UUIDS[nome]) return COFRES_UUIDS[nome];
    const k = Object.keys(COFRES_UUIDS).find(key => key.toLowerCase() === String(nome).toLowerCase());
    if (k) return COFRES_UUIDS[k];
  }
  return null;
}

// ===== D4Sign =====
const D4_BASE = 'https://api.d4sign.com.br/v2';
async function d4Fetch(path, method, payload) {
  const url = `${D4_BASE}${path}?tokenAPI=${D4SIGN_TOKEN}&cryptKey=${D4SIGN_CRYPT_KEY}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) throw new Error(`D4 error ${res.status}: ${await res.text()}`);
  return res.json();
}
async function d4CreateFromTemplateUUID({ templateUuid, fileName, variables, safeUuid }) {
  const payload = { template: templateUuid, name: fileName, data: variables, safe: safeUuid };
  const created = await d4Fetch('/documents/create', 'POST', payload);
  if (!created?.uuid && safeUuid) {
    const alt = await d4Fetch(`/documents/create/${safeUuid}`, 'POST', { template: templateUuid, name: fileName, data: variables });
    return alt;
  }
  return created;
}
async function d4AddSigners(documentKey, signers) {
  const payload = {
    signers: signers.map(s => ({
      email: s.email,
      act: '1',
      foreign: '0',
      certificadoicpbr: '0',
      name: s.name || s.email,
    })),
  };
  return d4Fetch(`/documents/${documentKey}/signers`, 'POST', payload);
}
async function d4SendToSign(documentKey, message = 'Contrato para assinatura') {
  return d4Fetch(`/documents/${documentKey}/sendto`, 'POST', { message, emails: [], workflow: '0' });
}
app.get('/download/:documentKey', async (req, res) => {
  try {
    if (!validateSignature(req)) return res.status(401).send('assinatura inválida');
    const { documentKey } = req.params;
    const url = `${D4_BASE}/documents/${documentKey}/download?tokenAPI=${D4SIGN_TOKEN}&cryptKey=${D4SIGN_CRYPT_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`D4 download ${r.status}`);
    res.setHeader('Content-Disposition', `attachment; filename="Contrato_${documentKey}.pdf"`);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/pdf');
    r.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ===== ROTA ECO =====
app.get('/_echo/*', (req, res) => {
  res.json({
    method: req.method,
    originalUrl: req.originalUrl,
    path: req.path,
    baseUrl: req.baseUrl,
    host: req.get('host'),
    href: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    headers: req.headers,
    query: req.query,
  });
});

// ===== Fluxo: webhook → confirmar → gerar → baixar/enviar =====
async function handleCriarLinkConfirmacao(req, res) {
  try {
    const cardId = req.method === 'GET' ? (req.query.cardId || req.query.card_id) : (req.body.cardId || req.body.card_id);
    if (!cardId) return res.status(400).json({ error: 'cardId é obrigatório' });

    const confirmUrl = makeSignedURL('/novo-pipe/confirmar', { cardId });
    console.log('[link-confirmacao]', { cardId, confirmUrl, PUBLIC_BASE_URL });

    await updateCardField(cardId, FIELD_ID_LINKS_D4, confirmUrl);
    return res.json({ ok: true, link: confirmUrl });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
app.post('/novo-pipe/criar-link-confirmacao', handleCriarLinkConfirmacao);
app.get('/novo-pipe/criar-link-confirmacao', handleCriarLinkConfirmacao);

app.get('/novo-pipe/confirmar', async (req, res) => {
  try {
    if (!validateSignature(req)) return res.status(401).send('assinatura inválida');
    const { cardId } = req.query;
    if (!cardId) return res.status(400).send('Faltou cardId');

    const card = await getCardFields(cardId);

    if (NOVO_PIPE_ID && String(card?.pipe?.id) !== String(NOVO_PIPE_ID)) {
      return res.status(400).send('Card não pertence ao pipe configurado');
    }
    if (FASE_VISITA_ID && String(card?.current_phase?.id) !== String(FASE_VISITA_ID)) {
      return res.status(400).send('Card não está na fase esperada');
    }

    const vars = await buildTemplateVariablesAsync(card);

    const resumo = `
      <h2>Confirmar dados do cliente</h2>
      <p><b>Contratante:</b> ${vars.contratante_1 || ''}</p>
      <p><b>CPF:</b> ${vars.cpf || ''} &nbsp; <b>CNPJ:</b> ${vars.cnpj || ''} &nbsp; <b>RG:</b> ${vars.rg || ''}</p>
      <p><b>Endereço:</b> ${vars.rua || ''}, ${vars.numero || ''} - ${vars.bairro || ''} - ${vars.cidade || ''}/${vars.uf || ''} - ${vars.cep || ''}</p>
      <p><b>Contato:</b> ${vars['E-mail'] || ''} &nbsp; ${vars.telefone || ''}</p>
      <p><b>Marca:</b> ${vars.nome_da_marca || ''} &nbsp; <b>Classe:</b> ${vars.classe || ''}</p>
      <p><b>Assessoria:</b> ${vars.numero_de_parcelas_da_assessoria || ''} x ${vars.valor_da_parcela_da_assessoria || ''}</p>
      <p><b>Pesquisa:</b> ${vars.valor_da_pesquisa} via ${vars.forma_de_pagamento_da_pesquisa} em ${vars.data_de_pagamento_da_pesquisa}</p>
      <form method="POST" action="/novo-pipe/gerar">
        <input type="hidden" name="cardId" value="${cardId}"/>
        <input type="hidden" name="sig" value="${new URL(req.originalUrl, PUBLIC_BASE_URL).searchParams.get('sig')||''}"/>
        <button type="submit">Gerar contrato</button>
      </form>
    `;
    res.send(`<!doctype html><html><body>${resumo}</body></html>`);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.post('/novo-pipe/gerar', async (req, res) => {
  try {
    const { cardId, sig } = req.body;
    if (!cardId) return res.status(400).send('Faltou cardId');
    if (!sig) return res.status(401).send('assinatura ausente');

    const card = await getCardFields(cardId);
    const vars = await buildTemplateVariablesAsync(card);

    const templateUuid = vars.TEMPLATE_UUID_CONTRATO || TEMPLATE_UUID_CONTRATO;
    if (!templateUuid) throw new Error('TEMPLATE_UUID_CONTRATO não encontrado (card/env)');

    const safeUuid = resolveCofreUuidByCard(card);
    if (!safeUuid) throw new Error('Não foi possível resolver o cofre pelo responsável do card');

    const fileName = `Contrato_${card.title || card.id}.docx`;
    const created = await d4CreateFromTemplateUUID({ templateUuid, fileName, variables: vars, safeUuid });
    const documentKey = created.uuid || created.documentKey || created.key;
    if (!documentKey) throw new Error('Não foi possível obter documentKey do D4');

    const nextUrl = makeSignedURL(`/contratos/${documentKey}`, { cardId });
    await updateCardField(cardId, FIELD_ID_LINKS_D4, nextUrl);

    res.redirect(nextUrl);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.get('/contratos/:documentKey', async (req, res) => {
  try {
    if (!validateSignature(req)) return res.status(401).send('assinatura inválida');
    const { documentKey } = req.params;
    const { cardId } = req.query;

    const downloadUrl = makeSignedURL(`/download/${documentKey}`, { cardId });
    const html = `
      <h2>Contrato gerado</h2>
      <p><b>DocumentKey:</b> ${documentKey}</p>
      <p><a href="${downloadUrl}">Baixar documento</a></p>
      <form method="POST" action="/contratos/${documentKey}/enviar-assinatura">
        <input type="hidden" name="cardId" value="${cardId || ''}"/>
        <input type="hidden" name="sig" value="${new URL(req.originalUrl, PUBLIC_BASE_URL).searchParams.get('sig')||''}"/>
        <button type="submit">Enviar para assinatura</button>
      </form>
    `;
    res.send(`<!doctype html><html><body>${html}</body></html>`);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.post('/contratos/:documentKey/enviar-assinatura', async (req, res) => {
  try {
    const { documentKey } = req.params;
    const { cardId, sig } = req.body;
    if (!cardId) return res.status(400).send('Faltou cardId');
    if (!sig) return res.status(401).send('assinatura ausente');

    const card = await getCardFields(cardId);
    const vars = await buildTemplateVariablesAsync(card);

    const signers = [{ email: EMAIL_ASSINATURA_EMPRESA }];
    if (vars['E-mail']) signers.push({ email: vars['E-mail'] });

    await d4AddSigners(documentKey, signers);
    await d4SendToSign(documentKey, 'Contrato para assinatura');

    const back = makeSignedURL(`/contratos/${documentKey}`, { cardId });
    res.send(`<!doctype html><html><body>
      <h2>Contrato enviado para assinatura</h2>
      <p><b>Assinantes:</b> ${signers.map(s => s.email).join(', ')}</p>
      <p><a href="${back}">Voltar</a></p>
    </body></html>`);
  } catch (e) {
    // <<<<<< CORRIGIDO o parêntese aqui >>>>>>
    res.status(500).send(String(e.message || e));
  }
});

// ===== Debug =====
app.get('/debug/card', async (req, res) => {
  try {
    const { cardId } = req.query;
    if (!cardId) return res.status(400).send('cardId obrigatório');
    const card = await getCardFields(cardId);
    res.json({
      id: card.id,
      title: card.title,
      pipe: card.pipe,
      phase: card.current_phase,
      fields: (card.fields || []).map(f => ({
        name: f.name, id: f.field?.id, type: f.field?.type, value: f.value
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/debug/vars', async (req, res) => {
  try {
    const { cardId } = req.query;
    if (!cardId) return res.status(400).send('cardId obrigatório');
    const card = await getCardFields(cardId);
    const vars = await buildTemplateVariablesAsync(card);
    res.json(vars);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/debug/marca-contato', async (req, res) => {
  try {
    const { cardId } = req.query;
    if (!cardId) return res.status(400).send('cardId obrigatório');
    const card = await getCardFields(cardId);
    const marcaRecord = await resolveMarcaRecordFromCard(card);
    let contato = { email:'', telefone:'' };
    if (marcaRecord) contato = await resolveContatoFromMarcaRecord(marcaRecord);
    const classe = await resolveClasseFromCard(card, marcaRecord);
    res.json({ cardTitle: card.title, marcaRecord, contato, classe });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ===== Health =====
app.get('/health', (_, res) => res.json({ ok: true }));

// ===== Start + rotas registradas =====
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  const list = [];
  app._router.stack.forEach(m => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).map(x => x.toUpperCase()).join(',');
      list.push(`${methods} ${m.route.path}`);
    } else if (m.name === 'router' && m.handle.stack) {
      m.handle.stack.forEach(h => {
        const route = h.route;
        if (route) {
          const methods = Object.keys(route.methods).map(x => x.toUpperCase()).join(',');
          list.push(`${methods} ${route.path}`);
        }
      });
    }
  });
  console.log('[rotas-registradas]');
  list.sort().forEach(r => console.log('  -', r));
});
