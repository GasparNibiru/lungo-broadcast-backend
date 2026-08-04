# Modelo de Dados Inicial

Este documento propõe as tabelas iniciais para a arquitetura SaaS.

## organizations

- **Finalidade**: representa corretoras e contas individuais.
- **Campos principais**:
  - id
  - name
  - logo_url
  - status
  - owner_user_id
  - plan_id
  - limit_brokers
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `owner_user_id` → `users.id`
  - `plan_id` → `plans.id`
- **Índices importantes**:
  - `name`
  - `status`
  - `plan_id`
- **Campos de auditoria**:
  - created_at
  - updated_at
- **Status possíveis**: active, suspended, cancelled, pending

## users

- **Finalidade**: armazena todos os usuários do sistema.
- **Campos principais**:
  - id
  - organization_id
  - role
  - name
  - email
  - phone
  - password_hash
  - auth_provider_id
  - status
  - last_login_at
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `role` → `roles.code`
- **Índices importantes**:
  - `email` (único)
  - `organization_id`
  - `status`
- **Campos de auditoria**:
  - created_at
  - updated_at
  - last_login_at
- **Status possíveis**: active, inactive, pending, blocked

## roles

- **Finalidade**: define perfis e permissões.
- **Campos principais**:
  - id
  - code
  - name
  - description
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `code` usado em `users.role`
- **Índices importantes**:
  - `code` (único)
- **Campos de auditoria**:
  - created_at
  - updated_at
- **Status possíveis**: active, inactive

## subscriptions

- **Finalidade**: controle de assinaturas por organização.
- **Campos principais**:
  - id
  - organization_id
  - plan_id
  - status
  - base_price
  - extra_accesses
  - extra_access_price
  - total_price
  - started_at
  - next_due_date
  - due_mode
  - fixed_due_day
  - legacy
  - suspended_at
  - cancelled_at
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `plan_id` → `plans.id`
- **Índices importantes**:
  - `organization_id`
  - `status`
  - `next_due_date`
- **Campos de auditoria**:
  - created_at
  - updated_at
  - suspended_at
  - cancelled_at
- **Status possíveis**: active, trial, past_due, suspended, cancelled, expired

## plans

- **Finalidade**: descreve os planos comerciais.
- **Campos principais**:
  - id
  - code
  - name
  - price
  - included_supervisors
  - included_brokers
  - allows_master
  - active
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `id` referenciado em `subscriptions.plan_id`
- **Índices importantes**:
  - `code` (único)
  - `active`
- **Campos de auditoria**:
  - created_at
  - updated_at
- **Status possíveis**: active, inactive

## access_tokens

- **Finalidade**: controle de sessões e tokens de API.
- **Campos principais**:
  - id
  - user_id
  - token_hash
  - status
  - expires_at
  - last_used_at
  - created_at
  - revoked_at
- **Chave primária**: id
- **Relacionamentos**:
  - `user_id` → `users.id`
- **Índices importantes**:
  - `user_id`
  - `token_hash` (único)
  - `status`
- **Campos de auditoria**:
  - created_at
  - last_used_at
  - revoked_at
- **Status possíveis**: active, revoked, expired, blocked

## whatsapp_instances

- **Finalidade**: registra instâncias de WhatsApp associadas a usuários.
- **Campos principais**:
  - id
  - organization_id
  - user_id
  - phone_number
  - instance_key
  - status
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `user_id` → `users.id`
- **Índices importantes**:
  - `organization_id`
  - `user_id`
  - `phone_number`
- **Campos de auditoria**:
  - created_at
  - updated_at
- **Status possíveis**: active, inactive, disconnected, pending

## leads

- **Finalidade**: representa oportunidades de venda originadas por corretores ou supervisores.
- **Campos principais**:
  - id
  - organization_id
  - owner_user_id
  - name
  - phone
  - email
  - person_type
  - document_number
  - lives_count
  - business_value
  - product_interest
  - city
  - status
  - source
  - notes
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `owner_user_id` → `users.id`
  - `source_lead_id` opcional → `leads.id`
- **Índices importantes**:
  - `organization_id`
  - `owner_user_id`
  - `status`
  - `document_number`
- **Campos de auditoria**:
  - created_at
  - updated_at
- **Status possíveis**: new, contacted, qualified, proposal, lost, won, archived

## clients

- **Finalidade**: clientes convertidos a partir de leads ou cadastrados diretamente.
- **Campos principais**:
  - id
  - organization_id
  - owner_user_id
  - source_lead_id
  - name
  - phone
  - email
  - document_number
  - city
  - status
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `owner_user_id` → `users.id`
  - `source_lead_id` → `leads.id`
