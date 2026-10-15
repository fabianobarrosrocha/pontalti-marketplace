# Bot de atendimento e vendas da loja

Primeira versão implementada em 29/09/2026, para a loja pública. Atendimento automático, sem transferência para atendentes. O catálogo, o cliente, o carrinho, os pedidos e os pagamentos usam o mesmo Supabase do site.

## Fluxo implementado

- Catálogo com uma mensagem de foto e botões por produto, em grupos de até três. Cada mensagem mostra foto principal do Supabase Storage, nome/preço atual, Escolher produto e Ver detalhes. A última também oferece carrinho quando não há paginação. Páginas adicionais preservam a busca.
- Quantidade por botões de 1 ou 2 unidades (também aceita quantidade digitada), carrinho, alteração/remoção de itens e seleção provisória antes do vínculo.
- Conta vinculada por link de 15 minutos: autenticação no site e código confirmado na conversa. Não identifica o comprador por telefone digitado ou CPF.
- Confirmação explícita para adicionar a seleção provisória ao carrinho da conta.
- Endereços da própria conta, resumo final, pedido e Pix/boleto Cora.
- Consulta dos próprios pedidos e avisos de pagamento confirmado/cancelado.
- FAQ com artigos aprovados. Sem resposta cadastrada, o bot oferece os assuntos disponíveis.
- Gerenciamento e revogação de vínculos em `/conta/whatsapp`.
- **Meus pedidos**: status atualizado, total, navegação pelo histórico e botão de atualização no detalhe. Comandos `status`, `status do pedido` e `pedidos` abrem a consulta da conta vinculada.
- **Meus dados**: consulta e alteração de nome e telefone, com revisão e confirmação antes de salvar. O telefone de contato não troca a identidade ou o número vinculado à conversa. CPF e dados de acesso continuam no site autenticado.
- **Meus endereços**: consulta, novo endereço, edição de CEP/rua/número/complemento/bairro/cidade/UF e escolha de padrão. O cadastro novo é preenchido campo a campo e confirmado ao final. Se um endereço corrigido já estiver associado a pedidos, sua versão anterior é preservada nesses pedidos; a versão corrigida passa a aparecer no bot e no site.
- **Repetir último pedido** no menu e **Repetir este pedido** no detalhe: mostra os itens aos preços atuais e pede confirmação para somar ao carrinho existente. Não emite pedido ou cobrança nessa etapa. Produtos indisponíveis, mudança de preço durante a revisão e soma acima de 999 unidades impedem a operação, sem adição parcial.
- **Pagar com Pix**: lista as cobranças pendentes, inclusive de pedidos antigos. Ao selecionar, consulta a mesma cobrança Cora e envia seu código copia e cola em uma mensagem separada. Pedidos já pagos não reapresentam o código.

As gravações cadastrais e a repetição conferem novamente o vínculo no banco, além da identidade recebida pelo worker. A operação usa o ID da entrada para não repetir a gravação ou somar itens duas vezes após uma queda. Botões de menus antigos não confirmam alterações.

A compra usa o vínculo confirmado em `whatsapp_contacts.customer_id` para associar o número à conta. Esse vínculo é preservado nas próximas conversas. Sem vínculo, o bot envia um link seguro: clientes existentes entram na conta e novos clientes usam `Cadastre-se` no site; ambos confirmam o código na conversa. O campo de telefone informado no cadastro, sozinho, não comprova a identidade do comprador. A seleção provisória é preservada até o cliente autorizar sua adição ao carrinho da conta.

Quando a conta vinculada tem nome ou CPF incompleto/inválido, o bot envia o link de Meus dados e os botões `Retomar compra` e `Ver carrinho`. A correção ocorre no site, sem coletar CPF na conversa, e o carrinho permanece salvo. Os links precisam usar a URL pública HTTPS da loja em `NEXT_PUBLIC_SITE_URL`; os links locais do runner não representam uma loja publicada.

Comandos: `menu`, `produtos`, `buscar bojo`, `detalhes 1`, `carrinho`, `comprar`, `pedidos`, `status do pedido`, `repetir ultimo pedido`, `meus dados`, `enderecos`, `pix`, `ajuda`, `conta`, `vincular CODIGO` e `desvincular`. Durante uma edição cadastral, `cancelar` descarta os dados ainda não salvos. Menus aceitam números e labels. IDs de escolhas interativas incluem versão; uma escolha antiga não executa outra etapa.

### Pix Cora

O cliente bancário já envia `payment_forms: ["BANK_SLIP", "PIX"]` ao criar a cobrança. O campo `pix.emv` retornado pela Cora é persistido como `order_payments.pix_qr_code` e recuperado pelo botão Pix do bot. Webhook e consultas periódicas confirmam a liquidação por mTLS, validando referência, valor e total recebido; a mensagem do cliente não marca o pedido como pago.

Ao escolher Pix, o bot envia uma orientação, o código copia e cola sozinho em outra mensagem e a imagem PNG do QR Code da mesma cobrança (640 px, margem de quatro módulos). O PNG é gerado localmente e enviado em base64 à Evolution, sem URL pública com o pagamento. A mensagem do código é marcada como literal: o runner não acrescenta `Pontalti · teste` e ignora seu eco na conversa consigo mesmo. A confirmação continua consultando a mesma cobrança, sem nova emissão.

