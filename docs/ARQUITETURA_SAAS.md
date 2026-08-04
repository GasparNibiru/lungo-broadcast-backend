# Arquitetura SaaS Lungo Corretores

## Visão geral

A arquitetura SaaS é baseada em um backend compartilhado que atende múltiplas organizações (corretoras e contas individuais) e em dois frontends principais:

- **Frontend CRM**: usado por Corretor e Supervisor
- **Frontend Admin**: usado por Admin Master

O backend centraliza autenticação, autorização, gerenciamento de organizações, assinaturas, leads, clientes e integração com Evolution API.

---

## Componentes principais

### Frontend CRM

Perfis suportados:
- **Corretor**
- **Supervisor**

Funcionalidades:
- acesso a leads e clientes próprios
- uso de instância WhatsApp própria
- disparos e pós-venda
- documentos e vendas
- métricas e funil (Supervisor)

### Frontend Admin

Perfis suportados:
- **Admin Master**

Funcionalidades:
- gerenciamento de organizações e corretoras
- criação de supervisores e corretores
- definição de planos e limites
- controle de pagamentos e assinaturas
- acesso financeiro e auditoria

### Backend compartilhado

O backend contém os módulos comuns a todas as organizações:

- autenticação
- permissões
- organizações
- usuários
- assinaturas
- acessos e tokens
- leads
- clientes
- produtos
- documentos
- pagamentos
- vendas
- mensagens internas
- Evolution API

---

## Hierarquia de perfis

```text
Admin Master
  ├─ cria organizações (corretoras e contas individuais)
  ├─ cria supervisores
  ├─ cria corretores individuais
  ├─ define plano e limite
  ├─ controla pagamento e assinatura
  └─ administra usuários e acessos

Supervisor
  ├─ pertence a uma corretora
  ├─ também atua como corretor
  ├─ cria corretores até o limite contratado
  ├─ vê métricas da equipe
  ├─ vê funil da equipe
  ├─ vê todos os clientes da equipe
  ├─ administra metas
  ├─ usa WhatsApp próprio
  └─ usa leads próprios

Corretor
  ├─ pertence a uma corretora ou conta individual
  ├─ vê apenas seus próprios leads
  ├─ vê apenas seus próprios clientes
  ├─ usa sua própria instância WhatsApp
  ├─ usa disparos
  ├─ usa pós-venda
  └─ usa documentos
```

---

## Fluxo de relacionamento

- **Admin Master** administra o ecossistema: cria organizações, define planos, limites e controla pagamentos.
- **Organizações** representam corretoras ou contas individuais e são isoladas por `organization_id`.
- **Supervisor** e **Corretor** estão vinculados a uma organização.
- **Supervisor** mantém funções de equipe e também opera como corretor.
- **Corretor** trabalha com leads, clientes, produtos e documentos na sua própria organização.

---

## Integração Evolution API

O backend deve preservar a integração existente com a **Evolution API** como fonte de dados e webhook.

Pontos de atenção:
- Evolution API permanece inalterada nesta fase.
- O backend compartilha acesso a dados de evolução e atualiza leads/clientes conforme eventos.
- Webhooks devem ser validados e armazenados com seção de auditoria própria.

---

## Principais interfaces

- **Admin Master**: painel administrativo para gestão de organizações, planos, assinaturas e relatórios financeiros.
- **Supervisor/Corretor**: CRM com acesso a leads, clientes, funil, mensagens e pós-venda.
- **Backend**: serviço comum com autorização forte, isolamento por organização e suporte a múltiplos planos.

---

## Resumo arquitetural

A arquitetura proposta combina:
- backend multi-tenant com isolamento lógico por organização;
- frontend CRM unificado para corretores e supervisores;
- frontend Admin dedicado ao Admin Master;
- controle centralizado de assinaturas, limites e pagamentos;
- preservação da base atual e da integração Evolution API.
