# Supabase — migrations do marketplace

Scripts SQL versionados da Etapa 1 do `PLANO-IMPLEMENTACAO-MARKETPLACE.md`.
O projeto não usa a CLI do Supabase por enquanto — os scripts são aplicados
manualmente pelo SQL Editor, **em ordem**:

| Ordem | Arquivo | Conteúdo |
|---|---|---|
| 1 | `migrations/0001_init.sql` | Tabelas, trigger de signup (`handle_new_user`), triggers de `updated_at` |
| 2 | `migrations/0002_rls.sql` | RLS de todas as tabelas |
| 3 | `migrations/0003_storage.sql` | Bucket `product-images` + policy de leitura pública |
| 4 | `migrations/0004_grants.sql` | GRANTs de API — o projeto usa "expose new tables OFF", então **toda migration que criar tabela precisa conceder GRANTs** aos roles `anon`/`authenticated` |
| 5 | `migrations/0005_grants_service_role.sql` | GRANTs para o `service_role` (usado pelo factory-control) + default privileges — tabelas futuras já nascem acessíveis a ele |
| 6 | `migrations/0006_orders_delete_policy.sql` | Cliente pode apagar o próprio pedido `pending` (rollback do checkout / futuro cancelamento) |
| 7 | `migrations/0007_payments.sql` | Tabela `order_payments` (cobranças Cora) + default de `orders.status` vira `awaiting_payment` |
| 8 | `migrations/0008_notification_log.sql` | Histórico unificado de notificações |
| 9 | `migrations/0009_whatsapp_commerce.sql` | Bot WhatsApp, vínculo verificado, carrinho atômico, checkout compartilhado e recuperação de cobranças |

A migration 0009 exige a publicação do checkout/carrinho novos e do worker junto da configuração do bot. As operações privilegiadas são exclusivas do servidor; o carrinho autenticado usa `commerce_my_cart`. Consulte [WHATSAPP-BOT.md](../docs/WHATSAPP-BOT.md) para variáveis, condições comerciais, instalação e testes locais.

## Como aplicar

1. Abra o projeto no dashboard do Supabase → **SQL Editor**.
2. Cole e execute cada arquivo, na ordem da tabela acima.
3. Se o `0003` falhar com `must be owner of table objects`, crie a policy pelo
   Dashboard (Storage → product-images → Policies → New policy, SELECT para
   `anon` e `authenticated`, expressão `bucket_id = 'product-images'`).

## Critério de aceite (do plano)

- `select * from public.product_marketplace_config;` retorna `[]` sem erro.
- Criar um usuário manual em Authentication → Users faz aparecer a linha
  correspondente em `public.customers` (trigger de signup funcionando).

## Convenção para mudanças futuras

Nunca edite um script já aplicado — crie `000N_<descricao>.sql` novo e
aplique apenas ele. Assim o histórico de migrations reflete o estado do banco.
