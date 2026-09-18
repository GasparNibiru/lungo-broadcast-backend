# Agente de IA — implantação somente em staging

## Atualização Multirramos — 18/09/2026

O atendimento de saúde e a interface compacta já foram homologados pelo
proprietário. A migration original já foi aplicada. As instruções de primeira
implantação abaixo são históricas: **não repetir migration, chaves ou pareamento**.

Esta atualização exige apenas reimplantar o backend da branch staging no
EasyPanel. O frontend habilita a seleção quando a API anuncia os dois tipos.
O supervisor pausa, escolhe o roteiro, salva e reativa o agente.

- Planos de saúde mantém o roteiro existente; contas antigas usam esse padrão.
- Multirramos adapta o prompt do arquivo VSeg - Van IA (1).json: Auto,
  Residencial, Consórcio, Viagem, Vida e Saúde, com perguntas e resumo por ramo.
- Nome, corretora e destinatário substituem os nomes fixos do fluxo n8n.
  Não há transferência automática para outra instância: o responsável recebe
  o resumo e contata o lead pelo próprio WhatsApp.
- Mesmo gpt-4o-mini, WhatsApp dedicado e regras de créditos. Um tipo ativo
  por corretora. Conversas em andamento mantêm o roteiro anterior até concluir.
- Tipo e estado ficam nos campos JSON existentes; nenhuma mudança de schema.
- Validação automatizada com APIs simuladas; atendimento real multirramos ainda
  depende da homologação do proprietário após o deploy.

## Escopo implementado

Um agente por organização, acessível apenas ao supervisor. WhatsApp próprio, sem
reutilizar a instância do CRM. Nome, informações da corretora e destinatário do
resumo são editáveis; prompt e modelo `gpt-4o-mini` ficam no servidor.

Roteiro adaptado do JSON Prime Solutions / Eduarda fornecido pelo proprietário.
Não depende de n8n. Atende texto e legendas; não transcreve áudio nem interpreta
documentos. Ao concluir, envia o resumo ao cliente e ao número configurado.
O responsável entra em contato com o lead por conta própria.

## Créditos

- Primeira ativação: 100 créditos. Renovação na data mensal da ativação, com
  ajuste de fim de mês, sem acumular franquia. Créditos extras não expiram.
- Inteiros no banco: 10 unidades = 1 crédito; uma resposta confirmada consome
  uma unidade. Franquia gratuita antes do saldo comprado.
- Reserva antes da chamada de IA; falha anterior ao envio libera a reserva.
- Resumo ao responsável não consome crédito e não chama o modelo novamente.
- Pacotes: 300/R$50, 500/R$75, 1000/R$100. Link de compra: WhatsApp
  `5555992102864` (Brasil + DDD 55 + 99210-2864).
- Recargas manuais autenticadas pelo Admin, com referência, histórico e
  identificador de idempotência. Nenhuma confirmação de pagamento automática.
- Contador técnico de tokens fica no resultado do job; não altera a equivalência
  de créditos. Histórico enviado ao modelo limitado a 16.000 caracteres,
  entrada a 4.000 caracteres e geração a 1.500 tokens por resposta.

## Primeira implantação — histórico já concluído

1. Aplicar **somente** `supabase/migrations/20260919010000_supervisor_ai_agent.sql`
   no Supabase operacional de staging `hgqtanlzajogxrfbchrl`. Não executar o
   diretório inteiro de migrations; Financeiro e Prospecção já estão aplicados.
   A migration nova cria cinco tabelas `ai_*`, quatro funções, índices e RLS.
2. No backend de staging do EasyPanel, configurar:
   - `OPENAI_API_KEY`: chave do projeto OpenAI, somente no servidor.
   - `AI_AGENT_WEBHOOK_SECRET`: segredo novo aleatório, pelo menos 32 bytes.
   - `AI_AGENT_PUBLIC_URL=https://lungo-lungo-backend-staging.dzpywk.easypanel.host`
   - `AI_AGENT_ENABLED=true` após aplicar a migration.
   - Reutilizar `EVOLUTION_BASE_URL` e `EVOLUTION_API_KEY` existentes.
   Preservar APP_ENV/NODE_ENV staging e o Supabase operacional de staging.
3. Implantar manualmente o backend da branch `staging` no EasyPanel.
4. No frontend de staging: supervisor salva configuração, conecta um WhatsApp
   **dedicado**, ativa e faz um atendimento de homologação autorizado.
5. Conferir identidade do agente, perguntas, destinatário, dois resumos, débito
   de 0,1 por resposta, consumo gratuito antes do comprado, pausa e recarga.
   Repetir a entrega do mesmo evento deve manter um único envio/débito.

Não usar números de clientes reais durante a homologação. Não promover para
produção neste trabalho. QR e envio real dependem da versão instalada do Evolution
e ainda precisam dessa homologação; testes locais usam provedores simulados.

## Falhas e operação

Fila persistida no banco, com uma tarefa por organização de cada vez. Webhook
autenticado por segredo HMAC da organização, configurado no header
`x-agent-secret` da instância dedicada. Ignora grupos, mensagens da própria
instância e conversas com o destinatário de resumos. Identificadores `@lid`
exigem um número alternativo válido no evento, nunca são tratados como telefone.

Timeout após início do envio ou interrupção do worker gera `uncertain`. A carteira
mantém a reserva e a organização aguarda conferência; não há reenvio automático.
O Admin confere a conversa no WhatsApp e marca enviado (confirma débito e resumo)
ou não enviado (libera reserva). Uma resposta com falha não é reenviada por essa
ação; o próximo contato inicia outra resposta. Eventos de texto em fila expiram
após 24 horas, evitando resposta atrasada após uma renovação. Sem saldo, novas
mensagens não são enfileiradas. Pausa mantém a conexão mas interrompe respostas.

Franquia tem renovação lazy no acesso/consumo. Não exige cron. Recursos protegidos
por autenticação de supervisor/Admin e RLS sem acesso direto de anon/authenticated.

## Fontes de integração verificadas

- https://developers.openai.com/api/docs/models/gpt-4o-mini
- https://developers.openai.com/api/docs/guides/structured-outputs
- Evolution: `src/api/integrations/event/webhook/webhook.schema.ts` no repositório
  oficial EvolutionAPI/evolution-api, campos `headers`, `byEvents`, `base64`.

## Validação local

`node --test tests/*.test.js`; testes `ai-agent.test.js` exercitam schema/RPCs em
PostgreSQL via PGlite, renovação, saldo, repetição de recarga, reserva, débito,
refund, outbox, isolamento, RLS e falhas dos provedores simulados.
Frontend: fluxo de configuração/conexão/pausa, recarga Admin, limpeza no logout,
erro de backend indisponível e 10 variantes de viewport/tema no Chrome.

Nenhuma chamada paga à OpenAI, mensagem real, conexão Evolution ou aplicação
remota da migration foi feita durante o desenvolvimento local.
