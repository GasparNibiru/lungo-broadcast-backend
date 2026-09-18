# Implantação do Agente de IA em produção

O proprietário aprovou saúde, Multirramos e interface no staging e autorizou
produção em 18/09/2026. Esta autorização substitui a restrição histórica do guia
AI_AGENT_STAGING.md. Somente os commits de Marketing/IA foram promovidos sobre
main; configurações e correções específicas de produção foram preservadas.

## Banco de produção

No SQL Editor do Supabase operacional **bnceclhjhgjfirubudwi**, executar uma vez
MIGRACAO_AGENTE_IA_PRODUCAO.sql, preparado na raiz do workspace.
O arquivo usa transação e interrompe se as tabelas de IA já existirem.
É a migration nova 20260919010000_supervisor_ai_agent.sql. Não reaplicar
Financeiro, Prospecção ou a migration no staging já homologado. Não importar
carteiras, conversas, agentes ou instâncias de teste para produção.

## EasyPanel — backend de produção

Preservar Supabase, Evolution, APP_ENV/NODE_ENV e demais variáveis de produção.
Adicionar no serviço de produção, sem expor os valores no chat:

- OPENAI_API_KEY: chave OpenAI no servidor.
- AI_AGENT_WEBHOOK_SECRET: segredo aleatório exclusivo de produção (32 bytes ou mais).
- AI_AGENT_PUBLIC_URL=https://lungo-disparos-app.dzpywk.easypanel.host
- AI_AGENT_ENABLED=true (somente depois da migration).
- EVOLUTION_BASE_URL e EVOLUTION_API_KEY: manter os valores de produção existentes.

Implantar o backend usando a branch **main**, após aplicar o SQL e salvar as
variáveis. Frontend de produção também usa main e mantém a API de produção.

## Primeiro uso

Cada supervisor configura seu agente em produção, informa outro WhatsApp para
receber os resumos, conecta um número dedicado e ativa quando estiver pronto.
Nenhum agente é ativado nem saldo concedido pela promoção de código.
Não reutilizar simultaneamente o WhatsApp que atende no staging.

## Verificação

52 testes backend (incluindo isolamento de produção), cinco frontend e navegador
com APIs simuladas. Verificação HTTP pública confirma somente disponibilidade e
autenticação; não comprova migration, chave funcional ou entrega real.

Sem acesso direto ao SQL Editor ou ao EasyPanel nesta sessão: aplicação do SQL,
variáveis e deploy backend precisam ser feitos pelo proprietário.