- **Índices importantes**:
  - `organization_id`
  - `owner_user_id`
  - `document_number`
  - `status`
- **Campos de auditoria**:
  - created_at
  - updated_at
- **Status possíveis**: active, inactive, prospect, customer, lost

## client_products

- **Finalidade**: produtos vinculados a clientes.
- **Campos principais**:
  - id
  - client_id
  - organization_id
  - owner_user_id
  - product_name
  - product_code
  - coverage
  - premium_value
  - status
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `client_id` → `clients.id`
  - `organization_id` → `organizations.id`
  - `owner_user_id` → `users.id`
- **Índices importantes**:
  - `client_id`
  - `organization_id`
  - `product_code`
- **Campos de auditoria**:
  - created_at
  - updated_at
- **Status possíveis**: active, pending, cancelled, expired

## documents

- **Finalidade**: arquivos e documentos relacionados a clientes e produtos.
- **Campos principais**:
  - id
  - organization_id
  - owner_user_id
  - client_id
  - lead_id
  - document_type
  - file_url
  - file_name
  - mime_type
  - status
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `owner_user_id` → `users.id`
  - `client_id` → `clients.id`
  - `lead_id` → `leads.id`
- **Índices importantes**:
  - `organization_id`
  - `client_id`
  - `lead_id`
  - `document_type`
- **Campos de auditoria**:
  - created_at
  - updated_at
- **Status possíveis**: uploaded, verified, rejected, archived

## sales

- **Finalidade**: registros de operações de venda.
- **Campos principais**:
  - id
  - organization_id
  - owner_user_id
  - client_id
  - lead_id
  - product_id
  - amount
  - commission
  - status
  - closed_at
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `owner_user_id` → `users.id`
  - `client_id` → `clients.id`
  - `lead_id` → `leads.id`
  - `product_id` → `client_products.id`
- **Índices importantes**:
  - `organization_id`
  - `owner_user_id`
  - `status`
  - `closed_at`
- **Campos de auditoria**:
  - created_at
  - updated_at
  - closed_at
- **Status possíveis**: draft, pending, won, lost, cancelled

## payments

- **Finalidade**: pagamentos de assinaturas ou comissões.
- **Campos principais**:
  - id
  - subscription_id
  - competence
  - due_date
  - expected_amount
  - paid_amount
  - paid_at
  - status
  - payment_method
  - notes
  - created_at
  - updated_at
- **Chave primária**: id
- **Relacionamentos**:
  - `subscription_id` → `subscriptions.id`
- **Índices importantes**:
  - `subscription_id`
  - `due_date`
  - `status`
- **Campos de auditoria**:
  - created_at
  - updated_at
  - paid_at
- **Status possíveis**: pending, paid, failed, overdue, cancelled

## payment_history

- **Finalidade**: histórico de eventos de pagamento.
- **Campos principais**:
  - id
  - payment_id
  - subscription_id
  - event_type
  - amount
  - created_at
  - notes
- **Chave primária**: id
- **Relacionamentos**:
  - `payment_id` → `payments.id`
  - `subscription_id` → `subscriptions.id`
- **Índices importantes**:
  - `payment_id`
  - `subscription_id`
  - `event_type`
- **Campos de auditoria**:
  - created_at
- **Status possíveis**: recorded, corrected, disputed

## internal_messages

- **Finalidade**: mensagens internas entre usuários da mesma organização.
- **Campos principais**:
  - id
  - organization_id
  - sender_user_id
  - recipient_user_id
  - subject
  - body
  - status
  - created_at
  - read_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `sender_user_id` → `users.id`
  - `recipient_user_id` → `users.id`
- **Índices importantes**:
  - `organization_id`
  - `recipient_user_id`
  - `status`
- **Campos de auditoria**:
  - created_at
  - read_at
- **Status possíveis**: sent, read, archived, deleted

## audit_logs

- **Finalidade**: registrar mudanças importantes e eventos de segurança.
- **Campos principais**:
  - id
  - organization_id
  - user_id
  - entity_type
  - entity_id
  - action
  - details
  - ip_address
  - user_agent
  - created_at
- **Chave primária**: id
- **Relacionamentos**:
  - `organization_id` → `organizations.id`
  - `user_id` → `users.id`
- **Índices importantes**:
  - `organization_id`
  - `user_id`
  - `entity_type`
  - `action`
- **Campos de auditoria**:
  - created_at
- **Status possíveis**: registered (normalmente não há status dinâmico)
