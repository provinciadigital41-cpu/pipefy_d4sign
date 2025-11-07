'use strict';

/**
 * server.js — Provincia Vendas (Pipefy + D4Sign, versão simplificada para novo pipe)
 * Node 18+ (fetch global)
 * Sem conexões a tabelas/databases: usa apenas campos do card (fase Proposta) e start form
 */

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', true);

// Log básico
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ua="${req.get('user-agent')}" ip=${req.ip}`);
  next();
});

/* =========================
 * ENV
 * =======================*/
let {
  PORT,
  PUBLIC_BASE_URL,
  PUBLIC_LINK_SECRET,

  PIPE_API_KEY,
  PIPE_GRAPHQL_ENDPOINT,

  // Campo no card que receberá o link público
  PIPEFY_FIELD_LINK_CONTRATO,

  // Controle de pipe e fase
  NOVO_PIPE_ID,          // opcional
  PHASE_ID_PROPOSTA,     // usado neste pipe mais simples
  PHASE_ID_CONTRATO_ENVIADO, // opcional

  // D4Sign
  D4SIGN_TOKEN,
  D4SIGN_CRYPT_KEY,
  TEMPLATE_UUID_CONTRATO,

  // Assinatura interna
  EMAIL_ASSINATURA_EMPRESA,

  // Cofres por responsável
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

  DEFAULT_COFRE_UUID
} = process.env;

PORT = PORT || 3000;
PIPE_GRAPHQL_ENDPOINT = PIPE_GRAPHQL_ENDPOINT || 'https://api.pipefy.com/graphql';
PIPEFY_FIELD_LINK_CONTRATO = PIPEFY_FIELD_LINK_CONTRATO || 'd4_contrato';

if (!PUBLIC_BASE_URL || !PUBLIC_LINK_SECRET) console.warn('[AVISO] Configure PUBLIC_BASE_URL e PUBLIC_LINK_SECRET');
if (!PIPE_API_KEY) console.warn('[AVISO] PIPE_API_KEY ausente');
if (!D4SIGN_TOKEN || !D4SIGN_CRYPT_KEY) console.warn('[AVISO] D4SIGN_TOKEN / D4SIGN_CRYPT_KEY ausentes');

// Cofres mapeados por responsável
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

/* =========================
 * Helpers gerais
 * =======================*/
function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }
function normalizePhone(s){ return onlyDigits(s); }
function toBRL(n){ return isNaN(n)?'':Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function parseNumberBR(v){
  if (v==null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(s)) return Number(s.replace(/\./g,'').replace(',','.'));
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return Number(s.replace(/[^\d.,-]/g,'').replace(/\./g,'').replace(',','.'));
}
function onlyNumberBR(s){
  const n = parseNumberBR(s);
  return isNaN(n)? 0 : n;
}
const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
function monthNamePt(mIndex1to12) { return MESES_PT[(Math.max(1, Math.min(12, Number(mIndex1to12))) - 1)]; }
function parsePipeDateToDate(value){
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m){
    const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
    const d = new Date(yyyy, mm-1, dd);
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function fmtDMY2(value){
  const d = value instanceof Date ? value : parsePipeDateToDate(value);
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
async function fetchWithRetry(url, init={}, opts={}){
  const attempts = opts.attempts || 3;
  const baseDelayMs = opts.baseDelayMs || 500;
  const timeoutMs = opts.timeoutMs || 15000;

  for (let i=0;i<attempts;i++){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), timeoutMs);
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok && i < attempts-1) {
        await new Promise(r => setTimeout(r, baseDelayMs * (i+1)));
        continue;
      }
      return res;
    } catch(e){
      if (i === attempts-1) throw e;
      await new Promise(r => setTimeout(r, baseDelayMs * (i+1)));
    }
  }
  throw new Error('fetchWithRetry: esgotou tentativas');
}

/* =========================
 * Token público (/lead/:token)
 * =======================*/
function makeLeadToken(payload){
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', PUBLIC_LINK_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function parseLeadToken(token){
  const [body, sig] = String(token||'').split('.');
  if (!body || !sig) throw new Error('token inválido');
  const expected = crypto.createHmac('sha256', PUBLIC_LINK_SECRET).update(body).digest('base64url');
  if (sig !== expected) throw new Error('assinatura inválida');
  const json = JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
  if (!json.cardId) throw new Error('payload inválido');
  return json;
}

/* =========================
 * Pipefy GraphQL
 * =======================*/
async function gql(query, variables){
  const r = await fetch(PIPE_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PIPE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error(`Pipefy GQL: ${r.status} ${JSON.stringify(j.errors||{})}`);
  return j.data;
}
async function getCard(cardId){
  const data = await gql(`query($id: ID!){
    card(id:$id){
      id title
      current_phase{ id name }
      pipe{ id name }
      fields{ name value field{ id type } }
      assignees{ name email }
    }
  }`, { id: cardId });
  return data.card;
}
async function updateCardField(cardId, fieldId, newValue){
  await gql(`mutation($input: UpdateCardFieldInput!){
    updateCardField(input:$input){ card{ id } }
  }`, { input: { card_id: Number(cardId), field_id: fieldId, new_value: newValue } });
}

/* =========================
 * Parsing de campos do card
 * =======================*/
function toById(card){
  const by={}; for (const f of card?.fields||[]) if (f?.field?.id) by[f.field.id]=f.value;
  return by;
}
function getByLabel(card, labelContains){
  const t = String(labelContains).toLowerCase();
  const f = (card.fields||[]).find(ff=> String(ff?.name||'').toLowerCase().includes(t));
  return f?.value || '';
}
function parseMaybeJsonArray(v){
  try { return Array.isArray(v)? v : JSON.parse(v); }
  catch { return v? [String(v)] : []; }
}
function checklistToText(v) {
  const arr = parseMaybeJsonArray(v);
  return Array.isArray(arr) ? arr.join(', ') : String(v || '');
}
function extractAssigneeNames(raw){
  const out=[]; const push=v=>{ if(v) out.push(String(v)); }; const tryParse=v=>{ if(typeof v==='string'){ try{return JSON.parse(v);} catch{return v;} } return v; };
  const val = tryParse(raw);
  if (Array.isArray(val)){ for (const it of val) push(typeof it==='string'? it : (it?.name||it?.username||it?.email||it?.value)); }
  else if (typeof val==='object'&&val){ push(val.name||val.username||val.email||val.value); }
  else if (typeof val==='string'){ const m = val.match(/^\s*\[.*\]\s*$/)? tryParse(val) : null; if (m && Array.isArray(m)) m.forEach(x=>push(typeof x==='string'? x : (x?.name||x?.email))); else push(val); }
  return [...new Set(out.filter(Boolean))];
}
function normalizeFaixaTaxaToValorBRL(taxa){
  const s = String(taxa||'');
  if (s.includes('440')) return 'R$ 440,00';
  if (s.includes('880')) return 'R$ 880,00';
  return '';
}

/* =========================
 * Montagem de dados do contrato — versão simples
 * =======================*/
function pickParcelasFromSimple(by, card){
  const raw = by['quantidade_de_parcelas_1'] || getByLabel(card, 'quantidade de parcelas') || '';
  const m = String(raw||'').match(/(\d+)/);
  return m ? m[1] : '1';
}
function pickValorAssessoriaFromSimple(by, card){
  const raw = by['valor_da_assessoria'] || getByLabel(card, 'valor da assessoria') || '';
  const n = parseNumberBR(raw);
  return isNaN(n)? null : n;
}

async function montarDados(card){
  const by = toById(card);

  // Identificação do contratante
  const nome = by['r_social_ou_nome_completo'] || getByLabel(card, 'nome') || '';
  const nacionalidade = by['nacionalidade'] || '';
  const estado_civil = by['estado_civil'] || '';
  const rg = by['rg'] || '';
  const cpfCampo = by['cpf'] || '';

  // Contato
  const email = by['email_profissional'] || getByLabel(card, 'e-mail') || '';
  const telefone = by['telefone'] || getByLabel(card, 'telefone') || '';

  // Endereço PF
  const cep = by['cep'] || '';
  const bairro = by['bairro'] || '';
  const rua = by['rua_ou_avenida'] || '';
  const numero = by['n_mero_do_endere_o'] || '';

  // Agora lidos diretamente pelos IDs adicionados
  const cidade = by['cidade'] || getByLabel(card, 'cidade') || '';
  const uf = by['uf'] || getByLabel(card, 'uf') || '';

  // Marca e classe
  const titulo = by['marca'] || card.title || '';
  const risco_marca = by['risco_da_marca'] || '';
  const tipo_marca = checklistToText(by['tipo_de_marca'] || '');
  const classe = by['classe'] || getByLabel(card, 'classe') || '';
  const qtd_marca = titulo ? '1' : '';

  // Serviços e condições
  const servicoContratos = by['servi_os_de_contratos'] || '';
  const servicos = [servicoContratos].filter(Boolean);

  const parcelas = pickParcelasFromSimple(by, card);
  const valorAssessoria = pickValorAssessoriaFromSimple(by, card);
  const valor_total = valorAssessoria ? toBRL(valorAssessoria) : '';
  const forma_pagto_assessoria = by['tipo_de_pagamento_assessoria'] || '';
  const data_pagto_assessoria = fmtDMY2(by['data_de_pagamento_assessoria'] || '');

  // Taxa
  const taxa_faixa = by['taxa'] || '';
  const valor_taxa_brl = normalizeFaixaTaxaToValorBRL(taxa_faixa);
  const forma_pagto_taxa = by['tipo_de_pagamento_taxa'] || '';
  const data_pagto_taxa = fmtDMY2(by['data_de_pagamento_da_taxa'] || '');

  // Pesquisa — no pipe novo é radio, sem valores numéricos. Mantemos zerado.
  const valor_da_pesquisa = 'R$ 00,00';
  const forma_da_pesquisa = by['pesquisa'] ? String(by['pesquisa']) : '';
  const data_da_pesquisa = '';

  // Documento: neste pipe novo consideramos só CPF
  const cpf = cpfCampo || '';
  const cnpj = '';

  // Vendedor para cofre
  const vendedor = extractAssigneeNames(by['respons_vel'] || getByLabel(card,'vendedor responsável'))[0] || '';

  return {
    cardId: card.id,
    titulo,

    // Contratante
    nome,
    nacionalidade,
    estado_civil,
    rg,

    // Documento
    cpf,
    cnpj,
    selecao_cnpj_ou_cpf: cpf ? 'CPF' : '',

    // Contato
    email,
    telefone,

    // Endereço PF
    cep_cnpj: cep,
    rua_cnpj: rua,
    bairro_cnpj: bairro,
    cidade_cnpj: cidade,
    uf_cnpj: uf,
    numero_cnpj: numero,

    // Marca
    risco_marca,
    tipo_marca,
    classe,
    qtd_marca,

    // Serviços / remuneração
    servicos,
    parcelas,
    valor_total,
    forma_pagto_assessoria,
    data_pagto_assessoria,

    // Taxa
    taxa_faixa,
    valor_taxa_brl,
    forma_pagto_taxa,
    data_pagto_taxa,

    // Pesquisa
    valor_pesquisa: valor_da_pesquisa,
    forma_pesquisa: forma_da_pesquisa,
    data_pesquisa: data_da_pesquisa,

    // Vendedor
    vendedor
  };
}

// Variáveis para Template Word
function montarADDWord(d, nowInfo){
  const valorTotalNum = onlyNumberBR(d.valor_total);
  const parcelaNum = parseInt(String(d.parcelas||'1'),10)||1;
  const valorParcela = parcelaNum>0 ? valorTotalNum/parcelaNum : 0;

  const rua    = d.rua_cnpj || '';
  const bairro = d.bairro_cnpj || '';
  const numero = d.numero_cnpj || '';
  const cidade = d.cidade_cnpj || '';
  const uf     = d.uf_cnpj || '';
  const cep    = d.cep_cnpj || '';

  const dia = String(nowInfo.dia).padStart(2,'0');
  const mesNum = String(nowInfo.mes).padStart(2,'0');
  const ano = String(nowInfo.ano);
  const mesExtenso = monthNamePt(nowInfo.mes);

  const baseVars = {
    'Contratante 1': d.nome || '',
    Nacionalidade: d.nacionalidade || '',
    'Estado Civíl': d.estado_civil || '',
    RG: d.rg || '',

    'CPF/CNPJ': d.selecao_cnpj_ou_cpf || 'CPF',
    CPF: d.cpf || '',
    CNPJ: d.cnpj || '',

    'E-mail': d.email || '',
    Telefone: d.telefone || '',

    rua,
    Bairro: bairro,
    Numero: numero,
    'Nome da cidade': cidade,
    UF: uf,
    CEP: cep,

    'Nome da Marca': d.titulo || '',
    'tipo de marca': d.tipo_marca || '',
    Classe: d.classe || '',
    'Quantidade depósitos/processos de MARCA': d.qtd_marca || '',
    Risco: d.risco_marca || '',

    'Número de parcelas da Assessoria': String(d.parcelas||'1'),
    'Valor da parcela da Assessoria': toBRL(valorParcela),
    'Forma de pagamento da Assessoria': d.forma_pagto_assessoria || '',
    'Data de pagamento da Assessoria': d.data_pagto_assessoria || '',

    'Valor da Pesquisa': d.valor_pesquisa || 'R$ 00,00',
    'Forma de pagamento da Pesquisa': d.forma_pesquisa || '',
    'Data de pagamento da pesquisa': d.data_pesquisa || '',

    'Valor da Taxa': d.valor_taxa_brl || '',
    'Forma de pagamento da Taxa': d.forma_pagto_taxa || '',
    'Data de pagamento da Taxa': d.data_pagto_taxa || '',

    'Valor da Anuidade': '',

    Cidade: cidade,
    Dia: dia,
    'Mês': mesExtenso,
    Ano: ano,

    mes_extenso: mesExtenso,
    TEMPLATE_UUID_CONTRATO: TEMPLATE_UUID_CONTRATO || ''
  };

  return baseVars;
}

function montarSigners(d){
  const list = [];
  if (d.email) list.push({ email: d.email, name: d.nome || d.titulo || d.email, act:'1', foreign:'0', send_email:'1' });
  if (EMAIL_ASSINATURA_EMPRESA) list.push({ email: EMAIL_ASSINATURA_EMPRESA, name: 'Empresa', act:'1', foreign:'0', send_email:'1' });
  const seen={}; return list.filter(s => (seen[s.email.toLowerCase()]? false : (seen[s.email.toLowerCase()]=true)));
}

/* =========================
 * Locks e preflight
 * =======================*/
const locks = new Set();
function acquireLock(key){ if (locks.has(key)) return false; locks.add(key); return true; }
function releaseLock(key){ locks.delete(key); }
async function preflightDNS(){}

/* =========================
 * D4Sign (endpoints estáveis)
 * =======================*/
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
async function getDownloadUrl(tokenAPI, cryptKey, uuidDocument, { type = 'PDF', language = 'pt' } = {}) {
  const base = 'https://secure.d4sign.com.br';
  const url = new URL(`/api/v1/documents/${uuidDocument}/download`, base);
  url.searchParams.set('tokenAPI', tokenAPI);
  url.searchParams.set('cryptKey', cryptKey);
  const body = { type, language, document: 'false' };
  const res = await fetchWithRetry(url.toString(), {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, { attempts: 5, baseDelayMs: 600, timeoutMs: 20000 });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json?.url) {
    console.error('[ERRO D4SIGN download]', res.status, text);
    throw new Error(`Falha ao gerar URL de download: ${res.status}`);
  }
  return json; // { url, name }
}
async function sendToSigner(tokenAPI, cryptKey, uuidDocument, {
  message = '',
  skip_email = '0',
  workflow = '0'
} = {}) {
  const base = 'https://secure.d4sign.com.br';
  const url = new URL(`/api/v1/documents/${uuidDocument}/sendtosigner`, base);
  url.searchParams.set('cryptKey', cryptKey);
  const body = { message, skip_email, workflow, tokenAPI };
  const res = await fetchWithRetry(url.toString(), {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, { attempts: 5, baseDelayMs: 600, timeoutMs: 20000 });
  const text = await res.text();
  if (!res.ok) {
    console.error('[ERRO D4SIGN sendtosigner]', res.status, text);
    throw new Error(`Falha ao enviar para assinatura: ${res.status}`);
  }
  return text;
}

/* =========================
 * Fase Pipefy (mover após gerar)
 * =======================*/
async function moveCardToPhaseSafe(cardId, phaseId){
  if (!phaseId) return;
  await gql(`mutation($input: MoveCardToPhaseInput!){
    moveCardToPhase(input:$input){ card{ id } }
  }`, { input: { card_id: Number(cardId), destination_phase_id: Number(phaseId) } }).catch(e=>{
    console.warn('[WARN] moveCardToPhaseSafe', e.message||e);
  });
}

/* =========================
 * Rotas — vendedor
 * =======================*/
app.get('/lead/:token', async (req, res) => {
  try {
    const { cardId } = parseLeadToken(req.params.token);
    const card = await getCard(cardId);
    const d = await montarDados(card);

    const html = `
