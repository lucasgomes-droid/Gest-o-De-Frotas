/* =====================================================
   CENTRAL DE FROTA — FRONTEND (ICC Brazil)
   SPA em JS puro (sem build tools). Fala com o backend em Google
   Apps Script via fetch(). A sessão vive só em memória (objeto S) —
   fechou o app, precisa logar de novo, igual ao app de referência.
   ===================================================== */

// >>> COLE AQUI A URL DO SEU APPS SCRIPT WEB APP <<<
const API_URL = 'https://script.google.com/macros/s/AKfycby65dQo0-IETCMgQEVYmkdtGlJYwWH0Av0HlGDBiKtTZ7B_vOIudVrBw2TzgR_-Q-1gJw/exec';

// Registra o service worker — necessário para o Android/Chrome oferecer
// a opção de instalar o site como app (ícone na tela + sem barra de endereço).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* PWA é bônus, não trava o app se falhar */ });
  });
}

// ------------------------- DICIONÁRIOS DE STATUS -------------------------
// Os valores da esquerda são exatamente os que o backend grava na planilha.

const STATUS_EQUIPAMENTO = {
  em_uso:     { label: 'Em uso',        cls: 'uso',     ic: '🟢' },
  manutencao: { label: 'Em manutenção', cls: 'manut',   ic: '🔧' },
  parado:     { label: 'Parado',        cls: 'parado',  ic: '🔴' },
  inativo:    { label: 'Inativo',       cls: 'inativo', ic: '⚪' }
};

const STATUS_MANUTENCAO = {
  aberta:    { label: 'Aberta',           cls: 'aberta' },
  acionado:  { label: 'Técnico acionado', cls: 'acionado' },
  andamento: { label: 'Em andamento',     cls: 'andamento' },
  concluida: { label: 'Finalizada',       cls: 'concluida' }
};
// Status que a não conformidade mostra depois que uma manutenção é aberta
// para ela — acompanha o chamado.
const FLUXO_NC_MANUTENCAO = {
  aberta:    { label: 'Manutenção aberta',     cls: 'aberta' },
  acionado:  { label: 'Técnico acionado',      cls: 'acionado' },
  andamento: { label: 'Em manutenção',         cls: 'andamento' },
  concluida: { label: 'Manutenção finalizada', cls: 'concluida' }
};
// [OUT/2026] Fluxo do chamado: aberta → técnico acionado → em andamento →
// finalizada. Quem abre é o Operador; quem move o status é o Administrador.
const FLUXO_MANUTENCAO = ['aberta', 'acionado', 'andamento', 'concluida'];
const ACAO_PROXIMO_STATUS = {
  acionado: '📞 Acionar técnico',
  andamento: '🔧 Iniciar manutenção',
  concluida: '✓ Finalizar manutenção'
};

const PRIORIDADE_MANUTENCAO = {
  baixa: { label: 'Baixa', cls: 'baixa' },
  media: { label: 'Média', cls: 'media' },
  alta:  { label: 'Alta',  cls: 'alta' }
};

// [OUT/2026] Setor — segundo nível de separação, logo abaixo da unidade.
// Os valores da esquerda são os gravados na planilha (coluna SETOR).
const SETORES = {
  FABRICA: { label: 'Fábrica', ic: '🏭', sub: 'Equipamentos e manutenções da fábrica' },
  OPERACAO: { label: 'Operação', ic: '🚜', sub: 'Equipamentos e manutenções da operação' }
};
function setorLabel(valor) {
  const s = SETORES[String(valor || '').toUpperCase()];
  return s ? s.label : (valor || '—');
}
// "Macatuba · Operação" — usado nos títulos das telas.
function unidadeSetorLabel() {
  return S.unidade.UNIDADE + (S.setor ? ' · ' + setorLabel(S.setor) : '');
}

const RESPOSTA_CHECKLIST = {
  ok:  { label: 'OK',  cls: 'ok' },
  nok: { label: 'NOK', cls: 'nok' },
  na:  { label: 'N/A', cls: 'na' }
};

const STATUS_CHECKLIST = {
  ok:        { label: 'Sem pendência', cls: 'ok' },
  pendencia: { label: 'Com pendência', cls: 'nok' }
};

// ------------------------- API -------------------------
// Ações que começam com "get" vão por GET (querystring); todo o resto vai
// por POST com corpo JSON em text/plain — text/plain evita o preflight CORS
// que quebraria a chamada vinda do GitHub Pages.

// Tempo máximo esperando resposta do Apps Script antes de desistir e avisar
// o usuário (em vez de deixar a tela girando pra sempre). O Apps Script às
// vezes demora pra "acordar" (cold start) ou fica na fila — mas nunca deveria
// passar disso; se passar, é melhor avisar e permitir tentar de novo do que
// parecer que o app travou.
const API_TIMEOUT_MS = 30000;

// [PERF 17/09] Gerar PDF (Slides + gráficos + Drive) é sempre mais lento
// que uma leitura normal — ainda mais agora que o relatório geral e o
// executivo ganharam seções novas (mais cálculo, mais páginas). Usar o
// mesmo limite de 25s pra isso fazia o app desistir enquanto o Apps
// Script ainda estava terminando de montar o PDF (não travado, só
// demorado) — daí a mensagem de timeout e precisar tentar de novo. Essas
// ações específicas ganham um tempo de espera bem maior.
const ACOES_LENTAS_TIMEOUT_MS = {
  gerarRelatorioPDF: 170000,
  gerarRelatorioExecutivoPDF: 170000,
  // [ESTABILIDADE OUT/2026] Relatórios e histórico leem várias abas inteiras,
  // e checklist/lavagem sobem fotos: ganham mais tempo antes de desistir.
  getRelatorio: 70000,
  getRelatorioExecutivo: 70000,
  getRelatorioGas: 60000,
  getHistorico: 60000,
  getVisaoGeralUnidades: 60000,
  createChecklist: 70000,
  createLavagem: 70000
};

// ------------------------- [ESTABILIDADE OUT/2026] REDE -------------------------
// 1. Trocar de tela cancela as leituras da tela anterior: elas não ocupam
//    mais o servidor e a resposta atrasada não mexe na tela nova.
// 2. A mesma leitura repetida em até 20 s (ir e voltar entre abas) usa a
//    resposta guardada, sem ir ao servidor. Qualquer gravação apaga o que
//    estava guardado, então o que você salvou aparece na hora.
// 3. Resposta quebrada do servidor (página de erro do Google em vez de
//    dados), queda de rede ou servidor ocupado: o app tenta de novo sozinho
//    antes de mostrar erro. Só leituras, criações e login são repetidos —
//    criação tem proteção contra duplicidade, as outras gravações não.
let GERACAO_TELA = 0;
const LEITURAS_ABERTAS = [];
const LEITURAS_EM_CURSO = {};
const MEMO_LEITURA = {};
const MEMO_LEITURA_MS = 20000;
let ULTIMA_FALHA_LEITURA = 0;
const NUNCA = function () { return new Promise(function () {}); };
function esperar(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

function cancelarLeiturasDaTelaAnterior() {
  for (let i = LEITURAS_ABERTAS.length - 1; i >= 0; i--) {
    const l = LEITURAS_ABERTAS[i];
    if (l.geracao < GERACAO_TELA) {
      l.cancelada = true;
      try { l.controller.abort(); } catch (e) { /* já terminou */ }
      LEITURAS_ABERTAS.splice(i, 1);
    }
  }
}

function limparMemoLeitura() {
  Object.keys(MEMO_LEITURA).forEach(function (k) { delete MEMO_LEITURA[k]; });
}

function erroDeRede(tipo, mensagem) {
  const e = new Error(mensagem);
  e.tipo = tipo;
  return e;
}

// Uma ida ao servidor. Devolve os dados, ou lança um erro com .tipo:
// 'cancelada' | 'timeout' | 'rede' | 'resposta' | 'ocupado' | 'aplicacao'.
async function irAoServidor(action, envio, isRead, timeoutMs, geracao) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw erroDeRede('rede', 'Sem internet. Confira a conexão e tente de novo.');
  }
  const registro = { controller: new AbortController(), geracao: geracao, cancelada: false };
  if (isRead) LEITURAS_ABERTAS.push(registro);
  const timeoutId = setTimeout(function () { registro.estourou = true; registro.controller.abort(); }, timeoutMs);
  try {
    let res;
    if (isRead) {
      const q = Object.assign({ action: action }, flattenParams(envio));
      if (S.token) q.token = S.token;
      res = await fetch(API_URL + '?' + new URLSearchParams(q).toString(), { signal: registro.controller.signal });
    } else {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS
        body: JSON.stringify({ action: action, payload: envio, token: S.token || '' }),
        signal: registro.controller.signal
      });
    }
    const texto = await res.text();
    let json;
    try { json = JSON.parse(texto); }
    catch (e) {
      // O Google devolveu uma página (erro, limite de uso, autorização) em
      // vez dos dados. Fica registrado no console para diagnóstico.
      console.error('[Central de Frota] Resposta inesperada em ' + action + ' (HTTP ' + res.status + '): ' + String(texto).slice(0, 300));
      throw erroDeRede('resposta', 'O servidor não respondeu direito agora. Tente de novo em instantes.');
    }
    if (!json || json.ok !== true) {
      const msg = (json && json.error) || 'Erro desconhecido';
      throw erroDeRede(msg.indexOf('servidor está ocupado') > -1 ? 'ocupado' : 'aplicacao', msg);
    }
    return json.data;
  } catch (err) {
    if (err && err.tipo) throw err;
    if (registro.cancelada) throw erroDeRede('cancelada', 'cancelada');
    if (err && err.name === 'AbortError') throw erroDeRede('timeout', 'O servidor demorou muito pra responder. Tente novamente.');
    throw erroDeRede('rede', 'Não foi possível falar com o servidor. Confira a internet e tente de novo.');
  } finally {
    clearTimeout(timeoutId);
    const i = LEITURAS_ABERTAS.indexOf(registro);
    if (i > -1) LEITURAS_ABERTAS.splice(i, 1);
  }
}

// [OUT/2026] Cada registro novo (ações "create...") leva um idRequisicao.
// Se o envio for repetido — automático depois de um timeout, ou manual —
// o servidor reconhece o mesmo id e devolve o resultado da primeira vez,
// em vez de gravar em duplicidade.
const REQ_IDS = {};
function hashTexto(texto) {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) | 0;
  return String(h) + '_' + texto.length;
}
function novoIdRequisicao() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

async function api(action, payload) {
  if (API_URL.indexOf('COLE_A_URL') > -1) {
    toast('Configure a API_URL no topo do app.js', true);
    throw new Error('API_URL não configurada');
  }
  const isRead = action.indexOf('get') === 0;
  const ehCriacao = action.indexOf('create') === 0;
  const ehLogin = action.indexOf('login') === 0;
  const geracao = GERACAO_TELA;
  let chaveReq = null;
  let envio = payload;
  // [OUT/2026] Todo pedido leva o setor escolhido no login, do mesmo jeito
  // que leva a unidade — o servidor só devolve/grava o que é daquele setor.
  // Quem já informa o setor por conta própria (cadastro de equipamento)
  // não é sobrescrito.
  if (S.setor && !(payload && payload.setor)) {
    payload = Object.assign({}, payload, { setor: S.setor });
    envio = payload;
  }
  if (ehCriacao) {
    chaveReq = action + '|' + hashTexto(JSON.stringify(payload || {}));
    if (!REQ_IDS[chaveReq]) REQ_IDS[chaveReq] = novoIdRequisicao();
    envio = Object.assign({}, payload, { idRequisicao: REQ_IDS[chaveReq] });
  }

  // Leitura repetida há pouco: usa a resposta guardada. Leitura idêntica
  // ainda em andamento nesta mesma tela: espera a mesma, sem pedir de novo.
  let chaveLeitura = null;
  if (isRead) {
    chaveLeitura = action + '|' + JSON.stringify(flattenParams(envio)) + '|' + (S.token || '');
    const guardado = MEMO_LEITURA[chaveLeitura];
    if (guardado && Date.now() - guardado.em < MEMO_LEITURA_MS) return JSON.parse(guardado.dados);
    const emCurso = LEITURAS_EM_CURSO[geracao + '|' + chaveLeitura];
    if (emCurso) return emCurso.then(function (texto) { return JSON.parse(texto); });
  }

  const timeoutMs = ACOES_LENTAS_TIMEOUT_MS[action] || API_TIMEOUT_MS;
  const podeRepetir = isRead || ehCriacao || ehLogin;
  const pausas = [1200, 3000];

  const tentar = async function () {
    let repeticoesRede = 0, repeticoesTimeout = 0;
    for (;;) {
      try {
        return await irAoServidor(action, envio, isRead, timeoutMs, geracao);
      } catch (err) {
        if (err.tipo === 'cancelada') throw err;
        const falhaPassageira = err.tipo === 'rede' || err.tipo === 'resposta' || err.tipo === 'ocupado';
        if (podeRepetir && falhaPassageira && repeticoesRede < pausas.length) {
          await esperar(pausas[repeticoesRede++]);
          if (isRead && geracao !== GERACAO_TELA) throw erroDeRede('cancelada', 'cancelada');
          continue;
        }
        // Timeout: leitura e criação (protegida por idRequisicao) repetem uma vez.
        if (err.tipo === 'timeout' && (isRead || ehCriacao) && repeticoesTimeout < 1) {
          repeticoesTimeout++;
          if (isRead && geracao !== GERACAO_TELA) throw erroDeRede('cancelada', 'cancelada');
          continue;
        }
        throw err;
      }
    }
  };

  let promessaTexto = null;
  if (isRead) {
    // Guarda o resultado como texto: cada tela recebe a sua própria cópia.
    promessaTexto = tentar().then(function (dados) { return JSON.stringify(dados === undefined ? null : dados); });
    LEITURAS_EM_CURSO[geracao + '|' + chaveLeitura] = promessaTexto;
    promessaTexto.then(function () {}, function () {}).then(function () { delete LEITURAS_EM_CURSO[geracao + '|' + chaveLeitura]; });
  }

  try {
    let dados;
    if (isRead) {
      const texto = await promessaTexto;
      MEMO_LEITURA[chaveLeitura] = { em: Date.now(), dados: texto };
      // Chegou, mas a pessoa já trocou de tela: fica guardado para a próxima
      // vez e não mexe na tela atual.
      if (geracao !== GERACAO_TELA) return NUNCA();
      dados = JSON.parse(texto);
    } else {
      dados = await tentar();
      // Gravou alguma coisa: nada do que estava guardado vale mais.
      if (action.indexOf('gerar') !== 0) limparMemoLeitura();
    }
    if (chaveReq) delete REQ_IDS[chaveReq];
    return dados;
  } catch (err) {
    // A pessoa já saiu daquela tela: a resposta não interessa mais e quem
    // estava esperando simplesmente para ali, sem erro e sem mexer na tela nova.
    if (err.tipo === 'cancelada') return NUNCA();
    if (err.message && err.message.indexOf('Sessão expirada') === 0 && S.usuario) {
      resetSession();
      render();
      toast('Sua sessão expirou. Entre novamente.', true);
      throw err;
    }
    if (isRead) ULTIMA_FALHA_LEITURA = Date.now();
    const msg = err.message || 'Erro de conexão com a planilha';
    toast(msg, true);
    throw new Error(msg);
  }
}

function flattenParams(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(function (k) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '' && typeof obj[k] !== 'object') out[k] = obj[k];
  });
  return out;
}

// ------------------------- STATE -------------------------

const S = {
  unidade: null,        // {ID_UNIDADE, UNIDADE}
  setor: null,          // 'FABRICA' | 'OPERACAO' — escolhido no login, depois da unidade
  cargo: null,          // 'ADMIN' | 'OPERADOR' — escolhido no login, antes do usuário
  usuario: null,        // {ID_USUARIO, NOME, USUARIO, TIPO, UNIDADE}
  token: null,          // token de sessão devolvido pelo servidor no login
  screen: 'loginUnidade',
  pendingUser: null,
  cache: {},            // listas que não mudam a toda hora (tipos, itens modelo)
  equipamentoAtual: null,
  manutencaoAtual: null,
  checklistAtual: null,
  checklistEquipamentoId: null,
  voltarPara: null,
  filtros: {}
};

function resetSession() {
  limparMemoLeitura();
  S.unidade = null;
  S.setor = null;
  S.cargo = null;
  S.usuario = null;
  S.token = null;
  S.manutencaoPrefill = null;
  try { sessionStorage.removeItem(CHAVE_SESSAO); } catch (e) { /* sem armazenamento: segue */ }
  S.screen = 'loginUnidade';
  S.pendingUser = null;
  S.cache = {};
  S.equipamentoAtual = null;
  S.manutencaoAtual = null;
  S.checklistAtual = null;
  S.checklistEquipamentoId = null;
  S.voltarPara = null;
  S.filtros = {};
  document.getElementById('topbar').hidden = true;
  document.getElementById('tabbar').hidden = true;
}

// [OUT/2026] A sessão fica guardada enquanto a aba estiver aberta: atualizar
// a página (F5) não desloga mais. Fechou a aba, precisa entrar de novo.
const CHAVE_SESSAO = 'centralDeFrota_sessao';
function salvarSessao() {
  try {
    sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify({
      unidade: S.unidade, setor: S.setor, cargo: S.cargo, usuario: S.usuario, token: S.token
    }));
  } catch (e) { /* sem armazenamento: o app funciona igual, só não lembra no F5 */ }
}
function restaurarSessao() {
  try {
    const bruto = sessionStorage.getItem(CHAVE_SESSAO);
    if (!bruto) return;
    const s = JSON.parse(bruto);
    // Sessão guardada antes de existir setor não é reaproveitada: a pessoa
    // passa pelo login de novo e escolhe o setor.
    if (s && s.token && s.usuario && s.unidade && SETORES[s.setor]) {
      S.unidade = s.unidade; S.setor = s.setor; S.cargo = s.cargo; S.usuario = s.usuario; S.token = s.token;
      S.screen = 'painel';
    }
  } catch (e) { /* dado inválido: começa do login */ }
}

function ehAdmin() { return S.usuario && S.usuario.TIPO === 'ADMIN'; }

// ------------------------- HELPERS DE UI -------------------------

const app = document.getElementById('app');

function go(screen, extra) {
  S.screen = screen;
  if (extra) Object.assign(S, extra);
  render();
  window.scrollTo(0, 0);
}

function toast(msg, isError, isSuccess) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast is-show' + (isError ? ' is-error' : isSuccess ? ' is-success' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(function () { t.className = 'toast'; }, 4000);
}

function el(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstElementChild;
}

