# Matriz de Permissões SaaS

## Papéis principais

- `admin_master`
- `supervisor`
- `broker`

---

## Permissões por papel

| Ação | admin_master | supervisor | broker |
|---|---|---|---|
| criar organização | ✅ | ❌ | ❌ |
| criar supervisor | ✅ | ❌ | ❌ |
| criar corretor individual | ✅ | ✅ (dentro do limite) | ❌ |
| alterar plano | ✅ | ❌ | ❌ |
| definir limite | ✅ | ❌ | ❌ |
| suspender assinatura | ✅ | ❌ | ❌ |
| reativar assinatura | ✅ | ❌ | ❌ |
| gerar/revogar token | ✅ | ✅ (próprio) | ❌ |
| ver dados financeiros | ✅ | ❌ | ❌ |
| ver cadastros | ✅ | ✅ | ✅ |
| ver métricas da equipe | ✅ | ✅ | ❌ |
| ver funil da equipe | ✅ | ✅ | ❌ |
| ver clientes da organização | ✅ | ✅ | ❌ |
| editar clientes da própria organização | ✅ | ✅ | ✅ (próprio) |
| enviar mensagens internas | ✅ | ✅ | ✅ |
| operar leads próprios | ✅ | ✅ | ✅ |
| criar usuários | ✅ | ❌ | ❌ |
| alterar plano contratado | ✅ | ❌ | ❌ |
| usar instância WhatsApp própria | ✅ | ✅ | ✅ |
| acessar dados financeiros da assinatura | ✅ | ❌ | ❌ |

---

## Detalhamento por papel

### Admin Master

- criar organização
- criar supervisor
- criar corretor individual
- alterar plano
- definir limite
- suspender/reativar assinatura
- gerar e revogar tokens
- ver dados financeiros e relatórios
- ver todos os cadastros da organização
- não deve operar leads dos clientes por padrão

### Supervisor

- pertence a uma corretora
- também atua como corretor
- criar corretores da própria organização até o limite contratado
- ver métricas da própria organização
- ver funil da própria organização
- ver clientes da própria organização
- editar clientes da própria organização
- enviar mensagens internas dentro da própria organização
- operar seus próprios leads e clientes
- não ver outras organizações
- não alterar plano contratado

### Corretor

- ver apenas seus próprios leads
- ver apenas seus próprios clientes
- editar apenas seus próprios dados comerciais
- usar sua própria instância WhatsApp
- não criar usuários
- não ver métricas da equipe
- não ver dados financeiros da assinatura

---

## Isolamento lógico

- cada registro chave contém `organization_id`
- todas as consultas devem filtrar por `organization_id`
- o backend deve impor isolamento entre corretoras e contas individuais
- um mesmo usuário pode existir apenas em sua organização

## Owner e validação

- `owner_user_id` define o usuário responsável por um recurso ou organização
- o backend deve validar que o usuário tem permissão antes de qualquer operação
- não confiar em valores enviados pelo frontend
- o frontend é apenas camada de apresentação
- todas as regras de autorização devem estar no backend

## Regras de validação no backend

- `admin_master` pode agir globalmente, mas somente dentro das organizações que administra
- `supervisor` pode criar corretores desde que o plano da organização permita
- `broker` não pode criar usuários nem alterar limites
- um supervisor não pode acessar dados de outras organizações
- um corretor só pode consultar e atualizar seu próprio conjunto de leads e clientes
- tokens e sessões devem ser revogados no backend quando necessário

---

## Controle de fronteira

- não confiar apenas no frontend para permissões
- validar `role`, `organization_id`, `owner_user_id` e `subscription_id` no backend
- usar `access_tokens` com `status` e `expires_at`
- verificar limites contratados antes de criar usuários ou atribuir recursos
