# Decisões de Arquitetura SaaS

Este documento registra as decisões já aprovadas para a arquitetura SaaS da Lungo Corretores.

## Decisões principais

- Admin Master terá frontend e domínio separados.
- Corretor e Supervisor compartilham o mesmo frontend CRM.
- Supervisor também atua como corretor.
- Supervisor possui WhatsApp próprio e contas próprias de leads.
- Resultados do Supervisor entram nas métricas da corretora.
- Todos os clientes recebem negócios em fechamento como status inicial ou padrão.
- Admin controla planos, acessos e pagamentos.
- Supervisor controla apenas sua própria equipe e organização.
- Planos iniciais definidos:
  - Individual: R$ 25,90
  - Equipe: R$ 49,90
  - Corretora 10: R$ 149,90
  - Corretora 16: R$ 199,90
  - Corretora 20: R$ 239,90
- Acesso adicional: R$ 15,90 por usuário extra.
- Próximo vencimento:
  - 30 dias após pagamento
  - ou dia fixo 1, 5, 10, 15, 20 ou 25
- Produção não deve ser alterada antes de staging.
- `service_role` do Supabase nunca vai para o frontend.
- autenticação e autorização devem ficar no backend.

---

## Decisões operacionais

- Organização é o principal domínio para isolamento de dados.
- `organization_id` e `owner_user_id` são chaves centrais para segurança e separação.
- Todos os acessos financeiros e de plano são centralizados no Admin Master.
- Supervisores têm visibilidade de equipe, mas não de assinaturas ou faturamento.
- Corretores operam apenas seus dados próprios e não podem criar ou editar usuários de outros níveis.
- O backend deve garantir validação de limites antes de criar novos usuários ou recursos do tipo broker.

---

## Pendências

- definição de maturidade de suporte a multi-instância WhatsApp por organização.
- regras de transição de usuários entre organizações.
- detalhamento de quotas de métricas e limites em cada plano.
- política de cobrança por acesso adicional e plano compartilhado.
- estratégia de rollback completo em caso de falha de migração.