// Insere um HTML que pode ter VÁRIOS elementos irmãos no topo (el() só
// devolveria o primeiro e descartaria o resto).
function appendHtml(container, html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html.trim();
  while (tmp.firstChild) container.appendChild(tmp.firstChild);
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Renderiza lista longa em páginas de N itens, com "Carregar mais" no fim.
function renderPaginado(container, items, renderItem, pageSize) {
  pageSize = pageSize || 20;
  let shown = 0;
  const btnWrap = el('<div style="text-align:center;margin-top:8px"></div>');

  function loadMore() {
    const next = items.slice(shown, shown + pageSize);
    next.forEach(function (item) { container.insertBefore(renderItem(item), btnWrap); });
    shown += next.length;
    btnWrap.innerHTML = '';
    if (shown < items.length) {
      const btn = el('<button class="btn btn--outline btn--sm">Carregar mais (' + shown + ' de ' + items.length + ')</button>');
      btn.onclick = loadMore;
      btnWrap.appendChild(btn);
    }
  }
  container.appendChild(btnWrap);
  loadMore();
}

// ------------------------- DATAS -------------------------
// O backend manda e recebe texto ISO com fuso (ex: 2026-09-10T14:32:00-03:00).

function parseIso(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtData(valor) {
  const d = parseIso(valor);
  if (!d) return '—';
  return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
}

function fmtDataHora(valor) {
  const d = parseIso(valor);
  if (!d) return '—';
  return fmtData(valor) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// Data/hora local -> texto ISO com fuso, do jeito que o backend guarda.
function toIsoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sinal = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    sinal + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

// Valor de <input type="datetime-local"> -> ISO com fuso.
function inputDateTimeParaIso(valor) {
  if (!valor) return '';
  const d = new Date(valor);
  return isNaN(d.getTime()) ? '' : toIsoLocal(d);
}

// Preenche <input type="datetime-local"> (formato yyyy-MM-ddTHH:mm).
function paraInputDateTime(valor) {
  const d = parseIso(valor) || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// Preenche <input type="date"> (formato yyyy-MM-dd).
function paraInputDate(valor) {
  const d = parseIso(valor);
  if (!d) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// ------------------------- FOTOS -------------------------

function fileToDataUrl(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Foto de celular vira facilmente um base64 de vários MB — o que estoura o
// limite de payload do Apps Script. Antes de enviar, reduz o maior lado para
// 1280px e recomprime em JPEG. Se der qualquer problema, cai de volta na
// imagem original em vez de impedir o registro.
async function fotoParaDataUrl(file) {
  const original = await fileToDataUrl(file);
  try {
    // O timeout evita que uma imagem que nunca decodifica deixe o botão
    // travado em "Processando foto…" para sempre.
    const img = await new Promise(function (resolve, reject) {
      const i = new Image();
      const limite = setTimeout(function () { reject(new Error('timeout')); }, 8000);
      i.onload = function () { clearTimeout(limite); resolve(i); };
      i.onerror = function () { clearTimeout(limite); reject(new Error('erro ao ler a imagem')); };
      i.src = original;
    });
    const MAX = 1280;
    const escala = Math.min(1, MAX / Math.max(img.width, img.height));
    if (escala === 1 && original.length < 900000) return original;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * escala);
    canvas.height = Math.round(img.height * escala);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  } catch (e) {
    return original;
  }
}

// Campo de UMA foto (o contrato da API pede uma data URL por campo).
function photoField(container, opts) {
  opts = opts || {};
  let foto = opts.initial || null;

  const wrap = el('<div class="photo-input"></div>');
  container.appendChild(wrap);

  function abrirSeletor() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.onchange = async function (e) {
      const file = (e.target.files || [])[0];
      if (file) {
        wrap.querySelectorAll('.photo-btn').forEach(function (b) { b.textContent = 'Processando foto…'; });
        foto = await fotoParaDataUrl(file);
      }
      document.body.removeChild(input);
      refresh();
    };
    document.body.appendChild(input);
    input.click();
  }

  function refresh() {
    wrap.innerHTML = '';
    wrap.appendChild(el('<label style="font-size:13px;font-weight:600;color:var(--ink-soft)">' +
      escapeHtml(opts.label || 'Foto') + (opts.required ? ' *' : '') + '</label>'));
    if (foto) {
      const thumbWrap = el('<div style="position:relative"></div>');
      thumbWrap.appendChild(el('<img class="photo-preview" src="' + foto + '" alt="Foto">'));
      const rm = el('<button type="button" class="photo-thumb__rm" style="top:8px;right:8px" aria-label="Remover foto">✕</button>');
      rm.onclick = function () { foto = null; refresh(); };
      thumbWrap.appendChild(rm);
      wrap.appendChild(thumbWrap);
      const trocar = el('<button type="button" class="btn btn--outline btn--sm" style="align-self:flex-start">📷 Trocar foto</button>');
      trocar.onclick = abrirSeletor;
      wrap.appendChild(trocar);
    } else {
      const btn = el('<div class="photo-btn' + (opts.required ? ' required' : '') + '">📷 Toque para tirar foto ou escolher da galeria' +
        (opts.required ? ' (obrigatória)' : '') + '</div>');
      btn.onclick = abrirSeletor;
      wrap.appendChild(btn);
    }
  }

  refresh();
  return { node: wrap, getValue: function () { return foto; } };
}

// Mostra uma foto já salva (o backend guarda o link do Drive).
function fotoSalva(url, alt) {
  if (!url) return '';
  return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' +
    '<img class="photo-preview" src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt || 'Foto') + '" loading="lazy">' +
    '</a>';
}

// ------------------------- CAMPOS DE FORMULÁRIO -------------------------

function textField(container, opts) {
  opts = opts || {};
  const id = 'f_' + Math.random().toString(36).slice(2);
  const tag = opts.multiline ? 'textarea' : 'input';
  const wrap = el(
    '<div class="field">' +
      '<label for="' + id + '">' + escapeHtml(opts.label) + (opts.required ? ' *' : '') + '</label>' +
      '<' + tag + ' id="' + id + '" ' + (opts.type ? 'type="' + opts.type + '"' : '') +
        ' placeholder="' + escapeHtml(opts.placeholder || '') + '"></' + tag + '>' +
      (opts.hint ? '<span class="hint">' + escapeHtml(opts.hint) + '</span>' : '') +
    '</div>'
  );
  container.appendChild(wrap);
  const input = wrap.querySelector(tag);
  if (opts.value !== undefined && opts.value !== null && opts.value !== '') input.value = opts.value;
  return {
    node: wrap, input: input,
    getValue: function () { return String(input.value || '').trim(); },
    setValue: function (v) { input.value = v == null ? '' : v; }
  };
}

function selectField(container, opts) {
  const id = 's_' + Math.random().toString(36).slice(2);
  const optionsHtml = (opts.semVazio ? [] : ['<option value="">' + escapeHtml(opts.placeholder || 'Selecione…') + '</option>'])
    .concat((opts.options || []).map(function (o) {
      const sel = (opts.value !== undefined && String(opts.value) === String(o.value)) ? ' selected' : '';
      return '<option value="' + escapeHtml(o.value) + '"' + sel + '>' + escapeHtml(o.label) + '</option>';
    })).join('');
  const wrap = el(
    '<div class="field">' +
      '<label for="' + id + '">' + escapeHtml(opts.label) + (opts.required ? ' *' : '') + '</label>' +
      '<select id="' + id + '">' + optionsHtml + '</select>' +
      (opts.hint ? '<span class="hint">' + escapeHtml(opts.hint) + '</span>' : '') +
    '</div>'
  );
  container.appendChild(wrap);
  const select = wrap.querySelector('select');
  return {
    node: wrap, select: select,
    getValue: function () { return select.value; },
    setValue: function (v) { select.value = v == null ? '' : v; }
  };
}

// Escolha única entre N opções, no visual dos botões grandes (option-grid).
function choiceField(container, opts) {
  const cols = opts.columns || opts.options.length;
  const wrap = el(
    '<div class="field">' +
      '<label>' + escapeHtml(opts.label) + (opts.required ? ' *' : '') + '</label>' +
      '<div class="option-grid" style="grid-template-columns:repeat(' + cols + ',1fr)">' +
        opts.options.map(function (o, i) {
          return '<button type="button" class="option-btn ' + (o.cls || '') + '" data-i="' + i + '">' + escapeHtml(o.label) + '</button>';
        }).join('') +
      '</div>' +
    '</div>'
  );
  let value = opts.value || null;
  const btns = wrap.querySelectorAll('.option-btn');
  btns.forEach(function (b, i) {
    if (value !== null && String(opts.options[i].value) === String(value)) b.classList.add('is-selected');
    b.onclick = function () {
      value = opts.options[i].value;
      btns.forEach(function (x) { x.classList.remove('is-selected'); });
      b.classList.add('is-selected');
      wrap.dispatchEvent(new CustomEvent('change'));
    };
  });
  container.appendChild(wrap);
  return { node: wrap, getValue: function () { return value; } };
}

// ------------------------- BLOCOS VISUAIS -------------------------

function screenHeader(eyebrow, title, subtitle) {
  return '<div class="stack" style="gap:4px;margin-bottom:4px">' +
    '<span class="eyebrow">' + escapeHtml(eyebrow) + '</span>' +
    '<h1 class="title-xl">' + escapeHtml(title) + '</h1>' +
    (subtitle ? '<p class="subtle">' + escapeHtml(subtitle) + '</p>' : '') +
    '</div>';
}

function botaoVoltar(screen, label) {
  const btn = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start;margin-top:-6px">← ' + escapeHtml(label || 'Voltar') + '</button>');
  btn.onclick = function () { go(screen); };
  return btn;
}

function menuCard(icon, title, sub, screen) {
  return '<button type="button" class="list-item" style="width:100%;padding:16px" data-go="' + screen + '">' +
    '<span class="row" style="gap:12px"><span style="font-size:22px">' + icon + '</span>' +
    '<span><span class="list-item__title">' + escapeHtml(title) + '</span><div class="list-item__sub">' + escapeHtml(sub) + '</div></span></span>' +
    '<span>›</span></button>';
}

function bindMenuCards() {
  app.querySelectorAll('[data-go]').forEach(function (b) {
    b.onclick = function () { go(b.dataset.go); };
  });
}

function kpi(value, label, cls) {
  return '<div class="kpi ' + (cls || '') + '"><span class="badge-count">' + escapeHtml(value) + '</span>' +
    '<span class="subtle">' + escapeHtml(label) + '</span></div>';
}

function barCard(title, dataObj, subtitulo) {
  const entries = Object.entries(dataObj || {}).sort(function (a, b) { return b[1] - a[1]; });
  const card = el('<div class="card stack"><h3 class="title-lg">' + escapeHtml(title) + '</h3>' +
    (subtitulo ? '<p class="subtle" style="margin-top:-6px">' + escapeHtml(subtitulo) + '</p>' : '') + '</div>');
  if (!entries.length) { card.appendChild(el('<p class="subtle">Sem dados no período.</p>')); return card; }
  const max = entries[0][1] || 1;
  entries.forEach(function (e) {
    card.appendChild(el(
      '<div class="bar-row"><span class="label">' + escapeHtml(e[0]) + '</span>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(4, (e[1] / max) * 100) + '%"></div></div>' +
      '<span class="bar-val">' + escapeHtml(e[1]) + '</span></div>'
    ));
  });
  return card;
}

function tagEquipamento(status) {
  const info = STATUS_EQUIPAMENTO[status] || { label: status || '—', cls: 'inativo' };
  return '<span class="tag tag--' + info.cls + '">' + escapeHtml(info.label) + '</span>';
}

function tagManutencao(status) {
  const info = STATUS_MANUTENCAO[status] || { label: status || '—', cls: 'aberta' };
  return '<span class="tag tag--' + info.cls + '">' + escapeHtml(info.label) + '</span>';
}

function tagPrioridade(prioridade) {
  const info = PRIORIDADE_MANUTENCAO[prioridade] || { label: prioridade || '—', cls: 'media' };
  return '<span class="tag tag--' + info.cls + '">' + escapeHtml(info.label) + '</span>';
}

function linhaInfo(label, valorHtml) {
  return '<div class="row between" style="gap:12px;align-items:flex-start">' +
    '<span class="subtle" style="flex:0 0 auto">' + escapeHtml(label) + '</span>' +
    '<span style="text-align:right;font-size:14px">' + valorHtml + '</span></div>';
}

function vazio(icone, texto) {
  // [ESTABILIDADE OUT/2026] Lista "vazia" logo depois de uma falha de
  // leitura não é lista vazia: é dado que não chegou. Mostra isso e
  // oferece tentar de novo, em vez de dizer que não há nada.
  if (Date.now() - ULTIMA_FALHA_LEITURA < 3000) return blocoFalhaCarregar();
  return '<div class="empty"><span class="ic">' + icone + '</span>' + escapeHtml(texto) + '</div>';
}

function blocoFalhaCarregar() {
  return '<div class="empty"><span class="ic">📡</span>Não foi possível carregar agora.' +
    '<div style="margin-top:10px"><button type="button" class="btn btn--outline btn--sm" onclick="render()">↻ Tentar de novo</button></div></div>';
}

// ------------------------- DOWNLOADS (CSV / PDF) -------------------------
// Não existe action de export no backend: o CSV é montado aqui mesmo, a
// partir dos arrays que a tela já carregou.

function downloadCSV(filename, colunas, linhas) {
  const esc = function (v) {
    v = (v === undefined || v === null) ? '' : String(v);
    if (v.indexOf(';') > -1 || v.indexOf('"') > -1 || v.indexOf('\n') > -1) {
      v = '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  };
  const out = [colunas.map(function (c) { return esc(c[1]); }).join(';')];
  linhas.forEach(function (linha) {
    out.push(colunas.map(function (c) {
      const bruto = linha[c[0]];
      return esc(c[2] ? c[2](bruto, linha) : bruto);
    }).join(';'));
  });
  // BOM + ponto e vírgula: abre certinho no Excel em português.
  const csv = '﻿' + out.join('\r\n');
  dispararDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), filename);
  toast('Arquivo CSV baixado!', false, true);
}

function downloadBase64File(filename, base64, mime) {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  dispararDownload(new Blob([bytes], { type: mime }), filename);
}

function dispararDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

function nomeArquivo(prefixo, extensao) {
  const hoje = new Date();
  return prefixo + '_' + String(S.unidade.UNIDADE).replace(/\s+/g, '_') + '_' +
    hoje.getFullYear() + '-' + pad2(hoje.getMonth() + 1) + '-' + pad2(hoje.getDate()) + '.' + extensao;
}

// ------------------------- CACHES DE APOIO -------------------------

// [ESTABILIDADE OUT/2026] A lista de equipamentos não fica mais guardada
// sem prazo: o status muda quando alguém abre ou finaliza uma manutenção, e
// a lista velha oferecia no checklist uma máquina que o servidor ia recusar
// (ou escondia uma que já tinha voltado). Agora vale a memória de 20 s do
// api(), que é apagada a cada gravação.
async function carregarEquipamentos(incluirInativos) {
  return api('getEquipamentos', {
    unidade: S.unidade.UNIDADE,
    incluirInativos: incluirInativos ? true : undefined
  }).catch(function () { return []; });
}

function limparCacheEquipamentos() { limparMemoLeitura(); }

async function carregarTiposEquipamento() {
  if (S.cache.tipos) return S.cache.tipos;
  const tipos = await api('getTiposEquipamento', {}).catch(function () {
    return ['Lavadoras de Piso Industrial', 'Empilhadeira', 'Paleteira Elétrica', 'Transpaleteira', 'Outro'];
  });
  S.cache.tipos = tipos;
  return tipos;
}

async function carregarResponsaveis() {
  const chave = 'resp_' + S.unidade.UNIDADE;
  if (S.cache[chave]) return S.cache[chave];
  const lista = await api('getResponsaveis', { unidade: S.unidade.UNIDADE }).catch(function () { return []; });
  S.cache[chave] = lista;
  return lista;
}

// Barra de filtro de período reutilizada em Histórico e Relatórios.
// Devolve { node, getValue() -> {periodo, dataInicio, dataFim} } e chama
// onChange() sempre que o usuário muda o período.
function filtroPeriodo(container, opts) {
  opts = opts || {};
  const wrap = el(
    '<div class="stack" style="gap:8px">' +
      '<div class="filters">' +
        '<select data-role="periodo">' +
          (opts.comTodos !== false ? '<option value="todos">Todo o período</option>' : '') +
          '<option value="semana">Últimos 7 dias</option>' +
          '<option value="mes">Últimos 30 dias</option>' +
          '<option value="custom">Período personalizado</option>' +
        '</select>' +
      '</div>' +
      '<div class="filters" data-role="custom" hidden>' +
        '<input type="date" data-role="ini">' +
        '<input type="date" data-role="fim">' +
        '<button class="btn btn--outline btn--sm" data-role="aplicar">Aplicar</button>' +
      '</div>' +
    '</div>'
  );
  container.appendChild(wrap);
  const sel = wrap.querySelector('[data-role="periodo"]');
  const custom = wrap.querySelector('[data-role="custom"]');
  const ini = wrap.querySelector('[data-role="ini"]');
  const fim = wrap.querySelector('[data-role="fim"]');
  sel.value = opts.value || (opts.comTodos !== false ? 'todos' : 'mes');

  sel.onchange = function () {
    custom.hidden = sel.value !== 'custom';
    if (sel.value !== 'custom' && opts.onChange) opts.onChange();
  };
  wrap.querySelector('[data-role="aplicar"]').onclick = function () {
    if (!ini.value && !fim.value) { toast('Escolha ao menos uma data', true); return; }
    if (opts.onChange) opts.onChange();
  };

  return {
    node: wrap,
    getValue: function () {
      return {
        periodo: sel.value,
        dataInicio: sel.value === 'custom' ? ini.value : undefined,
        dataFim: sel.value === 'custom' ? fim.value : undefined
      };
    }
  };
}

// ------------------------- BOOT -------------------------
// (a primeira chamada de render() fica no fim do arquivo, depois que o
// mapa de telas já foi definido)

document.getElementById('btnLogout').onclick = function () { resetSession(); render(); };

// ------------------------- ROTEADOR -------------------------

const SCREENS = {
  loginUnidade: renderLoginUnidade,
  loginSetor: renderLoginSetor,
  loginCargo: renderLoginCargo,
  loginUsuario: renderLoginUsuario,
  loginSenha: renderLoginSenha,

  painel: renderPainel,
  visaoGeral: renderVisaoGeralUnidades,

  checklists: renderChecklists,
  checklistNovo: renderChecklistNovo,
  checklistDetalhe: renderChecklistDetalhe,

  manutencoes: renderManutencoes,
  manutencaoForm: renderManutencaoForm,
  manutencaoDetalhe: renderManutencaoDetalhe,

  lavagemForm: renderLavagemForm,
  trocaGasForm: renderTrocaGasForm,

  preventivas: renderPreventivas,
  historico: renderHistorico,

  equipamentos: renderEquipamentos,
  equipamentoForm: renderEquipamentoForm,

  naoConformidades: renderNaoConformidades,
  relatorios: renderRelatorios,
  relatorioGas: renderRelatorioGas,
  relatorioExecutivo: renderRelatorioExecutivo,
  configuracoes: renderConfiguracoes,
  perguntas: renderPerguntas,
  mais: renderMais
};

// Telas que não são abas, mas devem manter a aba "pai" acesa.
const TAB_PAI = {
  checklistNovo: 'checklists',
  checklistDetalhe: 'checklists',
  manutencaoForm: 'manutencoes',
  manutencaoDetalhe: 'manutencoes',
  equipamentoForm: 'equipamentos',
  equipamentos: 'mais',
  naoConformidades: 'mais',
  configuracoes: 'mais',
  perguntas: 'mais'
};

// Telas restritas ao ADMIN — trava mesmo se alguém forçar a navegação.
// "mais" NÃO entra aqui: o Operador também acessa (Preventivas/Histórico),
// só que com um conteúdo diferente — ver renderMais().
const SCREENS_ADMIN = ['equipamentos', 'equipamentoForm', 'naoConformidades', 'relatorios', 'relatorioGas', 'relatorioExecutivo', 'configuracoes', 'perguntas', 'visaoGeral'];

function render() {
  // [ESTABILIDADE OUT/2026] Cada troca de tela ganha um número; as leituras
  // da tela anterior são canceladas (ver cancelarLeiturasDaTelaAnterior).
  GERACAO_TELA++;
  cancelarLeiturasDaTelaAnterior();
  const geracao = GERACAO_TELA;
  app.innerHTML = '';
  if (SCREENS_ADMIN.indexOf(S.screen) > -1 && !ehAdmin()) {
    S.screen = 'painel';
    toast('Área restrita ao administrador.', true);
  }
  // [OUT/2026] O Administrador não realiza checklist — só consulta os feitos.
  if (S.screen === 'checklistNovo' && ehAdmin()) S.screen = 'checklists';
  // Enquanto a unidade ativa for o sentinel "Todas as unidades", só a tela
  // de comparativo é permitida — pra registrar qualquer coisa (checklist,
  // manutenção, lavagem, gás) o gerente troca pra uma unidade específica
  // na própria barra de abas, que fica sempre visível.
  if (S.usuario && ehSentinelTodas_(S.unidade) && S.screen !== 'visaoGeral') {
    S.screen = 'visaoGeral';
  }
  const fn = SCREENS[S.screen] || renderLoginUnidade;
  // Tela que quebrar no meio não fica presa em "Carregando…": mostra o
  // aviso com o botão de tentar de novo.
  const telaFalhou = function (err) {
    console.error('[Central de Frota] Falha ao montar a tela ' + S.screen + ':', err);
    if (geracao !== GERACAO_TELA) return;
    app.querySelectorAll('p.subtle').forEach(function (p) {
      if (/^Carregando/.test(p.textContent)) p.remove();
    });
    app.appendChild(el(blocoFalhaCarregar()));
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') r.then(null, telaFalhou);
  } catch (err) { telaFalhou(err); }
  updateChrome();
}

function updateChrome() {
  const topbar = document.getElementById('topbar');
  const tabbar = document.getElementById('tabbar');
  if (!S.usuario) {
    topbar.hidden = true;
    tabbar.hidden = true;
    return;
  }
  topbar.hidden = false;
  salvarSessao();
  document.getElementById('topbarUnidade').textContent = unidadeSetorLabel();
  document.getElementById('topbarUsuario').textContent = S.usuario.NOME + ' · ' + (ehAdmin() ? 'Admin' : 'Operador');

  // Barra de abas de unidade — só existe pra quem tem UNIDADE = TODAS
  // (gerente/coordenador). Fica sempre visível, em qualquer tela, desde
  // logo depois do login.
  const unitsBar = document.getElementById('topbarUnits');
  if (souGerente_()) {
    unitsBar.hidden = false;
    if (S.cache.todasUnidadesLista) {
      renderBarraUnidadesGerente(S.cache.todasUnidadesLista);
    } else {
      api('getUnidades', {}).then(function (lista) {
        S.cache.todasUnidadesLista = lista;
        renderBarraUnidadesGerente(lista);
      }).catch(function () { /* toast já mostrado */ });
    }
  } else {
    unitsBar.hidden = true;
  }

  // Em "Todas as unidades" só existe a tela de comparativo — sem tabbar
  // de operação (Checklist/Manutenções/etc.), que não se aplica ali.
  if (ehSentinelTodas_(S.unidade)) {
    tabbar.hidden = true;
    return;
  }

  tabbar.hidden = false;
  const tabs = ehAdmin()
    ? [
        { s: 'painel', ic: '📊', label: 'Painel' },
        { s: 'manutencoes', ic: '🔧', label: 'Manutenções' },
        { s: 'relatorios', ic: '📈', label: 'Resumo' },
        { s: 'relatorioExecutivo', ic: '📊', label: 'Executivo' },
        { s: 'relatorioGas', ic: '⛽', label: 'Gás' },
        { s: 'mais', ic: '☰', label: 'Mais' }
      ]
    : [
        { s: 'painel', ic: '📊', label: 'Painel' },
        { s: 'checklists', ic: '✅', label: 'Checklist' },
        { s: 'manutencoes', ic: '🔧', label: 'Abertura' },
        { s: 'lavagemForm', ic: '🧽', label: 'Lavagem' },
        { s: 'trocaGasForm', ic: '⛽', label: 'Gás' },
        { s: 'mais', ic: '☰', label: 'Mais' }
      ];
  let ativa = TAB_PAI[S.screen] || S.screen;
  // Tela que não tem aba própria neste perfil (ex: Preventivas e Histórico,
  // que ficam dentro de "Mais" para os dois perfis) acende a aba "Mais".
  if (!tabs.some(function (t) { return t.s === ativa; })) {
    ativa = tabs.some(function (t) { return t.s === 'mais'; }) ? 'mais' : tabs[0].s;
  }
  tabbar.innerHTML = tabs.map(function (t) {
    return '<button class="' + (ativa === t.s ? 'is-active' : '') + '" data-s="' + t.s + '">' +
      '<span class="ic" style="position:relative">' + t.ic + '</span>' + t.label + '</button>';
  }).join('');
  tabbar.querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { go(b.dataset.s); };
  });
}

// ------------------------- LOGIN (unidade → usuário → senha) -------------------------

async function renderLoginUnidade() {
  app.appendChild(el(
    '<div class="screen" style="padding-top:8vh">' +
      '<div class="login-logo"><img src="logo.png" alt="ICC Brazil" class="mark"></div>' +
      '<h1 class="title-xl" style="text-align:center">Central de Frota</h1>' +
      '<p class="subtle" style="text-align:center;margin-bottom:8px">Selecione sua unidade para continuar</p>' +
      '<div class="card stack" id="unidadesList"><p class="subtle">Carregando unidades…</p></div>' +
    '</div>'
  ));
  try {
    const unidades = await api('getUnidades', {});
    const wrap = document.getElementById('unidadesList');
    wrap.innerHTML = '';
    if (!unidades.length) { wrap.innerHTML = '<p class="subtle">Nenhuma unidade ativa cadastrada.</p>'; return; }
    unidades.forEach(function (u) {
      const item = el('<button type="button" class="list-item" style="width:100%">' +
        '<span class="list-item__title">' + escapeHtml(u.UNIDADE) + '</span><span>›</span></button>');
      item.onclick = function () { S.unidade = u; S.setor = null; go('loginSetor'); };
      wrap.appendChild(item);
    });
  } catch (e) { /* toast já mostrado */ }
}

// [OUT/2026] Segundo passo do login: Fábrica ou Operação. Mesmo jeito da
// unidade — escolheu, o app inteiro só mostra o que é daquele setor.
function renderLoginSetor() {
  appendHtml(app,
    screenHeader('Login · ' + S.unidade.UNIDADE, 'Qual o setor?', 'Selecione o setor para continuar') +
    '<div class="stack" style="gap:12px">' +
      '<button class="btn btn--outline btn--sm" id="btnVoltarUnidadeSetor" style="align-self:flex-start;margin-top:-6px">← Trocar unidade</button>' +
      '<div class="card stack" id="setoresList"></div>' +
    '</div>'
  );
  document.getElementById('btnVoltarUnidadeSetor').onclick = function () { go('loginUnidade'); };
  const wrap = document.getElementById('setoresList');
  Object.keys(SETORES).forEach(function (k) {
    const item = el(
      '<button type="button" class="list-item" style="width:100%">' +
        '<span><span class="list-item__title">' + SETORES[k].ic + ' ' + escapeHtml(SETORES[k].label) + '</span>' +
        '<div class="list-item__sub">' + escapeHtml(SETORES[k].sub) + '</div></span>' +
        '<span>›</span>' +
      '</button>'
    );
    item.onclick = function () { S.setor = k; go('loginCargo'); };
    wrap.appendChild(item);
  });
}

function renderLoginCargo() {
  appendHtml(app,
    screenHeader('Login · ' + unidadeSetorLabel(), 'Qual o seu cargo?', 'Selecione como você vai acessar') +
    '<div class="stack" style="gap:12px">' +
      '<button class="btn btn--outline btn--sm" id="btnVoltarUnidadeCargo" style="align-self:flex-start;margin-top:-6px">← Trocar setor</button>' +
      '<div class="card stack">' +
        '<button type="button" class="list-item" id="btnCargoOperador" style="width:100%">' +
          '<span><span class="list-item__title">🧑‍🔧 Operador</span>' +
          '<div class="list-item__sub">Checklist, manutenções, preventivas</div></span>' +
          '<span>›</span>' +
        '</button>' +
        '<button type="button" class="list-item" id="btnCargoAdmin" style="width:100%">' +
          '<span><span class="list-item__title">🛡️ Administrador</span>' +
          '<div class="list-item__sub">Acesso completo · pede senha</div></span>' +
          '<span>›</span>' +
        '</button>' +
      '</div>' +
    '</div>'
  );
  document.getElementById('btnVoltarUnidadeCargo').onclick = function () { go('loginSetor'); };
  document.getElementById('btnCargoOperador').onclick = function () { S.cargo = 'OPERADOR'; go('loginUsuario'); };
  document.getElementById('btnCargoAdmin').onclick = function () { S.cargo = 'ADMIN'; go('loginUsuario'); };
}

async function renderLoginUsuario() {
  appendHtml(app,
    screenHeader('Login · ' + unidadeSetorLabel(), 'Quem é você?', 'Selecione seu usuário') +
    '<div class="stack" style="gap:12px">' +
      '<button class="btn btn--outline btn--sm" id="btnVoltarUnidade" style="align-self:flex-start;margin-top:-6px">← Voltar</button>' +
      '<div class="card stack" id="usuariosList"><p class="subtle">Carregando usuários…</p></div>' +
    '</div>'
  );
  document.getElementById('btnVoltarUnidade').onclick = function () { go('loginCargo'); };
  try {
    const todos = await api('getUsuarios', { unidade: S.unidade.UNIDADE });
    const usuarios = todos.filter(function (u) { return u.TIPO === S.cargo; });
    const wrap = document.getElementById('usuariosList');
    wrap.innerHTML = '';
    if (!usuarios.length) {
      wrap.innerHTML = '<p class="subtle">Nenhum usuário ' + (S.cargo === 'ADMIN' ? 'administrador' : 'operador') + ' ativo nesta unidade.</p>';
      return;
    }
    usuarios.forEach(function (u) {
      const item = el(
        '<button type="button" class="list-item" style="width:100%">' +
          '<span><span class="list-item__title">' + escapeHtml(u.NOME) + '</span>' +
          '<div class="list-item__sub">' + (u.TIPO === 'ADMIN' ? 'Administrador · pede senha' : 'Operador') +
          (String(u.UNIDADE).toUpperCase() === 'TODAS' ? ' · acesso a todas as unidades' : '') + '</div></span>' +
          '<span>›</span>' +
        '</button>'
      );
      item.onclick = function () {
        if (u.TIPO === 'ADMIN') {
          go('loginSenha', { pendingUser: u });
        } else {
          // Operador entra sem senha, mas o servidor abre uma sessão pra ele.
          item.disabled = true;
          api('loginOperador', { idUsuario: u.ID_USUARIO }).then(function (data) {
            S.token = data.token;
            S.usuario = data;
            go('painel');
          }).catch(function () { item.disabled = false; });
        }
      };
      wrap.appendChild(item);
    });
  } catch (e) { /* */ }
}

function renderLoginSenha() {
  const u = S.pendingUser;
  appendHtml(app,
    screenHeader('Login admin · ' + unidadeSetorLabel(), u.NOME, 'Digite sua senha para acessar a área administrativa') +
    '<div class="card stack">' +
      '<div class="field"><label for="inpSenha">Senha</label><input type="password" id="inpSenha" autofocus></div>' +
      '<button class="btn btn--primary btn--block" id="btnEntrar">Entrar</button>' +
      '<button class="btn btn--outline btn--block" id="btnVoltar">← Voltar</button>' +
    '</div>'
  );
  document.getElementById('btnVoltar').onclick = function () { go('loginUsuario'); };
  const btn = document.getElementById('btnEntrar');
  const input = document.getElementById('inpSenha');
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
  btn.onclick = async function () {
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      const data = await api('loginAdmin', { idUsuario: u.ID_USUARIO, senha: input.value });
      S.token = data.token;
      S.usuario = data;
      go('painel');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  };
}

// Unidade "virtual" usada só pelo usuário com UNIDADE = TODAS (gerente/
// coordenador) — nunca existe na planilha CONFIG_UNIDADES; é só o sentinel
// que, ao ser escolhido, joga o app pra tela de comparativo consolidado.
const UNIDADE_TODAS_OBJ = { ID_UNIDADE: 'TODAS', UNIDADE: 'Todas as Unidades' };

function ehSentinelTodas_(u) { return String((u || {}).ID_UNIDADE).toUpperCase() === 'TODAS'; }
function souGerente_() { return !!S.usuario && ehAdmin() && String(S.usuario.UNIDADE).toUpperCase() === 'TODAS'; }

// Barra de abas do gerente (uma por unidade real + "Todas as unidades"),
// sempre visível embaixo da barra superior desde o login — é a troca de
// unidade em si, sem precisar entrar em nenhuma tela extra pra isso.
function renderBarraUnidadesGerente(unidades) {
  const wrap = document.getElementById('topbarUnits');
  const itens = unidades.concat([UNIDADE_TODAS_OBJ]);
  const atualId = String((S.unidade || {}).ID_UNIDADE || (S.unidade || {}).UNIDADE || '').toUpperCase();
  wrap.innerHTML = itens.map(function (u) {
    const todas = ehSentinelTodas_(u);
    const id = String(u.ID_UNIDADE || u.UNIDADE).toUpperCase();
    const ativo = id === atualId;
    return '<button type="button" class="' + (ativo ? 'is-active ' : '') + (todas ? 'is-todas' : '') + '">' +
      (todas ? '🌐 ' : '') + escapeHtml(u.UNIDADE) + '</button>';
  }).join('');
  wrap.querySelectorAll('button').forEach(function (btn, i) {
    btn.onclick = function () {
      const u = itens[i];
      const id = String(u.ID_UNIDADE || u.UNIDADE).toUpperCase();
      if (id === atualId) return; // já está nela
      S.unidade = u;
      S.cache = {};
      go(ehSentinelTodas_(u) ? 'visaoGeral' : 'painel');
    };
  });
}

// ------------------------- TODAS AS UNIDADES (GERENTE) -------------------------
// Visão consolidada pra quem tem acesso a todas as unidades: comparativo
// visual (máquinas ativas/manutenção/paradas, unidade por unidade) e o
// relatório único de todas as unidades juntas. Sem escrita nenhuma aqui —
// pra registrar qualquer coisa, o gerente troca pra uma unidade específica
// na própria barra de abas.
async function renderVisaoGeralUnidades() {
  appendHtml(app, screenHeader('Gerente · Todas as unidades', 'Visão geral',
    'Comparativo em tempo real de todas as unidades ativas'));

  const topo = el('<div class="card stack" style="gap:10px"></div>');
  app.appendChild(topo);
  topo.appendChild(el('<h3 class="title-lg" style="font-size:15px">📄 Relatório de todas as unidades</h3>' +
    '<p class="subtle" style="margin-top:-6px">Manutenção + Lavagem + Troca de gás de todas as unidades, num PDF só</p>'));
  const periodo = filtroPeriodo(topo, { comTodos: true, value: 'mes', onChange: function () { carregarComparativo(); carregarExecutivoGestao(); } });
  const btnPdf = el('<button class="btn btn--accent btn--block">📄 Emitir relatório de todas as unidades</button>');
  topo.appendChild(btnPdf);
  btnPdf.onclick = async function () {
    btnPdf.disabled = true;
    btnPdf.innerHTML = '<span class="spinner" style="border-color:rgba(58,37,6,.3);border-top-color:#3a2506"></span> Gerando PDF de todas as unidades…';
    toast('Gerando o PDF no servidor — com todas as unidades pode levar mais tempo…');
    try {
      const p = periodo.getValue();
      // Reaproveita a mesma ação do Relatório Executivo — ela já suporta
      // unidade = 'TODAS' (o backend filtra "sem filtro" nesse caso),
      // então o PDF sai combinando Manutenção + Lavagem + Gás das 3
      // unidades juntas, sem precisar de uma ação nova no Code.gs.
      const res = await api('gerarRelatorioExecutivoPDF', { unidade: 'TODAS', periodo: p.periodo, dataInicio: p.dataInicio, dataFim: p.dataFim });
      downloadBase64File(res.filename, res.base64, 'application/pdf');
      toast('Relatório de todas as unidades baixado!', false, true);
    } catch (e) { /* toast já mostrado pelo api() */ }
    btnPdf.disabled = false;
    btnPdf.innerHTML = '📄 Emitir relatório de todas as unidades';
  };

  const body = el('<div class="stack" style="margin-top:2px"><p class="subtle">Carregando comparativo das unidades…</p></div>');
  app.appendChild(body);
  // [EXECUTIVO OUT/2026] Visão executiva da gestão: as frotas das três
  // unidades juntas (do setor escolhido), no período do filtro acima.
  const exec = el('<div class="stack" style="margin-top:2px"></div>');
  async function carregarExecutivoGestao() {
    exec.innerHTML = '<p class="subtle">Carregando visão executiva de todas as unidades…</p>';
    const p = periodo.getValue();
    const r = await api('getRelatorioExecutivo', { unidade: 'TODAS', periodo: p.periodo, dataInicio: p.dataInicio, dataFim: p.dataFim })
      .catch(function () { return null; });
    exec.innerHTML = '';
    if (!r) { exec.appendChild(el(blocoFalhaCarregar())); return; }
    exec.appendChild(el('<h3 class="title-lg" style="margin-top:6px">📊 Executivo — todas as unidades · ' + escapeHtml(setorLabel(S.setor)) + '</h3>' +
      '<p class="subtle" style="margin-top:-6px">' + escapeHtml(r.periodo.label) + '</p>'));
    montarFrotasExecutivo(exec, r.frotas);
  }

  // Comparativo de gás e manutenção entre as unidades, no período do filtro.
  const comp = el('<div class="stack" style="margin-top:2px"></div>');
  async function carregarComparativo() {
    comp.innerHTML = '<p class="subtle">Carregando comparativo de gás e manutenção…</p>';
    const p = periodo.getValue();
    const r = await api('getComparativoUnidades', { periodo: p.periodo, dataInicio: p.dataInicio, dataFim: p.dataFim })
      .catch(function () { return null; });
    comp.innerHTML = '';
    if (!r) { comp.appendChild(el(blocoFalhaCarregar())); return; }
    montarComparativoUnidades(comp, r);
  }

  try {
    const d = await api('getVisaoGeralUnidades', {});
    montarVisaoGeralUnidades(body, d);
  } catch (e) {
    body.innerHTML = '<p class="subtle">Não foi possível carregar o comparativo das unidades.</p>';
  }
  app.appendChild(comp);
  carregarComparativo();
  app.appendChild(exec);
  carregarExecutivoGestao();
}

// Comparativo entre as unidades (gás + manutenção) no período do filtro.
function montarComparativoUnidades(box, d) {
  const us = d.unidades || [];
  const tg = d.total.gas, tm = d.total.manutencao;
  const horas = function (v) { return v ? String(v).replace('.', ',') + 'h' : '—'; };
  const dinheiro = function (v) { return v ? fmtMoeda(v) : '—'; };
  const porHora = function (v) { return v ? fmtMoeda(v) + '/h' : '—'; };
  const destaque = function (o, fmt) { return o ? escapeHtml(o.nome) + '<br><span class="subtle">' + escapeHtml(fmt(o.valor)) + '</span>' : '—'; };
  const maquina = function (o) {
    return o ? escapeHtml(o.nome) + '<br><span class="subtle">' + escapeHtml(o.texto) + ' · ' + o.quantidade + ' chamado(s)</span>' : '—';
  };

  box.appendChild(el('<h3 class="title-lg" style="margin-top:6px">⛽ Comparativo das unidades — gás e manutenção</h3>'));
  box.appendChild(el('<p class="subtle" style="margin-top:-6px">' + escapeHtml(d.periodo.label) + ' · ' + escapeHtml(setorLabel(S.setor)) + '</p>'));

  box.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(tg.totalTrocas, 'Trocas de gás') +
      kpi(fmtMoeda(tg.custoTotal), 'Custo total de gás', 'kpi--accent') +
      kpi(horas(tg.horaMedia), 'Horas médias entre trocas') +
      kpi(porHora(tg.custoMedioPorHora), 'Custo médio por hora') +
    '</div>'
  ));

  if (!tg.totalTrocas && !tm.total) {
    box.appendChild(el('<div class="card"><p class="subtle">Nenhuma troca de gás nem manutenção neste período. ' +
      'Troque o período acima para ver o histórico.</p></div>'));
    return;
  }

  // Barras: uma linha por unidade, para comparar de relance.
  function barras(titulo, subtitulo, valor, texto) {
    const card = el('<div class="card stack"><h3 class="title-lg">' + titulo + '</h3>' +
      '<p class="subtle" style="margin-top:-6px">' + escapeHtml(subtitulo) + '</p></div>');
    const max = Math.max.apply(null, us.map(function (u) { return Number(valor(u)) || 0; }).concat([0]));
    us.forEach(function (u) {
      const v = Number(valor(u)) || 0;
      card.appendChild(el(
        '<div class="bar-row"><span class="label">' + escapeHtml(u.UNIDADE) + '</span>' +
        '<div class="bar-track">' + (v > 0 ? '<div class="bar-fill" style="width:' + Math.max(4, (v / (max || 1)) * 100) + '%"></div>' : '') + '</div>' +
        '<span class="bar-val" style="width:auto;min-width:92px">' + escapeHtml(texto(u)) + '</span></div>'
      ));
    });
    box.appendChild(card);
  }
  barras('💰 Custo de gás por unidade', 'Total gasto no período e número de trocas',
    function (u) { return u.gas.custoTotal; },
    function (u) { return fmtMoeda(u.gas.custoTotal) + ' · ' + u.gas.totalTrocas + 'x'; });
  barras('📈 Custo por hora de uso', 'Custo do gás ÷ horas rodadas — quanto menor, melhor',
    function (u) { return u.gas.custoMedioPorHora; },
    function (u) { return porHora(u.gas.custoMedioPorHora); });
  barras('🕐 Horas médias entre trocas', 'Quanto tempo o gás dura em cada unidade — quanto maior, melhor',
    function (u) { return u.gas.horaMedia; },
    function (u) { return horas(u.gas.horaMedia); });
  barras('🔧 Manutenções por unidade', 'Chamados abertos no período e tempo em manutenção',
    function (u) { return u.manutencao.total; },
    function (u) { return u.manutencao.total + ' · ' + u.manutencao.tempoTotalTexto; });

  // Fornecedores de cada unidade.
  const cardForn = el('<div class="card stack"><h3 class="title-lg">⛽ Fornecedor por unidade</h3>' +
    '<p class="subtle" style="margin-top:-6px">Quanto cada unidade gastou com cada fornecedor</p></div>');
  const maxForn = Math.max.apply(null, us.reduce(function (acc, u) {
    return acc.concat(u.gas.fornecedores.map(function (f) { return f.custo; }));
  }, [0]));
  us.forEach(function (u) {
    if (!u.gas.fornecedores.length) {
      cardForn.appendChild(el('<div class="bar-row"><span class="label">' + escapeHtml(u.UNIDADE) + '</span>' +
        '<span class="subtle">sem trocas no período</span></div>'));
    }
    u.gas.fornecedores.forEach(function (f) {
      cardForn.appendChild(el(
        '<div class="bar-row"><span class="label" style="width:150px">' + escapeHtml(u.UNIDADE) + ' · ' + escapeHtml(f.nome) + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(4, (f.custo / (maxForn || 1)) * 100) + '%"></div></div>' +
        '<span class="bar-val" style="width:auto;min-width:92px">' + escapeHtml(fmtMoeda(f.custo)) + ' · ' + f.trocas + 'x</span></div>'
      ));
    });
  });
  box.appendChild(cardForn);

  // Tabela lado a lado: uma coluna por unidade + o total.
  const linhas = [
    ['Trocas de gás', function (g) { return g.totalTrocas; }, 'gas'],
    ['Custo total de gás', function (g) { return dinheiro(g.custoTotal); }, 'gas'],
    ['Custo médio por troca', function (g) { return dinheiro(g.custoMedioPorTroca); }, 'gas'],
    ['Gás trocado (kg)', function (g) { return g.trocasComKg ? String(g.kgTotal).replace('.', ',') + ' kg' : 'não informado'; }, 'gas'],
    ['Horas de uso somadas', function (g) { return horas(g.horasTotal); }, 'gas'],
    ['Horas médias entre trocas', function (g) { return horas(g.horaMedia); }, 'gas'],
    ['Custo médio por hora', function (g) { return porHora(g.custoMedioPorHora); }, 'gas'],
    ['Frota com maior custo', function (g) { return destaque(g.maiorCusto, fmtMoeda); }, 'gas', true],
    ['Frota com mais horas de uso', function (g) { return destaque(g.maisHoras, horas); }, 'gas', true],
    ['Maior custo por hora', function (g) { return destaque(g.maiorCustoPorHora, porHora); }, 'gas', true],
    ['Menor custo por hora', function (g) { return destaque(g.menorCustoPorHora, porHora); }, 'gas', true],
    ['Maior tempo entre trocas', function (g) { return destaque(g.maiorIntervalo, horas); }, 'gas', true],
    ['Menor tempo entre trocas', function (g) { return destaque(g.menorIntervalo, horas); }, 'gas', true],
    ['Manutenções no período', function (m) { return m.total + (m.ativas ? ' (' + m.ativas + ' em aberto)' : ''); }, 'manutencao'],
    ['Tempo total em manutenção', function (m) { return m.total ? m.tempoTotalTexto : '—'; }, 'manutencao'],
    ['Mais tempo em manutenção', function (m) { return maquina(m.maiorTempo); }, 'manutencao', true],
    ['Menos tempo em manutenção', function (m) { return maquina(m.menorTempo); }, 'manutencao', true]
  ];
  const cardTab = el('<div class="card stack"><h3 class="title-lg">📋 Lado a lado</h3>' +
    '<p class="subtle" style="margin-top:-6px">Todos os números, uma coluna por unidade. Tempo de manutenção conta só o expediente.</p></div>');
  let html = '<table class="report-table"><thead><tr><th>Indicador</th>' +
    us.map(function (u) { return '<th>' + escapeHtml(u.UNIDADE) + '</th>'; }).join('') + '<th>Todas</th></tr></thead><tbody>';
  linhas.forEach(function (l) {
    html += '<tr><td><strong>' + escapeHtml(l[0]) + '</strong></td>' +
      us.concat([d.total]).map(function (u) {
        const v = l[1](u[l[2]]);
        return '<td>' + (l[3] ? v : escapeHtml(v)) + '</td>'; // l[3]: célula já vem montada (e escapada)
      }).join('') + '</tr>';
  });
  html += '</tbody></table>';
  const scroll = el('<div class="table-scroll"></div>');
  scroll.innerHTML = html;
  cardTab.appendChild(scroll);
  box.appendChild(cardTab);
}

