# Prospecção — núcleo funcional de staging

Alvo operacional exclusivo: `hgqtanlzajogxrfbchrl`. Catálogo somente leitura:
`fmktrtyahaudefcymrvm.public.companies_v2`, competência `2026-08`, conforme o
processamento/importação existente. Não foi reaplicada nem alterada a migration.

## Endpoints

Atualização de 15/09/2026, ainda não publicada no backend de staging: pedido
`POST /api/prospecting/exports` com `{company_id}` (ID do direito de `Minhas
empresas`) e consulta `GET /api/prospecting/exports/:id`. O servidor verifica
propriedade, chama `prospecting_request_export` e um processador de staging
reivindica a outbox via `prospecting_claim_jobs`. O lead recebe ID determinístico
`prospecting_<export-id>` e referência ao direito; repetir a exportação reutiliza
o registro. Resultado ambíguo fica `unknown` para revisão. Nenhum contato do
navegador é aceito como fonte. O serviço deve ter uma única réplica enquanto
`Meus Leads` usar JSON local; os escritores legados assíncronos de marketplace e
atribuição foram tornados síncronos na seção de leitura/gravação do arquivo.

Todos exigem `requireAccess` para broker/supervisor e usam `req.accessUser.id`.
Respostas privadas com `Cache-Control: private, no-store`.

- `GET /api/prospecting/wallet`: retorna `{ok,wallet}` com free_balance,
  extra_balance, total_balance, cycle_start, next_renewal, cycle_allowance e timezone.
- `GET /api/prospecting/companies`: `{ok,companies,pagination,ownershipUnavailable}`.
  Filtros: state, category (parâmetro repetido), cnae (parâmetro repetido, sete
  dígitos), opened_year, company_size, page e limit (1..100; padrão 25).
  OR dentro de cada multisseleção; AND entre grupos. Cidade não é um filtro.
- `POST /api/prospecting/acquisitions`: corpo `{company_ids:[...],idempotency_key}`.
  Entre uma e 100 seleções; chave com 8..160 caracteres alfanuméricos, `_` ou `-`.
  Resposta: operation_id, acquired_ids, charged, already_owned, free_balance,
  extra_balance. Não retorna chaves de fonte ou dados fornecidos pelo navegador.
- `GET /api/prospecting/my-companies?page=1&limit=25`: somente direitos do usuário,
  12 campos do snapshot, id do direito, acquired_at e is_acquired.

O router próprio está em src/routes/prospecting.js; server.js somente importa e
registra o módulo. Serviço/adaptadores em src/modules/prospecting/.

## Tokens e snapshots

RPC prospecting_get_wallet faz renovação lazy/idempotente no dia 5, timezone
America/Sao_Paulo: broker 20, supervisor 100. Extras não expiram.
RPC prospecting_acquire cobra um token por empresa nova, gratuito antes de extra;
lote sem saldo é totalmente revertido. Direitos existentes não são cobrados.

O servidor resolve os IDs opacos, valida usuário/versão, busca novamente cada
empresa no catálogo e passa somente os 12 campos permitidos para a RPC. Ela cria
ou reutiliza o snapshot e registra o direito atomicamente. Não há importação em massa.
Falha após a RPC não provoca uma segunda escrita: o frontend atualiza leitura
separadamente e mantém a mesma chave em repetição de uma resposta inconclusiva.

## Privacidade e compatibilidade

Identificador cifrado AES-256-GCM, IV aleatório, AAD, vínculo ao usuário e versão,
validade de 15 minutos. A chave é derivada no servidor por HKDF-SHA256 da credencial
operacional já existente, com domínio exclusivo para esta finalidade. Nenhuma
credencial foi criada, alterada, rotacionada ou enviada ao browser. Não exige nova
variável secreta. Reinícios conservam a validade; eventual rotação administrativa
futura invalida IDs pendentes, sem alterar direitos adquiridos.

Não adquiridas recebem máscara integral dos contatos e CNPJ, sem valores completos
em IDs, campos desconhecidos ou objetos aninhados. Adquiridas usam o snapshot do
proprietário, não o contato atual de outra versão do catálogo.

As duas rotas antigas /api/business-intelligence/companies e /companies-v2 usam o
mesmo serviço de direitos e projeção. V1 conserva aliases phone_1/phone_2/city_name
e os campos legados explícitos. V1 não oferece identificador de compra: empresas
fora da V2 não podem ser adquiridas por essa rota. Falha operacional resulta em
máscara e seleção desabilitada. Falha de autenticação nunca libera contatos.

## Validação

`npm ci` e `npm test` (ou `node --test --test-isolation=none tests/*.test.js`).
23 testes passaram: regressões existentes e seis grupos novos de integração HTTP
com RPCs reais em PostgreSQL local (PGlite), sem acesso aos bancos remotos.
Cobrem os dois perfis, renovação, extras, filtros/multisseleção/paginação,
mascaramento/desbloqueio, aquisição individual/lote, idempotência, saldo insuficiente,
identidade forjada, isolamento de direitos, IDs inválidos/expirados e ambas as rotas antigas.
tests/fixtures/prospecting.sql é exclusivamente local; não executar esse fixture remotamente.

## Publicação

Somente branch staging. Backend requer deploy manual pelo proprietário no serviço
staging existente. Preservar SUPABASE_URL/SUPABASE_SECRET_KEY operacionais e
BUSINESS_INTELLIGENCE_SUPABASE_URL/BUSINESS_INTELLIGENCE_SUPABASE_KEY empresariais.
O módulo bloqueia uso de outro projeto operacional. Sem migration adicional.

Após o deploy manual, homologar acesso autenticado broker/supervisor nos quatro
endpoints e confirmar que as rotas V1/V2 também estão mascaradas. Até lá, o backend
publicado ainda executa a versão anterior. Não habilitar apenas a UI como controle
de acesso. Rollback da UI pode usar as rotas antigas protegidas; não reverter a
proteção backend para uma versão que entregue os contatos sem direitos.

Sem Admin de tokens, atribuição, atendimento, agendamento,
VOIP ou mudanças em outros fluxos. Nenhum deploy manual backend nesta entrega.
