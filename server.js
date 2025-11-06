'use strict';

/**
 * server.js — Provincia Vendas (Pipefy + D4Sign via secure.d4sign.com.br)
 * Node 18+ (fetch global)
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

  // IDs de tabelas / campos
  FIELD_ID_CONNECT_MARCA_NOME, // marcas_1 (Marcas - Captação)
  FIELD_ID_CONNECT_CLASSE,     // marcas_2 (Marcas (Visita))
  FIELD_ID_CONNECT_CLASSES,    // classes_inpi (se existir no card)
  MARCAS_TABLE_ID,             // MmqLNaPk (Marcas - Captação)
  CONTACTS_TABLE_ID,           // 306505297 (Contatos)
  MARCAS2_TABLE_ID,            // tnDAtg7l (Marcas - Visita)
  CLASSES_TABLE_ID,            // 306521337 (Classes INPI)

  PIPEFY_FIELD_LINK_CONTRATO,  // d4_contrato
  NOVO_PIPE_ID,
  FASE_VISITA_ID,
  PHASE_ID_CONTRATO_ENVIADO,

  // D4Sign
  D4SIGN_TOKEN,
  D4SIGN_CRYPT_KEY,
  TEMPLATE_UUID_CONTRATO,

  // Assinatura interna
  EMAIL_ASSINATURA_EMPRESA,

  // Cofres
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
FIELD_ID_CONNECT_MARCA_NOME = FIELD_ID_CONNECT_MARCA_NOME || 'marcas_1';
FIELD_ID_CONNECT_CLASSE     = FIELD_ID_CONNECT_CLASSE     || 'marcas_2';
CLASSES_TABLE_ID            = CLASSES_TABLE_ID || '306521337';

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
function moneyBRNoSymbol(n){
  const num = typeof n==='number'? n : parseNumberBR(n);
  if (isNaN(num)) return '';
  return num.toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2});
}
function onlyNumberBR(s){
  const n = parseNumberBR(s);
  return isNaN(n)? 0 : n;
}

// Datas — meses por extenso (capitalizados) e formatações auxiliares
const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
function monthNamePt(mIndex1to12) { return MESES_PT[(Math.max(1, Math.min(12, Number(mIndex1to12))) - 1)]; }

// Aceita "DD/MM/YYYY" (Pipefy) ou ISO; devolve Date válido ou null
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
// Retorna "DD/MM/YY"
function fmtDMY2(value){
  const d = value instanceof Date ? value : parsePipeDateToDate(value);
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// Retry com timeout exponencial
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
function makeLeadToken(payload){ // {cardId, ts}
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
async function getTableRecord(recordId){
  const data = await gql(`query($id: ID!){
    table_record(id:$id){
      id title
      record_fields{ name value field{ id type } }
    }
  }`, { id: recordId });
  return data.table_record;
}
async function listTableRecords(tableId, first=100, after=null){
  const data = await gql(`query($tableId: ID!, $first: Int!, $after: String){
    table(id:$tableId){
      id
      table_records(first:$first, after:$after){
        edges{ node{ id title record_fields{ name value field{ id type } } } }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }`, { tableId, first, after });
  const edges = data?.table?.table_records?.edges || [];
  const pageInfo = data?.table?.table_records?.pageInfo || {};
  return { records: edges.map(e=>e.node), pageInfo };
}

/* =========================
 * Parsing de campos do card
 * =======================*/
function toById(card){
  const by={}; for (const f of card?.fields||[]) if (f?.field?.id) by[f.field.id]=f.value;
  return by;
}
function getByName(card, nameSub){
  const t = String(nameSub).toLowerCase();
  const f = (card.fields||[]).find(ff=> String(ff?.name||'').toLowerCase().includes(t));
  return f?.value || '';
}
function getFirstByNames(card, arr){
  for (const k of arr){ const v = getByName(card, k); if (v) return v; }
  return '';
}
function parseMaybeJsonArray(v){
  try { return Array.isArray(v)? v : JSON.parse(v); }
  catch { return v? [String(v)] : []; }
}
function extractNameEmailPhoneFromRecord(record){
  let nome='', email='', telefone='';
  for (const f of record?.record_fields||[]){
    const t = (f?.field?.type||'').toLowerCase();
    const id = (f?.field?.id||'').toLowerCase();
    const label = (f?.name||'').toLowerCase();
    if (!nome && (id==='nome_do_contato' || label.includes('nome'))) nome = String(f.value||'');
    if (!email && (t==='email' || id.includes('email') || label.includes('email'))) email = String(f.value||'');
    if (!telefone && (t==='phone' || label.includes('telefone') || label.includes('whats') || label.includes('celular'))) telefone = String(f.value||'');
  }
  return { nome, email, telefone };
}