function montarVisaoGeralUnidades(body, d) {
  body.innerHTML = '';
  const t = d.totais;
  body.appendChild(el('<h3 class="title-lg">📊 Frota — total das ' + d.totalUnidades + ' unidades</h3>'));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(t.total, 'Equipamentos') +
      kpi(t.em_uso, 'Ativas', 'kpi--uso') +
      kpi(t.manutencao, 'Em manutenção', 'kpi--manut') +
      kpi(t.parado, 'Paradas', 'kpi--parado') +
    '</div>'
  ));

  body.appendChild(el('<h3 class="title-lg" style="margin-top:6px">🏭 Unidade por unidade</h3>'));
  const lista = el('<div class="unit-compare-list"></div>');
  body.appendChild(lista);

  if (!d.unidades.length) {
    lista.appendChild(el('<p class="subtle">Nenhuma unidade ativa cadastrada.</p>'));
  } else {
    d.unidades.forEach(function (u) {
      const base = Math.max(1, u.total);
      const pct = function (v) { return Math.max(0, (v / base) * 100); };
      lista.appendChild(el(
        '<div class="unit-compare-card">' +
          '<div class="unit-compare-card__head">' +
            '<span class="unit-compare-card__title">' + escapeHtml(u.UNIDADE) + '</span>' +
            '<span class="unit-compare-card__total">' + u.total + ' equipamento(s)</span>' +
          '</div>' +
          '<div class="unit-compare-track">' +
            (u.em_uso ? '<div class="unit-compare-seg" style="width:' + pct(u.em_uso) + '%;background:var(--st-uso)"></div>' : '') +
            (u.manutencao ? '<div class="unit-compare-seg" style="width:' + pct(u.manutencao) + '%;background:var(--st-manut)"></div>' : '') +
            (u.parado ? '<div class="unit-compare-seg" style="width:' + pct(u.parado) + '%;background:var(--st-parado)"></div>' : '') +
            (u.inativo ? '<div class="unit-compare-seg" style="width:' + pct(u.inativo) + '%;background:var(--st-inativo)"></div>' : '') +
          '</div>' +
          '<div class="unit-compare-legend">' +
            '<span><span class="dot" style="background:var(--st-uso)"></span>' + u.em_uso + ' ativa(s)</span>' +
            '<span><span class="dot" style="background:var(--st-manut)"></span>' + u.manutencao + ' manutenção</span>' +
            '<span><span class="dot" style="background:var(--st-parado)"></span>' + u.parado + ' parada(s)</span>' +
            (u.inativo ? '<span><span class="dot" style="background:var(--st-inativo)"></span>' + u.inativo + ' inativa(s)</span>' : '') +
          '</div>' +
        '</div>'
      ));
    });
  }

  body.appendChild(el('<p class="subtle" style="text-align:center">Checklist de hoje — ' +
    d.unidades.map(function (u) { return escapeHtml(u.UNIDADE) + ': ' + u.checklistsHoje.feitos + '/' + u.checklistsHoje.total; }).join(' · ') +
    '</p>'));
  body.appendChild(el('<p class="subtle" style="text-align:center">Atualizado em ' + fmtDataHora(d.geradoEm) + '</p>'));
}

// Troca de gás: acima deste número de horas entre uma troca e a seguinte
// da mesma frota, o app pede para conferir o horímetro antes de salvar.
// O mesmo limite existe no Code.gs (LIMITE_HORAS_ENTRE_TROCAS).
const LIMITE_HORAS_ENTRE_TROCAS = 25;

// ------------------------- PERGUNTAS (CHECKLIST / LAVAGEM) -------------------------
// O Administrador escolhe o formulário (checklist ou lavagem) e o TIPO de
// equipamento, e adiciona, altera ou exclui perguntas. Vale para todas as
// unidades: é por tipo de equipamento, não por frota.
async function renderPerguntas() {
  appendHtml(app, screenHeader('Perguntas', 'Perguntas do checklist e da lavagem',
    'Por tipo de equipamento — vale para todas as unidades'));
  app.appendChild(botaoVoltar('mais'));

  const card = el('<div class="card stack"><p class="subtle">Carregando…</p></div>');
  app.appendChild(card);

  // Tipos: os padrões do app + qualquer tipo que já exista nos equipamentos.
  const res = await Promise.all([carregarTiposEquipamento(), carregarEquipamentos(true)]);
  const tipos = [];
  (res[0] || []).concat((res[1] || []).map(function (e) { return e.TIPO; })).forEach(function (t) {
    const nome = String(t || '').trim();
    if (nome && nome !== 'Outro' && tipos.map(function (x) { return x.toLowerCase(); }).indexOf(nome.toLowerCase()) === -1) tipos.push(nome);
  });

  card.innerHTML = '';
  const selModulo = selectField(card, {
    label: 'Formulário', required: true, value: S.perguntasModulo || 'checklist',
    options: [{ value: 'checklist', label: 'Checklist' }, { value: 'lavagem', label: 'Lavagem' }]
  });
  const selTipo = selectField(card, {
    label: 'Tipo de equipamento', required: true, value: S.perguntasTipo || tipos[0] || '',
    options: tipos.map(function (t) { return { value: t, label: t }; })
  });
  if (!selModulo.getValue()) selModulo.setValue('checklist');
  if (!selTipo.getValue() && tipos.length) selTipo.setValue(tipos[0]);

  const lista = el('<div class="stack" style="gap:8px"></div>');
  card.appendChild(lista);

  const form = el('<div class="card stack"></div>');
  app.appendChild(form);
  const tituloForm = el('<h3 class="title-lg">＋ Adicionar pergunta</h3>');
  form.appendChild(tituloForm);
  const campoItem = textField(form, { label: 'Pergunta (nome do item)', required: true, placeholder: 'Ex: Garfos e corrente' });
  const campoInstrucao = textField(form, { label: 'Instrução para o operador', multiline: true, placeholder: 'Explique o que conferir neste item.' });
  const btnSalvar = el('<button class="btn btn--primary btn--block">＋ Adicionar pergunta</button>');
  const btnCancelar = el('<button class="btn btn--outline btn--block" hidden>Cancelar alteração</button>');
  form.appendChild(btnSalvar); form.appendChild(btnCancelar);

  let emEdicao = null; // pergunta sendo alterada (ou null = adicionando)
  function limparForm() {
    emEdicao = null;
    campoItem.setValue(''); campoInstrucao.setValue('');
    tituloForm.textContent = '＋ Adicionar pergunta';
    btnSalvar.textContent = '＋ Adicionar pergunta';
    btnCancelar.hidden = true;
  }
  btnCancelar.onclick = limparForm;

  async function carregar() {
    S.perguntasModulo = selModulo.getValue(); S.perguntasTipo = selTipo.getValue();
    limparForm();
    if (!selTipo.getValue()) { lista.innerHTML = '<p class="subtle">Nenhum tipo de equipamento cadastrado.</p>'; return; }
    lista.innerHTML = '<p class="subtle">Carregando perguntas…</p>';
    const modulo = selModulo.getValue(), tipo = selTipo.getValue();
    const r = await api('getPerguntas', { modulo: modulo, tipo: tipo }).catch(function () { return null; });
    if (modulo !== selModulo.getValue() || tipo !== selTipo.getValue()) return;
    lista.innerHTML = '';
    if (!r) { lista.appendChild(el('<p class="subtle">Não foi possível carregar as perguntas.</p>')); return; }
    lista.appendChild(el('<div class="note' + (r.personalizado ? '' : ' warn') + '">' + (r.personalizado
      ? 'Este tipo tem perguntas próprias (' + r.itens.length + ').'
      : 'Este tipo ainda usa a lista padrão. Ao adicionar, alterar ou excluir uma pergunta, ele passa a ter a lista própria.') + '</div>'));
    r.itens.forEach(function (q, i) {
      const linha = el(
        '<div class="list-item" style="cursor:default;align-items:flex-start">' +
          '<span><span class="list-item__title">' + (i + 1) + '. ' + escapeHtml(q.item) + '</span>' +
          '<div class="list-item__sub" style="white-space:normal">' + escapeHtml(q.instrucao || 'Sem instrução.') + '</div></span>' +
          '<span class="row" style="gap:6px;flex-shrink:0"></span>' +
        '</div>'
      );
      const acoes = linha.lastChild;
      const bAlt = el('<button type="button" class="btn btn--outline btn--sm">Alterar</button>');
      const bExc = el('<button type="button" class="btn btn--danger btn--sm">Excluir</button>');
      acoes.appendChild(bAlt); acoes.appendChild(bExc);
      bAlt.onclick = function () {
        emEdicao = q;
        campoItem.setValue(q.item); campoInstrucao.setValue(q.instrucao || '');
        tituloForm.textContent = 'Alterar pergunta ' + (i + 1);
        btnSalvar.textContent = '✓ Salvar alteração';
        btnCancelar.hidden = false;
        form.scrollIntoView({ block: 'center' });
        campoItem.input.focus();
      };
      bExc.onclick = async function () {
        if (!window.confirm('Excluir a pergunta "' + q.item + '" de ' + tipo + '?\n\nChecklists e lavagens já feitos não mudam.')) return;
        bExc.disabled = true; bExc.textContent = 'Excluindo…';
        try {
          await api('deletePergunta', { modulo: modulo, tipo: tipo, idPergunta: q.idPergunta || undefined, itemOriginal: q.item, idUsuario: S.usuario.ID_USUARIO });
          toast('Pergunta excluída.', false, true);
          carregar();
        } catch (e) { bExc.disabled = false; bExc.textContent = 'Excluir'; }
      };
      lista.appendChild(linha);
    });
  }
  selModulo.select.addEventListener('change', carregar);
  selTipo.select.addEventListener('change', carregar);

  btnSalvar.onclick = async function () {
    if (!selTipo.getValue()) { toast('Selecione o tipo de equipamento', true); return; }
    if (!campoItem.getValue()) { toast('Escreva a pergunta', true); return; }
    const rotulo = btnSalvar.textContent;
    btnSalvar.disabled = true; btnSalvar.textContent = 'Salvando…';
    try {
      await api('savePergunta', {
        modulo: selModulo.getValue(), tipo: selTipo.getValue(),
        idPergunta: emEdicao && emEdicao.idPergunta ? emEdicao.idPergunta : undefined,
        itemOriginal: emEdicao ? emEdicao.item : undefined,
        item: campoItem.getValue(), instrucao: campoInstrucao.getValue(),
        idUsuario: S.usuario.ID_USUARIO
      });
      toast(emEdicao ? 'Pergunta alterada.' : 'Pergunta adicionada.', false, true);
      btnSalvar.disabled = false;
      carregar();
    } catch (e) { btnSalvar.disabled = false; btnSalvar.textContent = rotulo; }
  };

  carregar();
}

// ------------------------- ESCALA DE LAVAGEM -------------------------
// Uma máquina por dia útil (seg a sex), em rodízio: todas as máquinas da
// unidade/setor passam pela lavagem antes de alguma repetir. A ordem do
// rodízio é embaralhada, mas fixa — a mesma em qualquer celular e sem
// gravar nada na planilha. Vale igual para todas as unidades.
const DIAS_SEMANA_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function ordemRodizioLavagem(equipamentos) {
  const embaralho = function (texto) { // número fixo a partir do ID
    let h = 2166136261;
    for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  return equipamentos
    .filter(function (e) { return e.STATUS !== 'inativo'; })
    .map(function (e) { return { e: e, h: embaralho(String(e.ID_EQUIPAMENTO)) }; })
    .sort(function (a, b) { return a.h - b.h || String(a.e.ID_EQUIPAMENTO).localeCompare(String(b.e.ID_EQUIPAMENTO)); })
    .map(function (x) { return x.e; });
}

// Número do dia útil (seg a sex) contado desde segunda 05/01/2026; null no fim de semana.
function indiceDiaUtil(data) {
  const dias = Math.round((Date.UTC(data.getFullYear(), data.getMonth(), data.getDate()) - Date.UTC(2026, 0, 5)) / 86400000);
  const naSemana = ((dias % 7) + 7) % 7; // 0 = segunda … 6 = domingo
  if (naSemana > 4) return null;
  return Math.floor(dias / 7) * 5 + naSemana;
}

function maquinaDaLavagem(rodizio, data) {
  const i = indiceDiaUtil(data);
  if (i === null || !rodizio.length) return null;
  return rodizio[((i % rodizio.length) + rodizio.length) % rodizio.length];
}

// Data do dia útil de número `i` (inverso de indiceDiaUtil).
function dataDoIndiceDiaUtil(i) {
  const semanas = Math.floor(i / 5), resto = ((i % 5) + 5) % 5;
  return new Date(2026, 0, 5 + semanas * 7 + resto);
}

async function montarLavagemDoDia(card) {
  const geracao = GERACAO_TELA;
  const res = await Promise.all([
    carregarEquipamentos(false),
    // 30 dias: o suficiente para enxergar uma lavagem adiantada dentro do rodízio.
    api('getLavagens', { unidade: S.unidade.UNIDADE, periodo: 'mes' }).catch(function () { return []; })
  ]);
  if (geracao !== GERACAO_TELA || !card.isConnected) return; // já saiu do Painel
  const rodizio = ordemRodizioLavagem(res[0] || []);
  const lavagens = res[1] || [];
  card.innerHTML = '<h3 class="title-lg">🧽 Lavagem do dia</h3>' +
    '<p class="subtle" style="margin-top:-6px">Uma máquina por dia, de segunda a sexta, em rodízio. ' +
    'Se a máquina foi lavada antes do dia dela, já aparece como lavada.</p>';
  if (!rodizio.length) {
    card.appendChild(el('<p class="subtle">Nenhum equipamento cadastrado neste setor.</p>'));
    return;
  }

  const hoje = new Date();
  const fimDeHoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 23, 59, 59);
  const mesmoDia = function (a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  };
  const ddmm = function (d) { return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0'); };
  // Lavagem que "vale" para a vez da máquina no dia `dia`: a mais recente
  // feita depois da vez anterior dela no rodízio e até o próprio dia. Assim
  // quem lavou adiantado não precisa lavar de novo — e a ordem não muda.
  const lavagemDaVez = function (equip, dia) {
    const i = indiceDiaUtil(dia);
    if (i === null) return null;
    const vezAnterior = dataDoIndiceDiaUtil(i - rodizio.length);
    const depoisDe = new Date(vezAnterior.getFullYear(), vezAnterior.getMonth(), vezAnterior.getDate(), 23, 59, 59);
    const ate = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 23, 59, 59);
    let achada = null;
    lavagens.forEach(function (l) {
      const d = new Date(l.DATA_HORA);
      if (String(l.ID_EQUIPAMENTO) !== String(equip.ID_EQUIPAMENTO) || isNaN(d)) return;
      if (d > depoisDe && d <= ate && d <= fimDeHoje && (!achada || d > achada)) achada = d;
    });
    return achada;
  };

  const doDia = maquinaDaLavagem(rodizio, hoje);
  if (!doDia) {
    card.appendChild(el('<div class="note">Hoje não tem lavagem — a escala é de segunda a sexta.</div>'));
  } else {
    const quando = lavagemDaVez(doDia, hoje);
    const adiantada = quando && !mesmoDia(quando, hoje);
    const item = el(
      '<button type="button" class="list-item ' + (quando ? 'is-ok' : 'is-warn') + '" style="width:100%">' +
        '<span><span class="list-item__title">' + escapeHtml(doDia.NOME) + '</span>' +
        '<div class="list-item__sub">' + escapeHtml(doDia.CODIGO || doDia.TIPO || '') +
        (doDia.STATUS !== 'em_uso' ? ' · ' + escapeHtml((STATUS_EQUIPAMENTO[doDia.STATUS] || {}).label || doDia.STATUS) : '') +
        (adiantada ? ' · já foi lavada no dia ' + ddmm(quando) + ', não precisa lavar hoje'
          : quando ? ' · lavagem já registrada hoje' : ' · toque para registrar a lavagem') + '</div></span>' +
        '<span class="tag ' + (quando ? 'tag--ok' : 'tag--nok') + '">' + (adiantada ? 'Lavada ' + ddmm(quando) : quando ? 'Feita' : 'Hoje') + '</span>' +
      '</button>'
    );
    item.onclick = function () { go('lavagemForm'); };
    card.appendChild(item);
  }

  // Escala da semana (a atual; no fim de semana, a próxima).
  const segunda = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const dow = segunda.getDay(); // 0 = domingo
  segunda.setDate(segunda.getDate() + (dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow));
  card.appendChild(el('<strong style="font-size:13px;color:var(--ink-soft)">' +
    (dow === 0 || dow === 6 ? 'Escala da próxima semana' : 'Escala da semana') + '</strong>'));
  for (let i = 0; i < 5; i++) {
    const dia = new Date(segunda.getFullYear(), segunda.getMonth(), segunda.getDate() + i);
    const m = maquinaDaLavagem(rodizio, dia);
    const ehHoje = mesmoDia(dia, hoje);
    const passou = !ehHoje && dia < hoje;
    const quando = lavagemDaVez(m, dia);
    card.appendChild(el(
      '<div class="row between" style="gap:10px;font-size:13.5px;padding:6px 0;border-bottom:1px solid var(--line)' + (ehHoje ? ';font-weight:700' : '') + '">' +
        '<span><span class="mono" style="color:var(--ink-soft)">' + DIAS_SEMANA_CURTO[dia.getDay()] + ' ' + ddmm(dia) + '</span> · ' + escapeHtml(m.NOME) + '</span>' +
        '<span class="subtle">' + (quando ? '✓ lavada ' + ddmm(quando) : ehHoje ? 'hoje' : passou ? 'não registrada' : '') + '</span>' +
      '</div>'
    ));
  }
}

// ------------------------- PAINEL -------------------------

