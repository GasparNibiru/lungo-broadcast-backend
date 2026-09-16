# Prospecção — candidata de produção, revisão antes de publicar

Preparada em 15/09/2026 sobre `origin/main` do backend. Não houve escrita no
Supabase de produção, deploy de backend ou publicação do frontend de produção.
Frontend candidato preparado separadamente sobre `origin/main`, preservando
`config.js` com `https://lungo-disparos-app.dzpywk.easypanel.host`.

## Escopo

O núcleo de staging homologado (carteira 20/100, busca mascarada, aquisição
idempotente, direitos, Minhas empresas, proteção V1/V2) e `Enviar para Meus
Leads`. O processador de exportação opera também em produção após a migration,
mas o serviço de Prospecção aceita `SUPABASE_URL` apenas do projeto operacional
esperado para `APP_ENV`/`NODE_ENV`: staging `hgqtanlzajogxrfbchrl`, produção
`bnceclhjhgjfirubudwi`. O catálogo empresarial continua no projeto
`fmktrtyahaudefcymrvm`, somente leitura.

## Migration candidata

`migration.candidate.sql` é uma cópia funcional do SQL aplicado em staging em
10/09/2026, com cabeçalho próprio de produção. Ela ainda **não** foi movida para
`supabase/migrations` para evitar execução acidental. Antes de aprovar:

1. Confirmar por conexão autenticada de leitura que o projeto operacional é
   exatamente `bnceclhjhgjfirubudwi` e obter o estado atual de migrations.
   `PRODUCTION_SCHEMA_AUDIT.sql` é uma consulta somente de metadados para essa
   conferência; o próprio SQL Editor deve estar aberto no projeto correto.
2. Auditar no banco real as tabelas `public.users` e `public.organizations`,
   tipos de `id`, `organization_id`, `role` e `status`, FKs, privilégios e
   existência prévia de qualquer objeto `prospecting_*`.
3. Comparar esse resultado com a auditoria que sustentou a aplicação em staging.
   Qualquer divergência exige SQL de produção revisado e novos testes.
4. Validar capacidade e janela de lock. A candidata usa transação e
   `lock_timeout = 5s`; uma falha deve preservar o esquema anterior.

Não copiar dados de staging nem reexecutar a migration no projeto de staging.

## Ordem de implantação proposta

1. Aplicar somente a migration aprovada no Supabase operacional de produção e
   validar tabelas/RPCs/RLS sem criar compras de teste desnecessárias.
2. Confirmar no serviço EasyPanel do backend de produção `APP_ENV` e `NODE_ENV`
   como `production`, URL do Supabase operacional de produção e as variáveis
   empresariais. Não enviar valores secretos pelo chat.
3. Implantar manualmente o backend de produção da branch/commit aprovado.
   Verificar `/health`, quatro endpoints de Prospecção, duas rotas V1/V2,
   autenticação, máscara, franquia e idempotência antes de publicar a UI.
4. Publicar o frontend de produção pela branch GitHub vinculada à Netlify,
   preservando `config.js` de produção. Validar os perfis, visual e exportação
   para Meus Leads. Não transferir uma instância WhatsApp de staging.

Enquanto `Meus Leads` usar `leads.json`, manter uma única réplica do backend com
o volume persistente de produção. Resultado ambíguo de exportação fica
`unknown` para reconciliação; não executar retry cego. Rollback de frontend
pode voltar à interface antiga, mas o backend não deve voltar a uma versão que
exponha contatos sem direitos. A migration contém direitos e extratos permanentes;
não revertê-la automaticamente após compras reais.

## Validação já realizada na candidata de código

`npm ci --offline --ignore-scripts`; 30 testes backend aprovados. O frontend
candidato passou três testes estruturais e 24 grupos Playwright (interceptando
API sintética), inclusive exportação e layouts claro/escuro/mobile. Esses
testes não substituem a auditoria do banco de produção nem a homologação HTTP
autenticada após deploy.