<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revisar contrato</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;margin:0;background:#f7f7f7;color:#111}
  .wrap{max-width:920px;margin:24px auto;padding:0 16px}
  .card{background:#fff;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08);padding:24px;margin-bottom:16px}
  h1{font-size:22px;margin:0 0 12px}
  h2{font-size:16px;margin:24px 0 8px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
  .btn{display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;border:0;background:#111;color:#fff;font-weight:600;cursor:pointer}
  .muted{color:#666}
  .label{font-weight:700}
  .tag{display:inline-block;background:#111;color:#fff;border-radius:8px;padding:4px 8px;font-size:12px;margin-left:8px}
</style>
<div class="wrap">
  <div class="card">
    <h1>Revisar dados do contrato <span class="tag">Card #${card.id}</span></h1>

    <h2>Contratante</h2>
    <div class="grid">
      <div><div class="label">Nome</div><div>${d.nome||'-'}</div></div>
      <div><div class="label">Nacionalidade</div><div>${d.nacionalidade||'-'}</div></div>
      <div><div class="label">Estado Civíl</div><div>${d.estado_civil||'-'}</div></div>
      <div><div class="label">CPF</div><div>${d.cpf||'-'}</div></div>
      <div><div class="label">RG</div><div>${d.rg||'-'}</div></div>
    </div>

    <h2>Contato</h2>
    <div class="grid">
      <div><div class="label">E-mail</div><div>${d.email||'-'}</div></div>
      <div><div class="label">Telefone</div><div>${d.telefone||'-'}</div></div>
    </div>

    <h2>Endereço</h2>
    <div class="grid3">
      <div><div class="label">CEP</div><div>${d.cep_cnpj || '-'}</div></div>
      <div><div class="label">Rua</div><div>${d.rua_cnpj || '-'}</div></div>
      <div><div class="label">Número</div><div>${d.numero_cnpj || '-'}</div></div>
      <div><div class="label">Bairro</div><div>${d.bairro_cnpj || '-'}</div></div>
      <div><div class="label">Cidade</div><div>${d.cidade_cnpj || '-'}</div></div>
      <div><div class="label">UF</div><div>${d.uf_cnpj || '-'}</div></div>
    </div>

    <h2>Marca</h2>
    <div class="grid3">
      <div><div class="label">Nome da marca</div><div>${d.titulo||'-'}</div></div>
      <div><div class="label">Classe</div><div>${d.classe||'-'}</div></div>
      <div><div class="label">Risco da marca</div><div>${d.risco_marca||'-'}</div></div>
      <div><div class="label">Qtd. de marcas</div><div>${d.qtd_marca||'0'}</div></div>
      <div><div class="label">Tipo da marca</div><div>${d.tipo_marca||'-'}</div></div>
    </div>

    <h2>Remuneração — Assessoria</h2>
    <div class="grid3">
      <div><div class="label">Valor total</div><div>${d.valor_total||'-'}</div></div>
      <div><div class="label">Parcelas</div><div>${String(d.parcelas||'1')}</div></div>
      <div><div class="label">Forma de pagamento</div><div>${d.forma_pagto_assessoria||'-'}</div></div>
      <div><div class="label">Data de pagamento (Assessoria)</div><div>${d.data_pagto_assessoria||'-'}</div></div>
    </div>

    <h2>Taxa</h2>
    <div class="grid3">
      <div><div class="label">Valor da Taxa</div><div>${d.valor_taxa_brl || '-'}</div></div>
      <div><div class="label">Forma de pagamento (Taxa)</div><div>${d.forma_pagto_taxa || '-'}</div></div>
      <div><div class="label">Data de pagamento (Taxa)</div><div>${d.data_pagto_taxa || '-'}</div></div>
    </div>

    <form method="POST" action="/lead/${encodeURIComponent(req.params.token)}/generate" style="margin-top:24px">
      <button class="btn" type="submit">Gerar contrato</button>
    </form>
    <p class="muted" style="margin-top:12px">Ao clicar, o documento será criado no D4Sign e o card poderá ser movido para Contrato enviado.</p>
  </div>
</div>
`;
    res.setHeader('content-type','text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    console.error('[ERRO /lead]', e.message||e);
    return res.status(400).send('Link inválido ou expirado.');
  }
});

// Gera o documento e mostra botões
app.post('/lead/:token/generate', async (req, res) => {
  try {
    const { cardId } = parseLeadToken(req.params.token);
    const lockKey = `lead:${cardId}`;
    if (!acquireLock(lockKey)) return res.status(200).send('Processando, tente novamente em instantes.');

    preflightDNS().catch(()=>{});

    const card = await getCard(cardId);
    const d = await montarDados(card);

    const now = new Date();
    const nowInfo = { dia: now.getDate(), mes: now.getMonth()+1, ano: now.getFullYear() };
    const add = montarADDWord(d, nowInfo);
    const signers = montarSigners(d);

    const uuidSafe = COFRES_UUIDS[d.vendedor] || DEFAULT_COFRE_UUID;
    if (!uuidSafe) throw new Error(`Cofre não configurado para vendedor: ${d.vendedor}`);

    const uuidDoc = await makeDocFromWordTemplate(D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, uuidSafe, TEMPLATE_UUID_CONTRATO, d.titulo || `Card ${card.id}`, add);
    await cadastrarSignatarios(D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, uuidDoc, signers);

    await moveCardToPhaseSafe(card.id, PHASE_ID_CONTRATO_ENVIADO);

    releaseLock(lockKey);

    const token = req.params.token;
    const html = `
<!doctype html><meta charset="utf-8"><title>Contrato gerado</title>
<style>
  body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;background:#f7f7f7;color:#111;margin:0}
  .box{background:#fff;padding:24px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-width:640px;width:92%}
  h2{margin:0 0 12px}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
  .btn{display:inline-block;padding:12px 16px;border-radius:10px;text-decoration:none;border:0;background:#111;color:#fff;font-weight:600}
  .muted{color:#666}
</style>
<div class="box">
  <h2>Contrato gerado com sucesso</h2>
  <p class="muted">UUID do documento: ${uuidDoc}</p>
  <div class="row">
    <a class="btn" href="/lead/${encodeURIComponent(token)}/doc/${encodeURIComponent(uuidDoc)}/download" target="_blank" rel="noopener">Baixar PDF</a>
    <form method="POST" action="/lead/${encodeURIComponent(token)}/doc/${encodeURIComponent(uuidDoc)}/send" style="display:inline">
      <button class="btn" type="submit">Enviar para assinatura</button>
    </form>
    <a class="btn" href="${PUBLIC_BASE_URL.replace(/\/+$/,'')}/lead/${encodeURIComponent(token)}">Voltar</a>
  </div>
</div>`;
    return res.status(200).send(html);

  } catch (e) {
    console.error('[ERRO LEAD-GENERATE]', e.message || e);
    return res.status(400).send('Falha ao gerar o contrato.');
  }
});

// Download (redirect temporário do D4Sign)
app.get('/lead/:token/doc/:uuid/download', async (req, res) => {
  try {
    const { cardId } = parseLeadToken(req.params.token);
    if (!cardId) throw new Error('token inválido');
    const uuidDoc = req.params.uuid;

    const { url: downloadUrl } = await getDownloadUrl(D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, uuidDoc, { type: 'PDF', language: 'pt' });
    return res.redirect(302, downloadUrl);
  } catch (e) {
    console.error('[ERRO lead download]', e.message || e);
    return res.status(400).send('Falha ao gerar link de download.');
  }
});

// Enviar para assinatura
app.post('/lead/:token/doc/:uuid/send', async (req, res) => {
  try {
    const { cardId } = parseLeadToken(req.params.token);
    if (!cardId) throw new Error('token inválido');
    const uuidDoc = req.params.uuid;

    await sendToSigner(D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, uuidDoc, {
      message: 'Olá. Há um documento aguardando sua assinatura.',
      skip_email: '0',
      workflow: '0'
    });

    const okHtml = `
<!doctype html><meta charset="utf-8"><title>Documento enviado</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;background:#f7f7f7} .box{background:#fff;padding:24px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-width:560px}</style>
<div class="box">
  <h2>Documento enviado para assinatura</h2>
  <p>Os signatários foram notificados.</p>
  <p><a href="${PUBLIC_BASE_URL.replace(/\/+$/,'')}/lead/${encodeURIComponent(req.params.token)}">Voltar</a></p>
</div>`;
    return res.status(200).send(okHtml);

  } catch (e) {
    console.error('[ERRO sendtosigner]', e.message || e);
    return res.status(400).send('Falha ao enviar para assinatura.');
  }
});

/* =========================
 * Geração do link no Pipefy
 * =======================*/
app.post('/novo-pipe/criar-link-confirmacao', async (req, res) => {
  try {
    const cardId = req.body.cardId || req.body.card_id || req.query.cardId || req.query.card_id;
    if (!cardId) return res.status(400).json({ error: 'cardId é obrigatório' });

    const card = await getCard(cardId);

    if (NOVO_PIPE_ID && String(card?.pipe?.id)!==String(NOVO_PIPE_ID)) {
      return res.status(400).json({ error: 'Card não pertence ao pipe configurado' });
    }
    if (PHASE_ID_PROPOSTA && String(card?.current_phase?.id)!==String(PHASE_ID_PROPOSTA)) {
      return res.status(400).json({ error: 'Card não está na fase Proposta' });
    }

    const token = makeLeadToken({ cardId: String(cardId), ts: Date.now() });
    const url = `${PUBLIC_BASE_URL.replace(/\/+$/,'')}/lead/${encodeURIComponent(token)}`;

    await updateCardField(cardId, PIPEFY_FIELD_LINK_CONTRATO, url);

    return res.json({ ok:true, link:url });
  } catch (e) {
    console.error('[ERRO criar-link]', e.message||e);
    return res.status(500).json({ error: String(e.message||e) });
  }
});
app.get('/novo-pipe/criar-link-confirmacao', async (req,res)=>{ // opcional GET
  req.body = req.body || {};
  req.body.cardId = req.query.cardId || req.query.card_id;
  return app._router.handle(req, res, ()=>{});
});

/* =========================
 * Debug / Health
 * =======================*/
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
app.get('/debug/card', async (req,res)=>{
  try{
    const { cardId } = req.query; if (!cardId) return res.status(400).send('cardId obrigatório');
    const card = await getCard(cardId);
    res.json({
      id: card.id, title: card.title, pipe: card.pipe, phase: card.current_phase,
      fields: (card.fields||[]).map(f => ({ name:f.name, id:f.field?.id, type:f.field?.type, value:f.value }))
    });
  }catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});
app.get('/health', (_req,res)=> res.json({ ok:true }));

/* =========================
 * Start
 * =======================*/
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  const list=[];
  app._router.stack.forEach(m=>{
    if (m.route && m.route.path){
      const methods = Object.keys(m.route.methods).map(x=>x.toUpperCase()).join(',');
      list.push(`${methods} ${m.route.path}`);
    } else if (m.name==='router' && m.handle?.stack){
      m.handle.stack.forEach(h=>{
        const route = h.route;
        if (route){
          const methods = Object.keys(route.methods).map(x=>x.toUpperCase()).join(',');
          list.push(`${methods} ${route.path}`);
        }
      });
    }
  });
  console.log('[rotas-registradas]'); list.sort().forEach(r=>console.log('  -', r));
});

/**
 * Checklist de ENV
 *
 * PUBLIC_BASE_URL=http://72.60.247.192
 * PUBLIC_LINK_SECRET=um-segredo-forte
 *
 * PIPE_API_KEY=...
 * PIPE_GRAPHQL_ENDPOINT=https://api.pipefy.com/graphql
 *
 * PIPEFY_FIELD_LINK_CONTRATO=d4_contrato
 *
 * NOVO_PIPE_ID=306550975                   # opcional
 * PHASE_ID_PROPOSTA=339562147              # fase Proposta do novo pipe
 * PHASE_ID_CONTRATO_ENVIADO=XXXXXXXX       # opcional
 *
 * D4SIGN_TOKEN=...
 * D4SIGN_CRYPT_KEY=...
 * TEMPLATE_UUID_CONTRATO=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *
 * EMAIL_ASSINATURA_EMPRESA=contratos@empresa.com.br
 *
 * COFRE_UUID_EDNA=...
 * COFRE_UUID_GREYCE=...
 * COFRE_UUID_MARIANA=...
 * COFRE_UUID_VALDEIR=...
 * COFRE_UUID_DEBORA=...
 * COFRE_UUID_MAYKON=...
 * COFRE_UUID_JEFERSON=...
 * COFRE_UUID_RONALDO=...
 * COFRE_UUID_BRENDA=...
 * COFRE_UUID_MAURO=...
 * DEFAULT_COFRE_UUID=...                   # recomendado
 */