async function renderPainel() {
  appendHtml(app, screenHeader('Painel · ' + unidadeSetorLabel(), 'Olá, ' + S.usuario.NOME,
    'Situação da frota agora'));
  const body = el('<div class="stack"><p class="subtle">Carregando painel…</p></div>');
  app.appendChild(body);

  let d;
  try { d = await api('getPainel', { unidade: S.unidade.UNIDADE }); }
  catch (e) { body.innerHTML = '<p class="subtle">Não foi possível carregar o painel.</p>'; return; }

  body.innerHTML = '';
  const ind = d.indicadores;
  const resumo = d.checklistDoDiaResumo || { total: 0, feitos: 0, pendentes: 0 };

  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(d.totais.total, 'Equipamentos') +
      kpi(ind.emFuncionamento, 'Em funcionamento', 'kpi--uso') +
      kpi(ind.emManutencao, 'Em manutenção', 'kpi--manut') +
      kpi(ind.parados, 'Parados', 'kpi--parado') +
    '</div>'
  ));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(ind.inativos, 'Inativos', 'kpi--inativo') +
      (ehAdmin() ? kpi(resumo.feitos + '/' + resumo.total, 'Checklists hoje') : '') +
      kpi(ind.naoConformidadesAbertas, 'NCs abertas', 'kpi--parado') +
      kpi(ind.manutencoesAbertas + (ind.manutencoesAcionadas || 0) + ind.manutencoesAndamento, 'Manutenções ativas', 'kpi--accent') +
    '</div>'
  ));

  // ---- Manutenção ----
  // Cada frota mostra em que etapa o chamado está (aberta → técnico
  // acionado → em andamento), igual à aba Manutenções.
  const cardManut = el('<div class="card stack"><h3 class="title-lg">🔧 Manutenção</h3>' +
    '<p class="subtle" style="margin-top:-6px">Frotas com chamado de manutenção em aberto e a etapa de cada um</p></div>');
  body.appendChild(cardManut);
  if (!d.equipamentosEmManutencao.length) {
    cardManut.appendChild(el('<p class="subtle">Nenhuma frota com manutenção em aberto neste momento.</p>'));
  } else {
    d.equipamentosEmManutencao.forEach(function (e) {
      const etapa = STATUS_MANUTENCAO[e.STATUS_MANUTENCAO];
      cardManut.appendChild(el(
        '<div class="list-item is-warn" style="cursor:default">' +
          '<span><span class="list-item__title">' + escapeHtml(e.NOME) + '</span>' +
          '<div class="list-item__sub">' + escapeHtml(e.CODIGO || e.TIPO || '') +
          (e.TITULO_ATUAL ? ' · ' + escapeHtml(e.TITULO_ATUAL) : '') +
          (etapa ? ' · há ' + escapeHtml(e.TEMPO_TEXTO) : '') + '</div></span>' +
          (etapa
            ? '<span class="tag tag--' + etapa.cls + '">' + escapeHtml(etapa.label) + '</span>'
            : '<span class="tag tag--manut">' + escapeHtml(e.TEMPO_TEXTO) + '</span>') +
        '</div>'
      ));
    });
  }

  // ---- [OUT/2026] Máquinas paradas agora ----
  const paradas = d.equipamentosParados || [];
  const cardParadas = el('<div class="card stack"><h3 class="title-lg">🔴 Máquinas paradas agora</h3>' +
    '<p class="subtle" style="margin-top:-6px">Situação atual do setor</p></div>');
  body.appendChild(cardParadas);
  if (!paradas.length) {
    cardParadas.appendChild(el('<p class="subtle">Nenhuma máquina parada neste momento.</p>'));
  } else {
    paradas.forEach(function (e) {
      cardParadas.appendChild(el(
        '<div class="list-item is-alert" style="cursor:default">' +
          '<span><span class="list-item__title">' + escapeHtml(e.NOME) + '</span>' +
          '<div class="list-item__sub">' + escapeHtml(e.TIPO || e.CODIGO || '') +
          ' · parado desde ' + fmtDataHora(e.STATUS_DESDE) +
          (e.OBSERVACOES ? ' · ' + escapeHtml(e.OBSERVACOES) : '') + '</div></span>' +
          '<span class="tag tag--parado">' + escapeHtml(e.TEMPO_TEXTO) + '</span>' +
        '</div>'
      ));
    });
  }

  // ---- Lavagem do dia (escala seg a sex) ----
  // Aparece para Operador e Admin: qual máquina é lavada hoje e a escala
  // da semana. Carrega à parte, sem segurar o resto do Painel.
  const cardLavagem = el('<div class="card stack"><h3 class="title-lg">🧽 Lavagem do dia</h3>' +
    '<p class="subtle" style="margin-top:-6px">Carregando escala…</p></div>');
  body.appendChild(cardLavagem);
  montarLavagemDoDia(cardLavagem);

  // ---- Preventivas próximas (30 dias) ----
  const cardPrev = el('<div class="card stack"><h3 class="title-lg">🗓️ Preventivas próximas</h3>' +
    '<p class="subtle" style="margin-top:-6px">Previstas para os próximos 30 dias</p></div>');
  body.appendChild(cardPrev);
  if (!d.preventivasProximas.length) {
    cardPrev.appendChild(el('<p class="subtle">Nenhuma preventiva prevista para os próximos 30 dias.</p>'));
  } else {
    d.preventivasProximas.forEach(function (m) {
      cardPrev.appendChild(el(
        '<div class="list-item ' + (m.ATRASADA ? 'is-alert' : '') + '" style="cursor:default">' +
          '<span><span class="list-item__title">' + escapeHtml(m.NOME_EQUIPAMENTO) + '</span>' +
          '<div class="list-item__sub">' + escapeHtml(m.TITULO) + ' · ' + fmtData(m.DATA_PREVISTA) + '</div></span>' +
          '<span class="tag ' + (m.ATRASADA ? 'tag--parado' : 'tag--info') + '">' +
            (m.ATRASADA ? 'Atrasada ' + Math.abs(m.DIAS_RESTANTES) + 'd' : 'Em ' + m.DIAS_RESTANTES + 'd') +
          '</span>' +
        '</div>'
      ));
    });
  }

  // ---- Checklist do dia ----
  // [OUT/2026] Só Administrador e Gerente veem a lista de feitos/pendentes
  // do dia. O Operador continua fazendo o checklist pela aba "Checklist".
  if (!ehAdmin()) {
    body.appendChild(el('<p class="subtle" style="text-align:center">Atualizado em ' + fmtDataHora(d.geradoEm) + '</p>'));
    return;
  }
  const cardChk = el('<div class="card stack"><h3 class="title-lg">✅ Checklist do dia</h3>' +
    '<p class="subtle" style="margin-top:-6px">' + resumo.feitos + ' feito(s) · ' + resumo.pendentes + ' pendente(s)</p></div>');
  body.appendChild(cardChk);
  if (!d.checklistDoDia.length) {
    cardChk.appendChild(el('<p class="subtle">Nenhum equipamento em uso neste setor hoje (parados e em manutenção não entram no checklist).</p>'));
  } else {
    d.checklistDoDia.forEach(function (c) {
      // Checklist feito com item NOK aparece em vermelho e leva direto às
      // não conformidades daquele equipamento.
      const comNok = c.FEITO && String(c.STATUS_CHECKLIST) === 'pendencia';
      const item = el(
        '<button type="button" class="list-item ' + (c.FEITO && !comNok ? 'is-ok' : 'is-alert') + '" style="width:100%">' +
          '<span><span class="list-item__title">' + escapeHtml(c.NOME) + '</span>' +
          '<div class="list-item__sub">' + (c.FEITO
            ? 'Feito por ' + escapeHtml(c.RESPONSAVEL || '—') + ' às ' + fmtDataHora(c.DATA_HORA).split(' ')[1] +
              (comNok ? ' · <strong style="color:var(--st-risco)">com item NOK — ver não conformidades</strong>' : '')
            : 'Checklist ainda não realizado hoje') + '</div></span>' +
          '<span class="tag ' + (c.FEITO && !comNok ? 'tag--ok' : 'tag--nok') + '">' +
            (comNok ? 'Feito · NOK' : c.FEITO ? 'Feito' : 'Pendente') + '</span>' +
        '</button>'
      );
      item.onclick = function () {
        // só Admin chega aqui — ele consulta, não realiza
        if (comNok) {
          go('naoConformidades', { ncFiltro: { idEquipamento: c.ID_EQUIPAMENTO, status: '' } });
        } else if (c.FEITO && c.ID_CHECKLIST) {
          go('checklistDetalhe', { checklistAtual: { ID_CHECKLIST: c.ID_CHECKLIST, NOME_EQUIPAMENTO: c.NOME, DATA_HORA: c.DATA_HORA } });
        } else {
          go('checklists');
        }
      };
      cardChk.appendChild(item);
    });
  }

  body.appendChild(el('<p class="subtle" style="text-align:center">Atualizado em ' + fmtDataHora(d.geradoEm) + '</p>'));
}

// ------------------------- CHECKLIST -------------------------

async function renderChecklists() {
  appendHtml(app, screenHeader('Checklist', 'Checklists da frota', 'Inspeção diária dos equipamentos'));

  if (ehAdmin()) {
    app.appendChild(botaoVoltar('mais'));
  } else {
    const btnNovo = el('<button class="btn btn--primary btn--block">＋ Novo checklist</button>');
    btnNovo.onclick = function () { go('checklistNovo', { checklistEquipamentoId: null }); };
    app.appendChild(btnNovo);
  }

  const filtros = el(
    '<div class="filters" style="margin-top:12px">' +
      '<select id="fStatus">' +
        '<option value="">Todos os resultados</option>' +
        '<option value="pendencia">Com pendência</option>' +
        '<option value="ok">Sem pendência</option>' +
      '</select>' +
      '<select id="fEquip"><option value="">Todos os equipamentos</option></select>' +
    '</div>'
  );
  app.appendChild(filtros);
  // [OUT/2026] Por padrão só os últimos 30 dias — a lista não fica mais
  // lenta conforme o histórico cresce.
  const periodoWrap = el('<div style="margin-top:8px"></div>');
  app.appendChild(periodoWrap);
  const periodo = filtroPeriodo(periodoWrap, { comTodos: true, value: 'mes', onChange: function () { load(); } });

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);

  const equipamentos = await carregarEquipamentos(true);
  const selEquip = document.getElementById('fEquip');
  equipamentos.forEach(function (e) {
    selEquip.appendChild(el('<option value="' + escapeHtml(e.ID_EQUIPAMENTO) + '">' + escapeHtml(e.NOME) + '</option>'));
  });
  const selStatus = document.getElementById('fStatus');
  selStatus.onchange = load;
  selEquip.onchange = load;

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando…</p>';
    const per = periodo.getValue();
    const lista = await api('getChecklists', {
      unidade: S.unidade.UNIDADE,
      periodo: per.periodo, dataInicio: per.dataInicio, dataFim: per.dataFim,
      status: selStatus.value || undefined,
      idEquipamento: selEquip.value || undefined
    }).catch(function () { return []; });
    body.innerHTML = '';
    if (!lista.length) { body.appendChild(el(vazio('✅', 'Nenhum checklist encontrado com esses filtros.'))); return; }

    body.appendChild(el('<p class="subtle">' + lista.length + ' checklist(s) encontrado(s)</p>'));
    renderPaginado(body, lista, function (c) {
      const itens = c.ITENS || [];
      const noks = itens.filter(function (i) { return String(i.RESPOSTA || i.resposta) === 'nok'; }).length;
      const info = STATUS_CHECKLIST[c.STATUS] || { label: c.STATUS, cls: 'na' };
      const item = el(
        '<button type="button" class="list-item ' + (noks ? 'is-alert' : 'is-ok') + '" style="width:100%">' +
          '<span><span class="shiplabel">' + escapeHtml(c.ID_CHECKLIST) + '</span>' +
          '<div class="list-item__title" style="margin-top:6px">' + escapeHtml(c.NOME_EQUIPAMENTO) + '</div>' +
          '<div class="list-item__sub">' + fmtDataHora(c.DATA_HORA) + ' · ' + escapeHtml(c.RESPONSAVEL || '—') +
          (noks ? ' · <strong style="color:var(--st-risco)">' + noks + ' item(ns) NOK</strong>' : '') + '</div></span>' +
          '<span class="tag tag--' + info.cls + '">' + escapeHtml(info.label) + '</span>' +
        '</button>'
      );
      item.onclick = function () { go('checklistDetalhe', { checklistAtual: c }); };
      return item;
    });
  }
  load();
}

async function renderChecklistNovo() {
  appendHtml(app, screenHeader('Novo checklist', 'Checklist do equipamento',
    'Responda todos os itens. Item NOK abre uma não conformidade automaticamente.'));
  app.appendChild(botaoVoltar('checklists'));

  const card = el('<div class="card stack"><p class="subtle">Carregando formulário…</p></div>');
  app.appendChild(card);

  // O responsável pelo checklist é sempre quem fez o login — não há mais
  // lista para escolher.
  let equipamentos, modelo;
  try {
    const res = await Promise.all([
      carregarEquipamentos(false),
      api('getChecklistItensModelo', {})
    ]);
    // Checklist só de equipamento em uso (mesma regra do Painel).
    equipamentos = res[0].filter(function (e) { return e.STATUS === 'em_uso'; }); modelo = res[1];
  } catch (e) {
    card.innerHTML = '<p class="subtle">Não foi possível carregar o formulário.</p>';
    return;
  }

  card.innerHTML = '';
  if (!equipamentos.length) {
    card.appendChild(el('<p class="subtle">Nenhum equipamento "Em uso" nesta unidade. ' +
      'Parados e em manutenção não fazem checklist.</p>'));
    return;
  }
  const selEquip = selectField(card, {
    label: 'Equipamento', required: true,
    value: S.checklistEquipamentoId || '',
    options: equipamentos.map(function (e) {
      return { value: e.ID_EQUIPAMENTO, label: e.NOME + (e.CODIGO ? ' (' + e.CODIGO + ')' : '') };
    })
  });

  card.appendChild(el('<p class="subtle">Responsável pelo checklist: <strong>' +
    escapeHtml(S.usuario.NOME) + '</strong> (usuário do login)</p>'));

  const fotoEquip = photoField(card, { label: 'Foto do equipamento', required: true });

  card.appendChild(el('<div class="divider"></div>'));
  card.appendChild(el('<h3 class="title-lg">Itens de verificação</h3>'));

  // As perguntas dependem do TIPO do equipamento (empilhadeira, lavadora,
  // paleteira…) — o administrador ajusta em Mais › Perguntas. Tipo sem
  // perguntas próprias usa a lista padrão.
  const itensWrap = el('<div class="stack"></div>');
  card.appendChild(itensWrap);
  let refs = [];
  function montarItens(lista) {
    itensWrap.innerHTML = '';
    refs = lista.map(function (m, indice) {
    const box = el('<div class="stack" style="padding-bottom:12px;border-bottom:1px solid var(--line)"></div>');
    itensWrap.appendChild(box);
    box.appendChild(el('<strong style="font-size:15px">' + (indice + 1) + '. ' + escapeHtml(m.item) + '</strong>'));
    box.appendChild(el('<p class="subtle" style="margin-top:-6px">' + escapeHtml(m.instrucao) + '</p>'));

    const escolha = choiceField(box, {
      label: 'Resultado', required: true, columns: 3,
      options: [
        { value: 'ok', label: 'OK', cls: 'ok' },
        { value: 'nok', label: 'NOK', cls: 'nok' },
        { value: 'na', label: 'N/A', cls: 'na' }
      ]
    });

    const sub = el('<div class="stack" hidden></div>');
    box.appendChild(sub);
    let descricao = null, fotoProblema = null;

    escolha.node.addEventListener('change', function () {
      const v = escolha.getValue();
      sub.hidden = v !== 'nok';
      sub.innerHTML = '';
      descricao = null; fotoProblema = null;
      if (v === 'nok') {
        descricao = textField(sub, { label: 'Descreva o problema encontrado', required: true, multiline: true });
        fotoProblema = photoField(sub, { label: 'Foto do problema', required: true });
      }
    });

    return {
      item: m.item,
      instrucao: m.instrucao,
      validar: function () {
        const v = escolha.getValue();
        if (!v) return 'Responda o item "' + m.item + '".';
        if (v === 'nok') {
          if (!descricao || !descricao.getValue()) return 'Descreva o problema do item "' + m.item + '".';
          if (!fotoProblema || !fotoProblema.getValue()) return 'Anexe a foto do problema do item "' + m.item + '".';
        }
        return null;
      },
      build: function () {
        const v = escolha.getValue();
        return {
          item: m.item,
          instrucao: m.instrucao,
          resposta: v,
          descricaoProblema: v === 'nok' ? descricao.getValue() : '',
          fotoProblema: v === 'nok' ? fotoProblema.getValue() : ''
        };
      }
    };
  });
  }
  let tipoCarregado = null;
  async function carregarItensDoEquipamento() {
    const equip = equipamentos.find(function (x) { return String(x.ID_EQUIPAMENTO) === String(selEquip.getValue()); });
    if (!equip) {
      tipoCarregado = null; refs = [];
      itensWrap.innerHTML = '<p class="subtle">Selecione o equipamento para ver os itens.</p>';
      return;
    }
    const tipo = String(equip.TIPO || '');
    if (tipo === tipoCarregado) return; // mesmo tipo: mantém o que já foi respondido
    tipoCarregado = tipo; refs = [];
    itensWrap.innerHTML = '<p class="subtle">Carregando itens…</p>';
    const lista = await api('getChecklistItensModelo', { tipo: tipo }).catch(function () { return null; });
    if (tipoCarregado !== tipo) return; // trocou de equipamento no meio
    montarItens(lista && lista.length ? lista : modelo);
  }
  selEquip.select.addEventListener('change', carregarItensDoEquipamento);
  carregarItensDoEquipamento();

  const btn = el('<button class="btn btn--primary btn--block" style="margin-top:6px">✓ Concluir checklist</button>');
  card.appendChild(btn);
  btn.onclick = async function () {
    if (!selEquip.getValue()) { toast('Selecione o equipamento', true); return; }
    if (!fotoEquip.getValue()) { toast('A foto do equipamento é obrigatória', true); return; }
    if (!refs.length) { toast('Aguarde os itens carregarem', true); return; }
    const itens = [];
    for (const r of refs) {
      const erro = r.validar();
      if (erro) { toast(erro, true); return; }
      itens.push(r.build());
    }
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const res = await api('createChecklist', {
        unidade: S.unidade.UNIDADE,
        idUsuario: S.usuario.ID_USUARIO,
        idEquipamento: selEquip.getValue(),
        responsavel: S.usuario.NOME,
        fotoEquipamento: fotoEquip.getValue(),
        itens: itens
      });
      let msg = 'Checklist ' + res.idChecklist + ' registrado!';
      if (res.naoConformidadesCriadas && res.naoConformidadesCriadas.length) {
        msg += ' ' + res.naoConformidadesCriadas.length + ' não conformidade(s) aberta(s).';
      }
      if (res.naoConformidadesIgnoradas && res.naoConformidadesIgnoradas.length) {
        msg += ' ' + res.naoConformidadesIgnoradas.length + ' já estava(m) aberta(s).';
      }
      toast(msg, false, true);
      S.checklistEquipamentoId = null;
      go('checklists');
    } catch (e) {
      btn.disabled = false; btn.textContent = '✓ Concluir checklist';
    }
  };
}

async function renderChecklistDetalhe() {
  const base = S.checklistAtual;
  appendHtml(app, screenHeader('Checklist ' + base.ID_CHECKLIST, base.NOME_EQUIPAMENTO, fmtDataHora(base.DATA_HORA)));
  app.appendChild(botaoVoltar('checklists'));

  const card = el('<div class="card stack"><p class="subtle">Carregando detalhe…</p></div>');
  app.appendChild(card);

  let c;
  try { c = await api('getChecklistDetalhe', { idChecklist: base.ID_CHECKLIST }); }
  catch (e) { card.innerHTML = '<p class="subtle">Não foi possível carregar o checklist.</p>'; return; }

  const info = STATUS_CHECKLIST[c.STATUS] || { label: c.STATUS, cls: 'na' };
  card.innerHTML = '';
  appendHtml(card,
    linhaInfo('Resultado', '<span class="tag tag--' + info.cls + '">' + escapeHtml(info.label) + '</span>') +
    linhaInfo('Equipamento', '<strong>' + escapeHtml(c.NOME_EQUIPAMENTO) + '</strong>') +
    linhaInfo('Responsável', escapeHtml(c.RESPONSAVEL || '—')) +
    linhaInfo('Data/hora', fmtDataHora(c.DATA_HORA))
  );
  if (c.FOTO_EQUIPAMENTO) {
    card.appendChild(el('<div class="stack" style="gap:6px"><span class="subtle">Foto do equipamento</span>' +
      fotoSalva(c.FOTO_EQUIPAMENTO, 'Equipamento') + '</div>'));
  }

  const itensCard = el('<div class="card stack"><h3 class="title-lg">Itens verificados</h3></div>');
  app.appendChild(itensCard);
  (c.ITENS || []).forEach(function (it) {
    const resposta = String(it.RESPOSTA || '').toLowerCase();
    const r = RESPOSTA_CHECKLIST[resposta] || { label: resposta || '—', cls: 'na' };
    const box = el('<div class="stack" style="gap:6px;padding-bottom:10px;border-bottom:1px solid var(--line)"></div>');
    box.appendChild(el('<div class="row between"><strong style="font-size:14.5px">' + escapeHtml(it.ITEM) + '</strong>' +
      '<span class="tag tag--' + r.cls + '">' + escapeHtml(r.label) + '</span></div>'));
    if (it.DESCRICAO_PROBLEMA) {
      box.appendChild(el('<p class="subtle">' + escapeHtml(it.DESCRICAO_PROBLEMA) + '</p>'));
    }
    if (it.FOTO_PROBLEMA) box.appendChild(el('<div>' + fotoSalva(it.FOTO_PROBLEMA, 'Problema') + '</div>'));
    itensCard.appendChild(box);
  });

  const ncs = c.NAO_CONFORMIDADES || [];
  if (ncs.length) {
    const ncCard = el('<div class="card stack"><h3 class="title-lg">Não conformidades geradas</h3></div>');
    app.appendChild(ncCard);
    // A tela de não conformidades é do Administrador: para ele o cartão é
    // clicável e abre a NC; para o Operador continua só informativo.
    const podeAbrir = ehAdmin();
    ncs.forEach(function (nc) {
      const tagNc = podeAbrir ? 'button type="button"' : 'div';
      const itemNc = el(
        '<' + tagNc + ' class="list-item is-alert" style="' + (podeAbrir ? 'width:100%' : 'cursor:default') + '">' +
          '<span><span class="shiplabel">' + escapeHtml(nc.ID_NC) + '</span>' +
          '<div class="list-item__title" style="margin-top:6px">' + escapeHtml(nc.ITEM) + '</div>' +
          '<div class="list-item__sub">' + escapeHtml(nc.DESCRICAO || '') + '</div></span>' +
          '<span class="tag tag--' + (String(nc.STATUS) === 'aberta' ? 'aberta' : 'concluida') + '">' +
            (String(nc.STATUS) === 'aberta' ? 'Aberta' : 'Fechada') + '</span>' +
        '</' + (podeAbrir ? 'button' : 'div') + '>'
      );
      if (podeAbrir) {
        itemNc.onclick = function () {
          go('naoConformidades', { ncFiltro: { idEquipamento: nc.ID_EQUIPAMENTO || c.ID_EQUIPAMENTO, status: '', idNc: nc.ID_NC } });
        };
      }
      ncCard.appendChild(itemNc);
    });
  }

  // 3) Exclusão de checklist feito por engano — só Administrador.
  if (ehAdmin()) {
    const btnExcluir = el('<button class="btn btn--danger btn--block">🗑 Excluir este checklist</button>');
    app.appendChild(btnExcluir);
    btnExcluir.onclick = async function () {
      const aviso = 'Excluir o checklist ' + c.ID_CHECKLIST + ' de ' + c.NOME_EQUIPAMENTO + '?\n\n' +
        (ncs.length ? 'As ' + ncs.length + ' não conformidade(s) abertas por ele também serão excluídas.\n\n' : '') +
        'Esta ação não pode ser desfeita.';
      if (!window.confirm(aviso)) return;
      btnExcluir.disabled = true; btnExcluir.textContent = 'Excluindo…';
      try {
        await api('deleteChecklist', { idChecklist: c.ID_CHECKLIST, idUsuario: S.usuario.ID_USUARIO });
        toast('Checklist ' + c.ID_CHECKLIST + ' excluído.', false, true);
        go('checklists');
      } catch (e) {
        btnExcluir.disabled = false; btnExcluir.textContent = '🗑 Excluir este checklist';
      }
    };
  }
}

// ------------------------- LAVAGEM -------------------------

async function renderLavagemForm() {
  appendHtml(app, screenHeader('Lavagem', 'Lavagem de equipamento',
    'Responda os itens de verificação após a lavagem.'));

  const card = el('<div class="card stack"><p class="subtle">Carregando formulário…</p></div>');
  app.appendChild(card);

  let equipamentos, responsaveis, modelo;
  try {
    const res = await Promise.all([
      carregarEquipamentos(false),
      carregarResponsaveis(),
      api('getLavagemItensModelo', {})
    ]);
    equipamentos = res[0]; responsaveis = res[1]; modelo = res[2];
  } catch (e) {
    card.innerHTML = '<p class="subtle">Não foi possível carregar o formulário.</p>';
    return;
  }

  card.innerHTML = '';
  if (!equipamentos.length) {
    card.appendChild(el('<p class="subtle">Nenhum equipamento ativo cadastrado nesta unidade. ' +
      'Peça ao administrador para cadastrar em Equipamentos.</p>'));
    return;
  }
  if (!responsaveis.length) {
    card.appendChild(el('<div class="note warn">Nenhum responsável cadastrado nesta unidade. ' +
      'O administrador cadastra a lista em Configurações › Responsáveis.</div>'));
  }

  const selEquip = selectField(card, {
    label: 'Equipamento', required: true,
    options: equipamentos.map(function (e) {
      return { value: e.ID_EQUIPAMENTO, label: e.NOME + (e.CODIGO ? ' (' + e.CODIGO + ')' : '') };
    })
  });

  const selResp = selectField(card, {
    label: 'Responsável pela lavagem', required: true,
    options: responsaveis.map(function (r) { return { value: r.NOME, label: r.NOME }; })
  });

  const fotoEquip = photoField(card, { label: 'Foto do equipamento', required: true });

  card.appendChild(el('<div class="divider"></div>'));
  card.appendChild(el('<h3 class="title-lg">Itens da lavagem</h3>'));

  // As perguntas dependem do TIPO do equipamento (empilhadeira, lavadora,
  // paleteira…) — o administrador ajusta em Mais › Perguntas. Tipo sem
  // perguntas próprias usa a lista padrão.
  const itensWrap = el('<div class="stack"></div>');
  card.appendChild(itensWrap);
  let refs = [];
  function montarItens(lista) {
    itensWrap.innerHTML = '';
    refs = lista.map(function (m, indice) {
    const box = el('<div class="stack" style="padding-bottom:12px;border-bottom:1px solid var(--line)"></div>');
    itensWrap.appendChild(box);
    box.appendChild(el('<strong style="font-size:15px">' + (indice + 1) + '. ' + escapeHtml(m.item) + '</strong>'));
    box.appendChild(el('<p class="subtle" style="margin-top:-6px">' + escapeHtml(m.instrucao) + '</p>'));

    const escolha = choiceField(box, {
      label: 'Resultado', required: true, columns: 3,
      options: [
        { value: 'ok', label: 'OK', cls: 'ok' },
        { value: 'nok', label: 'NOK', cls: 'nok' },
        { value: 'na', label: 'N/A', cls: 'na' }
      ]
    });

    const sub = el('<div class="stack" hidden></div>');
    box.appendChild(sub);
    let observacao = null;

    escolha.node.addEventListener('change', function () {
      const v = escolha.getValue();
      sub.hidden = v !== 'nok';
      sub.innerHTML = '';
      observacao = null;
      if (v === 'nok') {
        observacao = textField(sub, { label: 'Observação (opcional)', multiline: true });
      }
    });

    return {
      item: m.item,
      instrucao: m.instrucao,
      validar: function () {
        const v = escolha.getValue();
        if (!v) return 'Responda o item "' + m.item + '".';
        return null;
      },
      build: function () {
        const v = escolha.getValue();
        return {
          item: m.item,
          instrucao: m.instrucao,
          resposta: v,
          observacao: v === 'nok' && observacao ? observacao.getValue() : ''
        };
      }
    };
  });
  }
  let tipoCarregado = null;
  async function carregarItensDoEquipamento() {
    const equip = equipamentos.find(function (x) { return String(x.ID_EQUIPAMENTO) === String(selEquip.getValue()); });
    if (!equip) {
      tipoCarregado = null; refs = [];
      itensWrap.innerHTML = '<p class="subtle">Selecione o equipamento para ver os itens.</p>';
      return;
    }
    const tipo = String(equip.TIPO || '');
    if (tipo === tipoCarregado) return; // mesmo tipo: mantém o que já foi respondido
    tipoCarregado = tipo; refs = [];
    itensWrap.innerHTML = '<p class="subtle">Carregando itens…</p>';
    const lista = await api('getLavagemItensModelo', { tipo: tipo }).catch(function () { return null; });
    if (tipoCarregado !== tipo) return; // trocou de equipamento no meio
    montarItens(lista && lista.length ? lista : modelo);
  }
  selEquip.select.addEventListener('change', carregarItensDoEquipamento);
  carregarItensDoEquipamento();

  const btn = el('<button class="btn btn--primary btn--block" style="margin-top:6px">✓ Concluir lavagem</button>');
  card.appendChild(btn);
  btn.onclick = async function () {
    if (!selEquip.getValue()) { toast('Selecione o equipamento', true); return; }
    if (!selResp.getValue()) { toast('Selecione o responsável', true); return; }
    if (!fotoEquip.getValue()) { toast('A foto do equipamento é obrigatória', true); return; }
    if (!refs.length) { toast('Aguarde os itens carregarem', true); return; }
    const itens = [];
    for (const r of refs) {
      const erro = r.validar();
      if (erro) { toast(erro, true); return; }
      itens.push(r.build());
    }
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const res = await api('createLavagem', {
        unidade: S.unidade.UNIDADE,
        idUsuario: S.usuario.ID_USUARIO,
        idEquipamento: selEquip.getValue(),
        responsavel: selResp.getValue(),
        fotoEquipamento: fotoEquip.getValue(),
        itens: itens
      });
      toast('Lavagem ' + res.idLavagem + ' registrada!' + (res.status === 'pendencia' ? ' Com pendência anotada.' : ''), false, true);
      go('painel');
    } catch (e) {
      btn.disabled = false; btn.textContent = '✓ Concluir lavagem';
    }
  };
}

