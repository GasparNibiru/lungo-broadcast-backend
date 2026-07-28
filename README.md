# Lungo Broadcast Backend

Backend em Node.js para conectar a interface **Lungo Disparos** à **Evolution API** sem expor API Key no navegador.

## O que este backend faz

- Recebe o `ID de usuário` digitado na interface.
- Valida se esse ID está autorizado em `data/instances.json`.
- Traduz o ID para o nome real da instância da Evolution API.
- Verifica se a instância está conectada.
- Recebe planilha `.xlsx`, `.xls` ou `.csv`.
- Lê contatos e identifica números válidos, duplicados e inválidos.
- Envia mensagens pela Evolution API.
- Controla intervalo randômico entre mensagens.
- Permite parar uma campanha em andamento.
- Expõe status da campanha para a interface.
- Gera relatório CSV.

## Estrutura

```txt
lungo-broadcast-backend/
├── package.json
├── .env.example
├── README.md
├── data/
│   └── instances.example.json
├── src/
│   ├── server.js
│   ├── config.js
│   ├── errors.js
│   ├── store.js
│   ├── routes/
│   │   ├── campaigns.js
│   │   └── instances.js
│   ├── services/
│   │   ├── campaignRunner.js
│   │   └── evolution.js
│   └── utils/
│       └── contacts.js
└── storage/
    ├── uploads/
    └── reports/
```

## 1. Instalar

```bash
npm install
```

## 2. Configurar `.env`

Crie o arquivo `.env` a partir do exemplo:

```bash
cp .env.example .env
```

Edite:

```env
PORT=3333
ALLOWED_ORIGINS=https://SEU-SITE-NETLIFY.netlify.app
EVOLUTION_BASE_URL=https://SUA-EVOLUTION-API.com.br
EVOLUTION_API_KEY=SUA_API_KEY_GLOBAL
```

Para teste local, pode usar:

```env
ALLOWED_ORIGINS=*
```

## 3. Autorizar IDs de usuário

Copie o arquivo de exemplo:

```bash
cp data/instances.example.json data/instances.json
```

Edite `data/instances.json`:

```json
[
  {
    "userId": "multplanos01",
    "instanceName": "multplanos01",
    "clientName": "Multi Planos",
    "enabled": true,
    "maxContactsPerCampaign": 5000,
    "minDelayMs": 8000,
    "maxDelayMs": 25000
  }
]
```

O usuário digita apenas:

```txt
multplanos01
```

O backend usa internamente:

```txt
instanceName: multplanos01
```

Se quiser que o ID seja diferente do nome da instância, use assim:

```json
{
  "userId": "cliente-lx-2026",
  "instanceName": "lxplanos",
  "clientName": "LX Planos",
  "enabled": true,
  "maxContactsPerCampaign": 3000,
  "minDelayMs": 10000,
  "maxDelayMs": 35000
}
```

## 4. Rodar localmente

```bash
npm run dev
```

ou:

```bash
npm start
```

Teste:

```bash
curl http://localhost:3333/health
```

## 5. Subir no servidor com PM2

```bash
npm install --omit=dev
npm install -g pm2
pm2 start src/server.js --name lungo-broadcast-api
pm2 save
```

A API ficará em:

```txt
http://SEU-SERVIDOR:3333
```

O ideal é colocar um proxy/SSL, por exemplo:

```txt
https://api-disparos.seudominio.com.br
```

## 6. Endpoints

### Health

```http
GET /health
```

### Validar ID de usuário

```http
POST /api/instances/validate
Content-Type: application/json

{
  "userId": "multplanos01"
}
```

### Iniciar campanha

Envie como `multipart/form-data`:

```http
POST /api/campaigns/start
```

Campos:

| Campo | Tipo | Obrigatório |
|---|---|---|
| userId | texto | sim |
| message | texto | sim |
| file | arquivo | sim |

Exemplo com curl:

```bash
curl -X POST http://localhost:3333/api/campaigns/start \
  -F "userId=multplanos01" \
  -F "message=Olá, {nome}! Tudo bem?" \
  -F "file=@contatos.xlsx"
```

### Ver status

```http
GET /api/campaigns/{campaignId}/status
```

### Parar envios

```http
POST /api/campaigns/{campaignId}/stop
```

### Baixar relatório

```http
GET /api/campaigns/{campaignId}/report.csv
```

## 7. Formato da planilha

Colunas recomendadas:

| nome | telefone | observacao |
|---|---|---|
| Maria Silva | 5555999999999 | Cliente interessado |

A coluna de telefone pode se chamar:

- telefone
- whatsapp
- celular
- numero
- número
- phone
- contato

Use número com DDI + DDD + telefone:

```txt
5555999999999
```

## 8. Variáveis na mensagem

Você pode usar colunas da planilha dentro da mensagem:

```txt
Olá, {nome}! Tudo bem?
```

Se a planilha tiver uma coluna chamada `cidade`, pode usar:

```txt
Olá, {nome}! Temos novidades para clientes de {cidade}.
```

## 9. Segurança

Nunca coloque sua `EVOLUTION_API_KEY` no front-end.

A interface deve chamar somente este backend. O backend chama a Evolution API por trás.

## 10. Observação importante

Esta versão usa fila em memória. Funciona bem para a primeira versão, mas se o servidor reiniciar durante uma campanha, a campanha é interrompida.

Para uma versão mais robusta, a próxima etapa é adicionar:

- banco PostgreSQL/Supabase;
- fila com BullMQ + Redis;
- login/admin;
- histórico persistente;
- relatórios por cliente.