// Resolve record de “marcas_1” (espelho por título ou id)
async function resolveMarcaRecordFromCard(card){
  const by = toById(card);
  const v = by[FIELD_ID_CONNECT_MARCA_NOME]; // 'marcas_1'
  const arr = parseMaybeJsonArray(v);
  if (!arr.length) return null;
  const first = String(arr[0]).trim();

  if (/^\d+$/.test(first)){ // ID
    try { return await getTableRecord(first); } catch { return null; }
  }

  if (!MARCAS_TABLE_ID) return null;
  let after=null;
  for (let i=0;i<50;i++){
    const {records, pageInfo} = await listTableRecords(MARCAS_TABLE_ID, 100, after);
    const hit = records.find(r=> String(r.title||'').trim().toLowerCase() === first.toLowerCase());
    if (hit) return hit;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor || null;
  }
  return null;
}
async function findContatoRecordByMirror({ contactsTableId, titleMirror, emailMirror, phoneMirrorDigits }){
  if (!contactsTableId) return null;
  let after=null;
  for (let i=0;i<100;i++){
    const {records, pageInfo} = await listTableRecords(contactsTableId, 200, after);
    if (titleMirror){
      const r = records.find(x => String(x.title||'').trim() === String(titleMirror).trim());
      if (r) return r;
    }
    for (const r of records){
      for (const f of r.record_fields||[]){
        const t = (f?.field?.type||'').toLowerCase();
        const val = String(f?.value||'');
        if (emailMirror && t==='email' && val.toLowerCase()===String(emailMirror).toLowerCase()) return r;
        if (phoneMirrorDigits && t==='phone' && normalizePhone(val)===phoneMirrorDigits) return r;
      }
    }
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor || null;
  }
  return null;
}
function contacts_table_id(){ return String(CONTACTS_TABLE_ID||'').trim(); }

async function resolveContatoFromMarcaRecord(marcaRecord){
  const campo = (marcaRecord?.record_fields||[]).find(f=> f?.field?.id==='contatos' || String(f?.name||'').toLowerCase().includes('contato'));
  if (!campo) return { nome:'', email:'', telefone:'' };

  const arr = parseMaybeJsonArray(campo.value);
  const first = arr && arr[0];
  if (!first) return { nome:'', email:'', telefone:'' };

  if (/^\d+$/.test(String(first))){
    try { const rec = await getTableRecord(String(first)); return extractNameEmailPhoneFromRecord(rec); }
    catch { /* espelho */ }
  }
  const titleMirror = String(first||'').trim();
  let emailMirror='', phoneMirrorDigits='';
  for (const s of arr.map(String)){
    if (!emailMirror && s.includes('@')) emailMirror = s;
    const d = normalizePhone(s);
    if (!phoneMirrorDigits && d.length>=10) phoneMirrorDigits = d;
  }
  const found = await findContatoRecordByMirror({
    contactsTableId: contacts_table_id(),
    titleMirror, emailMirror, phoneMirrorDigits
  });
  if (found) return extractNameEmailPhoneFromRecord(found);

  let nome='';
  if (arr.length) nome = arr.find(s => s && !String(s).includes('@') && normalizePhone(s).length<10) || '';
  return { nome, email: emailMirror||'', telefone: phoneMirrorDigits||'' };
}