// ------------------------- TROCA DE GÁS -------------------------

async function renderTrocaGasForm() {
  appendHtml(app, screenHeader('Troca de gás', 'Registrar troca de gás',
    'Informe o horímetro atual — o app calcula sozinho as horas de uso desde a última troca.'));

  const card = el('<div class="card stack"><p class="subtle">Carregando formulário…</p></div>');
  app.appendChild(card);

  let equipamentos, responsaveis;
  try {
    const res = await Promise.all([carregarEquipamentos(false), carregarResponsaveis()]);
    equipamentos = res[0]; responsaveis = res[1];
  } catch (e) {
    card.innerHTML = '<p class="subtle">Não foi possível carregar o formulário.</p>';
    return;
  }

  card.innerHTML = '';
  if (!equipamentos.length) {
    card.appendChild(el('<p class="subtle">Nenhum equipamento ativo cadastrado nesta unidade. ' +
      'Peça ao administrador para cadastrar em Equipamentos.</p>'));
    return;
  }

  const selResp = selectField(card, {
    label: 'Responsável', required: true,
    options: responsaveis.map(function (r) { return { value: r.NOME, label: r.NOME }; })
  });

  const selEquip = selectField(card, {
    label: 'Frota (equipamento)', required: true,
    options: equipamentos.map(function (e) {
      return { value: e.ID_EQUIPAMENTO, label: e.NOME + (e.CODIGO ? ' (' + e.CODIGO + ')' : '') };
    })
  });

  const horimetro = textField(card, {
    label: 'Horímetro atual', required: true, type: 'text', placeholder: 'Ex: 09529',
    hint: 'Digite todos os números do visor, sem vírgula nem ponto — veja o exemplo abaixo.'
  });
  horimetro.input.setAttribute('inputmode', 'numeric');
  horimetro.input.setAttribute('pattern', '[0-9]*');
  // Só deixa dígito passar — mesmo que o operador tente digitar vírgula ou
  // ponto (o horímetro mecânico mostra o último número separado, mas tem
  // que ser digitado junto com os outros, sem separador nenhum).
  horimetro.input.addEventListener('input', function () {
    const limpo = horimetro.input.value.replace(/[^0-9]/g, '');
    if (limpo !== horimetro.input.value) horimetro.input.value = limpo;
  });
  card.appendChild(el(
    '<div class="horimetro-exemplo">' +
      '<span class="horimetro-exemplo__label">📟 Como digitar o horímetro</span>' +
      '<div class="horimetro-exemplo__visor">' +
        '<span>0</span><span>9</span><span>5</span><span>2</span><span>9</span>' +
      '</div>' +
      '<span class="horimetro-exemplo__seta">↓ digite todos os números juntos, sem vírgula ↓</span>' +
      '<div class="horimetro-exemplo__campo">09529</div>' +
    '</div>'
  ));

  const kg = textField(card, {
    label: 'Quantidade de gás (kg) — opcional', required: false, type: 'text', placeholder: 'Ex: 20',
    hint: 'Deixe em branco se não souber. Ex: cilindro P20 = 20kg, P45 = 45kg.'
  });
  kg.input.setAttribute('inputmode', 'decimal');

  const fornecedorWrap = el('<div class="field"><label>Fornecedor *</label><p class="subtle" style="margin-top:0">Selecione o equipamento para ver os fornecedores da unidade.</p></div>');
  card.appendChild(fornecedorWrap);
  let selFornecedor = null;
  let fornecedores = [];

  async function carregarFornecedores() {
    fornecedorWrap.innerHTML = '<label>Fornecedor *</label><p class="subtle" style="margin-top:0">Carregando fornecedores…</p>';
    try {
      fornecedores = await api('getFornecedoresGas', { unidade: S.unidade.UNIDADE });
    } catch (e) { fornecedores = []; }
    fornecedorWrap.innerHTML = '';
    if (!fornecedores.length) {
      fornecedorWrap.appendChild(el('<label>Fornecedor *</label>'));
      fornecedorWrap.appendChild(el('<div class="note warn">Nenhum fornecedor de gás cadastrado para a unidade ' +
        escapeHtml(S.unidade.UNIDADE) + '.</div>'));
      selFornecedor = null;
      return;
    }
    selFornecedor = selectField(fornecedorWrap, {
      label: 'Fornecedor', required: true,
      options: fornecedores.map(function (f) {
        return { value: f.FORNECEDOR, label: f.FORNECEDOR + ' · R$ ' + f.VALOR.toFixed(2).replace('.', ',') };
      })
    });
  }
  await carregarFornecedores();

  // ---- Conferência do horímetro ----
  // Mostra o horímetro da última troca da frota e as horas calculadas. Se
  // passar de LIMITE_HORAS_ENTRE_TROCAS, pede confirmação antes de salvar
  // (o operador pode corrigir ou confirmar que está certo).
  const infoHoras = el('<p class="subtle" style="margin-top:-4px"></p>');
  horimetro.node.appendChild(infoHoras);
  let ultimaTroca = null;      // última troca da frota escolhida (ou null)
  let ultimaTrocaDe = '';      // de qual frota é o valor acima
  function horasCalculadas() {
    if (!ultimaTroca || ultimaTrocaDe !== selEquip.getValue() || !horimetro.getValue()) return null;
    const ant = Number(ultimaTroca.HORIMETRO), atual = Number(horimetro.getValue());
    if (isNaN(ant) || isNaN(atual)) return null;
    return Math.round((atual - ant) * 100) / 100;
  }
  function atualizarInfoHoras() {
    if (!selEquip.getValue()) { infoHoras.textContent = ''; return; }
    if (ultimaTrocaDe !== selEquip.getValue()) { infoHoras.textContent = 'Buscando a última troca desta frota…'; return; }
    if (!ultimaTroca) { infoHoras.textContent = 'Primeira troca registrada desta frota — não há horímetro anterior para comparar.'; return; }
    const h = horasCalculadas();
    let texto = 'Última troca: horímetro ' + ultimaTroca.HORIMETRO + ' em ' + fmtData(ultimaTroca.DATA_HORA) + '.';
    if (h !== null) {
      texto += ' Horas desde a última troca: ' + String(h).replace('.', ',') + 'h' +
        (h > LIMITE_HORAS_ENTRE_TROCAS ? ' — acima de ' + LIMITE_HORAS_ENTRE_TROCAS + 'h, confira o horímetro.' : '.');
    }
    infoHoras.textContent = texto;
    infoHoras.style.color = (h !== null && (h > LIMITE_HORAS_ENTRE_TROCAS || h < 0)) ? 'var(--st-risco)' : '';
  }
  async function buscarUltimaTroca() {
    const id = selEquip.getValue();
    ultimaTroca = null; ultimaTrocaDe = '';
    fecharAvisoHoras();
    atualizarInfoHoras();
    if (!id) return;
    const lista = await api('getTrocasGas', { unidade: S.unidade.UNIDADE, idEquipamento: id }).catch(function () { return null; });
    if (selEquip.getValue() !== id) return; // trocou de frota no meio
    if (lista === null) { infoHoras.textContent = ''; return; } // sem resposta: o servidor confere ao salvar
    ultimaTroca = lista.length ? lista[0] : null; // o servidor devolve a mais recente primeiro
    ultimaTrocaDe = id;
    atualizarInfoHoras();
  }
  selEquip.select.addEventListener('change', buscarUltimaTroca);
  horimetro.input.addEventListener('input', function () { fecharAvisoHoras(); atualizarInfoHoras(); });

  const avisoHoras = el('<div class="note warn stack" style="gap:10px;display:none"></div>');
  card.appendChild(avisoHoras);
  function fecharAvisoHoras() { avisoHoras.style.display = 'none'; avisoHoras.innerHTML = ''; }
  function pedirConfirmacaoHoras(mensagem) {
    avisoHoras.innerHTML = '';
    avisoHoras.appendChild(el('<div><strong>⚠️ Verifique o horímetro</strong><br>' + escapeHtml(mensagem) + '</div>'));
    const linha = el('<div class="row" style="gap:8px;flex-wrap:wrap"></div>');
    const btnCorrigir = el('<button type="button" class="btn btn--outline btn--sm">Corrigir horímetro</button>');
    const btnCerto = el('<button type="button" class="btn btn--primary btn--sm">Está certo, salvar</button>');
    btnCorrigir.onclick = function () { fecharAvisoHoras(); horimetro.input.focus(); horimetro.input.select(); };
    btnCerto.onclick = function () { fecharAvisoHoras(); enviar(true); };
    linha.appendChild(btnCorrigir); linha.appendChild(btnCerto);
    avisoHoras.appendChild(linha);
    avisoHoras.style.display = '';
    avisoHoras.scrollIntoView({ block: 'center' });
  }

  const btn = el('<button class="btn btn--primary btn--block" style="margin-top:6px">✓ Registrar troca de gás</button>');
  card.appendChild(btn);
  btn.onclick = function () { enviar(false); };

  async function enviar(horasConfirmadas) {
    if (!selResp.getValue()) { toast('Selecione o responsável', true); return; }
    if (!selEquip.getValue()) { toast('Selecione a frota', true); return; }
    if (!horimetro.getValue()) { toast('Informe o horímetro', true); return; }
    if (!selFornecedor || !selFornecedor.getValue()) { toast('Selecione o fornecedor', true); return; }
    const horas = horasCalculadas();
    if (!horasConfirmadas && horas !== null && horas > LIMITE_HORAS_ENTRE_TROCAS) {
      pedirConfirmacaoHoras('Está dando ' + String(horas).replace('.', ',') + ' horas desde a última troca desta frota, acima das ' +
        LIMITE_HORAS_ENTRE_TROCAS + 'h esperadas. Horímetro anterior: ' + ultimaTroca.HORIMETRO + ' · informado agora: ' + horimetro.getValue() + '.');
      return;
    }
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const res = await api('createTrocaGas', {
        unidade: S.unidade.UNIDADE,
        idUsuario: S.usuario.ID_USUARIO,
        idEquipamento: selEquip.getValue(),
        responsavel: selResp.getValue(),
        horimetro: horimetro.getValue(),
        fornecedor: selFornecedor.getValue(),
        quantidadeKg: kg.getValue(),
        confirmarHorasAltas: horasConfirmadas ? true : undefined
      });
      let msg = 'Troca de gás ' + res.idTrocaGas + ' registrada! Custo: R$ ' + Number(res.custo).toFixed(2).replace('.', ',');
      if (res.horasOperacao !== null && res.horasOperacao !== undefined) {
        msg += ' · ' + res.horasOperacao + 'h desde a última troca desta frota.';
      }
      toast(msg, false, true);
      go('painel');
    } catch (e) {
      btn.disabled = false; btn.textContent = '✓ Registrar troca de gás';
      // O servidor também confere as horas (caso o app não tenha conseguido
      // buscar a última troca): mostra a mesma confirmação.
      if (!horasConfirmadas && e && e.message && e.message.indexOf('Verifique o horímetro') === 0) {
        pedirConfirmacaoHoras(e.message.replace(/^Verifique o horímetro:?\s*/, ''));
      }
    }
  }
}

// ------------------------- MANUTENÇÕES -------------------------

async function renderManutencoes() {
  const titulo = ehAdmin() ? 'Manutenções' : 'Abertura de manutenção';
  appendHtml(app, screenHeader(titulo, titulo, 'Corretivas e preventivas da unidade ' + S.unidade.UNIDADE));

  // [OUT/2026] Quem abre o chamado é o Operador. O Administrador acompanha
  // e move o status (técnico acionado → em andamento → finalizada).
  if (!ehAdmin()) {
    const btnNova = el('<button class="btn btn--primary btn--block">＋ Nova manutenção</button>');
    btnNova.onclick = function () { go('manutencaoForm', { manutencaoAtual: null }); };
    app.appendChild(btnNova);
  }

  const filtros = el(
    '<div class="filters" style="margin-top:12px">' +
      '<select id="fStatus">' +
        '<option value="">Todos os status</option>' +
        '<option value="aberta">Abertas</option>' +
        '<option value="acionado">Técnico acionado</option>' +
        '<option value="andamento">Em andamento</option>' +
        '<option value="concluida">Finalizadas</option>' +
      '</select>' +
      '<select id="fTipo">' +
        '<option value="">Corretivas e preventivas</option>' +
        '<option value="corretiva">Corretivas</option>' +
        '<option value="preventiva">Preventivas</option>' +
      '</select>' +
      '<select id="fPrioridade">' +
        '<option value="">Todas as prioridades</option>' +
        '<option value="alta">Alta</option>' +
        '<option value="media">Média</option>' +
        '<option value="baixa">Baixa</option>' +
      '</select>' +
    '</div>'
  );
  app.appendChild(filtros);
  // [ESTABILIDADE OUT/2026] Por padrão só os últimos 30 dias, como no
  // checklist — a lista não fica mais pesada conforme o histórico cresce.
  // Chamado ainda em aberto aparece sempre, mesmo que seja mais antigo.
  const periodoWrap = el('<div style="margin-top:8px"></div>');
  app.appendChild(periodoWrap);
  const periodo = filtroPeriodo(periodoWrap, { comTodos: true, value: 'mes', onChange: function () { load(); } });
  app.appendChild(el('<p class="subtle" style="margin-top:6px">Chamados em aberto aparecem sempre, mesmo fora do período.</p>'));

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);

  ['fStatus', 'fTipo', 'fPrioridade'].forEach(function (id) {
    document.getElementById(id).onchange = load;
  });

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando…</p>';
    const per = periodo.getValue();
    const lista = await api('getManutencoes', {
      unidade: S.unidade.UNIDADE,
      periodo: per.periodo, dataInicio: per.dataInicio, dataFim: per.dataFim,
      status: document.getElementById('fStatus').value || undefined,
      tipo: document.getElementById('fTipo').value || undefined,
      prioridade: document.getElementById('fPrioridade').value || undefined
    }).catch(function () { return []; });

    body.innerHTML = '';
    if (!lista.length) { body.appendChild(el(vazio('🔧', 'Nenhuma manutenção encontrada com esses filtros.'))); return; }

    const abertas = lista.filter(function (m) { return m.STATUS === 'aberta'; }).length;
    const acionadas = lista.filter(function (m) { return m.STATUS === 'acionado'; }).length;
    const andamento = lista.filter(function (m) { return m.STATUS === 'andamento'; }).length;
    const concluidas = lista.filter(function (m) { return m.STATUS === 'concluida'; }).length;
    body.appendChild(el('<div class="kpi-grid">' +
      kpi(abertas, 'Abertas', 'kpi--parado') +
      kpi(acionadas, 'Técnico acionado', 'kpi--accent') +
      kpi(andamento, 'Em andamento', 'kpi--manut') +
      kpi(concluidas, 'Finalizadas', 'kpi--uso') +
    '</div>'));

    const btnCsv = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar CSV</button>');
    btnCsv.onclick = function () { downloadCSV(nomeArquivo('manutencoes', 'csv'), COLUNAS_MANUTENCAO, lista); };
    body.appendChild(btnCsv);

    renderPaginado(body, lista, function (m) {
      const atrasada = m.TIPO === 'preventiva' && m.STATUS !== 'concluida' &&
        m.DATA_PREVISTA && parseIso(m.DATA_PREVISTA) < new Date();
      const item = el(
        '<button type="button" class="list-item ' + (atrasada || m.STATUS === 'aberta' ? 'is-alert' : m.STATUS !== 'concluida' ? 'is-warn' : '') + '" style="width:100%">' +
          '<span><span class="shiplabel">' + escapeHtml(m.ID_MANUTENCAO) + '</span>' +
          '<div class="list-item__title" style="margin-top:6px">' + escapeHtml(m.TITULO) + '</div>' +
          '<div class="list-item__sub">' + escapeHtml(m.NOME_EQUIPAMENTO) + ' · ' +
            escapeHtml(m.TIPO === 'preventiva' ? 'Preventiva' : 'Corretiva') + ' · ' + fmtDataHora(m.ABERTA_EM) +
            ' · ' + escapeHtml(m.TEMPO_TOTAL_TEXTO || '—') + (m.STATUS === 'concluida' ? ' no total' : ' até agora') +
            (m.TIPO === 'preventiva' && m.DATA_PREVISTA ? ' · prevista ' + fmtData(m.DATA_PREVISTA) : '') + '</div></span>' +
          '<span class="stack" style="gap:4px;align-items:flex-end">' + tagManutencao(m.STATUS) + tagPrioridade(m.PRIORIDADE) + '</span>' +
        '</button>'
      );
      item.onclick = function () { go('manutencaoDetalhe', { manutencaoAtual: m, voltarPara: 'manutencoes' }); };
      return item;
    });
  }
  load();
}

const COLUNAS_MANUTENCAO = [
  ['ID_MANUTENCAO', 'ID'],
  ['NOME_EQUIPAMENTO', 'Equipamento'],
  ['TITULO', 'Título'],
  ['TIPO', 'Tipo'],
  ['PRIORIDADE', 'Prioridade'],
  ['STATUS', 'Status'],
  ['DESCRICAO', 'Descrição'],
  ['DATA_PREVISTA', 'Data prevista', fmtData],
  ['ABERTA_EM', 'Chamado aberto em', fmtDataHora],
  ['ACIONADO_EM', 'Técnico acionado em', fmtDataHora],
  ['INICIADA_EM', 'Início da manutenção', fmtDataHora],
  ['CONCLUIDA_EM', 'Fim da manutenção', fmtDataHora],
  ['TEMPO_ACIONAMENTO_TEXTO', 'Abertura até acionamento (expediente)'],
  ['TEMPO_CHEGADA_TEXTO', 'Acionamento até início (expediente)'],
  ['TEMPO_EXECUCAO_TEXTO', 'Início até fim (expediente)'],
  ['TEMPO_TOTAL_TEXTO', 'Total abertura até fim (expediente)'],
  ['UNIDADE', 'Unidade']
];

async function renderManutencaoForm() {
  const m = S.manutencaoAtual;
  const editando = !!m;
  // Dados vindos do botão "Abrir manutenção" de uma não conformidade.
  const pre = (!editando && S.manutencaoPrefill) || {};
  S.manutencaoPrefill = null;
  appendHtml(app, screenHeader(editando ? 'Editar manutenção' : 'Nova manutenção',
    editando ? m.ID_MANUTENCAO : 'Abrir manutenção',
    editando ? m.NOME_EQUIPAMENTO : 'Registre uma manutenção corretiva ou preventiva'));
  app.appendChild(botaoVoltar(editando ? 'manutencaoDetalhe' : 'manutencoes'));

  const card = el('<div class="card stack"><p class="subtle">Carregando formulário…</p></div>');
  app.appendChild(card);

  const equipamentos = await carregarEquipamentos(true);
  card.innerHTML = '';

  if (!equipamentos.length) {
    card.appendChild(el('<p class="subtle">Nenhum equipamento cadastrado nesta unidade.</p>'));
    return;
  }

  const selEquip = selectField(card, {
    label: 'Equipamento', required: true,
    value: editando ? m.ID_EQUIPAMENTO : (pre.idEquipamento || ''),
    options: equipamentos.map(function (e) {
      return { value: e.ID_EQUIPAMENTO, label: e.NOME + (e.CODIGO ? ' (' + e.CODIGO + ')' : '') };
    })
  });
  if (editando) selEquip.select.disabled = true; // o backend não troca o equipamento de uma manutenção

  const tit = textField(card, { label: 'Título', required: true, value: editando ? m.TITULO : (pre.titulo || ''), placeholder: 'Ex: Troca de pastilha de freio' });

  const selTipo = selectField(card, {
    label: 'Tipo', required: true, semVazio: true,
    value: editando ? m.TIPO : 'corretiva',
    options: [{ value: 'corretiva', label: 'Corretiva' }, { value: 'preventiva', label: 'Preventiva' }]
  });

  const selPrio = selectField(card, {
    label: 'Prioridade', required: true, semVazio: true,
    value: editando ? m.PRIORIDADE : 'media',
    options: [{ value: 'baixa', label: 'Baixa' }, { value: 'media', label: 'Média' }, { value: 'alta', label: 'Alta' }]
  });

  const prevWrap = el('<div class="stack"></div>');
  card.appendChild(prevWrap);
  const dtPrevista = textField(prevWrap, {
    label: 'Data prevista', type: 'date',
    value: editando ? paraInputDate(m.DATA_PREVISTA) : '',
    hint: 'Obrigatória para manutenção preventiva'
  });
  function atualizarPrevista() { prevWrap.hidden = selTipo.getValue() !== 'preventiva'; }
  selTipo.select.onchange = atualizarPrevista;
  atualizarPrevista();

  const desc = textField(card, { label: 'Descrição', multiline: true, value: editando ? m.DESCRICAO : (pre.descricao || '') });

  if (!editando) {
    card.appendChild(el('<div class="note">O chamado entra como <strong>Aberta</strong> com a data e hora de agora, ' +
      'e os responsáveis do setor recebem o e-mail na hora.</div>'));
  }

  const btn = el('<button class="btn btn--primary btn--block">' + (editando ? '✓ Salvar alterações' : '✓ Abrir manutenção') + '</button>');
  card.appendChild(btn);
  btn.onclick = async function () {
    if (!selEquip.getValue()) { toast('Selecione o equipamento', true); return; }
    if (!tit.getValue()) { toast('Informe o título da manutenção', true); return; }
    if (selTipo.getValue() === 'preventiva' && !dtPrevista.getValue()) {
      toast('Informe a data prevista da preventiva', true); return;
    }
    const payload = {
      idUsuario: S.usuario.ID_USUARIO,
      titulo: tit.getValue(),
      tipo: selTipo.getValue(),
      prioridade: selPrio.getValue(),
      descricao: desc.getValue(),
      dataPrevista: selTipo.getValue() === 'preventiva' ? dtPrevista.getValue() : ''
    };

    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      if (editando) {
        payload.idManutencao = m.ID_MANUTENCAO;
        const atualizada = await api('updateManutencao', payload);
        toast('Manutenção atualizada!', false, true);
        go('manutencaoDetalhe', { manutencaoAtual: atualizada });
      } else {
        payload.unidade = S.unidade.UNIDADE;
        payload.idEquipamento = selEquip.getValue();
        const criada = await api('createManutencao', payload);
        toast('Manutenção ' + criada.ID_MANUTENCAO + ' aberta!', false, true);
        go('manutencoes');
      }
    } catch (e) {
      btn.disabled = false; btn.textContent = editando ? '✓ Salvar alterações' : '✓ Abrir manutenção';
    }
  };
}

