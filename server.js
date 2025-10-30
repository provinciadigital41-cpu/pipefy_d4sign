
import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json({ limit: '1mb' }));

const {
  PORT = 3000,
  PIPE_API_KEY,
  PIPE_GRAPHQL_ENDPOINT = 'https://api.pipefy.com/graphql',
  D4SIGN_CRYPT_KEY,
  D4SIGN_TOKEN,
  TEMPLATE_UUID_CONTRATO,
  PHASE_ID_PROPOSTA,
  PHASE_ID_CONTRATO_ENVIADO,
  COFRE_UUID_LUCAS,
  COFRE_UUID_MARIA,
  COFRE_UUID_JOAO
} = process.env;

// ====== SUBSTITUA PELOS IDS REAIS DOS SEUS CAMPOS DO PIPEFY ======
const FIELD_ID_CHECKBOX_DISPARO = 'checkbox_disparo'; // Ex.: "campo_checkbox_123"
const FIELD_ID_LINKS_D4 = 'link_documentos_d4'; // Ex.: "campo_link_456"
// =================================================================

const COFRES_UUIDS = {
  'Lucas Santos': COFRE_UUID_LUCAS,
  'Maria Lima': COFRE_UUID_MARIA,
  'João Silva': COFRE_UUID_JOAO
};

const CARD_Q = `
query($cardId: ID!) {
  card(id: $cardId) {
    id title assignees { name } current_phase { id name }
    fields { name value report_value field { id internal_id }}
  }
}`;

const SET_FIELD_Q = `
mutation($input: SetFieldValueInput!) {
  setFieldValue(input: $input) { card { id } }
}`;

const MOVE_CARD_Q = `
mutation($input: MoveCardToPhaseInput!) {
  moveCardToPhase(input: $input) { card { id current_phase { id name } } }
}`;

async function gql(query, vars) {
  const res = await fetch(PIPE_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PIPE_API_KEY}` },
    body: JSON.stringify({ query, variables: vars })
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || res.statusText));
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
    cnpj: getField(f, 'cnpj'),
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

async function criarDocumentoD4(token, cryptKey, uuidTemplate, title, add, signers, cofreUuid) {
  const url = `https://api.d4sign.com.br/api/v1/documents/${uuidTemplate}/templates`;

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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'tokenAPI': token,
      'cryptKey': cryptKey
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok || !Array.isArray(data) || !data[0]?.uuid_document)
    throw new Error(`Erro D4Sign: ${res.status}`);

  return data[0].uuid_document;
}

app.post('/pipefy', async (req, res) => {
  const cardId = req.body?.data?.action?.card?.id;
  if (!cardId) return res.status(400).json({ error: 'Sem cardId' });

  try {
    const data = await gql(CARD_Q, { cardId });
    const card = data.card;
    const f = card.fields || [];

    // Opcional: garantir que estamos na fase Proposta
    // const currentPhaseId = card.current_phase?.id;
    // if (currentPhaseId !== PHASE_ID_PROPOSTA) return res.status(200).json({ ok: true, message: 'Fora da fase Proposta' });

    const disparo = getField(f, FIELD_ID_CHECKBOX_DISPARO);
    if (!disparo) return res.status(200).json({ ok: true, message: 'Checkbox não marcado' });

    const dados = montarDados(card);
    const add = montarADD(dados);
    const signers = montarSigners(dados);

    const cofreUuid = COFRES_UUIDS[dados.vendedor];
    if (!cofreUuid) throw new Error(`Cofre não configurado para vendedor: ${dados.vendedor}`);

    const d4uuid = await criarDocumentoD4(D4SIGN_TOKEN, D4SIGN_CRYPT_KEY, TEMPLATE_UUID_CONTRATO, card.title, add, signers, cofreUuid);

    const link = `https://secure.d4sign.com.br/Plus/${d4uuid}`;
    await gql(SET_FIELD_Q, { input: { card_id: card.id, field_id: FIELD_ID_LINKS_D4, value: link } });
    await gql(MOVE_CARD_Q, { input: { card_id: card.id, destination_phase_id: PHASE_ID_CONTRATO_ENVIADO } });

    return res.json({ ok: true, d4uuid });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
