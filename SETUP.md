# Central de Frota — Guia de Configuração (Planilha + GitHub)

Arquitetura: **frontend estático** (HTML/CSS/JS, hospedado no GitHub Pages, igual
ao "Gestão de Armazéns") + **backend em Google Apps Script**, que lê e escreve
direto numa planilha do Google Sheets. Não há servidor próprio nem banco de
dados separado — a planilha *é* o banco de dados.

Essa é uma arquitetura diferente da versão anterior (que usava Firebase) — os
dois caminhos funcionam de forma independente, você não precisa desligar um
para usar o outro.

---

## FASE 1 — Criar a planilha e o backend

1. Crie uma planilha nova no Google Sheets (ex: "Central de Frota - Dados").
2. Nela, vá em **Extensões → Apps Script**.
3. Apague o conteúdo padrão do `Code.gs` e cole o conteúdo do arquivo `Code.gs` deste pacote.
4. No topo da barra de ferramentas do editor, selecione a função `configurarPlanilha` no dropdown e clique em **Executar** (▶). Na primeira vez, o Google vai pedir autorização — aceite (é a sua própria conta acessando a sua própria planilha).
5. Ainda no dropdown, selecione `autorizarPermissoesPDF` e clique em **Executar** (▶) também — essa é a autorização separada que o Google pede para criar documentos/apresentações (usada só na hora de gerar o relatório em PDF). Sem rodar essa função uma vez, o botão "Baixar relatório em PDF" do app vai dar erro de permissão na primeira vez que for usado.
6. Volte na planilha: as abas `CONFIG_UNIDADES`, `CONFIG_USUARIOS`, `CONFIG_RESPONSAVEIS`, `EQUIPAMENTOS`, `CHECKLISTS`, `CHECKLIST_ITENS`, `NAO_CONFORMIDADES`, `MANUTENCOES` e `_SEQ` foram criadas com cabeçalhos e alguns dados de exemplo (unidades Macatuba/Jundiaí/Jundiaí II, um usuário admin "Lucas" com senha `1234`, um operador "João", 3 equipamentos de exemplo).
7. **Apague/edite os dados de exemplo** e cadastre suas unidades, usuários e equipamentos reais (veja a tabela de abas mais abaixo para saber o que cada coluna significa).

### Publicar a API (Web App)

1. No editor do Apps Script: **Implantar → Nova implantação**.
2. Tipo: **App da Web**.
3. Configurações:
   - Executar como: **Eu**
   - Quem pode acessar: **Qualquer pessoa**
4. Clique em **Implantar**, autorize novamente se pedido, e copie a **URL do app da Web** (termina em `/exec`).

> Sempre que você editar o `Code.gs`, é preciso criar uma **nova versão** da implantação (Implantar → Gerenciar implantações → ✏️ → Nova versão) para as mudanças valerem na URL publicada.

---

## FASE 2 — Conectar o frontend

1. Abra `app.js`.
2. Perto do topo do arquivo, troque:
   ```js
   const API_URL = 'COLE_A_URL_DO_SEU_APPS_SCRIPT_AQUI';
   ```
   pela URL que você copiou (terminando em `/exec`).
3. Crie um repositório novo no GitHub (ex: `central-de-frota`) e suba **todos** os arquivos deste pacote — `index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js` e a pasta `assets/` inteira (com `logo.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`) — na raiz do repositório.
4. Em **Settings → Pages** do repositório, ative o GitHub Pages apontando para a branch principal (`main`), pasta raiz (`/`). O GitHub publica automaticamente em algo como `https://SEU-USUARIO.github.io/central-de-frota/`.

---

## Testando

Abra o link do GitHub Pages: a primeira tela pede a **Unidade**, depois o
**Usuário** (a lista vem da planilha), e só pede **Senha** se o usuário
escolhido for do tipo `ADMIN` — operador entra direto. Use o usuário de
exemplo `Lucas` / senha `1234` para testar como administrador, ou `João` para
testar como operador (sem senha).

---

## Estrutura de dados (abas da planilha)

| Aba | Uso |
|---|---|
| `CONFIG_UNIDADES` | Unidades (Macatuba, Jundiaí...). `ATIVO = SIM/NAO` controla se aparece no login. |
| `CONFIG_USUARIOS` | Quem loga no app. `TIPO = ADMIN` (usa `SENHA`) ou `OPERADOR` (sem senha, só escolhe o nome). **Para dar acesso a todas as unidades** (gerente/coordenador), coloque `TODAS` na coluna `UNIDADE` — veja a seção abaixo. |
| `CONFIG_RESPONSAVEIS` | Nomes selecionáveis no campo "Responsável" ao preencher um checklist — **não** são usuários do app, é só a lista de quem pode assinar o checklist. Podem ser cadastrados/removidos pelo próprio app, em Configurações (o admin faz isso direto pelo app, sem precisar abrir a planilha). |
| `EQUIPAMENTOS` | Frota cadastrada — nome, código, tipo, status (`em_uso`/`manutencao`/`parado`/`inativo`). `STATUS_DESDE` é preenchido automaticamente pelo backend toda vez que o status muda, e é o que permite calcular "há quanto tempo está parado" nos Relatórios. |
| `CHECKLISTS` / `CHECKLIST_ITENS` | Geradas automaticamente pelo formulário de checklist do app (7 itens fixos por checklist). |
| `NAO_CONFORMIDADES` | Geradas automaticamente só quando um item do checklist é reprovado (NOK) — não existe cadastro manual, por design. |
| `MANUTENCOES` | Corretivas e preventivas, com todo o fluxo de status (aberta → andamento → concluída) e os carimbos de data usados para calcular o tempo em manutenção. |
| `_SEQ` | Interna — controla a numeração dos IDs (EQP-000001, CHK-000001...). Não edite manualmente. |