function renderManutencaoDetalhe() {
  const m = S.manutencaoAtual;
  appendHtml(app, screenHeader('Manutenção ' + m.ID_MANUTENCAO, m.TITULO, m.NOME_EQUIPAMENTO));
  app.appendChild(botaoVoltar(S.voltarPara === 'preventivas' ? 'preventivas' : 'manutencoes'));

  const card = el('<div class="card stack"></div>');
  app.appendChild(card);
  appendHtml(card,
    linhaInfo('Status', tagManutencao(m.STATUS)) +
    linhaInfo('Tipo', escapeHtml(m.TIPO === 'preventiva' ? 'Preventiva' : 'Corretiva')) +
    linhaInfo('Prioridade', tagPrioridade(m.PRIORIDADE)) +
    linhaInfo('Frota', '<strong>' + escapeHtml(m.NOME_EQUIPAMENTO) + '</strong>') +
    (m.DATA_PREVISTA ? linhaInfo('Data prevista', fmtData(m.DATA_PREVISTA)) : '')
  );
  if (m.DESCRICAO) {
    card.appendChild(el('<div class="stack" style="gap:4px"><span class="subtle">Descrição</span>' +
      '<p style="font-size:14px">' + escapeHtml(m.DESCRICAO) + '</p></div>'));
  }
  if (ehAdmin()) {
    const btnEditar = el('<button class="btn btn--outline btn--block">✎ Editar dados da manutenção</button>');
    btnEditar.onclick = function () { go('manutencaoForm', { manutencaoAtual: m }); };
    card.appendChild(btnEditar);
  }

  // ---- Linha do tempo do chamado ----
  const emCurso = m.ETAPA_EM_CURSO || '';
  function passo(numero, titulo, data, tempoRotulo, tempoTexto, etapaAnterior) {
    const feito = !!data;
    const correndo = !feito && emCurso === etapaAnterior;
    return '<div class="list-item ' + (feito ? 'is-ok' : correndo ? 'is-warn' : '') + '" style="cursor:default">' +
      '<span><span class="list-item__title">' + numero + '. ' + titulo + '</span>' +
      '<div class="list-item__sub">' + (feito ? fmtDataHora(data) : correndo ? 'Aguardando…' : '—') +
      (tempoRotulo && tempoTexto && tempoTexto !== '—'
        ? ' · ' + tempoRotulo + ': <strong>' + escapeHtml(tempoTexto) + '</strong>' + (correndo ? ' até agora' : '') : '') +
      '</div></span>' +
      '<span class="tag ' + (feito ? 'tag--ok' : 'tag--na') + '">' + (feito ? 'Feito' : correndo ? 'Em espera' : 'Pendente') + '</span>' +
    '</div>';
  }
  const linha = el('<div class="card stack"><h3 class="title-lg">🕒 Linha do tempo</h3></div>');
  app.appendChild(linha);
  appendHtml(linha,
    passo(1, 'Chamado aberto', m.ABERTA_EM) +
    passo(2, 'Técnico acionado', m.ACIONADO_EM, 'desde a abertura', m.TEMPO_ACIONAMENTO_TEXTO, 'aberta') +
    passo(3, 'Início da manutenção', m.INICIADA_EM, 'desde o acionamento', m.TEMPO_CHEGADA_TEXTO, 'acionado') +
    passo(4, 'Fim da manutenção', m.CONCLUIDA_EM, 'duração do serviço', m.TEMPO_EXECUCAO_TEXTO, 'andamento')
  );
  linha.appendChild(el('<div class="divider"></div>'));
  appendHtml(linha,
    linhaInfo('Abertura → técnico acionado', '<strong class="mono">' + escapeHtml(m.TEMPO_ACIONAMENTO_TEXTO || '—') + '</strong>') +
    linhaInfo('Técnico acionado → início', '<strong class="mono">' + escapeHtml(m.TEMPO_CHEGADA_TEXTO || '—') + '</strong>') +
    linhaInfo('Início → fim', '<strong class="mono">' + escapeHtml(m.TEMPO_EXECUCAO_TEXTO || '—') + '</strong>') +
    linhaInfo(m.STATUS === 'concluida' ? 'Total (abertura → fim)' : 'Total até agora',
      '<strong class="mono">' + escapeHtml(m.TEMPO_TOTAL_TEXTO || '—') + '</strong>')
  );
  linha.appendChild(el('<div class="note">Os tempos contam só o expediente do setor, de segunda a sexta. ' +
    (S.setor === 'FABRICA' ? 'Fábrica: direto, de segunda 05:00 até sábado 06:00.'
      : 'Operação: 07:30 às 02:30, sem a hora do almoço (12:00 às 13:00).') + '</div>'));

  // ---- Mudança de status: só o Administrador ----
  if (!ehAdmin()) return;

  const acoes = el('<div class="card stack"><h3 class="title-lg">Atualizar status</h3></div>');
  app.appendChild(acoes);
  const areaDatas = el('<div class="stack" hidden></div>');

  function abrirConfirmacao(st) {
    const info = STATUS_MANUTENCAO[st];
    areaDatas.hidden = false;
    areaDatas.innerHTML = '';
    let campoAcionado = null, campoInicio = null, campoFim = null;
    if (st === 'acionado') {
      campoAcionado = textField(areaDatas, { label: 'Data e hora em que o técnico foi acionado', type: 'datetime-local',
        value: paraInputDateTime(m.ACIONADO_EM) });
    }
    if (st === 'andamento' || st === 'concluida') {
      campoInicio = textField(areaDatas, { label: 'Data e hora de início da manutenção', type: 'datetime-local',
        value: paraInputDateTime(m.INICIADA_EM) });
    }
    if (st === 'concluida') {
      campoFim = textField(areaDatas, { label: 'Data e hora do fim da manutenção', type: 'datetime-local',
        value: paraInputDateTime(m.CONCLUIDA_EM) });
    }
    if (FLUXO_MANUTENCAO.indexOf(st) < FLUXO_MANUTENCAO.indexOf(m.STATUS)) {
      areaDatas.appendChild(el('<div class="note warn">Voltar o status apaga as datas das etapas seguintes já registradas.</div>'));
    }
    areaDatas.appendChild(el('<div class="note">A data e a hora vêm preenchidas com o momento atual — ajuste se aconteceu em outro horário. ' +
      'Ao confirmar, os responsáveis do setor recebem o e-mail com a linha do tempo.</div>'));
    const confirmar = el('<button class="btn btn--primary btn--block">Confirmar → ' + info.label + '</button>');
    areaDatas.appendChild(confirmar);
    confirmar.onclick = async function () {
      confirmar.disabled = true; confirmar.textContent = 'Salvando…';
      const payload = { idManutencao: m.ID_MANUTENCAO, idUsuario: S.usuario.ID_USUARIO, status: st };
      if (campoAcionado) payload.acionadoEm = inputDateTimeParaIso(campoAcionado.getValue());
      if (campoInicio) payload.iniciadaEm = inputDateTimeParaIso(campoInicio.getValue());
      if (campoFim) payload.concluidaEm = inputDateTimeParaIso(campoFim.getValue());
      try {
        const atualizada = await api('updateManutencao', payload);
        toast('Status atualizado para "' + info.label + '".', false, true);
        go('manutencaoDetalhe', { manutencaoAtual: atualizada });
      } catch (e) {
        confirmar.disabled = false; confirmar.textContent = 'Confirmar → ' + info.label;
      }
    };
  }

  // Botão grande do próximo passo do fluxo.
  const proximo = FLUXO_MANUTENCAO[FLUXO_MANUTENCAO.indexOf(m.STATUS) + 1];
  if (proximo) {
    const btnProx = el('<button class="btn btn--primary btn--block">' + ACAO_PROXIMO_STATUS[proximo] + '</button>');
    btnProx.onclick = function () { abrirConfirmacao(proximo); };
    acoes.appendChild(btnProx);
  } else {
    acoes.appendChild(el('<p class="subtle">Chamado finalizado.</p>'));
  }
  acoes.appendChild(areaDatas);

  // Correção: ir para qualquer outro status (pular etapa ou voltar).
  const outros = el('<details><summary class="subtle" style="cursor:pointer">Corrigir: mudar para outro status</summary></details>');
  const grid = el('<div class="option-grid" style="grid-template-columns:repeat(2,1fr);margin-top:8px"></div>');
  outros.appendChild(grid);
  FLUXO_MANUTENCAO.forEach(function (st) {
    const b = el('<button type="button" class="option-btn"' + (st === m.STATUS ? ' disabled' : '') + '>' + STATUS_MANUTENCAO[st].label + '</button>');
    if (st === m.STATUS) b.classList.add('is-selected');
    else b.onclick = function () { abrirConfirmacao(st); };
    grid.appendChild(b);
  });
  acoes.appendChild(outros);
}

// ------------------------- PREVENTIVAS -------------------------

async function renderPreventivas() {
  appendHtml(app, screenHeader('Preventivas', 'Manutenções preventivas', 'Ordenadas pela data prevista — atrasadas em vermelho'));

  const filtros = el(
    '<div class="filters">' +
      '<select id="fStatus">' +
        '<option value="">Pendentes e finalizadas</option>' +
        '<option value="aberta">Abertas</option>' +
        '<option value="acionado">Técnico acionado</option>' +
        '<option value="andamento">Em andamento</option>' +
        '<option value="concluida">Finalizadas</option>' +
      '</select>' +
    '</div>'
  );
  app.appendChild(filtros);

  const btnNova = el('<button class="btn btn--primary btn--block" style="margin-top:12px">＋ Nova preventiva</button>');
  btnNova.onclick = function () { go('manutencaoForm', { manutencaoAtual: null }); };
  app.appendChild(btnNova);

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);
  document.getElementById('fStatus').onchange = load;

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando…</p>';
    const lista = await api('getManutencoes', {
      unidade: S.unidade.UNIDADE,
      tipo: 'preventiva',
      status: document.getElementById('fStatus').value || undefined
    }).catch(function () { return []; });

    body.innerHTML = '';
    if (!lista.length) { body.appendChild(el(vazio('🗓️', 'Nenhuma preventiva cadastrada.'))); return; }

    // Ordena por data prevista (as sem data vão para o fim).
    const ordenada = lista.slice().sort(function (a, b) {
      const da = parseIso(a.DATA_PREVISTA), db = parseIso(b.DATA_PREVISTA);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });

    const hoje = new Date();
    const atrasadas = ordenada.filter(function (m) {
      return m.STATUS !== 'concluida' && parseIso(m.DATA_PREVISTA) && parseIso(m.DATA_PREVISTA) < hoje;
    }).length;
    body.appendChild(el('<div class="kpi-grid">' +
      kpi(ordenada.length, 'Preventivas') +
      kpi(atrasadas, 'Atrasadas', 'kpi--parado') +
    '</div>'));

    renderPaginado(body, ordenada, function (m) {
      const prevista = parseIso(m.DATA_PREVISTA);
      const atrasada = m.STATUS !== 'concluida' && prevista && prevista < hoje;
      const dias = prevista ? Math.ceil((prevista.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000) : null;
      const item = el(
        '<button type="button" class="list-item ' + (atrasada ? 'is-alert' : m.STATUS === 'concluida' ? 'is-ok' : 'is-warn') + '" style="width:100%">' +
          '<span><span class="list-item__title">' + escapeHtml(m.TITULO) + '</span>' +
          '<div class="list-item__sub">' + escapeHtml(m.NOME_EQUIPAMENTO) + ' · prevista ' + fmtData(m.DATA_PREVISTA) + '</div></span>' +
          '<span class="stack" style="gap:4px;align-items:flex-end">' + tagManutencao(m.STATUS) +
          (m.STATUS !== 'concluida' && dias !== null
            ? '<span class="tag ' + (atrasada ? 'tag--parado' : 'tag--info') + '">' +
              (atrasada ? 'Atrasada ' + Math.abs(dias) + 'd' : 'Em ' + dias + 'd') + '</span>'
            : '') +
          '</span>' +
        '</button>'
      );
      item.onclick = function () { go('manutencaoDetalhe', { manutencaoAtual: m, voltarPara: 'preventivas' }); };
      return item;
    });
  }
  load();
}

// ------------------------- HISTÓRICO -------------------------

const HISTORICO_ICONE = {
  checklist: { ic: '✅', label: 'Checklist' },
  manutencao: { ic: '🔧', label: 'Manutenção' },
  nao_conformidade: { ic: '⚠️', label: 'Não conformidade' },
  lavagem: { ic: '🧽', label: 'Lavagem' },
  troca_gas: { ic: '⛽', label: 'Troca de gás' }
};

async function renderHistorico() {
  appendHtml(app, screenHeader('Histórico', 'Linha do tempo', 'Checklists, manutenções e não conformidades da unidade'));

  const filtroTopo = el('<div class="stack" style="gap:8px"></div>');
  app.appendChild(filtroTopo);
  const periodo = filtroPeriodo(filtroTopo, { comTodos: true, value: 'mes', onChange: function () { load(); } });

  const filtros2 = el(
    '<div class="filters" style="margin-top:4px">' +
      '<select id="fTipo">' +
        '<option value="">Todos os eventos</option>' +
        '<option value="checklist">Checklists</option>' +
        '<option value="manutencao">Manutenções</option>' +
        '<option value="nao_conformidade">Não conformidades</option>' +
        '<option value="lavagem">Lavagens</option>' +
        '<option value="troca_gas">Trocas de gás</option>' +
      '</select>' +
      '<select id="fEquip"><option value="">Todos os equipamentos</option></select>' +
    '</div>'
  );
  app.appendChild(filtros2);

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);

  const equipamentos = await carregarEquipamentos(true);
  const selEquip = document.getElementById('fEquip');
  equipamentos.forEach(function (e) {
    selEquip.appendChild(el('<option value="' + escapeHtml(e.ID_EQUIPAMENTO) + '">' + escapeHtml(e.NOME) + '</option>'));
  });
  selEquip.onchange = load;
  document.getElementById('fTipo').onchange = load;

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando…</p>';
    const p = periodo.getValue();
    const d = await api('getHistorico', {
      unidade: S.unidade.UNIDADE,
      periodo: p.periodo,
      dataInicio: p.dataInicio,
      dataFim: p.dataFim,
      idEquipamento: selEquip.value || undefined,
      tipo: document.getElementById('fTipo').value || undefined
    }).catch(function () { return null; });

    body.innerHTML = '';
    if (!d) return;
    body.appendChild(el('<p class="subtle">' + escapeHtml(d.periodo.label) + ' · ' + d.total + ' evento(s)</p>'));

    if (!d.eventos.length) { body.appendChild(el(vazio('🕘', 'Nenhum evento registrado neste período.'))); return; }

    const card = el('<div class="card stack" style="gap:0"></div>');
    body.appendChild(card);
    renderPaginado(card, d.eventos, function (ev) {
      const info = HISTORICO_ICONE[ev.tipo] || { ic: '•', label: ev.tipo };
      let tag = '';
      if (ev.tipo === 'manutencao') tag = tagManutencao(ev.status);
      else if (ev.tipo === 'checklist' || ev.tipo === 'lavagem') {
        const st = STATUS_CHECKLIST[ev.status] || { label: ev.status, cls: 'na' };
        tag = '<span class="tag tag--' + st.cls + '">' + escapeHtml(st.label) + '</span>';
      } else if (ev.tipo === 'troca_gas') {
        tag = '<span class="tag tag--uso">Concluída</span>';
      } else {
        tag = '<span class="tag tag--' + (ev.status === 'aberta' ? 'aberta' : 'concluida') + '">' +
          (ev.status === 'aberta' ? 'Aberta' : 'Fechada') + '</span>';
      }
      return el(
        '<div class="tl-item">' +
          '<div class="tl-rail"><span class="tl-dot">' + info.ic + '</span><span class="tl-line"></span></div>' +
          '<div class="tl-body">' +
            '<div class="row between" style="gap:8px"><span class="t">' + escapeHtml(ev.titulo || info.label) + '</span>' + tag + '</div>' +
            '<div class="m">' + escapeHtml(ev.nomeEquipamento || '—') + ' · ' + fmtDataHora(ev.data) + '</div>' +
            (ev.descricao ? '<div class="m">' + escapeHtml(ev.descricao) + '</div>' : '') +
            (ev.tipo === 'manutencao' && ev.tempoTexto ? '<div class="m mono">Tempo: ' + escapeHtml(ev.tempoTexto) + '</div>' : '') +
          '</div>' +
        '</div>'
      );
    }, 25);
  }
  load();
}

// ------------------------- EQUIPAMENTOS (ADMIN) -------------------------

async function renderEquipamentos() {
  appendHtml(app, screenHeader('Equipamentos', 'Frota · ' + setorLabel(S.setor), 'Cadastro, status e histórico dos equipamentos de ' + unidadeSetorLabel()));

  const btnNovo = el('<button class="btn btn--primary btn--block">＋ Novo equipamento</button>');
  btnNovo.onclick = function () { go('equipamentoForm', { equipamentoAtual: null }); };
  app.appendChild(btnNovo);

  const filtros = el(
    '<div class="stack" style="gap:8px;margin-top:12px">' +
      '<div class="field" style="gap:4px"><input type="search" id="fBusca" placeholder="🔎 Buscar por nome ou código"></div>' +
      '<div class="filters">' +
        '<select id="fStatus">' +
          '<option value="">Todos os status</option>' +
          '<option value="em_uso">Em uso</option>' +
          '<option value="manutencao">Em manutenção</option>' +
          '<option value="parado">Parado</option>' +
          '<option value="inativo">Inativo</option>' +
        '</select>' +
        '<select id="fTipo"><option value="">Todos os tipos</option></select>' +
        '<label class="subtle row" style="gap:6px;white-space:nowrap">' +
          '<input type="checkbox" id="fInativos" style="width:auto"> Mostrar inativos</label>' +
      '</div>' +
    '</div>'
  );
  app.appendChild(filtros);

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);

  const tipos = await carregarTiposEquipamento();
  const selTipo = document.getElementById('fTipo');
  tipos.forEach(function (t) { selTipo.appendChild(el('<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>')); });

  const inpBusca = document.getElementById('fBusca');
  let timerBusca = null;
  inpBusca.oninput = function () { clearTimeout(timerBusca); timerBusca = setTimeout(load, 400); };
  document.getElementById('fStatus').onchange = load;
  selTipo.onchange = load;
  document.getElementById('fInativos').onchange = load;

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando…</p>';
    const lista = await api('getEquipamentos', {
      unidade: S.unidade.UNIDADE,
      busca: inpBusca.value || undefined,
      status: document.getElementById('fStatus').value || undefined,
      tipo: selTipo.value || undefined,
      incluirInativos: document.getElementById('fInativos').checked ? true : undefined
    }).catch(function () { return []; });

    body.innerHTML = '';
    if (!lista.length) { body.appendChild(el(vazio('🚜', 'Nenhum equipamento encontrado com esses filtros.'))); return; }

    const btnCsv = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar CSV</button>');
    btnCsv.onclick = function () {
      downloadCSV(nomeArquivo('equipamentos', 'csv'), [
        ['ID_EQUIPAMENTO', 'ID'], ['NOME', 'Nome'], ['CODIGO', 'Código'], ['TIPO', 'Tipo'],
        ['STATUS', 'Status'], ['STATUS_DESDE', 'Status desde', fmtDataHora],
        ['TEMPO_NO_STATUS_TEXTO', 'Tempo no status'], ['OBSERVACOES', 'Observações'],
        ['CRIADO_EM', 'Criado em', fmtDataHora], ['UNIDADE', 'Unidade'], ['SETOR', 'Setor', setorLabel]
      ], lista);
    };
    body.appendChild(btnCsv);
    body.appendChild(el('<p class="subtle">' + lista.length + ' equipamento(s)</p>'));

    renderPaginado(body, lista, function (e) {
      const cls = e.STATUS === 'parado' ? 'is-alert' : e.STATUS === 'manutencao' ? 'is-warn' : e.STATUS === 'em_uso' ? 'is-ok' : '';
      const item = el(
        '<button type="button" class="list-item ' + cls + '" style="width:100%">' +
          '<span><span class="list-item__title">' + escapeHtml(e.NOME) + '</span>' +
          '<div class="list-item__sub">' + (e.CODIGO ? escapeHtml(e.CODIGO) + ' · ' : '') + escapeHtml(e.TIPO || '—') +
          ' · ' + escapeHtml(e.TEMPO_NO_STATUS_TEXTO || '—') + ' neste status</div></span>' +
          tagEquipamento(e.STATUS) +
        '</button>'
      );
      item.onclick = function () { go('equipamentoForm', { equipamentoAtual: e }); };
      return item;
    });
  }
  load();
}

async function renderEquipamentoForm() {
  const e = S.equipamentoAtual;
  const editando = !!e;
  appendHtml(app, screenHeader(editando ? 'Editar equipamento' : 'Novo equipamento',
    editando ? e.NOME : 'Cadastrar equipamento',
    editando ? 'Código ' + (e.CODIGO || '—') + ' · ' + setorLabel(e.SETOR || S.setor) : 'Unidade ' + S.unidade.UNIDADE));
  app.appendChild(botaoVoltar('equipamentos'));

  const card = el('<div class="card stack"><p class="subtle">Carregando…</p></div>');
  app.appendChild(card);

  const tipos = await carregarTiposEquipamento();
  card.innerHTML = '';

  const nome = textField(card, { label: 'Nome do equipamento', required: true, value: editando ? e.NOME : '' });
  const codigo = textField(card, { label: 'Código / patrimônio', value: editando ? e.CODIGO : '', hint: 'Opcional, mas não pode repetir na unidade' });

  const tipoConhecido = editando ? tipos.indexOf(e.TIPO) > -1 && e.TIPO !== 'Outro' : true;
  const selTipo = selectField(card, {
    label: 'Tipo', semVazio: true,
    value: editando ? (tipoConhecido ? e.TIPO : 'Outro') : tipos[0],
    options: tipos.map(function (t) { return { value: t, label: t }; })
  });
  const outroWrap = el('<div class="stack"></div>');
  card.appendChild(outroWrap);
  const outroTipo = textField(outroWrap, {
    label: 'Qual o tipo?', placeholder: 'Ex: Rebocador elétrico',
    value: editando && !tipoConhecido ? e.TIPO : ''
  });
  function atualizarOutro() { outroWrap.hidden = selTipo.getValue() !== 'Outro'; }
  selTipo.select.onchange = atualizarOutro;
  atualizarOutro();

  // [OUT/2026] Setor do equipamento: decide em qual setor ele aparece e
  // para quem vai o e-mail quando abrirem manutenção dele.
  const setorAtual = editando ? (SETORES[String(e.SETOR || '').toUpperCase()] ? String(e.SETOR).toUpperCase() : S.setor) : S.setor;
  const selSetor = choiceField(card, {
    label: 'Setor', required: true, value: setorAtual,
    options: Object.keys(SETORES).map(function (k) {
      return { value: k, label: SETORES[k].ic + ' ' + SETORES[k].label };
    })
  });

  const selStatus = selectField(card, {
    label: 'Status', semVazio: true,
    value: editando ? e.STATUS : 'em_uso',
    options: Object.keys(STATUS_EQUIPAMENTO).map(function (k) {
      return { value: k, label: STATUS_EQUIPAMENTO[k].label };
    }),
    hint: 'Trocar o status reinicia a contagem de tempo no status'
  });

  const obs = textField(card, { label: 'Observações', multiline: true, value: editando ? e.OBSERVACOES : '' });

  if (editando) {
    card.appendChild(el('<div class="note">Status atual há <strong>' + escapeHtml(e.TEMPO_NO_STATUS_TEXTO || '—') +
      '</strong> (desde ' + fmtDataHora(e.STATUS_DESDE) + ').</div>'));
  }

  const btn = el('<button class="btn btn--primary btn--block">' + (editando ? '✓ Salvar alterações' : '✓ Cadastrar equipamento') + '</button>');
  card.appendChild(btn);
  btn.onclick = async function () {
    if (!nome.getValue()) { toast('Informe o nome do equipamento', true); return; }
    if (!selSetor.getValue()) { toast('Escolha o setor: Fábrica ou Operação', true); return; }
    const tipoFinal = selTipo.getValue() === 'Outro' ? (outroTipo.getValue() || 'Outro') : selTipo.getValue();
    const payload = {
      idUsuario: S.usuario.ID_USUARIO,
      nome: nome.getValue(),
      codigo: codigo.getValue(),
      tipo: tipoFinal,
      setor: selSetor.getValue(),
      status: selStatus.getValue(),
      observacoes: obs.getValue()
    };
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      if (editando) {
        payload.idEquipamento = e.ID_EQUIPAMENTO;
        await api('updateEquipamento', payload);
        toast(payload.setor !== S.setor
          ? 'Equipamento movido para ' + setorLabel(payload.setor) + '.'
          : 'Equipamento atualizado!', false, true);
      } else {
        payload.unidade = S.unidade.UNIDADE;
        await api('createEquipamento', payload);
        toast(payload.setor !== S.setor
          ? 'Equipamento cadastrado em ' + setorLabel(payload.setor) + '.'
          : 'Equipamento cadastrado!', false, true);
      }
      limparCacheEquipamentos();
      go('equipamentos');
    } catch (err) {
      btn.disabled = false; btn.textContent = editando ? '✓ Salvar alterações' : '✓ Cadastrar equipamento';
    }
  };

  if (editando) {
    const btnExcluir = el('<button class="btn btn--danger btn--block">🗑 Excluir equipamento</button>');
    card.appendChild(btnExcluir);
    btnExcluir.onclick = async function () {
      if (!window.confirm('Excluir "' + e.NOME + '"? Se ele já tiver histórico, será apenas inativado.')) return;
      btnExcluir.disabled = true; btnExcluir.textContent = 'Excluindo…';
      try {
        const res = await api('deleteEquipamento', { idEquipamento: e.ID_EQUIPAMENTO, idUsuario: S.usuario.ID_USUARIO });
        toast(res.inativado ? (res.mensagem || 'Equipamento inativado.') : 'Equipamento excluído.', false, true);
        limparCacheEquipamentos();
        go('equipamentos');
      } catch (err) {
        btnExcluir.disabled = false; btnExcluir.textContent = '🗑 Excluir equipamento';
      }
    };
  }
}

// ------------------------- NÃO CONFORMIDADES (ADMIN) -------------------------

async function renderNaoConformidades() {
  appendHtml(app, screenHeader('Não conformidades', 'Não conformidades', 'Abertas automaticamente pelos itens NOK do checklist'));
  app.appendChild(el('<div class="note">Não existe cadastro manual: cada não conformidade nasce de um item respondido ' +
    '<strong>NOK</strong> num checklist. Aqui o administrador acompanha e fecha o que já foi resolvido. ' +
    'Enquanto uma NC do mesmo equipamento + item estiver aberta, o checklist não abre outra duplicada.</div>'));

  const filtros = el(
    '<div class="filters" style="margin-top:12px">' +
      '<select id="fStatus">' +
        '<option value="aberta">Abertas</option>' +
        '<option value="fechada">Fechadas</option>' +
        '<option value="">Todas</option>' +
      '</select>' +
      '<select id="fEquip"><option value="">Todos os equipamentos</option></select>' +
    '</div>'
  );
  app.appendChild(filtros);

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);

  const equipamentos = await carregarEquipamentos(true);
  const selEquip = document.getElementById('fEquip');
  equipamentos.forEach(function (e) {
    selEquip.appendChild(el('<option value="' + escapeHtml(e.ID_EQUIPAMENTO) + '">' + escapeHtml(e.NOME) + '</option>'));
  });
  const selStatus = document.getElementById('fStatus');
  selStatus.onchange = load;
  selEquip.onchange = load;

  // Filtro vindo de outra tela (checklist do dia / detalhe do checklist):
  // vale uma vez só, depois a tela volta ao padrão.
  const filtroInicial = S.ncFiltro || null;
  S.ncFiltro = null;
  let ncDestaque = '';
  if (filtroInicial) {
    if (filtroInicial.status !== undefined) selStatus.value = filtroInicial.status;
    if (filtroInicial.idEquipamento) selEquip.value = String(filtroInicial.idEquipamento);
    ncDestaque = filtroInicial.idNc || '';
  }

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando…</p>';
    const lista = await api('getNaoConformidades', {
      unidade: S.unidade.UNIDADE,
      status: selStatus.value || undefined,
      idEquipamento: selEquip.value || undefined
    }).catch(function () { return []; });

    body.innerHTML = '';
    if (!lista.length) { body.appendChild(el(vazio('⚠️', 'Nenhuma não conformidade com esses filtros.'))); return; }

    const btnCsv = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar CSV</button>');
    btnCsv.onclick = function () { downloadCSV(nomeArquivo('nao_conformidades', 'csv'), COLUNAS_NC, lista); };
    body.appendChild(btnCsv);
    body.appendChild(el('<p class="subtle">' + lista.length + ' não conformidade(s)</p>'));

    renderPaginado(body, lista, function (nc) {
      const aberta = String(nc.STATUS) === 'aberta';
      // Depois que uma manutenção é aberta para a NC, o status dela
      // acompanha o chamado: manutenção aberta → técnico acionado → em
      // manutenção → manutenção finalizada.
      const etapaNc = aberta ? FLUXO_NC_MANUTENCAO[nc.STATUS_MANUTENCAO] : null;
      const manutAtiva = !!etapaNc && nc.STATUS_MANUTENCAO !== 'concluida';
      const emDestaque = ncDestaque && String(nc.ID_NC) === String(ncDestaque);
      const card = el('<div class="card stack" style="gap:10px' + (aberta ? ';border-left:4px solid var(--st-risco)' : '') +
        (emDestaque ? ';outline:2px solid var(--brand);outline-offset:2px' : '') + '"></div>');
      if (emDestaque) setTimeout(function () { if (card.isConnected) card.scrollIntoView({ block: 'center' }); }, 60);
      appendHtml(card,
        '<div class="row between" style="gap:8px">' +
          '<span class="shiplabel">' + escapeHtml(nc.ID_NC) + '</span>' +
          '<span class="tag tag--' + (etapaNc ? etapaNc.cls : aberta ? 'aberta' : 'concluida') + '">' +
            (etapaNc ? etapaNc.label : aberta ? 'Aberta' : 'Fechada') + '</span>' +
        '</div>' +
        '<div><strong style="font-size:15px">' + escapeHtml(nc.ITEM) + '</strong>' +
        '<div class="subtle">' + escapeHtml(nc.NOME_EQUIPAMENTO) + '</div></div>' +
        (nc.DESCRICAO ? '<p style="font-size:14px">' + escapeHtml(nc.DESCRICAO) + '</p>' : '') +
        linhaInfo('Aberta em', fmtDataHora(nc.ABERTA_EM)) +
        (nc.FECHADA_EM ? linhaInfo('Fechada em', fmtDataHora(nc.FECHADA_EM)) : '') +
        linhaInfo(aberta ? 'Tempo em aberto' : 'Tempo até o fechamento', '<strong class="mono">' + escapeHtml(nc.TEMPO_ABERTA_TEXTO || '—') + '</strong>') +
        (nc.ID_CHECKLIST_ORIGEM ? linhaInfo('Checklist de origem', '<span class="mono">' + escapeHtml(nc.ID_CHECKLIST_ORIGEM) + '</span>') : '') +
        (nc.ID_MANUTENCAO ? linhaInfo('Manutenção', '<span class="mono">' + escapeHtml(nc.ID_MANUTENCAO) + '</span>') : '')
      );
      if (nc.FOTO) card.appendChild(el('<div>' + fotoSalva(nc.FOTO, 'Problema') + '</div>'));

      const btn = el('<button class="btn ' + (aberta ? 'btn--primary' : 'btn--outline') + ' btn--block">' +
        (aberta ? '✓ Marcar como fechada' : '↩ Reabrir') + '</button>');
      btn.onclick = async function () {
        btn.disabled = true; btn.textContent = 'Salvando…';
        try {
          await api('updateStatusNaoConformidade', {
            idNc: nc.ID_NC,
            idUsuario: S.usuario.ID_USUARIO,
            status: aberta ? 'fechada' : 'aberta',
            fechadaEm: aberta ? toIsoLocal(new Date()) : undefined
          });
          toast(aberta ? 'Não conformidade fechada!' : 'Não conformidade reaberta.', false, true);
          load();
        } catch (err) {
          btn.disabled = false; btn.textContent = aberta ? '✓ Marcar como fechada' : '↩ Reabrir';
        }
      };
      card.appendChild(btn);
      if (aberta && manutAtiva) {
        const btnVer = el('<button class="btn btn--outline btn--block">🔧 Ver na aba Manutenções</button>');
        btnVer.onclick = function () { go('manutencoes'); };
        card.appendChild(btnVer);
      }
      if (aberta && !manutAtiva) {
        const btnMan = el('<button class="btn btn--outline btn--block">🔧 Abrir manutenção para este problema</button>');
        btnMan.onclick = function () {
          go('manutencaoForm', {
            manutencaoAtual: null,
            manutencaoPrefill: {
              idEquipamento: nc.ID_EQUIPAMENTO,
              titulo: nc.ITEM,
              descricao: (nc.DESCRICAO ? nc.DESCRICAO + ' ' : '') + '(origem: não conformidade ' + nc.ID_NC + ')'
            }
          });
        };
        card.appendChild(btnMan);
      }
      return card;
    }, 10);
  }
  load();
}

