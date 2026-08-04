# Plano de Migração para Supabase/Postgres

Este plano descreve uma migração segura do banco JSON atual para uma base relacional em Supabase/Postgres.

## Premissas

- o banco JSON atual continua inalterado durante a fase inicial
- não há mudança de rotas ou de API para produção nesta fase
- a evolução da integração com Evolution API permanece estável

---

## Fase 0 — Backup

- realizar backup completo dos arquivos JSON existentes
- inventariar todos os arquivos e formatos atuais
- documentar quais tabelas e campos são originados de cada JSON
- congelar uma versão estável antes de começar a migração
- validar checksums e versões dos arquivos

## Fase 1 — Estrutura paralela

- criar projeto Supabase e esquema inicial em Postgres
- definir tabelas de acordo com o modelo de dados SaaS
- criar migrations para as tabelas principais
- manter o banco JSON funcionando como fonte primária de dados
- garantir que o backend leia do JSON sem alterações durante a fase

## Fase 2 — Importação inicial

- importar usuários e tokens
- importar leads e clientes
- importar produtos, pagamentos e assinaturas
- importar histórico financeiro e mensagens internas, se existir
- validar contagens entre JSON e novo banco
- registrar divergências para correção posterior

## Fase 3 — Leitura dupla controlada

- configurar backend para leitura de Supabase em paralelo com JSON
- usar JSON como backup de comparação
- comparar resultados de queries críticas em ambas as fontes
- priorizar Supabase para validação de integridade, mas manter JSON como fallback
- documentar discrepâncias e resolver antes de avançar

## Fase 4 — Escrita no Supabase

- migrar operações de escrita para o Supabase
- manter logs de falha e rollback possível
- gravar em Supabase e, opcionalmente, registrar eventos no JSON para auditoria temporária
- ativar monitoração e alertas para erros de persistência
- garantir que tokens e credenciais não sejam expostos no frontend

## Fase 5 — Desativar JSON como banco principal

- transferir gradualmente o JSON para modo backup somente leitura
- validar integridade dos dados finais
- monitorar as métricas de uso e performance
- remover leituras de JSON do fluxo principal somente quando seguro
- manter o JSON arquivado como snapshot de contingência

---

## Riscos identificados

- duplicidade de registros durante importação
- IDs antigos potencialmente conflitantes em Postgres
- campos de documento armazenados em base64 ou formatos inconsistentes
- tokens armazenados em texto no JSON
- concorrência de atualização entre leitura JSON e escrita Supabase
- inconsistência de dados de webhook da Evolution API
- divergência de esquema entre o modelo JSON atual e a estrutura relacional
- perda de histórico e metadados se o campo não for mapeado corretamente

---

## Recomendações

- usar scripts de migração idempotentes
- criar testes de comparação de contagens e amostras de dados
- implementar verificação de integridade por entidade
- não desligar o banco JSON sem validação completa
- manter logs de audit trail para cada etapa