Editar unidades, usuários, responsáveis e equipamentos **direto na planilha**
já reflete no app automaticamente (nada fica fixo no código).

---

## Admins com acesso a todas as unidades (Gerente, Coordenador)

1. Na aba `CONFIG_USUARIOS`, cadastre a linha normalmente, mas coloque **`TODAS`** (maiúsculo) na coluna `UNIDADE` em vez do nome de uma unidade específica.
2. No login, esse usuário aparece na lista de qualquer unidade escolhida primeiro (é só o ponto de partida).
3. Depois de logado, aparece um botão **"🔄 Trocar unidade"** no topo do app, disponível só para esses usuários — troca a unidade de trabalho instantaneamente, sem sair e logar de novo.
4. Mesmo com acesso a todas, o app sempre mostra os dados **de uma unidade por vez** (a que estiver selecionada no momento) — isso preserva o isolamento entre unidades; ele só tem a conveniência de trocar rápido entre elas.

---

## O que já está implementado

- Login em 2 ou 3 passos: Unidade → Usuário → Senha (só para ADMIN), sessão em memória (sem repetir unidade/usuário nos formulários).
- Isolamento total por unidade em todas as consultas, com opção de acesso multi-unidade para quem tem `UNIDADE = TODAS`.
- Menu por perfil: **Operador** vê Painel, Checklist, Abertura de manutenção, Preventivas e Histórico; **Administrador** vê tudo isso mais Equipamentos, Não conformidades, Relatórios e Configurações.
- **Checklist**: 7 itens fixos com instrução de como verificar cada um, resposta única OK/NOK/N-A, foto do equipamento obrigatória, e item NOK exige foto + descrição específica daquele item.
- **Não conformidade nasce só do checklist**: um item NOK abre automaticamente uma não conformidade vinculada a equipamento + item; se já existir uma aberta para o mesmo par, não duplica — só depois de fechada uma nova pode ser aberta.
- **Manutenção**: corretiva ou preventiva, com abertura automática, campos de início/conclusão condicionais ao mudar o status, e tempo total em manutenção calculado e mostrado.
- **Painel**: quantos equipamentos em funcionamento/parados/em manutenção, quais já fizeram o checklist do dia e quais estão pendentes, preventivas dos próximos 30 dias.
- **Relatórios** (administrador): filtro por Semana / Mês / Todo período / Personalizado, indicadores, gráfico de manutenções por status, ranking das máquinas que mais tempo acumularam em manutenção, lista das máquinas paradas agora com o tempo parado, tabelas detalhadas com exportação CSV, e um botão para **baixar um relatório completo em PDF** (gerado no próprio Google, com o mesmo estilo visual da ICC).
- **Histórico**: linha do tempo de checklists, manutenções e não conformidades, com filtro de período e equipamento.
- Fotos são enviadas em base64 (comprimidas no celular antes de enviar) e salvas automaticamente numa pasta do Google Drive (`CentralDeFrota_Fotos`), com o link salvo na planilha.

## O que ainda precisa de atenção (próximos incrementos)

- **Cadastro de unidades e usuários via app**: hoje isso é feito só pela planilha (`CONFIG_UNIDADES` / `CONFIG_USUARIOS`) — nenhuma tela de "criar unidade/usuário" foi feita no app, propositalmente (evita duas pessoas cadastrando ao mesmo tempo de formas diferentes). Responsáveis do checklist, esses sim, são cadastrados pelo próprio app.
- **Senhas de administrador** ficam em texto simples na planilha (mesma estrutura do "Gestão de Armazéns"). Dá para trocar por hash no futuro, se fizer sentido.
- **Fotos** ficam em resolução reduzida (comprimidas no celular antes do envio, para não estourar o limite do Apps Script) — funcionam bem para conferência, mas não são a foto original em resolução máxima.
- **Relatório em PDF**: em unidades com volume muito alto de registros, as tabelas do PDF mostram um recorte (as primeiras linhas, com uma nota de "mostrando X de Y") — os dados completos continuam disponíveis na tela de Relatórios e no CSV.
- Sem notificação automática (e-mail/push) quando algo é registrado — se fizer falta, dá para adicionar depois via `MailApp.sendEmail()` no `Code.gs`.

## Se quiser mudar algo no app depois

- **Backend** (regras, cálculos, planilha): edite `Code.gs`, cole no editor do Apps Script por cima do que já está lá, e crie uma **nova versão** da implantação (Implantar → Gerenciar implantações → ✏️ → Nova versão).
- **Frontend** (telas, textos, visual): edite `index.html` / `style.css` / `app.js` e suba os arquivos alterados de novo para o GitHub — o GitHub Pages publica a mudança automaticamente em alguns segundos/minutos.