const COLUNAS_NC = [
  ['ID_NC', 'ID'],
  ['NOME_EQUIPAMENTO', 'Equipamento'],
  ['ITEM', 'Item'],
  ['DESCRICAO', 'Descrição'],
  ['STATUS', 'Status'],
  ['ABERTA_EM', 'Aberta em', fmtDataHora],
  ['FECHADA_EM', 'Fechada em', fmtDataHora],
  ['TEMPO_ABERTA_TEXTO', 'Tempo em aberto'],
  ['ID_CHECKLIST_ORIGEM', 'Checklist de origem'],
  ['UNIDADE', 'Unidade']
];

const COLUNAS_CHECKLIST = [
  ['ID_CHECKLIST', 'ID'],
  ['NOME_EQUIPAMENTO', 'Equipamento'],
  ['RESPONSAVEL', 'Responsável'],
  ['DATA_HORA', 'Data/hora', fmtDataHora],
  ['STATUS', 'Resultado'],
  ['UNIDADE', 'Unidade']
];

// ------------------------- RELATÓRIOS (ADMIN) -------------------------

async function renderRelatorios() {
  appendHtml(app, screenHeader('Relatórios', 'Resumo geral da frota', 'Indicadores consolidados da unidade ' + S.unidade.UNIDADE));

  const topo = el('<div class="stack" style="gap:8px"></div>');
  app.appendChild(topo);
  const periodo = filtroPeriodo(topo, { comTodos: true, value: 'mes', onChange: function () { load(); } });

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando relatório…</p></div>');
  app.appendChild(body);

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando relatório…</p>';
    const p = periodo.getValue();
    const r = await api('getRelatorio', {
      unidade: S.unidade.UNIDADE,
      periodo: p.periodo,
      dataInicio: p.dataInicio,
      dataFim: p.dataFim
    }).catch(function () { return null; });
    body.innerHTML = '';
    if (!r) return;
    montarRelatorio(body, r, p);
  }
  load();
}

function montarRelatorio(body, r, filtroAtual) {
  const ind = r.indicadores;

  // ---- Capa ----
  body.appendChild(el(
    '<div class="report-hero">' +
      '<div class="row between" style="align-items:flex-start">' +
        '<div class="stack" style="gap:2px">' +
          '<span class="eyebrow">Relatório da frota</span>' +
          '<h2>' + escapeHtml(r.unidade) + '</h2>' +
          '<span class="hero-sub">' + escapeHtml(r.periodo.label) + '</span>' +
        '</div>' +
        '<img class="hero-logo" src="icon-192.png" alt="ICC Brazil">' +
      '</div>' +
      '<span class="hero-sub" style="opacity:.75">Gerado em ' + fmtDataHora(r.geradoEm) + '</span>' +
    '</div>'
  ));

  // ---- Botão de PDF ----
  const btnPdf = el('<button class="btn btn--accent btn--block">📄 Baixar relatório em PDF</button>');
  btnPdf.onclick = async function () {
    btnPdf.disabled = true;
    btnPdf.innerHTML = '<span class="spinner" style="border-color:rgba(58,37,6,.3);border-top-color:#3a2506"></span> Gerando PDF…';
    toast('Gerando o PDF no servidor — pode levar até 2-3 minutos com esses relatórios novos, não feche a tela…');
    try {
      const res = await api('gerarRelatorioPDF', {
        unidade: S.unidade.UNIDADE,
        periodo: filtroAtual.periodo,
        dataInicio: filtroAtual.dataInicio,
        dataFim: filtroAtual.dataFim
      });
      downloadBase64File(res.filename, res.base64, 'application/pdf');
      toast('Relatório em PDF baixado!', false, true);
    } catch (e) { /* toast já mostrado pelo api() */ }
    btnPdf.disabled = false;
    btnPdf.textContent = '📄 Baixar relatório em PDF';
  };
  body.appendChild(btnPdf);

  // ---- [OUT/2026] RESUMO GERAL DA FROTA ----
  // Dois números que não são a mesma coisa:
  //  • Em operação  = horas que a máquina realmente rodou (horímetro
  //    anotado em cada troca de gás do período);
  //  • Sem manutenção = expediente em que ela não estava quebrada nem
  //    parada (disponível — não quer dizer que trabalhou).
  const imp = r.impacto || {};
  const pctTxt = function (v) { return v === null || v === undefined ? '—' : String(v).replace('.', ',') + '%'; };
  const cardResumo = el('<div class="card stack"><h3 class="title-lg">📋 Resumo geral da frota</h3>' +
    '<p class="subtle" style="margin-top:-6px">' + escapeHtml(r.periodo.label) + '</p></div>');
  body.appendChild(cardResumo);
  cardResumo.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(imp.operacaoRealTexto || '—', 'Em operação (horímetro)', 'kpi--uso') +
      kpi(imp.semManutencaoTexto || imp.operacaoTexto || '0min', 'Sem manutenção (disponível)', 'kpi--accent') +
      kpi(imp.manutencaoTexto || '0min', 'Em manutenção', 'kpi--manut') +
      kpi(imp.paradoTexto || '0min', 'Parado', 'kpi--parado') +
    '</div>'
  ));
  cardResumo.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(pctTxt(imp.disponibilidadePct), 'Disponibilidade', 'kpi--uso') +
      kpi(pctTxt(imp.utilizacaoPct), 'Utilização (rodou ÷ disponível)', 'kpi--accent') +
      kpi(pctTxt(imp.impactoPct), 'Impacto (expediente perdido)', 'kpi--parado') +
      kpi(imp.indisponibilidadeTexto || '0min', 'Sem máquina (manut. + parado)', 'kpi--parado') +
    '</div>'
  ));
  cardResumo.appendChild(el('<div class="note">' +
    '<strong>Em operação</strong> é o que a máquina realmente rodou: a soma das horas do horímetro em cada troca de gás do período' +
    (imp.maquinasComHorimetro !== undefined ? ' (' + imp.maquinasComHorimetro + ' máquina(s) com troca no período)' : '') + '. ' +
    '<strong>Sem manutenção</strong> é o tempo de expediente em que ela não estava quebrada nem parada. ' +
    'Expediente contado: ' + escapeHtml(imp.expediente || '—') + '.</div>'));

  // ---- Por máquina ----
  const hpm = (r.horasPorMaquina || []).slice();
  cardResumo.appendChild(el('<h3 class="title-lg" style="font-size:15px;margin-top:6px">Por máquina</h3>'));
  if (!hpm.length) {
    cardResumo.appendChild(el('<p class="subtle">Nenhum equipamento ativo neste setor.</p>'));
  } else {
    const wrapTabela = el('<div style="overflow-x:auto"></div>');
    wrapTabela.appendChild(tabelaHtml([
      ['nomeEquipamento', 'Máquina'], ['operacaoTexto', 'Em operação'], ['semManutencaoTexto', 'Sem manutenção'],
      ['manutencaoTexto', 'Em manutenção'], ['paradoTexto', 'Parada'],
      ['disponibilidadePct', 'Disponib.', pctTxt], ['utilizacaoPct', 'Utilização', pctTxt]
    ], hpm));
    cardResumo.appendChild(wrapTabela);
    const btnCsvH = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar CSV</button>');
    btnCsvH.onclick = function () {
      downloadCSV(nomeArquivo('resumo_frota_por_maquina', 'csv'), [
        ['nomeEquipamento', 'Máquina'], ['codigo', 'Código'], ['tipo', 'Tipo'],
        ['operacaoTexto', 'Em operação (horímetro)'], ['trocasGas', 'Trocas de gás'],
        ['semManutencaoTexto', 'Sem manutenção'], ['manutencaoTexto', 'Em manutenção'], ['paradoTexto', 'Parada'],
        ['indisponibilidadeTexto', 'Sem máquina'], ['disponibilidadePct', 'Disponibilidade (%)'], ['utilizacaoPct', 'Utilização (%)']
      ], hpm);
    };
    cardResumo.appendChild(btnCsvH);
  }

  // ---- Tempo médio de cada etapa do chamado ----
  const tm = r.temposMedios || {};
  const cardTempos = el('<div class="card stack"><h3 class="title-lg">🕒 Tempo médio por etapa do chamado</h3>' +
    '<p class="subtle" style="margin-top:-6px">Média dos ' + (tm.finalizadas || 0) + ' chamado(s) finalizado(s) no período, em horas de expediente</p></div>');
  body.appendChild(cardTempos);
  cardTempos.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(tm.acionamentoTexto || '—', 'Abertura → técnico acionado', 'kpi--parado') +
      kpi(tm.chegadaTexto || '—', 'Acionado → início', 'kpi--accent') +
      kpi(tm.execucaoTexto || '—', 'Início → fim', 'kpi--manut') +
      kpi(tm.totalTexto || '—', 'Total do chamado', 'kpi--uso') +
    '</div>'
  ));

  // ---- Indicadores ----
  body.appendChild(el('<h3 class="title-lg" style="margin-top:4px">Indicadores do período</h3>'));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(ind.totalEquipamentos, 'Equipamentos') +
      kpi(ind.checklistsRealizados, 'Checklists realizados') +
      kpi(ind.manutencoesTotal, 'Manutenções no período', 'kpi--accent') +
      kpi(ind.checklistsComPendencia, 'Checklists com pendência', 'kpi--parado') +
    '</div>'
  ));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(ind.manutencoesAtivas, 'Manutenções ativas', 'kpi--manut') +
      kpi(ind.manutencoesAbertas, 'Abertas', 'kpi--parado') +
      kpi(ind.manutencoesAndamento, 'Em andamento', 'kpi--manut') +
      kpi(ind.manutencoesConcluidas, 'Concluídas', 'kpi--uso') +
    '</div>'
  ));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(ind.naoConformidadesAbertas, 'NCs abertas', 'kpi--parado') +
      kpi(ind.naoConformidadesFechadas, 'NCs fechadas', 'kpi--uso') +
      kpi(ind.equipamentosParadosAgora, 'Parados agora', 'kpi--parado') +
      kpi(ind.equipamentosEmManutencaoAgora, 'Em manutenção agora', 'kpi--manut') +
    '</div>'
  ));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(ind.manutencoesPreventivas, 'Preventivas') +
      kpi(ind.manutencoesCorretivas, 'Corretivas') +
    '</div>'
  ));

  // ---- Gráficos em painel escuro (CSS puro, sem biblioteca) ----
  body.appendChild(painelGrafico('Manutenções por status', 'Quantidade de manutenções em cada etapa no período',
    r.graficoManutencoesPorStatus));
  body.appendChild(painelGrafico('Status da frota', 'Situação atual de cada equipamento cadastrado',
    r.graficoStatusFrota));

  // ---- Ranking de tempo em manutenção ----
  const cardRank = el('<div class="card stack"><h3 class="title-lg">🏭 Máquinas com mais tempo em manutenção</h3>' +
    '<p class="subtle" style="margin-top:-6px">Horas de expediente, da abertura ao fim de cada chamado, dentro do período</p></div>');
  body.appendChild(cardRank);
  if (!r.rankingTempoManutencao.length) {
    cardRank.appendChild(el('<p class="subtle">Nenhuma manutenção com tempo apurado no período.</p>'));
  } else {
    r.rankingTempoManutencao.slice(0, 10).forEach(function (item, i) {
      cardRank.appendChild(el(
        '<div class="rank-row">' +
          '<span class="rank-pos">' + (i + 1) + '</span>' +
          '<span class="rank-info"><span class="n">' + escapeHtml(item.nomeEquipamento) + '</span>' +
          '<div class="subtle" style="font-size:12px">' + escapeHtml(item.codigo || item.tipo || '—') + ' · ' +
            item.quantidadeManutencoes + ' manutenção(ões)</div></span>' +
          '<span class="rank-time">' + escapeHtml(item.tempoTexto) + '</span>' +
        '</div>'
      ));
    });
  }

  // ---- Ranking de QUANTIDADE de manutenções (quem deu mais trabalho de novo) ----
  const cardRankQtd = el('<div class="card stack"><h3 class="title-lg">🔁 Máquinas com mais manutenções</h3>' +
    '<p class="subtle" style="margin-top:-6px">Contagem de manutenções abertas no período — pode ser diferente do ranking por tempo</p></div>');
  body.appendChild(cardRankQtd);
  if (!r.rankingQuantidadeManutencao.length) {
    cardRankQtd.appendChild(el('<p class="subtle">Nenhuma manutenção no período.</p>'));
  } else {
    r.rankingQuantidadeManutencao.slice(0, 10).forEach(function (item, i) {
      cardRankQtd.appendChild(el(
        '<div class="rank-row">' +
          '<span class="rank-pos">' + (i + 1) + '</span>' +
          '<span class="rank-info"><span class="n">' + escapeHtml(item.nomeEquipamento) + '</span>' +
          '<div class="subtle" style="font-size:12px">' + escapeHtml(item.codigo || item.tipo || '—') + ' · tempo total ' +
            escapeHtml(item.tempoTexto) + '</div></span>' +
          '<span class="rank-time">' + item.quantidadeManutencoes + 'x</span>' +
        '</div>'
      ));
    });
  }

  // ---- Máquinas paradas agora ----
  const cardParados = el('<div class="card stack"><h3 class="title-lg">🔴 Máquinas paradas agora</h3>' +
    '<p class="subtle" style="margin-top:-6px">Situação atual, independente do período</p></div>');
  body.appendChild(cardParados);
  if (!r.equipamentosParados.length) {
    cardParados.appendChild(el('<p class="subtle">Nenhum equipamento parado neste momento. 👍</p>'));
  } else {
    r.equipamentosParados.forEach(function (e) {
      cardParados.appendChild(el(
        '<div class="list-item is-alert" style="cursor:default">' +
          '<span><span class="list-item__title">' + escapeHtml(e.nomeEquipamento) + '</span>' +
          '<div class="list-item__sub">' + escapeHtml(e.codigo || e.tipo || '—') + ' · parado desde ' + fmtDataHora(e.statusDesde) + '</div></span>' +
          '<span class="tag tag--parado">' + escapeHtml(e.tempoTexto) + '</span>' +
        '</div>'
      ));
    });
  }

  // ---- Equipamentos em manutenção agora ----
  if (r.equipamentosEmManutencao.length) {
    const cardEmManut = el('<div class="card stack"><h3 class="title-lg">🔧 Máquinas em manutenção agora</h3></div>');
    body.appendChild(cardEmManut);
    r.equipamentosEmManutencao.forEach(function (e) {
      cardEmManut.appendChild(el(
        '<div class="list-item is-warn" style="cursor:default">' +
          '<span><span class="list-item__title">' + escapeHtml(e.nomeEquipamento) + '</span>' +
          '<div class="list-item__sub">' + escapeHtml(e.codigo || e.tipo || '—') + ' · desde ' + fmtDataHora(e.statusDesde) + '</div></span>' +
          '<span class="tag tag--manut">' + escapeHtml(e.tempoTexto) + '</span>' +
        '</div>'
      ));
    });
  }

  // ---- Não conformidades mais recorrentes ----
  body.appendChild(barCard('⚠️ Não conformidades por item', r.naoConformidadesPorItem,
    'Itens do checklist que mais reprovaram no período'));

  // ---- Gás no período (resumo) — detalhe completo continua no Relatório de Gás ----
  const gasInd = (r.gas && r.gas.indicadores) || {};
  const cardGas = el('<div class="card stack"><h3 class="title-lg">⛽ Gás no período</h3>' +
    '<p class="subtle" style="margin-top:-6px">Resumo — para fornecedor, tabela de trocas e mais rankings, use o Relatório de Gás</p></div>');
  body.appendChild(cardGas);
  cardGas.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(gasInd.totalTrocas || 0, 'Trocas no período') +
      kpi(fmtMoeda(gasInd.custoTotal), 'Custo total', 'kpi--accent') +
      kpi((gasInd.kgTotal || 0) + 'kg', 'Consumo total (kg)') +
      kpi(gasInd.custoMedioPorKg ? fmtMoeda(gasInd.custoMedioPorKg) : '—', 'Custo médio por kg') +
    '</div>'
  ));

  // ---- Comparativo: custo de gás × horas de operação real, por máquina ----
  const cardComparativo = el('<div class="card stack"><h3 class="title-lg">⚖️ Custo de gás × horas em operação</h3>' +
    '<p class="subtle" style="margin-top:-6px">Custo do gás dividido pelas horas que a máquina rodou (horímetro das trocas do período)</p></div>');
  body.appendChild(cardComparativo);
  const comCusto = (r.comparativoCustoHorasOperacao || []).filter(function (c) { return c.custoGasTotal > 0; });
  if (!comCusto.length) {
    cardComparativo.appendChild(el('<p class="subtle">Nenhuma troca de gás com custo no período.</p>'));
  } else {
    comCusto.slice(0, 10).forEach(function (item, i) {
      cardComparativo.appendChild(el(
        '<div class="rank-row">' +
          '<span class="rank-pos">' + (i + 1) + '</span>' +
          '<span class="rank-info"><span class="n">' + escapeHtml(item.nomeEquipamento) + '</span>' +
          '<div class="subtle" style="font-size:12px">' + fmtMoeda(item.custoGasTotal) +
            (item.kgTotal !== null && item.kgTotal !== undefined ? ' · ' + item.kgTotal + 'kg' : '') +
            ' · ' + item.horasOperacao + 'h em operação</div></span>' +
          '<span class="rank-time">' + (item.custoPorHoraOperacao !== null ? fmtMoeda(item.custoPorHoraOperacao) + '/h' : '—') + '</span>' +
        '</div>'
      ));
    });
  }

  // ---- Tabelas detalhadas com export CSV ----
  const cardTabelas = el('<div class="card stack"><h3 class="title-lg">Tabelas detalhadas</h3></div>');
  body.appendChild(cardTabelas);

  const abas = [
    { id: 'manutencoes', label: 'Manutenções', linhas: r.manutencoes || [], colunas: COLUNAS_MANUTENCAO, arquivo: 'relatorio_manutencoes' },
    { id: 'ncs', label: 'Não conformidades', linhas: r.naoConformidadesAbertasLista || [], colunas: COLUNAS_NC, arquivo: 'relatorio_nao_conformidades' },
    { id: 'checklists', label: 'Checklists', linhas: r.checklists || [], colunas: COLUNAS_CHECKLIST, arquivo: 'relatorio_checklists' }
  ];

  const seg = el('<div class="segmented">' + abas.map(function (a, i) {
    return '<button data-aba="' + a.id + '" class="' + (i === 0 ? 'is-active' : '') + '">' + a.label + ' (' + a.linhas.length + ')</button>';
  }).join('') + '</div>');
  cardTabelas.appendChild(seg);

  const conteudo = el('<div class="stack"></div>');
  cardTabelas.appendChild(conteudo);

  function mostrarAba(id) {
    const aba = abas.find(function (a) { return a.id === id; });
    seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('is-active', b.dataset.aba === id); });
    conteudo.innerHTML = '';
    if (!aba.linhas.length) {
      conteudo.appendChild(el('<p class="subtle">Nenhum registro nesta aba para o período selecionado.</p>'));
      return;
    }
    const btnCsv = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar ' + aba.label + ' em CSV</button>');
    btnCsv.onclick = function () { downloadCSV(nomeArquivo(aba.arquivo, 'csv'), aba.colunas, aba.linhas); };
    conteudo.appendChild(btnCsv);
    conteudo.appendChild(el('<p class="subtle">Mostrando os ' + Math.min(15, aba.linhas.length) + ' primeiros de ' + aba.linhas.length + ' registro(s). O CSV traz tudo.</p>'));
    const scroll = el('<div class="table-scroll"></div>');
    scroll.appendChild(tabelaHtml(aba.colunas, aba.linhas.slice(0, 15)));
    conteudo.appendChild(scroll);
  }
  seg.querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { mostrarAba(b.dataset.aba); };
  });
  mostrarAba('manutencoes');
}

// Painel escuro com gráfico de barras desenhado só com div + height %.
function painelGrafico(titulo, subtitulo, grafico) {
  const painel = el('<div class="chart-panel"><h3>' + escapeHtml(titulo) + '</h3>' +
    '<span class="chart-sub">' + escapeHtml(subtitulo) + '</span></div>');
  if (!grafico || !grafico.valores || !grafico.valores.length) {
    painel.appendChild(el('<p class="chart-sub">Sem dados no período.</p>'));
    return painel;
  }
  const max = Math.max.apply(null, grafico.valores.concat([1]));
  const bars = el('<div class="chart-bars"></div>');
  grafico.valores.forEach(function (v, i) {
    const altura = Math.max(3, Math.round((v / max) * 100));
    bars.appendChild(el(
      '<div class="chart-col">' +
        '<span class="chart-val">' + escapeHtml(v) + '</span>' +
        '<div class="chart-bar" style="height:' + altura + '%;background:' + escapeHtml(grafico.cores[i] || '#5e9030') + '"></div>' +
      '</div>'
    ));
  });
  painel.appendChild(bars);
  painel.appendChild(el('<div class="chart-legend">' + grafico.categorias.map(function (c, i) {
    return '<span class="leg"><span class="dot" style="background:' + escapeHtml(grafico.cores[i] || '#5e9030') + '"></span>' +
      escapeHtml(c) + '</span>';
  }).join('') + '</div>'));
  return painel;
}