async function resolveClasseFromLabelOnCard(card){
  const f = (card.fields||[]).find(ff=>{
    const isConn = (ff?.field?.type==='connector' || ff?.field?.type==='table_connection');
    const idOk = String(ff?.field?.id||'').toLowerCase()==='classes_inpi';
    const lblOk = String(ff?.name||'').toLowerCase().includes('classes inpi');
    return isConn && (idOk||lblOk);
  });
  if (!f||!f.value) return '';
  let arr=[]; try { arr = Array.isArray(f.value)? f.value : JSON.parse(f.value); } catch { arr=[f.value]; }
  const first = arr && arr[0]; if (!first) return '';
  if (/^\d+$/.test(String(first))){
    try { const rec = await getTableRecord(String(first)); return rec?.title || ''; } catch {}
  }
  return String(first||'');
}
async function resolveClasseFromCard(card, marcaRecordFallback){
  const fromCard = await resolveClasseFromLabelOnCard(card);
  if (fromCard) return fromCard;

  const by = toById(card);

  if (FIELD_ID_CONNECT_CLASSES){
    const v = by[FIELD_ID_CONNECT_CLASSES];
    const arr = parseMaybeJsonArray(v);
    if (arr.length){
      const first = String(arr[0]);
      if (/^\d+$/.test(first)){ try { const rec = await getTableRecord(first); return rec?.title||''; } catch{} }
      try { const a = Array.isArray(v)? v : JSON.parse(v); if (Array.isArray(a)&&a.length) return String(a[0]||''); } catch{}
    }
  }

  const v2 = by[FIELD_ID_CONNECT_CLASSE];
  const arr2 = parseMaybeJsonArray(v2);
  if (arr2.length){
    const first = String(arr2[0]).trim();
    if (/^\d+$/.test(first)){
      try{
        const rec = await getTableRecord(first);
        const classeField = (rec.record_fields||[]).find(f => String(f?.name||'').toLowerCase().includes('classe'));
        if (classeField?.value){
          const val = classeField.value;
          if (Array.isArray(val)){
            const id0 = String(val[0]||'');
            if (/^\d+$/.test(id0)){ const recClasse = await getTableRecord(id0); return recClasse?.title || ''; }
          } else {
            try { const a = JSON.parse(val); if (Array.isArray(a)&&a.length) return String(a[0]||''); } catch { if (val) return String(val); }
          }
        }
        if (rec?.title) return String(rec.title);
      } catch {}
    } else {
      if (MARCAS2_TABLE_ID){
        let after=null;
        for (let i=0;i<50;i++){
          const {records,pageInfo} = await listTableRecords(MARCAS2_TABLE_ID, 100, after);
          const rec = records.find(r => String(r.title||'').trim().toLowerCase() === first.trim().toLowerCase());
          if (rec){
            const classeField = (rec.record_fields||[]).find(f => String(f?.name||'').toLowerCase().includes('classe'));
            if (classeField?.value){
              const val = classeField.value;
              if (Array.isArray(val)){
                const id0 = String(val[0]||'');
                if (/^\d+$/.test(id0)){ const recClasse = await getTableRecord(id0); return recClasse?.title || ''; }
              } else {
                try { const a = JSON.parse(val); if (Array.isArray(a)&&a.length) return String(a[0]||''); } catch { if (val) return String(val); }
              }
            }
            return String(rec.title||'');
          }
          if (!pageInfo?.hasNextPage) break;
          after = pageInfo.endCursor || null;
        }
      } else {
        try { const a = Array.isArray(v2)? v2 : JSON.parse(v2); if (Array.isArray(a)&&a.length) return String(a[0]||''); } catch{}
      }
    }
  }
  if (marcaRecordFallback){
    const classeField = (marcaRecordFallback.record_fields||[]).find(f=> String(f?.name||'').toLowerCase().includes('classe'));
    if (classeField?.value) return String(classeField.value);
  }
  return '';
}

// Documento (CPF/CNPJ)
function pickDocumento(card){
  const prefer = ['cpf','cnpj','documento','doc','cpf/cnpj','cnpj/cpf'];
  for (const k of prefer){
    const v = getFirstByNames(card, [k]);
    const d = onlyDigits(v);
    if (d.length===11) return { tipo:'CPF', valor:v };
    if (d.length===14) return { tipo:'CNPJ', valor:v };
  }
  const by = toById(card);
  const cnpjStart = by['cnpj'] || getFirstByNames(card, ['cnpj']);
  if (cnpjStart) return { tipo:'CNPJ', valor:cnpjStart };
  return { tipo:'', valor:'' };
}