Em 15/10, o PNG gerado a partir de um Pix existente foi lido por um detector independente (Apple Vision); o resultado coincidiu exatamente com o código Cora persistido. Passaram 28 testes de conversa/transporte, oito do canal e 23 de integração, lint, TypeScript e build. O runner de telefone passou a usar tokens exclusivos da base local válidos por 24 horas, preservando o nome corrigido ao retomar uma conversa; as suítes mantêm o vencimento padrão de uma hora.

O runner foi reiniciado com `--self-chat --resume`. Uma solicitação identificada como `local_script_not_phone` reenviou o Pix existente na própria conversa de homologação: orientação, código literal, PNG e opções do pedido receberam IDs da Evolution e status `accepted`, com zero erros do worker e nenhuma nova cobrança. Relatório: `/tmp/pontalti-whatsapp-pix-qr-validation-20261015.json`.

A [documentação oficial de boleto com Pix](https://developers.cora.com.br/reference/emiss%C3%A3o-de-boleto-registrado-v2) confirma esse contrato e exige uma chave Pix cadastrada na conta recebedora. Sem ela, o banco pode retornar apenas o boleto. O bot informa que o Pix ainda não está disponível e permite consultar novamente, sem emitir uma nova cobrança. O marketplace permanece em Cora stage; a conexão de produção da fábrica é independente.

Validação em 15/10/2026: 27 testes de conversa/transporte, sete do canal de homologação e 23 de integração com PostgreSQL/PostgREST passaram, assim como lint, TypeScript e build. A suíte usou outro compose nas portas 55449/55450, preservando a conversa existente. Uma cobrança de R$ 5,00 foi emitida na API Cora stage; o bot retornou exatamente o Pix persistido, a mesma chave recuperou a mesma cobrança e a simulação confirmou pagamento/pedido como `paid`. Nenhuma mensagem WhatsApp/Telegram foi enviada. Relatório: `/tmp/pontalti-whatsapp-cora-stage-result.json`.

A migration `0010` também foi aplicada à base local de homologação na porta 55439, após backup privado em `/tmp/pontalti-whatsapp-before-0010-20261015T140843Z.dump`. Foram preservados dois contatos, duas conversas, dois pedidos e dois pagamentos existentes. O Supabase remoto não foi migrado nesta entrega. No encerramento da validação, não havia runner nas portas 3013/3015; iniciar o runner com `--resume` para retomar a conversa existente sem reinicializar sua base ou enviar outro catálogo. A visualização dos novos menus no aparelho ainda depende dessa retomada.

**Apresentação atual, escolhida pelo usuário em 15/10:** fotos individuais com botões no aplicativo. Após dois formatos de carrossel falharem no WhatsApp instalado no computador, o usuário selecionou expressamente essa alternativa. `Ver produtos` envia uma mensagem independente para cada produto, sem colagem e sem exigir Anterior/Próximo para ver o próximo item da mesma página. Esse formato vale para a conversa em todos os dispositivos; não se infere o aparelho de leitura pelo webhook.

O motor emite mensagens `product`, uma por produto, com entradas independentes em `whatsapp_outbox`. O worker e o runner usam `catalogSender`/`renderProduct` para preparar a foto e converter cada entrada em imagem com botões via `sendButtons`. Assim cada envio tem seu próprio ID/status; uma falha parcial não reenvia um lote inteiro já aceito. Cada produto conserva os botões Escolher produto e Ver detalhes com seu UUID e versão. A última mensagem oferece Ver carrinho quando não há páginas adicionais. As páginas contêm até três produtos; quando necessário, uma mensagem de navegação oferece Página anterior, Mais produtos e carrinho, preservando a busca. O console local também mostra cada foto e seus botões.

A foto principal tem preferência (com fallback para a primeira na ordem cadastrada). Cada imagem é ajustada por `sharp` para 640 × 480, mantendo proporções. Produtos sem foto recebem uma imagem neutra com “Sem foto cadastrada”, e falhas de download aparecem como “Foto indisponível”. São aceitas somente imagens raster do bucket público `product-images` da origem Supabase configurada, com limite de bytes, pixels e tempo de download. Cada foto é enviada em base64 individualmente, sem arquivo fixo ou novo upload ao Storage. O código antigo de carrossel permanece apenas para entradas anteriores que já estivessem na fila; os pedidos novos de catálogo não o geram. A entrada Meta do bot continua pendente de implementação e homologação.

Validação das fotos individuais em 15/10: passaram 46 testes de conversa/transporte/renderização, sete do canal e 26 de integração, lint, TypeScript e build. A integração rodou em compose próprio 55479/55480, removido ao final, preservando a conversa e os outros testes em andamento. O runner foi retomado com `--resume`, e uma entrada `local_script_not_phone` reenviou dois produtos em duas saídas independentes `product`, aceitas pelo provedor como `documentMessage` com o formato legado de imagem/botões. Cada mensagem conservou os IDs de seleção/detalhes do seu produto; a segunda também ofereceu carrinho. O worker ficou sem erros; três pedidos e três pagamentos e o carrinho foram preservados, sem nova cobrança. Um produto continua sem foto cadastrada. A aparência desta versão e os cliques no aplicativo ainda dependem da conferência do usuário. Relatório: `/tmp/pontalti-whatsapp-individual-validation-20261015.json`.

### Histórico da investigação do carrossel

A revisão de 15/10 substituiu o formato intermediário de um produto por mensagem, após o usuário esclarecer com uma referência visual que deseja cartões lado a lado. O patch da Evolution passou a usar o perfil N47 de [WhiskeySockets/Baileys PR #2849](https://github.com/WhiskeySockets/Baileys/pull/2849), commit `1441cf3`: cabeçalho raiz sem mídia, cabeçalho de imagem em cada cartão, rodapé vazio e `messageParamsJson="{}"` em cada cartão, sem versão explícita do carrossel, contexto/rodapé/fluxo na raiz ou citação. Esse PR está fechado e não foi incorporado; relata funcionamento no Web, mas seleção desabilitada no iOS testado. Isso orienta a tentativa de compatibilidade; não comprova o funcionamento no aplicativo do usuário.

O canal Docker local em `../infra/evolution-test` mantém a Evolution 2.3.7 e a sessão pareada, com Baileys rc14 e um patch de transporte nativo reproduzível no Dockerfile. O patch adiciona o carrossel e os metadados `biz` necessários para botões/listas, com referência no código oficial da Evolution 2.4.0-rc1. A construção falha se os pontos esperados da imagem fixa forem diferentes. Ele se destina à homologação; não atualiza o provedor de produção.

**Revalidação em 15/10:** após o reenvio N47, o usuário confirmou por captura que o aplicativo WhatsApp do computador continua mostrando “Não foi possível exibir a mensagem”. Relatou que aparentemente funciona no celular; isso não confirma os botões nem toda a compra. O WhatsApp instalado neste Mac está em 26.41.14 (build 1087428306). O relato do upstream é sobre Web, sem versão exata, e não homologa este aplicativo nativo.

Foi acrescentado um perfil local `PONTALTI_TEST_CAROUSEL_PROFILE=evolution-go`, baseado no `SendCarousel` de [evolution-foundation/evolution-go](https://github.com/evolution-foundation/evolution-go/blob/main/pkg/sendMessage/service/send_service.go). Mantém os cartões individuais e mídia própria; inclui `contextInfo={}` na interação, `messageContextInfo.deviceListMetadata={}` na raiz e `messageVersion=1` no carrossel. Omite rodapés vazios, `messageParamsJson` nos cartões e cabeçalho raiz, seguindo esse código. Não troca a biblioteca nem o provedor e não fabrica hashes de chaves. A tentativa é reversível: `PONTALTI_TEST_CAROUSEL_PROFILE=n47` retoma o formato anterior após recriar o container. A imagem N47 está preservada em `pontalti-evolution-test:n47-20261015`. Os quatro testes do perfil e a construção da imagem passaram; a compatibilidade no aplicativo continua pendente de validação.

O perfil alternativo foi enviado na mesma conversa de homologação, por entrada `local_script_not_phone`. A inspeção do retorno da Evolution confirmou os dois cartões e mídias individuais, contextos explícitos, versão 1 do carrossel, ausência de rodapés vazios e os mesmos IDs de compra/detalhes. Isso confirma o formato transmitido, não a renderização no cliente. Relatório: `/tmp/pontalti-whatsapp-desktop-validation-20261015.json`; a captura posterior do usuário confirmou nova falha no aplicativo do computador. O navegador não foi confirmado. Esse formato deixou de ser usado nos novos catálogos após a escolha por fotos individuais.

No reinício, o código compartilhado já incluía as consultas de saldo da migration `0011`, enquanto a base local ainda estava na `0010`. Isso causou erros do worker e HTTP 503 no painel local. Após revisar a migration e guardar backup privado em `/tmp/pontalti-whatsapp-before-0011-20261015-desktop.dump`, a `0011_customer_account_balance.sql` foi aplicada somente ao banco local `pontalti_whatsapp_test`, porta 55439, sem reset. Os três pedidos/pagamentos e o carrinho foram preservados; após retomar o runner, o estado voltou a HTTP 200 e o worker permaneceu sem erros. Não houve migração remota, consulta de saldo no core ou nova cobrança nessa validação.

**Limite observado em 07/10:** o usuário confirmou que o carrossel aparece no celular, mas seus botões ficam desabilitados. No aplicativo WhatsApp instalado no computador, a mesma mensagem mostra “Não foi possível exibir a mensagem”. Os menus por lista continuam recebendo cliques. Portanto, o carrossel desse canal não está homologado para venda e a compra inteira no aparelho permanece pendente.

O Docker de teste agora usa `PONTALTI_TEST_REPLY_CARRIER=document` para uma amostra de botões legados com imagem em `documentWithCaptionMessage`. Esse formato experimental segue os perfis N23/N25 da [investigação Baileys #2849](https://github.com/WhiskeySockets/Baileys/pull/2849), fechada e não incorporada à biblioteca oficial. Os metadados de destinatário são opacos, sem alegação de representar um hash verificado de chave Signal. O usuário confirmou que o botão da amostra de um produto funciona no celular e apresenta as quantidades. Depois, confirmou que a mensagem com os três produtos numa imagem e seus três botões aparece e permite escolher tanto no celular quanto no aplicativo instalado no computador. Os cliques reais de seleção e retorno ao catálogo foram registrados. Essa confirmação cobre a alternativa com imagem e botões, sem homologar o carrossel horizontal ou a jornada inteira.

## Instalação

1. Aplicar `supabase/migrations/0009_whatsapp_commerce.sql` no Supabase da loja, após as migrations existentes. É aditiva, sem reset. Ela também move as alterações do carrinho e a criação de pedidos para serviços/RPC; publicar o novo site junto dessa migration.
   Aplicar também `supabase/migrations/0010_whatsapp_account_repeat.sql` antes desta versão do site/worker. Acrescenta o histórico de operações cadastrais, arquivamento das versões de endereço e RPCs restritas ao servidor para cadastro e repetição. As páginas de endereços/checkout passam a selecionar apenas endereços ativos. Fazer backup e aplicar uma vez, sem reset; a migration é transacional. Reiniciar o worker/runner para carregar o menu e os fluxos novos.
2. Configurar as variáveis de `.env.local.example`. Manter as credenciais Cora em stage na homologação.
3. Configurar as condições comerciais e os artigos de suporte, conforme abaixo.
4. Publicar o marketplace e executar `npm run whatsapp:worker` como processo supervisionado, com reinício automático. O worker precisa das mesmas credenciais de servidor e arquivos/PEMs Cora. `tsx` é dependência de execução.
5. Configurar o webhook da instância Evolution para `/api/webhooks/whatsapp/evolution`, com o header `x-whatsapp-webhook-secret`, `byEvents: false`, `base64: false` e evento `MESSAGES_UPSERT`.
6. Ativar `WHATSAPP_BOT_ENABLED=true` e `WHATSAPP_BOT_SEND_MODE=live` somente no ambiente destinado aos envios. O webhook valida o segredo e a instância. O worker desta versão exige `WHATSAPP_PROVIDER=evolution`.

Configuração Evolution equivalente, usando `/webhook/set/{instance}`:

```json
{
  "webhook": {
    "enabled": true,
    "url": "https://SUA-LOJA/api/webhooks/whatsapp/evolution",
    "headers": { "x-whatsapp-webhook-secret": "SEU-SEGREDO" },
    "byEvents": false,
    "base64": false,
    "events": ["MESSAGES_UPSERT"]
  }
}
```

Use segredos aleatórios distintos de pelo menos 32 caracteres para webhook e vínculo. Configure HTTPS em `NEXT_PUBLIC_SITE_URL`. As credenciais de servidor não são enviadas ao navegador ou ao WhatsApp.

## Condições comerciais

Os registros iniciais de `whatsapp_settings` deixam o checkout do bot indisponível até definir unidade de venda e modalidade de entrega. O catálogo e o suporte continuam funcionando. Não se presume frete gratuito por o checkout antigo calcular somente o subtotal.

Na configuração `unit_label`, salvar a unidade comercial aprovada como uma string JSON. Na configuração `delivery`, salvar:

```json
{
  "enabled": false,
  "description": "DESCRIÇÃO APROVADA DA MODALIDADE",
  "feeCents": 0,
  "states": ["SP"]
}
```

`feeCents` é o custo aprovado em centavos; `states` limita os estados atendidos, ou `[]` para todos. Alterar `enabled` para `true` depois de validar os valores reais. Esta versão oferece uma modalidade de custo fixo. Não calcula frete por transportadora/CEP. No site, foi preservada a condição atual de envio a combinar, com custo de envio fora do total exibido.

`support_articles` contém `title`, `answer`, `enabled` e `display_order`. Os artigos iniciais explicam pagamento e acompanhamento já implementados. Cadastrar políticas comerciais aprovadas antes de publicá-las. Não cadastrar descontos, estoque ou prazos que a plataforma não possa confirmar.

## Persistência e recuperação

O webhook confirma recebimento depois de gravar o evento. IDs externos são únicos por conversa, que é única por provedor/instância/número. Mensagens próprias, grupos e histórico antigo são ignorados. O payload integral, incluindo a chave Evolution, não é salvo.

O worker assume uma conversa por vez usando leases e grava estado e respostas em uma transação. Alterações externas do carrinho são atômicas e identificadas pelo evento. Reprocessar uma entrada depois de uma queda não adiciona o mesmo item novamente. Leases expiradas permitem recuperar tarefas.

O checkout bloqueia o carrinho e os produtos, revalida disponibilidade, preço, comprador, endereço e condição de entrega. Pedido, itens, intenção de pagamento e reserva dos itens são gravados juntos. Os itens reservados saem do carrinho nessa transação; itens adicionados depois continuam disponíveis. Repetir a confirmação da mesma versão, inclusive pelo outro canal, recupera o mesmo pedido.

A referência, o vencimento, os dados da cobrança e a chave Cora são congelados antes da emissão. Um timeout preserva o pedido e a chave. A recuperação automática usa a mesma chave por até 10 minutos após a primeira tentativa; depois a intenção passa a `review`, para conciliar a referência no banco antes de emitir qualquer outra cobrança. Não presume retenção ilimitada da chave pela Cora. O pedido continua disponível em Meus pedidos.

A confirmação consulta a Cora via mTLS. A gravação de pagamento/pedido/aviso é atômica, confirma valor e recebimento e não regride um pedido pago após uma consulta atrasada. Pix/boleto disponibilizados depois da emissão também são atualizados. O worker consulta pagamentos pendentes sem depender da tela aberta ou de `after()`.

As respostas ficam em `whatsapp_outbox`. `accepted` significa que a Evolution devolveu um ID de mensagem; não comprova entrega/leitura no aparelho. Timeout ou queda com resultado desconhecido produz `unknown`, sem reenvio automático daquela mensagem. A conversa pode continuar; o cliente pode pedir novamente o pagamento, recuperando a mesma cobrança. Logs registram o resultado. Mensagens privadas ainda pendentes são canceladas se a conta tiver sido desvinculada.

Avisos do bot usam chaves únicas por evento. Os avisos legados de Telegram e de clientes sem vínculo são mantidos pelo processador de eventos, com o comportamento de envio existente. Não existe painel de atendentes.

Para observar falhas, consultar `whatsapp_inbox_events` (`failed`), `whatsapp_outbox` (`unknown`/`failed`), `checkout_intents` (`review`) e `notification_log` no servidor. Não alterar uma intenção para criar uma nova chave Cora antes de conciliar a referência original.

## Testes locais

Postgres/PostgREST isolados nas portas 55439/55440; os testes não carregam `.env.local`, não usam o Supabase configurado da loja e interceptam todos os envios.

Se houver uma conversa de homologação usando essas portas, executar os testes em outro compose. `PONTALTI_WHATSAPP_TEST_DATABASE_URL` e `PONTALTI_WHATSAPP_TEST_API_URL` permitem mudar as portas, aceitando somente loopback e o banco `pontalti_whatsapp_test`. A preparação e a suíte precisam receber as mesmas variáveis. Não reinicializar a base da conversa para executar os testes.

```sh
docker compose -f infra/whatsapp-test/compose.yml up -d db
npm run test:whatsapp:db
docker compose -f infra/whatsapp-test/compose.yml up -d rest api
npm run test:whatsapp
npm run test:whatsapp:integration
npm run lint
npm run build
```

Para encerrar somente essa infraestrutura de teste:

```sh
docker compose -f infra/whatsapp-test/compose.yml down --volumes
```

`test:whatsapp:db` aplica as migrations em uma base nova. Os testes limpam apenas a base local fixa `pontalti_whatsapp_test`; ela é descartável. O teste não precisa do Storage nem de um servidor de autenticação: usa papéis/JWTs de teste para verificar RPC e RLS.

O comando abaixo usa **as credenciais Cora stage existentes**, gera uma cobrança de R$ 5,00 com comprador de teste e simula pagamento. Pedido e pagamento são persistidos **somente na base local fixa**, e nenhum envio WhatsApp/Telegram é executado. Ele também reinicializa os dados dessa base de teste:

```sh
npm run test:cora:stage
```

O teste foi executado com sucesso em 29/09/2026: Pix, boleto e linha digitável retornados; repetição com a mesma chave recuperou a mesma cobrança; pagamento e pedido confirmados como `paid`. Relatório: `/tmp/pontalti-whatsapp-cora-stage-result.json`. A migration não foi aplicada ao Supabase remoto e o webhook/worker não foram ativados para clientes reais nesta implementação.

Também passaram 12 testes de conversa/transporte, 15 testes de integração com Postgres/PostgREST/RLS, lint e build do marketplace. Os testes cobrem compras simultâneas entre canais, recuperação após queda, timeout, menus antigos, vínculo, propriedade dos pedidos, preço alterado, resposta bancária incompleta e dados de pagamento disponibilizados após a emissão.

No navegador, o vínculo foi preservado ao navegar entre login e cadastro; o webhook respondeu como desativado na configuração atual.

### Conversa interativa no navegador

Com o Postgres/PostgREST de teste iniciado conforme os comandos acima:

```sh
npm run whatsapp:test-console
```

Abrir [http://127.0.0.1:3013](http://127.0.0.1:3013). O console usa o webhook, o motor de conversa, os serviços de carrinho/checkout e o worker implementados. Intercepta o transporte de saída para mostrar as respostas no navegador e não executa notificações externas. As credenciais Cora de `.env.local` são carregadas, e a inicialização exige `CORA_ENV=stage`.

O catálogo, comprador, endereço e retirada são fictícios, com produto de R$ 5,00. O login é representado por um botão que seleciona a conta local de teste; a geração do código e sua confirmação no chat usam os RPCs reais de vínculo. Ao confirmar a compra, a cobrança é emitida pela API Cora de staging. O botão **Simular pagamento no Cora staging** chama o endpoint de simulação da Cora e consulta o resultado antes de confirmar o pedido.

O console reinicializa **somente** a base local fixa `pontalti_whatsapp_test` ao iniciar e ao clicar em **Reiniciar conversa de teste**. Não executar os testes de integração ou `test:cora:stage` enquanto estiver usando o console, pois compartilham essa base descartável. Ele escuta somente em `127.0.0.1`, porta 3013. Encerrar com Ctrl+C e desligar o compose de teste quando terminar.

Em 29/09/2026, a jornada foi testada no navegador: catálogo → quantidade → vínculo com código → adição ao carrinho da conta → endereço → pedido → Pix e boleto → simulação Cora → pagamento confirmado → consulta de pedidos e FAQ. Pedido e pagamento ficaram `paid` para uma cobrança de R$ 5,00. Não houve erros de JavaScript; a tela também foi verificada em tamanho de celular. Evidências locais: `/tmp/pontalti-whatsapp-teste-local-relatorio.json` e `/tmp/pontalti-whatsapp-teste-local-pagamento.png`.

A Evolution configurada estava indisponível nesse teste de 29/09; os containers existentes em `infra/evolution-test` estavam parados. Portanto, essa validação no navegador não comprova entrega em um aparelho WhatsApp.

### Conversa de homologação no WhatsApp real

`whatsapp:test-live` conecta o webhook e o worker implementados a uma instância Evolution já pareada. Lê o catálogo real pelo Supabase configurado em `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` e baixa as fotos do Storage. Apenas consultas públicas GET são feitas nessa origem. Cliente de teste, vínculos, carrinho, pedidos e pagamentos continuam no Postgres/PostgREST local fixo; exige Cora stage. Os arquivos `.env` não são alterados. O transporte de respostas é real. As notificações legadas de Telegram e de outros compradores continuam interceptadas neste runner.

Com a base de teste preparada, encerre o console de navegador antes de iniciar:

```sh
WHATSAPP_TEST_INSTANCE=SUA_INSTANCIA_CONECTADA \
WHATSAPP_TEST_BOT_NUMBER=5511999990000 \
WHATSAPP_TEST_CUSTOMER_NUMBER=5511888880000 \
npm run whatsapp:test-live
```

O número de cliente é a única conversa aceita. As demais mensagens do WhatsApp conectado são ignoradas, sem registrar seu conteúdo na base de teste. O runner adiciona um comprador e endereço fictícios. A conta fictícia já fica vinculada para testar a compra; esta ferramenta não homologa login nem o vínculo com uma conta real. Produtos visíveis com preço positivo são consultados na loja, mantendo seus UUIDs, SKUs, nomes e preços em um espelho local para permitir selecionar/adicionar/comprar esses mesmos produtos na homologação. Preço e disponibilidade são reconferidos antes das alterações do carrinho, repetição e checkout. O catálogo fictício anterior fica indisponível para novas compras; pedidos antigos são preservados. As condições de retirada continuam sendo de teste. Não executar o console, testes de integração ou `test:cora:stage` no mesmo banco durante esta conversa.

Se houver apenas um número, use o mesmo valor nos dois números e acrescente `-- --self-chat`. Esse modo aceita mensagens próprias somente nessa conversa de teste, marca cada resposta com `Pontalti · teste` e ignora respostas do bot para evitar ciclos. O normalizador de produção permanece ignorando mensagens próprias. Ao usar dois números, mensagens próprias continuam excluídas.

Uma mensagem com o catálogo é enviada ao iniciar sem `--resume`. Depois, o cliente envia `menu` ou `produtos` e toca nos botões dos produtos. O fluxo usa catálogo, quantidades, carrinho, endereço, confirmação explícita, pedido e Cora stage pelos mesmos serviços do bot. `Abrir boleto` envia o documento PDF do pedido escolhido.

O runner usa o mesmo renderizador do worker, enviando uma mensagem de foto/botões para cada produto, em páginas de até três. Busca e paginação atualizam as mensagens conforme os produtos retornados pelo Supabase. As antigas variáveis `WHATSAPP_TEST_CATALOG_IMAGE` e `WHATSAPP_TEST_IMAGE_DIR` não são usadas; `infra/whatsapp-live/` e seu script de composição ficam apenas como artefatos da amostra anterior.

Validação do carrossel horizontal em 15/10: passaram 38 testes de conversa/transporte/renderização, sete do canal, 26 de integração e três do perfil da Evolution, além de lint, TypeScript e build. A instância de teste foi reconstruída sem trocar Baileys nem apagar a sessão; a imagem anterior foi conservada como `pontalti-evolution-test:before-carousel-20261015`. Após retomar o runner com `--self-chat --resume`, uma solicitação `local_script_not_phone` enviou os dois produtos reais em um único `interactiveMessage` com `carouselMessage.cards`. Foi conferido no retorno do provedor que cada cartão possui mídia própria e seus dois IDs de botões, sem versão explícita do carrossel. Um produto continua sem foto cadastrada e o outro usa sua foto principal. Carrinho, três pedidos e três pagamentos foram preservados, sem nova cobrança e sem erro de worker. A exibição e os cliques no aplicativo ainda dependem da conferência do usuário. Relatório: `/tmp/pontalti-whatsapp-horizontal-validation-20261015.json`.

Histórico de 15/10: a correção inicial do carrossel incompatível usou uma imagem local fixa. A solicitação posterior do usuário substituiu essa montagem pelas fotos atuais do Supabase; uma nova referência visual motivou a retomada do carrossel horizontal descrita acima.

Após reiniciar com `--resume`, a imagem respondeu à Evolution e o reenvio de `produtos` foi aceito como `documentMessage` com botões legados, em vez de `interactiveMessage` com carrossel. A solicitação foi `local_script_not_phone`; carrinho e pedidos foram preservados e o worker permaneceu sem erros. Relatório: `/tmp/pontalti-whatsapp-catalog-fix-20261015.json`. A exibição desta nova mensagem e seus cliques no aparelho ainda dependem da confirmação do usuário.

Não é necessário copiar fotos para o projeto ou cadastrar uma URL pública adicional para a composição. O nome, preço, foto e visibilidade devem ser mantidos no cadastro da loja; as consultas seguintes do bot refletem esses dados.

Validação do catálogo real em 15/10: 33 testes de conversa/transporte/renderização, sete do canal e 26 de integração passaram, além de lint, TypeScript e build. O runner foi retomado com leitura pública do Supabase e o catálogo com dois produtos foi reenviado, com aceitação da Evolution no formato de imagem e botões. As fotos coincidiram com o cadastro atual: um produto estava sem foto e o outro tinha foto principal. A seleção programática de um UUID real chegou à etapa de quantidade, preservando carrinho e três pedidos/pagamentos locais anteriores. Nenhuma cobrança nova foi emitida nessa validação e nenhum dado privado foi gravado no Supabase remoto. Relatório: `/tmp/pontalti-whatsapp-real-catalog-validation-20261015.json`. Backup anterior ao espelho: `/tmp/pontalti-whatsapp-before-real-catalog-20261015T155434Z.dump`.

O webhook exige um segredo aleatório criado a cada execução. A Evolution no Docker acessa `http://host.docker.internal:3015/api/webhooks/whatsapp/evolution`; a porta 3015 precisa estar livre. O estado de teste pode ser consultado somente neste computador em `http://127.0.0.1:3015/api/state`. A rota local `/api/test-input` identifica suas entradas como `local_script_not_phone`: usá-la não comprova recebimento de mensagens do celular. Ao encerrar com Ctrl+C, o runner desativa seu webhook; a sessão WhatsApp permanece pareada.

Para reiniciar o processo mantendo o menu atual e sem enviar outro catálogo, acrescente `--resume` aos argumentos. A conversa de teste precisa já existir. Estado, carrinho e pedidos são preservados.

Em 07/10/2026, o pareamento por código e a entrega de um PDF Cora stage no aparelho foram confirmados pelo usuário. Isso comprova o transporte desse documento, sem substituir a validação da conversa completa no celular. Passaram também os 17 testes de conversa/transporte/restrição de canal, lint e build com o novo runner.

Na revisão do mesmo dia, o usuário rejeitou a apresentação com várias fotos e links. O motor e o transporte foram corrigidos para o carrossel nativo previsto em `../PREVIA-WHATSAPP-PONTALTI.html`. O primeiro carrossel recebeu um ID e `SERVER_ACK`, mas a validação no aparelho encontrou as limitações descritas acima. Foi corrigida também a leitura de `templateButtonReplyMessage.selectedId`, usada em respostas de cartões. Passaram 16 testes do motor/transporte e sete do canal/amostra, além de lint e build. Os 15 testes de integração da jornada passaram na etapa anterior em outro compose temporário, sem reinicializar a base da conversa no WhatsApp; o banco é real e a Cora/transporte são interceptados nessa suíte. As entradas reais de menus e da amostra de botão foram registradas; ainda não houve pedido confirmado nessa conversa no aparelho.

Na continuação da homologação, o usuário montou um carrinho com uma unidade do clássico e duas do triangular, subtotal R$ 19,00. A finalização encontrou um CPF inválido no cadastro fictício do runner. O fixture foi corrigido usando um CPF de teste aceito pelo validador; o início do runner agora valida esse cadastro e corrige o registro local existente, inclusive com `--resume`. A retomada automática de teste (`local_script_not_phone`) avançou para o endereço preservando o carrinho e enviou a nova seleção pelo WhatsApp real. Essa retomada não comprova um clique do aparelho nem emissão de boleto. Passaram 17 testes de motor/transporte e 16 de integração em outro banco temporário, incluindo bloqueio por CPF inválido e retomada após correção, além de lint e build. A compra com emissão de boleto dessa conversa continua pendente de confirmação.

## Saldo da conta Pontalti e depósitos

A fonte financeira é a API da fábrica, em `/api/v1/commerce-finance`. O Supabase mantém apenas pedidos, intenções de compra, a referência da aprovação e referências para avisos de depósito; não calcula nem guarda um saldo independente. O vínculo entre o usuário da loja e o cliente da fábrica é conferido pela Pontalti quando o CPF já existe. Alterar um CPF no cadastro não autoriza ler o saldo de outra pessoa.

Aplicar `0011_customer_account_balance.sql` e `0012_customer_deposit_notifications.sql` antes de publicar esta versão do site e do worker. A primeira preserva carrinhos, pedidos, cobranças e os RPCs existentes, acrescentando forma de pagamento e estados de aprovação. A segunda guarda somente referências para os avisos; não cria lançamentos financeiros. Ambas são aditivas, transacionais e restritas ao servidor. Fazer backup e aplicar uma vez, sem reset. A aplicação ao Supabase remoto depende do acesso SQL autorizado; os testes usam exclusivamente bancos descartáveis.

Na conferência de 15/10/2026, o Supabase da loja ainda não possuía as etapas `0009` a `0012`. Para essa instalação, executar o arquivo completo `supabase/apply-customer-account.sql` no Editor SQL: ele aplica somente as etapas ausentes de `0008` a `0012` em uma transação. O arquivo foi validado com dados existentes e em uma segunda execução, sem duplicar ou apagar registros.

A base local da conversa no aparelho, porta `55439`, recebeu a etapa `0012` após backup privado em `/tmp/pontalti-whatsapp-before-0012-20261015.dump`. Foram preservados três clientes, quatro pedidos/pagamentos, dois contatos/conversas e dois carrinhos. Essa atualização não iniciou o runner nem enviou mensagens. O Supabase remoto continua dependendo da execução pelo Editor SQL.

Variáveis privadas do servidor:

- `CORE_API_URL`: URL da API da fábrica terminada em `/api/v1`.
- `CUSTOMER_FINANCE_INTERNAL_TOKEN`: mesmo segredo privado configurado na fábrica, com pelo menos 32 caracteres. Não usar prefixo `NEXT_PUBLIC_`.
- `CUSTOMER_FINANCE_ENVIRONMENT`: `STAGE` ou `PRODUCTION`, obrigatório. O ambiente fica persistido na intenção e é conferido no core. Não é inferido do `CORA_ENV` da loja. As cobranças Pix/boleto de produtos continuam no ambiente que já estava configurado.

No WhatsApp, `saldo`, `extrato`, `adicionar saldo`, `já depositei` e `meus depósitos` usam a mesma conta mostrada em `/conta/saldo`. O checkout oferece Pix/boleto Cora ou Saldo na conta. A revisão mostra o saldo disponível e a projeção após a compra. Toda projeção negativa informa que a continuidade depende da Pontalti e pede Solicitar aprovação. Pedidos pendentes ficam bloqueados para produção e envio. Aprovação com crédito usa `balance_approved`, nunca um falso `paid`; a dívida restante aparece no detalhe e no histórico.

O resumo financeiro exato, a revisão da conta, o ambiente, o endereço selecionado e os itens/preços/produtos são congelados na intenção antes do pedido financeiro. O core usa uma chave idempotente persistida e trava a conta para reservar/consumir os valores. Uma falha entre os dois bancos é recuperada pelo worker sem repetir pedido ou débito. Se o saldo piorar desde a revisão do cliente, o pedido exige nova confirmação, inclusive quando já há solicitação pendente. Uma consulta antiga não regride uma decisão nova; cancelamentos autenticados posteriores permitem atualizar o pedido e os valores, preservando o estado operacional quando já registrado na fábrica.

Adicionar saldo emite um boleto individual no core, separado de um pedido de produtos. A emissão depende da flag `CORA_CUSTOMER_DEPOSITS_ENABLED` na fábrica e do ambiente da conexão bancária. O crédito exige consulta bancária autenticada e confirmação de valor/identificador/liquidação. Já depositei registra valor, data e referência para conferência; não confirma dinheiro com base apenas na mensagem ou comprovante. A área financeira vincula a solicitação a uma entrada bancária comprovada e não reutilizada. Cada entrada credita uma vez. O worker da loja consulta o core e enfileira um aviso de crédito pelo outbox existente, deduplicado e vinculado à conta WhatsApp atual; a referência do aviso não constitui saldo.

Validação específica: `npm run test:whatsapp` cobre os menus e confirmações com fakes, sem enviar WhatsApp. `npm run test:balance:integration` cobre RPCs, reservas, idempotência, snapshots, versões e avisos no Postgres/PostgREST descartável. `npm run test:balance:core` cobre a fronteira HTTP com a API real de domínio, Cora simulada e uma conversa completa de compra com saldo e aprovação. Essas suítes devem ser sequenciais porque reinicializam seus bancos de teste; jamais apontá-las ao Supabase da loja ou ao banco real da fábrica.

A suíte com o core requer `PONTALTI_FINANCE_E2E_DATABASE_URL` apontando exclusivamente para o banco local `pontalti_finance_e2e_test`, preparado com o schema Prisma atual. Ela também exige o Supabase descartável nas portas `55449` (Postgres) e `55450` (PostgREST), informadas por `PONTALTI_WHATSAPP_TEST_DATABASE_URL` e `PONTALTI_WHATSAPP_TEST_API_URL`. O helper HTTP escuta somente em loopback na porta `35511` e não carrega credenciais bancárias reais. A suíte falha antes de limpar dados se esses limites não forem atendidos.

As ferramentas `whatsapp-test-live`, `whatsapp-test-console` e `test-cora-stage` descartam a configuração financeira da fábrica herdada de `.env.local` antes de carregar os serviços. Clientes fictícios não consultam nem criam contas financeiras reais. Nesses runners, saldo e depósitos da fábrica ficam indisponíveis; Pix/boleto stage continuam com sua configuração própria. O fluxo de saldo é validado pela suíte isolada com o core. `tests/local-finance-isolation.test.ts` comprova que a configuração de produção é removida e que nenhuma requisição financeira pode sair do simulador.

## Referências técnicas

- [Emissão de boleto registrado Cora](https://developers.cora.com.br/reference/emissão-de-boleto-registrado-v2)
- [Simulação de pagamento em stage](https://developers.cora.com.br/reference/pagar-boleto-em-stage)
- [Configuração de headers do webhook Evolution](https://github.com/evolution-foundation/evolution-api/blob/main/src/api/integrations/event/webhook/webhook.controller.ts)
- [Carrossel e correções de mensagens interativas Evolution](https://github.com/evolution-foundation/evolution-api/releases/tag/2.4.0-rc1)