// Tabela montada com createElement de propósito: innerHTML numa <div> joga
// fora <tr>/<td> (o parser só aceita essas tags dentro de <table>), então o
// atalho do el() não serve aqui.
function tabelaHtml(colunas, linhas) {
  const table = document.createElement('table');
  table.className = 'report-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  colunas.forEach(function (c) {
    const th = document.createElement('th');
    th.textContent = c[1];
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  linhas.forEach(function (linha) {
    const tr = document.createElement('tr');
    colunas.forEach(function (c) {
      const bruto = linha[c[0]];
      const td = document.createElement('td');
      const valor = c[2] ? c[2](bruto, linha) : bruto;
      td.textContent = (valor === undefined || valor === null) ? '' : String(valor);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

// ------------------------- RELATÓRIO DE GÁS (ADMIN) -------------------------

function fmtMoeda(v) {
  return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
}

async function renderRelatorioGas() {
  appendHtml(app, screenHeader('Relatório de Gás', 'Troca de gás da frota', 'Custos, horas de uso e ranking por equipamento — unidade ' + S.unidade.UNIDADE));

  const topo = el('<div class="stack" style="gap:8px"></div>');
  app.appendChild(topo);
  const periodo = filtroPeriodo(topo, { comTodos: true, value: 'mes', onChange: function () { load(); } });

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando relatório…</p></div>');
  app.appendChild(body);

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando relatório…</p>';
    const p = periodo.getValue();
    const r = await api('getRelatorioGas', {
      unidade: S.unidade.UNIDADE,
      periodo: p.periodo,
      dataInicio: p.dataInicio,
      dataFim: p.dataFim
    }).catch(function () { return null; });
    body.innerHTML = '';
    if (!r) return;
    montarRelatorioGas(body, r, load);
  }
  load();
}

function montarRelatorioGas(body, r, recarregar) {
  const ind = r.indicadores;

  body.appendChild(el(
    '<div class="report-hero">' +
      '<div class="row between" style="align-items:flex-start">' +
        '<div class="stack" style="gap:2px">' +
          '<span class="eyebrow">Relatório de gás</span>' +
          '<h2>' + escapeHtml(r.unidade) + '</h2>' +
          '<span class="hero-sub">' + escapeHtml(r.periodo.label) + '</span>' +
        '</div>' +
        '<img class="hero-logo" src="icon-192.png" alt="ICC Brazil">' +
      '</div>' +
      '<span class="hero-sub" style="opacity:.75">Gerado em ' + fmtDataHora(r.geradoEm) + '</span>' +
    '</div>'
  ));

  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(ind.totalTrocas, 'Trocas no período') +
      kpi(fmtMoeda(ind.custoTotal), 'Custo total', 'kpi--accent') +
      kpi(ind.horaMedia ? ind.horaMedia + 'h' : '—', 'Horas médias entre trocas') +
      kpi(ind.custoMedioPorHora ? fmtMoeda(ind.custoMedioPorHora) + '/h' : '—', 'Custo médio por hora') +
    '</div>'
  ));

  // ---- Custo por fornecedor ----
  const entradasFornecedor = Object.entries(r.custoPorFornecedor || {}).sort(function (a, b) { return b[1] - a[1]; });
  const cardForn = el('<div class="card stack"><h3 class="title-lg">⛽ Custo por fornecedor</h3>' +
    '<p class="subtle" style="margin-top:-6px">Total gasto e número de trocas no período</p></div>');
  body.appendChild(cardForn);
  if (!entradasFornecedor.length) {
    cardForn.appendChild(el('<p class="subtle">Nenhuma troca de gás no período.</p>'));
  } else {
    const max = entradasFornecedor[0][1] || 1;
    entradasFornecedor.forEach(function (e) {
      const qtd = (r.trocasPorFornecedor || {})[e[0]] || 0;
      cardForn.appendChild(el(
        '<div class="bar-row"><span class="label">' + escapeHtml(e[0]) + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(4, (e[1] / max) * 100) + '%"></div></div>' +
        '<span class="bar-val">' + escapeHtml(fmtMoeda(e[1])) + ' · ' + qtd + 'x</span></div>'
      ));
    });
  }

  // ---- Rankings por frota ----
  function cardRanking(titulo, subtitulo, icone, lista, montarLinha) {
    const card = el('<div class="card stack"><h3 class="title-lg">' + icone + ' ' + escapeHtml(titulo) + '</h3>' +
      '<p class="subtle" style="margin-top:-6px">' + escapeHtml(subtitulo) + '</p></div>');
    body.appendChild(card);
    if (!lista.length) {
      card.appendChild(el('<p class="subtle">Sem dados suficientes no período.</p>'));
      return;
    }
    lista.forEach(function (item, i) {
      card.appendChild(el(
        '<div class="rank-row">' +
          '<span class="rank-pos">' + (i + 1) + '</span>' +
          '<span class="rank-info"><span class="n">' + escapeHtml(item.nomeEquipamento) + '</span>' +
          '<div class="subtle" style="font-size:12px">' + montarLinha(item) + '</div></span>' +
          '<span class="rank-time">' + escapeHtml(item.__valorExibido) + '</span>' +
        '</div>'
      ));
    });
  }

  cardRanking('Maior custo por frota', 'Total gasto com gás no período', '💰',
    (r.rankingCustoPorFrota || []).map(function (i) { return Object.assign({}, i, { __valorExibido: fmtMoeda(i.custo) }); }),
    function (item) { return item.quantidade + ' troca(s)'; });

  cardRanking('Mais horas de uso por frota', 'Horas acumuladas entre trocas no período', '⏱️',
    (r.rankingHorasPorFrota || []).map(function (i) { return Object.assign({}, i, { __valorExibido: i.horasTotal + 'h' }); }),
    function (item) { return item.quantidade + ' troca(s)'; });

  cardRanking('Maior custo por hora', 'Frotas com o gás mais caro em relação ao uso', '📈',
    (r.rankingCustoPorHoraPorFrota || []).map(function (i) { return Object.assign({}, i, { __valorExibido: fmtMoeda(i.custoPorHora) + '/h' }); }),
    function () { return 'Custo ÷ horas de uso'; });

  cardRanking('Maior intervalo médio entre trocas', 'Frotas que mais seguram o gás', '🕐',
    (r.rankingIntervaloMedioPorFrota || []).map(function (i) { return Object.assign({}, i, { __valorExibido: i.horasMedia + 'h' }); }),
    function (item) { return item.quantidade + ' troca(s)'; });

  // A tabela "Trocas do período" saiu desta tela (o CSV continua
  // disponível no botão abaixo). Fica só a exclusão de troca lançada por
  // engano — restrita ao Administrador.
  if (r.trocas.length) {
    const cardDados = el('<div class="card stack"><h3 class="title-lg">Dados do período</h3></div>');
    body.appendChild(cardDados);
    const btnCsv = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar trocas em CSV</button>');
    btnCsv.onclick = function () { downloadCSV(nomeArquivo('trocas_gas', 'csv'), COLUNAS_TROCA_GAS, r.trocas); };
    cardDados.appendChild(btnCsv);

    if (ehAdmin() && recarregar) {
      const boxExcluir = el(
        '<div class="stack" style="gap:8px;padding-top:12px;border-top:1px solid var(--line)">' +
          '<strong style="font-size:14.5px">Excluir troca lançada incorretamente</strong>' +
          '<div class="field"><select id="selTrocaExcluir"><option value="">Selecione a troca…</option></select></div>' +
        '</div>'
      );
      const selTroca = boxExcluir.querySelector('select');
      r.trocas.forEach(function (t) {
        selTroca.appendChild(el('<option value="' + escapeHtml(t.ID_TROCA_GAS) + '">' + escapeHtml(t.ID_TROCA_GAS) + ' · ' +
          escapeHtml(t.NOME_EQUIPAMENTO) + ' · ' + fmtDataHora(t.DATA_HORA) + ' · ' + escapeHtml(t.RESPONSAVEL || '—') + '</option>'));
      });
      const btnExcluirTroca = el('<button class="btn btn--danger btn--block">🗑 Excluir troca de gás</button>');
      boxExcluir.appendChild(btnExcluirTroca);
      btnExcluirTroca.onclick = async function () {
        const idTroca = selTroca.value;
        if (!idTroca) { toast('Selecione a troca a excluir', true); return; }
        const rotulo = selTroca.options[selTroca.selectedIndex].textContent;
        if (!window.confirm('Excluir a troca de gás ' + rotulo + '?\n\nEsta ação não pode ser desfeita.')) return;
        btnExcluirTroca.disabled = true; btnExcluirTroca.textContent = 'Excluindo…';
        try {
          await api('deleteTrocaGas', { idTrocaGas: idTroca, idUsuario: S.usuario.ID_USUARIO });
          toast('Troca de gás ' + idTroca + ' excluída.', false, true);
          recarregar();
        } catch (e) {
          btnExcluirTroca.disabled = false; btnExcluirTroca.textContent = '🗑 Excluir troca de gás';
        }
      };
      cardDados.appendChild(boxExcluir);
    }
  }
}

const COLUNAS_TROCA_GAS = [
  ['ID_TROCA_GAS', 'ID'],
  ['NOME_EQUIPAMENTO', 'Frota'],
  ['RESPONSAVEL', 'Responsável'],
  ['FORNECEDOR', 'Fornecedor'],
  ['HORIMETRO', 'Horímetro'],
  ['HORIMETRO_ANTERIOR', 'Horímetro anterior'],
  ['HORAS_OPERACAO', 'Horas de uso'],
  ['CUSTO', 'Custo', fmtMoeda],
  ['DATA_HORA', 'Data/hora', fmtDataHora],
  ['UNIDADE', 'Unidade']
];

// ------------------------- RELATÓRIO EXECUTIVO (ADMIN) -------------------------
// Resumo único juntando Manutenção + Lavagem + Troca de Gás, pra levar pra
// gestão — só indicadores e gráficos (os rankings e tabelas detalhadas
// continuam nos relatórios individuais de cada assunto).

async function renderRelatorioExecutivo() {
  appendHtml(app, screenHeader('Relatório Executivo', 'Manutenção, Lavagem e Gás', 'Resumo consolidado para apresentação à gestão — unidade ' + S.unidade.UNIDADE));

  const topo = el('<div class="stack" style="gap:8px"></div>');
  app.appendChild(topo);
  const periodo = filtroPeriodo(topo, { comTodos: true, value: 'mes', onChange: function () { load(); } });

  const body = el('<div class="stack" style="margin-top:12px"><p class="subtle">Carregando relatório…</p></div>');
  app.appendChild(body);

  async function load() {
    body.innerHTML = '<p class="subtle">Carregando relatório…</p>';
    const p = periodo.getValue();
    const r = await api('getRelatorioExecutivo', {
      unidade: S.unidade.UNIDADE,
      periodo: p.periodo,
      dataInicio: p.dataInicio,
      dataFim: p.dataFim
    }).catch(function () { return null; });
    body.innerHTML = '';
    if (!r) return;
    montarRelatorioExecutivo(body, r, p);
  }
  load();
}

// [EXECUTIVO OUT/2026] Gráfico de barras deitadas, uma por frota.
// itens: [{ rotulo, valor (número, define o tamanho), texto (o que aparece à direita) }]
function cardBarras(titulo, subtitulo, itens, cor, vazioTexto) {
  const card = el('<div class="card stack"><h3 class="title-lg" style="font-size:15px">' + escapeHtml(titulo) + '</h3>' +
    (subtitulo ? '<p class="subtle" style="margin-top:-6px">' + escapeHtml(subtitulo) + '</p>' : '') + '</div>');
  if (!itens || !itens.length) {
    card.appendChild(el('<p class="subtle">' + escapeHtml(vazioTexto || 'Sem dados no período.') + '</p>'));
    return card;
  }
  const LIMITE = 15;
  const max = Math.max.apply(null, itens.map(function (i) { return Number(i.valor) || 0; }).concat([0.0001]));
  itens.slice(0, LIMITE).forEach(function (i) {
    card.appendChild(el(
      '<div class="bar-row"><span class="label" style="width:38%;max-width:220px" title="' + escapeHtml(i.rotulo) + '">' + escapeHtml(i.rotulo) + '</span>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(3, ((Number(i.valor) || 0) / max) * 100) + '%' +
        (cor ? ';background:' + cor : '') + '"></div></div>' +
      '<span class="bar-val" style="width:auto;min-width:64px;white-space:nowrap">' + escapeHtml(i.texto) + '</span></div>'
    ));
  });
  if (itens.length > LIMITE) card.appendChild(el('<p class="subtle">Mostrando as ' + LIMITE + ' maiores de ' + itens.length + '.</p>'));
  return card;
}

// [EXECUTIVO OUT/2026] Bloco "por frota" do Relatório Executivo — usado na
// tela da unidade e na visão da gestão (todas as unidades).
function montarFrotasExecutivo(body, f) {
  if (!f) return;
  const horasTxt = function (h) { return String(h).replace('.', ',') + ' h'; };

  // ---- Pontos de atenção ----
  const corNivel = { alto: 'var(--st-parado)', medio: 'var(--accent)', baixo: 'var(--ink-soft)', ok: 'var(--st-uso)' };
  const rotuloNivel = { alto: 'Alto', medio: 'Médio', baixo: 'Baixo', ok: 'OK' };
  const cardPontos = el('<div class="card stack"><h3 class="title-lg">🚩 Pontos de atenção</h3>' +
    '<p class="subtle" style="margin-top:-6px">Montados automaticamente a partir dos números do período</p></div>');
  body.appendChild(cardPontos);
  (f.pontosDeAtencao || []).forEach(function (p) {
    cardPontos.appendChild(el(
      '<div class="list-item" style="cursor:default;border-left:4px solid ' + (corNivel[p.nivel] || 'var(--ink-soft)') + '">' +
        '<span class="list-item__sub" style="font-size:13px;color:var(--ink)">' + escapeHtml(p.texto) + '</span>' +
        '<span class="tag tag--na" style="white-space:nowrap">' + escapeHtml(rotuloNivel[p.nivel] || '') + '</span>' +
      '</div>'
    ));
  });

  // ---- Totais ----
  body.appendChild(el('<h3 class="title-lg" style="margin-top:4px">🚜 Frotas no período</h3>'));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(f.operacaoTotalTexto || '—', 'Horas totais em operação', 'kpi--uso') +
      kpi(f.horasParadasTotalTexto || '0min', 'Horas totais paradas', 'kpi--parado') +
      kpi(f.gasTotalTrocas || 0, 'Trocas de gás') +
      kpi(fmtMoeda(f.gasCustoTotal || 0), 'Gasto com gás', 'kpi--accent') +
    '</div>'
  ));
  body.appendChild(el('<p class="subtle" style="margin-top:-4px">Horas em operação = horímetro das trocas de gás (' + (f.maquinasComHorimetro || 0) +
    ' máquina(s)). Horas paradas = manutenção + parada, só no expediente (' + escapeHtml(f.expediente || '') + ').</p>'));

  // ---- Gráficos por frota ----
  body.appendChild(cardBarras('Frotas paradas, em horas', 'Tempo sem operar (em manutenção + parada) dentro do expediente',
    (f.paradasPorFrota || []).map(function (x) { return { rotulo: x.frota, valor: x.horas, texto: x.texto }; }),
    'var(--st-parado)', 'Nenhuma frota ficou parada no período.'));
  body.appendChild(cardBarras('Quantidade de manutenções por frota', 'Chamados abertos no período',
    (f.manutencoesPorFrota || []).map(function (x) { return { rotulo: x.frota, valor: x.quantidade, texto: x.quantidade + ' · ' + x.tempoTexto }; }),
    'var(--accent)', 'Nenhuma manutenção no período.'));
  body.appendChild(cardBarras('Horas em operação por frota', 'Horas rodadas pelo horímetro das trocas de gás do período',
    (f.operacaoPorFrota || []).map(function (x) { return { rotulo: x.frota, valor: x.horas, texto: x.texto }; }),
    'var(--st-uso)', 'Nenhuma troca de gás com horímetro no período.'));
  const gas = f.gasPorFrota || [];
  body.appendChild(cardBarras('Trocas de gás por frota', 'Quantidade de trocas no período',
    gas.slice().sort(function (a, b) { return b.trocas - a.trocas; }).map(function (x) { return { rotulo: x.frota, valor: x.trocas, texto: x.trocas + 'x' }; }),
    '#3B7DD8', 'Nenhuma troca de gás no período.'));
  body.appendChild(cardBarras('Gasto com gás por frota', 'Custo das trocas do período',
    gas.map(function (x) { return { rotulo: x.frota, valor: x.custo, texto: fmtMoeda(x.custo) }; }),
    'var(--accent)', 'Nenhuma troca de gás no período.'));

  // ---- Quem gastou e trocou mais, e se rodou mais ----
  const cardGas = el('<div class="card stack"><h3 class="title-lg" style="font-size:15px">⛽ Quem gastou mais gás — e se rodou mais</h3>' +
    '<p class="subtle" style="margin-top:-6px">Compara cada máquina com a média da frota: ' + horasTxt(f.gasMediaHoras || 0) +
    ' rodadas e ' + fmtMoeda(f.gasMediaCustoHora || 0) + ' por hora</p></div>');
  body.appendChild(cardGas);
  if (!gas.length) {
    cardGas.appendChild(el('<p class="subtle">Nenhuma troca de gás no período.</p>'));
    return;
  }
  const destaque = function (rotulo, x, valorTxt) {
    return '<div class="list-item ' + (x.atencao ? 'is-warn' : 'is-ok') + '" style="cursor:default">' +
      '<span><span class="list-item__title">' + rotulo + ': ' + escapeHtml(x.frota) + '</span>' +
      '<div class="list-item__sub">' + valorTxt + ' · ' + escapeHtml(x.horasTexto) + ' rodadas · ' + escapeHtml(x.veredito) + '</div></span></div>';
  };
  if (f.maiorGasto) cardGas.appendChild(el(destaque('Mais gastou', f.maiorGasto, fmtMoeda(f.maiorGasto.custo) + ' em ' + f.maiorGasto.trocas + ' troca(s)')));
  if (f.maisTrocas) cardGas.appendChild(el(destaque('Mais trocou', f.maisTrocas, f.maisTrocas.trocas + ' troca(s), ' + fmtMoeda(f.maisTrocas.custo))));
  const wrap = el('<div style="overflow-x:auto"></div>');
  wrap.appendChild(tabelaHtml([
    ['frota', 'Frota'], ['trocas', 'Trocas'], ['custo', 'Gasto', fmtMoeda], ['kg', 'Kg', function (v) { return v === null || v === undefined ? '—' : v; }],
    ['horasTexto', 'Horas rodadas'], ['custoPorHora', 'Custo por hora', function (v) { return v === null || v === undefined ? '—' : fmtMoeda(v); }],
    ['veredito', 'Rodou mais?']
  ], gas));
  cardGas.appendChild(wrap);
  const btnCsv = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar CSV</button>');
  btnCsv.onclick = function () {
    downloadCSV(nomeArquivo('gas_por_frota', 'csv'), [
      ['frota', 'Frota'], ['trocas', 'Trocas'], ['custo', 'Gasto (R$)'], ['kg', 'Kg'], ['horas', 'Horas rodadas'],
      ['custoPorHora', 'Custo por hora (R$)'], ['veredito', 'Rodou mais?']
    ], gas);
  };
  cardGas.appendChild(btnCsv);
}

function montarRelatorioExecutivo(body, r, filtroAtual) {
  const mInd = r.manutencao.indicadores;
  const lav = r.lavagem;
  const gasInd = r.gas.indicadores;

  body.appendChild(el(
    '<div class="report-hero">' +
      '<div class="row between" style="align-items:flex-start">' +
        '<div class="stack" style="gap:2px">' +
          '<span class="eyebrow">Relatório executivo</span>' +
          '<h2>' + escapeHtml(r.unidade) + '</h2>' +
          '<span class="hero-sub">' + escapeHtml(r.periodo.label) + '</span>' +
        '</div>' +
        '<img class="hero-logo" src="icon-192.png" alt="ICC Brazil">' +
      '</div>' +
      '<span class="hero-sub" style="opacity:.75">Gerado em ' + fmtDataHora(r.geradoEm) + '</span>' +
    '</div>'
  ));

  const btnPdf = el('<button class="btn btn--accent btn--block">📄 Baixar relatório executivo em PDF</button>');
  btnPdf.onclick = async function () {
    btnPdf.disabled = true;
    btnPdf.innerHTML = '<span class="spinner" style="border-color:rgba(58,37,6,.3);border-top-color:#3a2506"></span> Gerando PDF…';
    toast('Gerando o PDF no servidor — pode levar até 2-3 minutos com esses relatórios novos, não feche a tela…');
    try {
      const res = await api('gerarRelatorioExecutivoPDF', {
        unidade: S.unidade.UNIDADE,
        periodo: filtroAtual.periodo,
        dataInicio: filtroAtual.dataInicio,
        dataFim: filtroAtual.dataFim
      });
      downloadBase64File(res.filename, res.base64, 'application/pdf');
      toast('Relatório executivo em PDF baixado!', false, true);
    } catch (e) { /* toast já mostrado pelo api() */ }
    btnPdf.disabled = false;
    btnPdf.textContent = '📄 Baixar relatório executivo em PDF';
  };
  body.appendChild(btnPdf);

  // ---- [EXECUTIVO OUT/2026] Pontos de atenção e visão por frota ----
  montarFrotasExecutivo(body, r.frotas);

  // ---- Manutenção ----
  body.appendChild(el('<h3 class="title-lg" style="margin-top:4px">🔧 Manutenção</h3>'));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(mInd.totalEquipamentos, 'Equipamentos') +
      kpi(mInd.checklistsRealizados, 'Checklists realizados') +
      kpi(mInd.manutencoesTotal, 'Manutenções no período', 'kpi--accent') +
      kpi(mInd.manutencoesConcluidas, 'Concluídas', 'kpi--uso') +
    '</div>'
  ));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(mInd.manutencoesAbertas, 'Abertas', 'kpi--parado') +
      kpi(mInd.manutencoesAndamento, 'Em andamento', 'kpi--manut') +
      kpi(mInd.naoConformidadesAbertas, 'NCs abertas', 'kpi--parado') +
      kpi(mInd.equipamentosParadosAgora, 'Parados agora', 'kpi--parado') +
    '</div>'
  ));
  body.appendChild(painelGrafico('Manutenções por status', 'Quantidade de manutenções em cada etapa no período',
    r.manutencao.graficoManutencoesPorStatus));
  body.appendChild(painelGrafico('Situação atual da frota', 'Situação atual de cada equipamento cadastrado',
    r.manutencao.graficoStatusFrota));

  // ---- Lavagem ----
  body.appendChild(el('<h3 class="title-lg">🧽 Lavagem</h3>'));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(lav.total, 'Lavagens no período') +
      kpi(lav.semPendencia, 'Sem pendência', 'kpi--uso') +
      kpi(lav.comPendencia, 'Com pendência', lav.comPendencia > 0 ? 'kpi--parado' : '') +
    '</div>'
  ));
  body.appendChild(painelGrafico('Lavagens por resultado', 'Sem pendência x com pendência no período', lav.grafico));

  // ---- Troca de gás ----
  body.appendChild(el('<h3 class="title-lg">⛽ Troca de gás</h3>'));
  body.appendChild(el(
    '<div class="kpi-grid">' +
      kpi(gasInd.totalTrocas, 'Trocas no período') +
      kpi(fmtMoeda(gasInd.custoTotal), 'Custo total', 'kpi--accent') +
      kpi(gasInd.horaMedia ? gasInd.horaMedia + 'h' : '—', 'Horas médias entre trocas') +
      kpi(gasInd.custoMedioPorHora ? fmtMoeda(gasInd.custoMedioPorHora) + '/h' : '—', 'Custo médio por hora') +
    '</div>'
  ));

  const entradasFornecedor = Object.entries(r.gas.custoPorFornecedor || {}).sort(function (a, b) { return b[1] - a[1]; });
  const cardForn = el('<div class="card stack"><h3 class="title-lg" style="font-size:15px">Custo por fornecedor</h3></div>');
  body.appendChild(cardForn);
  if (!entradasFornecedor.length) {
    cardForn.appendChild(el('<p class="subtle">Nenhuma troca de gás no período.</p>'));
  } else {
    const max = entradasFornecedor[0][1] || 1;
    entradasFornecedor.forEach(function (e) {
      const qtd = (r.gas.trocasPorFornecedor || {})[e[0]] || 0;
      cardForn.appendChild(el(
        '<div class="bar-row"><span class="label">' + escapeHtml(e[0]) + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(4, (e[1] / max) * 100) + '%"></div></div>' +
        '<span class="bar-val">' + escapeHtml(fmtMoeda(e[1])) + ' · ' + qtd + 'x</span></div>'
      ));
    });
  }

  body.appendChild(el('<p class="subtle" style="text-align:center;margin-top:4px">Para rankings e tabelas detalhadas de cada assunto, use os relatórios individuais (Relatórios e Relatório de Gás).</p>'));
}

// ------------------------- MAIS (menu do admin) -------------------------

// Cartão "Trocar setor" da tela Mais — alterna entre Fábrica e Operação
// sem precisar sair e entrar de novo.
function cartaoTrocarSetor() {
  const outro = S.setor === 'FABRICA' ? 'OPERACAO' : 'FABRICA';
  const item = el(
    '<button type="button" class="list-item" style="width:100%;padding:16px">' +
      '<span class="row" style="gap:12px"><span style="font-size:22px">🔁</span>' +
      '<span><span class="list-item__title">Trocar para ' + escapeHtml(setorLabel(outro)) + '</span>' +
      '<div class="list-item__sub">Setor atual: ' + escapeHtml(setorLabel(S.setor)) + '</div></span></span>' +
      '<span>›</span>' +
    '</button>'
  );
  item.onclick = function () {
    S.setor = outro;
    S.cache = {};
    toast('Setor: ' + setorLabel(outro), false, true);
    go('painel');
  };
  return item;
}

function renderMais() {
  if (!ehAdmin()) {
    // Operador só tem consultas aqui — as ações (checklist, abertura,
    // lavagem, troca de gás) já têm aba própria na navegação principal.
    appendHtml(app,
      screenHeader('Mais', 'Consultas', 'Preventivas e histórico de ' + unidadeSetorLabel()) +
      '<div class="stack" id="maisLista">' +
        menuCard('🗓️', 'Preventivas', 'Agenda de manutenções preventivas', 'preventivas') +
        menuCard('🕘', 'Histórico', 'Linha do tempo da unidade', 'historico') +
      '</div>'
    );
    bindMenuCards();
    if (!S.usuario.SETOR) document.getElementById('maisLista').appendChild(cartaoTrocarSetor()); // usuário preso a um setor não troca
    return;
  }
  appendHtml(app,
    screenHeader('Mais', 'Administração', 'Cadastros e acompanhamento de ' + unidadeSetorLabel()) +
    '<div class="stack" id="maisLista">' +
      menuCard('🚜', 'Equipamentos', 'Cadastrar, editar status e excluir', 'equipamentos') +
      menuCard('✅', 'Checklists realizados', 'Consultar os checklists feitos pelos operadores', 'checklists') +
      menuCard('⚠️', 'Não conformidades', 'Acompanhar e fechar o que veio do checklist', 'naoConformidades') +
      menuCard('🗓️', 'Preventivas', 'Agenda de manutenções preventivas', 'preventivas') +
      menuCard('🕘', 'Histórico', 'Linha do tempo da unidade', 'historico') +
      menuCard('📝', 'Perguntas', 'Perguntas do checklist e da lavagem, por tipo de equipamento', 'perguntas') +
      menuCard('⚙️', 'Configurações', 'Responsáveis do checklist, usuários e unidades', 'configuracoes') +
    '</div>'
  );
  bindMenuCards();
  if (!S.usuario.SETOR) document.getElementById('maisLista').appendChild(cartaoTrocarSetor());
}

// ------------------------- CONFIGURAÇÕES (ADMIN) -------------------------

async function renderConfiguracoes() {
  appendHtml(app, screenHeader('Configurações', 'Configurações', 'Unidade ' + S.unidade.UNIDADE));
  app.appendChild(botaoVoltar('mais'));

  // ---- Responsáveis do checklist ----
  const cardResp = el('<div class="card stack"><h3 class="title-lg">Responsáveis do checklist</h3>' +
    '<p class="subtle" style="margin-top:-6px">Lista fechada de nomes que aparece no campo "Responsável" do checklist.</p></div>');
  app.appendChild(cardResp);

  const novoNome = textField(cardResp, { label: 'Nome do responsável', placeholder: 'Ex: João da Silva' });
  const btnAdd = el('<button class="btn btn--primary btn--sm" style="align-self:flex-start">＋ Cadastrar responsável</button>');
  cardResp.appendChild(btnAdd);
  const listaResp = el('<div class="stack" style="gap:8px"><p class="subtle">Carregando…</p></div>');
  cardResp.appendChild(listaResp);

  btnAdd.onclick = async function () {
    if (!novoNome.getValue()) { toast('Informe o nome do responsável', true); return; }
    btnAdd.disabled = true; btnAdd.textContent = 'Salvando…';
    try {
      await api('createResponsavel', {
        unidade: S.unidade.UNIDADE,
        nome: novoNome.getValue(),
        idUsuario: S.usuario.ID_USUARIO
      });
      toast('Responsável cadastrado!', false, true);
      novoNome.setValue('');
      delete S.cache['resp_' + S.unidade.UNIDADE];
      carregarLista();
    } catch (e) { /* toast já mostrado */ }
    btnAdd.disabled = false; btnAdd.textContent = '＋ Cadastrar responsável';
  };

  async function carregarLista() {
    listaResp.innerHTML = '<p class="subtle">Carregando…</p>';
    delete S.cache['resp_' + S.unidade.UNIDADE];
    const lista = await carregarResponsaveis();
    listaResp.innerHTML = '';
    if (!lista.length) { listaResp.appendChild(el('<p class="subtle">Nenhum responsável cadastrado ainda.</p>')); return; }
    lista.forEach(function (r) {
      const item = el(
        '<div class="list-item" style="cursor:default">' +
          '<span><span class="list-item__title">' + escapeHtml(r.NOME) + '</span>' +
          '<div class="list-item__sub mono">' + escapeHtml(r.ID_RESPONSAVEL) + '</div></span>' +
        '</div>'
      );
      const btnRm = el('<button class="btn btn--danger btn--sm">Remover</button>');
      btnRm.onclick = async function () {
        if (!window.confirm('Remover "' + r.NOME + '" da lista de responsáveis?')) return;
        btnRm.disabled = true; btnRm.textContent = 'Removendo…';
        try {
          await api('deleteResponsavel', { idResponsavel: r.ID_RESPONSAVEL, idUsuario: S.usuario.ID_USUARIO });
          toast('Responsável removido.', false, true);
          carregarLista();
        } catch (e) { btnRm.disabled = false; btnRm.textContent = 'Remover'; }
      };
      item.appendChild(btnRm);
      listaResp.appendChild(item);
    });
  }
  carregarLista();

  // ---- Usuários (somente leitura) ----
  const cardUsers = el('<div class="card stack"><h3 class="title-lg">Usuários da unidade</h3>' +
    '<div class="note">Usuários e unidades são cadastrados direto na planilha do Google Sheets, ' +
    'nas abas <strong>CONFIG_USUARIOS</strong> e <strong>CONFIG_UNIDADES</strong> — é lá que ficam o tipo ' +
    '(ADMIN/OPERADOR), a senha do admin, o campo ATIVO e o SETOR (FABRICA, OPERACAO ou em branco para os dois). Esta tela só mostra o que está cadastrado.</div>' +
    '<p class="subtle">Carregando usuários…</p></div>');
  app.appendChild(cardUsers);

  const usuarios = await api('getUsuarios', { unidade: S.unidade.UNIDADE }).catch(function () { return []; });
  cardUsers.querySelector('p.subtle').remove();
  if (!usuarios.length) {
    cardUsers.appendChild(el('<p class="subtle">Nenhum usuário ativo nesta unidade.</p>'));
  } else {
    usuarios.forEach(function (u) {
      cardUsers.appendChild(el(
        '<div class="list-item" style="cursor:default">' +
          '<span><span class="list-item__title">' + escapeHtml(u.NOME) + '</span>' +
          '<div class="list-item__sub">' + escapeHtml(u.USUARIO || '') + ' · ' + escapeHtml(u.UNIDADE) + ' · ' + (u.SETOR ? escapeHtml(setorLabel(u.SETOR)) : 'Fábrica e Operação') + '</div></span>' +
          '<span class="tag ' + (u.TIPO === 'ADMIN' ? 'tag--info' : 'tag--na') + '">' + escapeHtml(u.TIPO) + '</span>' +
        '</div>'
      ));
    });
  }

  // ---- Unidades (somente leitura) ----
  const cardUnidades = el('<div class="card stack"><h3 class="title-lg">Unidades</h3>' +
    '<p class="subtle">Carregando unidades…</p></div>');
  app.appendChild(cardUnidades);
  const unidades = await api('getUnidades', {}).catch(function () { return []; });
  cardUnidades.querySelector('p.subtle').remove();
  unidades.forEach(function (u) {
    cardUnidades.appendChild(el(
      '<div class="list-item" style="cursor:default">' +
        '<span class="list-item__title">' + escapeHtml(u.UNIDADE) + '</span>' +
        (u.UNIDADE === S.unidade.UNIDADE ? '<span class="tag tag--ok">Atual</span>' : '<span class="subtle mono">' + escapeHtml(u.ID_UNIDADE) + '</span>') +
      '</div>'
    ));
  });

  app.appendChild(el('<p class="subtle" style="text-align:center;padding:10px 0">Central de Frota · ICC Brazil</p>'));
}

// ------------------------- PRIMEIRA PINTURA -------------------------
// Fica no fim do arquivo de propósito: o roteador (SCREENS/TAB_PAI) é
// declarado com const e só existe a partir daqui.

restaurarSessao();
render();
