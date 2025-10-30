
# Pipefy → D4Sign (cofres por vendedor)

## Arquivos
- `server.js` — servidor Express que recebe o webhook, cria o documento no cofre do vendedor e move o card.
- `package.json` — dependências.
- `Dockerfile` — build do container.

## Variáveis de ambiente (.env no EasyPanel)
```
PORT=3000
PIPE_API_KEY=...
PIPE_GRAPHQL_ENDPOINT=https://api.pipefy.com/graphql

D4SIGN_CRYPT_KEY=...
D4SIGN_TOKEN=...
TEMPLATE_UUID_CONTRATO=...
PHASE_ID_PROPOSTA=...
PHASE_ID_CONTRATO_ENVIADO=...

# UUIDs dos cofres por vendedor
COFRE_UUID_LUCAS=...
COFRE_UUID_MARIA=...
COFRE_UUID_JOAO=...
```

### Substitua no código (server.js)
```js
const FIELD_ID_CHECKBOX_DISPARO = 'checkbox_disparo';
const FIELD_ID_LINKS_D4 = 'link_documentos_d4';
```
Coloque os **IDs reais** dos campos do seu Pipefy.

### Mapear vendedores → cofres
Em `COFRES_UUIDS` ajuste os nomes dos assignees e as variáveis correspondentes.

## EasyPanel
1. Serviços → Aplicativo → Dockerfile
2. Build context: pasta do projeto
3. Porta interna: 3000
4. Domínio e TLS: aponte para `/pipefy`
5. Healthcheck: `/health`
6. Variáveis: cole o conteúdo do .env acima
7. Deploy e teste