// Assignee parsing (para cofre)
function stripDiacritics(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function normalizeName(s){ return stripDiacritics(String(s||'').trim()).toLowerCase(); }
function extractAssigneeNames(raw){
  const out=[]; const push=v=>{ if(v) out.push(String(v)); }; const tryParse=v=>{ if(typeof v==='string'){ try{return JSON.parse(v);} catch{return v;} } return v; };
  const val = tryParse(raw);
  if (Array.isArray(val)){ for (const it of val) push(typeof it==='string'? it : (it?.name||it?.username||it?.email||it?.value)); }
  else if (typeof val==='object'&&val){ push(val.name||val.username||val.email||val.value); }
  else if (typeof val==='string'){ const m = val.match(/^\s*\[.*\]\s*$/)? tryParse(val) : null; if (m && Array.isArray(m)) m.forEach(x=>push(typeof x==='string'? x : (x?.name||x?.email))); else push(val); }
  return [...new Set(out.filter(Boolean))];
}
function resolveCofreUuidByCard(card){
  const by = toById(card);
  const candidatosBrutos = [];
  if (by['vendedor_respons_vel']) candidatosBrutos.push(by['vendedor_respons_vel']);
  if (by['vendedor_respons_vel_1']) candidatosBrutos.push(by['vendedor_respons_vel_1']);
  if (by['respons_vel_5']) candidatosBrutos.push(by['respons_vel_5']);
  if (by['representante']) candidatosBrutos.push(by['representante']);
  const nomesOuEmails = candidatosBrutos.flatMap(extractAssigneeNames);
  const normKeys = Object.keys(COFRES_UUIDS||{}).reduce((acc,k)=>{ acc[normalizeName(k)] = COFRES_UUIDS[k]; return acc; },{});
  for (const s of nomesOuEmails){ const n=normalizeName(s); if (normKeys[n]) return normKeys[n]; }
  if (DEFAULT_COFRE_UUID) return DEFAULT_COFRE_UUID;
  return null;
}

/* =========================
 * Regras específicas: Taxa e Classe
 * =======================*/
function computeValorTaxaBRLFromFaixa(d){
  let valorTaxaSemRS = '';
  const taxa = String(d.taxa_faixa||'');
  if (taxa.includes('440')) valorTaxaSemRS = '440,00';
  else if (taxa.includes('880')) valorTaxaSemRS = '880,00';
  return valorTaxaSemRS ? `R$ ${valorTaxaSemRS}` : '';
}
function normalizeClasseToNumbersOnly(classeStr){
  if (!classeStr) return '';
  const nums = String(classeStr).match(/\d+/g) || [];
  return nums.join(', ');
}

/* =========================
 * Montagem de dados do contrato
 * =======================*/
function pickParcelas(card){
  const by = toById(card);
  let raw = by['sele_o_de_lista'] || by['quantidade_de_parcelas'] || by['numero_de_parcelas'] || '';
  if (!raw) raw = getFirstByNames(card, ['parcelas','quantidade de parcelas','nº parcelas']);
  const m = String(raw||'').match(/(\d+)/);
  return m ? m[1] : '1';
}
function pickValorAssessoria(card){
  const by = toById(card);
  let raw = by['valor_da_assessoria'] || by['valor_assessoria'] || '';
  if (!raw) raw = getFirstByNames(card, ['valor da assessoria','assessoria']);
  if (!raw){
    const hit = (card.fields||[]).find(f => String(f?.field?.type||'').toLowerCase()==='currency'); raw = hit?.value||'';
  }
  const n = parseNumberBR(raw);
  return isNaN(n)? null : n;
}

async function montarDados(card){
  const by = toById(card);

  // === Classe / Marca / Contato
  const marcaRecord = await resolveMarcaRecordFromCard(card);
  let classe = await resolveClasseFromCard(card, marcaRecord);
  classe = normalizeClasseToNumbersOnly(classe);

  // contato
  let contatoNome='', contatoEmail='', contatoTelefone='';
  const contatoConn = (card.fields||[]).find(f => (f.field?.type==='connector'||f.field?.type==='table_connection') && String(f.name||'').toLowerCase().includes('contat'));
  if (contatoConn?.value){
    try{
      const arr = Array.isArray(contatoConn.value)? contatoConn.value : JSON.parse(contatoConn.value);
      const first = arr && arr[0];
      if (first && /^\d+$/.test(String(first))){
        const rec = await getTableRecord(first);
        const ex = extractNameEmailPhoneFromRecord(rec);
        contatoNome = ex.nome || '';
        contatoEmail = ex.email || '';
        contatoTelefone = ex.telefone || '';
      } else if (Array.isArray(arr)){
        const em = arr.find(s => String(s).includes('@'));
        const ph = arr.find(s => normalizePhone(s).length>=10);
        contatoEmail = em ? String(em) : '';
        contatoTelefone = ph ? String(ph) : '';
      }
    } catch {}
  }
  if (marcaRecord && (!contatoNome||!contatoEmail||!contatoTelefone)){
    const contato = await resolveContatoFromMarcaRecord(marcaRecord);
    contatoNome     = contatoNome     || contato.nome || '';
    contatoEmail    = contatoEmail    || contato.email || '';
    contatoTelefone = contatoTelefone || contato.telefone || '';
  }
  if (!contatoNome)    contatoNome    = getFirstByNames(card, ['nome do contato','contratante','responsável legal','responsavel legal']);
  if (!contatoEmail)   contatoEmail   = getFirstByNames(card, ['email','e-mail']);
  if (!contatoTelefone)contatoTelefone= getFirstByNames(card, ['telefone','celular','whatsapp','whats']);

  // Documento (CPF/CNPJ)
  const doc = pickDocumento(card);
  const cpfDoc  = doc.tipo==='CPF'?  doc.valor : '';
  const cnpjDoc = doc.tipo==='CNPJ'? doc.valor : '';
  const cpfCampo  = by['cpf']    || '';
  const cnpjCampo = by['cnpj_1'] || '';

  // Parcelas / Assessoria
  const nParcelas = pickParcelas(card);
  const valorAssessoria = pickValorAssessoria(card);
  const formaAss = by['copy_of_tipo_de_pagamento'] || getFirstByNames(card, ['tipo de pagamento assessoria']) || '';

  // Serviços / quantidade de marca
  const serv1 = getFirstByNames(card, ['serviços de contratos','serviços contratados','serviços']);
  const temMarca = Boolean(getFirstByNames(card, ['marca']) || by['marca'] || by['marcas_1'] || card.title);
  const qtdMarca = temMarca ? '1' : '';
  const servicos = [serv1].filter(Boolean);

  // TAXA
  const taxaFaixaRaw = by['taxa'] || getFirstByNames(card, ['taxa']);
  const valorTaxaBRL = computeValorTaxaBRLFromFaixa({ taxa_faixa: taxaFaixaRaw });
  const formaPagtoTaxa = by['tipo_de_pagamento'] || '';
  const dataPagtoTaxa = fmtDMY2(by['data_de_pagamento_taxa'] || ''); // NOVO

  // ENDEREÇO (CNPJ)
  const cepCnpj    = by['cep_do_cnpj']     || '';
  const ruaCnpj    = by['rua_av_do_cnpj']  || '';
  const bairroCnpj = by['bairro_do_cnpj']  || '';
  const cidadeCnpj = by['cidade_do_cnpj']  || '';
  const ufCnpj     = by['estado_do_cnpj']  || '';
  const numeroCnpj = by['n_mero_1']        || getFirstByNames(card, ['numero','número','nº']) || '';

  // Vendedor (cofre)
  const vendedor = extractAssigneeNames(by['vendedor_respons_vel'] || by['vendedor_respons_vel_1'] || by['respons_vel_5'])[0] || '';

  // Extras
  const riscoMarca = by['risco_da_marca'] || '';
  const nacionalidade = by['nacionalidade'] || '';
  const selecaoCnpjOuCpf = by['cnpj_ou_cpf'] || '';
  const estadoCivil = by['estado_civ_l'] || ''; // NOVO
  const dataPagtoAssessoria = fmtDMY2(by['data_de_pagamento_assessoria'] || ''); // NOVO

  return {
    cardId: card.id,
    titulo: card.title,

    // Contratante
    nome: contatoNome || (by['r_social_ou_n_completo']||''),
    cpf: cpfDoc, 
    cnpj: cnpjDoc,
    rg: by['rg'] || '',
    estado_civil: estadoCivil, // NOVO

    // Campos específicos doc
    cpf_campo: cpfCampo,
    cnpj_campo: cnpjCampo,

    // Contato
    email: contatoEmail || '',
    telefone: contatoTelefone || '',

    // Marca / Classe / Qtd marca
    classe: classe || '',
    qtd_marca: qtdMarca,

    // Serviços / Assessoria
    servicos,
    parcelas: nParcelas,
    valor_total: valorAssessoria ? toBRL(valorAssessoria) : '',
    forma_pagto_assessoria: formaAss,
    data_pagto_assessoria: dataPagtoAssessoria, // NOVO

    // TAXA
    taxa_faixa: taxaFaixaRaw || '',
    valor_taxa_brl: valorTaxaBRL,
    forma_pagto_taxa: formaPagtoTaxa,
    data_pagto_taxa: dataPagtoTaxa,

    // Endereço (CNPJ)
    cep_cnpj: cepCnpj,
    rua_cnpj: ruaCnpj,
    bairro_cnpj: bairroCnpj,
    cidade_cnpj: cidadeCnpj,
    uf_cnpj: ufCnpj,
    numero_cnpj: numeroCnpj,

    // Extras
    risco_marca: riscoMarca,
    nacionalidade,
    selecao_cnpj_ou_cpf: selecaoCnpjOuCpf,

    // Vendedor
    vendedor
  };
}

// Variáveis para Template Word (ADD)
function montarADDWord(d, nowInfo){
  const valorTotalNum = onlyNumberBR(d.valor_total);
  const parcelaNum = parseInt(String(d.parcelas||'1'),10)||1;
  const valorParcela = parcelaNum>0 ? valorTotalNum/parcelaNum : 0;

  const valorPesquisa = 'R$ 00,00';
  const formaPesquisa = '---';
  const dataPesquisa  = '00/00/00';

  const rua    = d.rua_cnpj || '';
  const bairro = d.bairro_cnpj || '';
  const numero = d.numero_cnpj || '';
  const cidade = d.cidade_cnpj || '';
  const uf     = d.uf_cnpj || '';
  const cep    = d.cep_cnpj || '';

  const valorDaTaxa = d.valor_taxa_brl || '';
  const formaDaTaxa = d.forma_pagto_taxa || '';
  const dataDaTaxa  = d.data_pagto_taxa || '';

  // Data atual (mês por extenso capitalizado)
  const dia = String(nowInfo.dia).padStart(2,'0');
  const mesNum = String(nowInfo.mes).padStart(2,'0');
  const ano = String(nowInfo.ano);
  const mesExtenso = monthNamePt(nowInfo.mes);

  const baseVars = {
    // Identificação / contrato
    contratante_1: d.nome || '',
    cpf: d.cpf || '',
    cnpj: d.cnpj || '',
    rg: d.rg || '',
    'Estado Civíl': d.estado_civil || '', // NOVO
    'Estado Civil': d.estado_civil || '', // tolerância

    // Doc adicionais
    'CPF/CNPJ': d.selecao_cnpj_ou_cpf || '',
    'CPF': d.cpf_campo || '',
    'CNPJ': d.cnpj_campo || '',

    // Endereço
    rua,
    bairro,
    numero,
    nome_da_cidade: cidade,
    cidade,
    uf,
    cep,

    // Contato
    'E-mail': d.email || '',
    telefone: d.telefone || '',

    // Marca / Classe / Qtd marca / Risco
    nome_da_marca: d.titulo || '',
    classe: d.classe || '',
    qtd_marca: d.qtd_marca || '',
    risco_da_marca: d.risco_marca || '',

    // Dados pessoais adicionais
    Nacionalidade: d.nacionalidade || '',

    // Assessoria
    numero_de_parcelas_da_assessoria: String(d.parcelas||'1'),
    valor_da_parcela_da_assessoria: toBRL(valorParcela),
    forma_de_pagamento_da_assessoria: d.forma_pagto_assessoria || '',
    data_de_pagamento_da_assessoria: d.data_pagto_assessoria || '', // NOVO
    'Data de pagamento da Assessoria': d.data_pagto_assessoria || '', // NOVO

    // Pesquisa
    valor_da_pesquisa: valorPesquisa,
    forma_de_pagamento_da_pesquisa: formaPesquisa,
    data_de_pagamento_da_pesquisa: dataPesquisa,

    // Taxa
    valor_da_taxa: valorDaTaxa,
    forma_de_pagamento_da_taxa: formaDaTaxa,
    data_de_pagamento_da_taxa: dataDaTaxa,
    'Valor da Taxa': valorDaTaxa,
    'Forma de pagamento da Taxa': formaDaTaxa,
    'Data de pagamento da Taxa': dataDaTaxa,

    // Datas (numérico E por extenso)
    dia,
    mes: mesNum,
    ano,
    mes_extenso: mesExtenso,
    'Mês': mesExtenso,  // <- para seu template
    'Mes': mesExtenso,  // tolerância

    // Template
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
async function preflightDNS(){ /* opcional: warmup */ }

/* =========================
 * D4Sign via secure.d4sign.com.br (validados)
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
 * Rotas — VENDEDOR (UX bonita)
 * =======================*/
// Página de revisão
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

    <h2>Contratante(s)</h2>
    <div class="grid">
      <div><div class="label">Nome</div><div>${d.nome||'-'}</div></div>
      <div><div class="label">Nacionalidade</div><div>${d.nacionalidade||'-'}</div></div>
      <div><div class="label">Estado Civíl</div><div>${d.estado_civil||'-'}</div></div>
      <div><div class="label">CPF/CNPJ (seleção)</div><div>${d.selecao_cnpj_ou_cpf||'-'}</div></div>
      <div><div class="label">CPF (campo)</div><div>${d.cpf_campo||'-'}</div></div>
      <div><div class="label">CNPJ (campo)</div><div>${d.cnpj_campo||'-'}</div></div>
      <div><div class="label">RG</div><div>${d.rg||'-'}</div></div>
    </div>

    <h2>Contato</h2>
    <div class="grid">
      <div><div class="label">E-mail</div><div>${d.email||'-'}</div></div>
      <div><div class="label">Telefone</div><div>${d.telefone||'-'}</div></div>
    </div>

    <h2>Marca</h2>
    <div class="grid3">
      <div><div class="label">Nome da marca</div><div>${d.titulo||'-'}</div></div>
      <div><div class="label">Classes (apenas números)</div><div>${d.classe||'-'}</div></div>
      <div><div class="label">Risco da marca</div><div>${d.risco_marca||'-'}</div></div>
      <div><div class="label">Qtd. de marcas</div><div>${d.qtd_marca||'0'}</div></div>
    </div>

    <h2>Serviços</h2>
    <div>${(d.servicos||[]).join(', ') || '-'}</div>

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

    <h2>Endereço (CNPJ)</h2>
    <div class="grid3">
      <div><div class="label">CEP</div><div>${d.cep_cnpj || '-'}</div></div>
      <div><div class="label">Rua/Av</div><div>${d.rua_cnpj || '-'}</div></div>
      <div><div class="label">Número</div><div>${d.numero_cnpj || '-'}</div></div>
      <div><div class="label">Bairro</div><div>${d.bairro_cnpj || '-'}</div></div>
      <div><div class="label">Cidade</div><div>${d.cidade_cnpj || '-'}</div></div>
      <div><div class="label">UF</div><div>${d.uf_cnpj || '-'}</div></div>
    </div>

    <form method="POST" action="/lead/${encodeURIComponent(req.params.token)}/generate" style="margin-top:24px">
      <button class="btn" type="submit">Gerar contrato</button>
    </form>
    <p class="muted" style="margin-top:12px">Ao clicar, o documento será criado no D4Sign e o card poderá ser movido para "Contrato enviado".</p>
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

// Gera o documento e mostra botões de Baixar PDF e Enviar para assinatura
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

    const uuidDoc = await makeDocFromWordTemplate(D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, uuidSafe, TEMPLATE_UUID_CONTRATO, card.title, add);
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
    <a class="btn" href="${PUBLIC_BASE_URL}/lead/${encodeURIComponent(token)}">Voltar</a>
  </div>
</div>`;
    return res.status(200).send(html);

  } catch (e) {
    console.error('[ERRO LEAD-GENERATE]', e.message || e);
    return res.status(400).send('Falha ao gerar o contrato.');
  }
});

// Download (redirect para URL temporária do D4Sign)
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
      message: 'Olá! Há um documento aguardando sua assinatura.',
      skip_email: '0',
      workflow: '0'
    });

    const okHtml = `
<!doctype html><meta charset="utf-8"><title>Documento enviado</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;background:#f7f7f7} .box{background:#fff;padding:24px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08);max-width:560px}</style>
<div class="box">
  <h2>Documento enviado para assinatura</h2>
  <p>Os signatários foram notificados.</p>
  <p><a href="${PUBLIC_BASE_URL}/lead/${encodeURIComponent(req.params.token)}">Voltar</a></p>
</div>`;
    return res.status(200).send(okHtml);

  } catch (e) {
    console.error('[ERRO sendtosigner]', e.message || e);
    return res.status(400).send('Falha ao enviar para assinatura.');
  }
});

/* =========================
 * Geração do link no Pipefy (ao marcar checkbox)
 * =======================*/
app.post('/novo-pipe/criar-link-confirmacao', async (req, res) => {
  try {
    const cardId = req.body.cardId || req.body.card_id || req.query.cardId || req.query.card_id;
    if (!cardId) return res.status(400).json({ error: 'cardId é obrigatório' });

    const card = await getCard(cardId);
    if (NOVO_PIPE_ID && String(card?.pipe?.id)!==String(NOVO_PIPE_ID)) {
      return res.status(400).json({ error: 'Card não pertence ao pipe configurado' });
    }
    if (FASE_VISITA_ID && String(card?.current_phase?.id)!==String(FASE_VISITA_ID)) {
      return res.status(400).json({ error: 'Card não está na fase esperada' });
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
 * Checklist de ENV (EasyPanel)
 *
 * PUBLIC_BASE_URL=https://seu-dominio.com
 * PUBLIC_LINK_SECRET=um-segredo-forte
 *
 * PIPE_API_KEY=...
 * PIPE_GRAPHQL_ENDPOINT=https://api.pipefy.com/graphql
 *
 * # Campos/Tabelas
 * PIPEFY_FIELD_LINK_CONTRATO=d4_contrato
 * FIELD_ID_CONNECT_MARCA_NOME=marcas_1
 * FIELD_ID_CONNECT_CLASSE=marcas_2
 * FIELD_ID_CONNECT_CLASSES=classes_inpi
 * MARCAS_TABLE_ID=MmqLNaPk
 * CONTACTS_TABLE_ID=306505297
 * MARCAS2_TABLE_ID=tnDAtg7l
 * CLASSES_TABLE_ID=306521337
 *
 * # D4Sign
 * D4SIGN_TOKEN=...
 * D4SIGN_CRYPT_KEY=...
 * TEMPLATE_UUID_CONTRATO=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *
 * # Fases (opcional)
 * NOVO_PIPE_ID=306505295
 * FASE_VISITA_ID=339299691
 * PHASE_ID_CONTRATO_ENVIADO=XXXXXXXX
 *
 * # Assinatura
 * EMAIL_ASSINATURA_EMPRESA=contratos@empresa.com.br
 *
 * # Cofres
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
 * DEFAULT_COFRE_UUID=... (opcional)
 */
