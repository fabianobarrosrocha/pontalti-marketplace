-- 0005_grants_service_role.sql — grants para o service_role
-- Com "expose new tables OFF", nem o service_role recebe privilégios
-- automáticos em tabelas novas. O factory-control (seção "Loja online")
-- usa o service_role para ler/escrever o catálogo e os pedidos — sem
-- estes grants, toda chamada dele falha com "permission denied".
-- (O service_role ignora RLS, mas ainda precisa de GRANT no nível da tabela.)

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Tabelas criadas no futuro já nascem acessíveis ao service_role:
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
