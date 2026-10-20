// Passo 1 de "Adicionar aplicativo": "De onde vem o programa?". Três caminhos (lista de programas instalados, arquivo, pasta),
// arrastar e soltar, e o link "Preencher tudo manualmente". Devolve { program } | { manual: true } | null (a pessoa desistiu).
// A lógica (busca, caminhos, nomes, candidatos) está em programs.js; aqui só interface e as chamadas à ponte nativa.
// Toda chamada à ponte passa por safeNative(): falha vira { error } e nunca estoura para a interface.
import { h, icon, native, nativeFiles, state, modal, toast, log, sleep } from '../core.js';
import * as P from './programs.js';

/**
 * Chama a ponte nativa sem nunca lançar. Falha = { error: "mensagem" }. timeout (ms): se o app nativo não responder a tempo,
 * devolve { error } em vez de deixar a tela esperando para sempre (não use nas janelas do Windows, onde a pessoa leva o tempo que quiser).
 */
export async function safeNative(cmd, data = {}, { timeout = 0 } = {}) {
  let timer = 0;
  try {
    const wait = timeout > 0 ? new Promise((ok) => { timer = setTimeout(() => ok({ error: 'O aplicativo demorou demais para responder. Tente de novo.' }), timeout); }) : null;
    const r = await (wait ? Promise.race([native(cmd, data), wait]) : native(cmd, data));
    return r && typeof r === 'object' ? r : { error: 'O aplicativo não respondeu.' };
  } catch (e) {
    try { log(`${cmd}: ${e}`); } catch { /* sem ponte */ }
    return { error: 'O aplicativo não respondeu.' };
  } finally { clearTimeout(timer); }
}

/* ---------- Programas instalados (guardados por alguns minutos: a leitura demora) ---------- */
const CACHE_MS = 5 * 60 * 1000;
let cache = null;   // { at, programs }
export async function loadInstalled({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return { programs: cache.programs };
  const r = await safeNative('installedPrograms', {}, { timeout: 60000 });
  if (!Array.isArray(r.programs)) return { error: P.describeBridgeError(r, 'Não consegui listar os programas instalados.') };
  const programs = P.sanitizePrograms(r.programs);
  cache = { at: Date.now(), programs };
  return { programs };
}

/* ---------- Do caminho ao programa ---------- */
/** Resultado de um passo: { program, note? } | { choose: { folder, ranked } } | { nofile: folder } | { error }. */
async function outcomeFromPath(path, { folderName = '' } = {}) {
  const r = await safeNative('inspectProgram', { path }, { timeout: 20000 });
  if (r.ok === true && typeof r.path === 'string' && r.path.trim()) {
    if (r.kind === 'other') return { error: P.DROP_MESSAGES.file };
    return { program: P.programFromInspect(r, { folderName }) };
  }
  if (r.ok === false && r.isFolder === true && !folderName) return outcomeFromDroppedFolder(path);   // era uma pasta: segue o caminho da pasta, em vez de mostrar erro
  return { error: P.describeBridgeError(r, 'Não consegui ler este arquivo.') };
}
async function outcomeFromFolder(folder, candidates) {
  const ranked = P.rankCandidates(candidates, { folder, trustOrder: true });   // o app nativo já devolve do mais para o menos provável
  if (!ranked.list.length) return { nofile: folder };
  if (ranked.list.length === 1) return outcomeFromPath(ranked.list[0].path, { folderName: P.fileNameOf(folder) });
  return { choose: { folder, ranked } };
}
/* ---------- Pasta solta na janela ----------
   "findExe { folder } -> { folder, candidates }" lista os executáveis de uma pasta que já existe, sem abrir a caixa do Windows (o pickFolder abre).
   O app nativo atual o tem; um app antigo responde "comando desconhecido": nesse caso (ou enquanto não se sabe) os textos não prometem a pasta,
   e quem soltar uma pasta mesmo assim recebe a mensagem que manda usar "Escolher a pasta do jogo". */
let folderDrop = null;                 // null = ainda não sei | true = o app nativo lê pastas soltas | false = não lê
let folderProbe = null;
/** Descobre (uma vez) se o app nativo sabe listar os programas de uma pasta solta. Nunca lança. */
export function probeFolderDrop() {
  folderProbe ??= safeNative('findExe', { folder: '' }, { timeout: 8000 }).then((r) => {
    if (Array.isArray(r.candidates)) folderDrop = true;
    else if (/comando desconhecido/i.test(String(r.error || ''))) folderDrop = false;
    else folderProbe = null;             // sem resposta clara (demorou, falhou): tenta de novo na próxima vez
    return folderDrop;
  });
  return folderProbe;
}
/** Texto do aviso "Solte aqui": só cita a pasta quando a pasta solta funciona. */
export const dropHint = () => (folderDrop === true ? 'Arquivo .exe, atalho ou a pasta do jogo' : 'Arquivo .exe ou atalho do jogo');
const FOLDER_DROP_HELP = 'Você soltou uma pasta. Para o R3D PLAY achar o programa dela, clique em "Escolher a pasta do jogo" e selecione a pasta.';

/** Item solto de tipo incerto (talvez uma pasta, talvez um arquivo estranho): a ponte diz o que é. */
async function outcomeFromUncertain(pick) {
  const r = await safeNative('inspectProgram', { path: pick.path }, { timeout: 20000 });
  switch (P.judgeDropped(pick.kind, r)) {
    case 'folder': return outcomeFromDroppedFolder(pick.path);
    case 'program': return { program: P.programFromInspect(r) };
    case 'error': return { error: P.describeBridgeError(r, P.DROP_MESSAGES.invalid) };
    default: return { error: pick.kind === 'unknown' ? P.DROP_MESSAGES.unknown : P.DROP_MESSAGES.file };
  }
}
async function outcomeFromDroppedFolder(folder) {
  const f = await safeNative('findExe', { folder }, { timeout: 20000 });
  if (!Array.isArray(f.candidates)) {
    if (/comando desconhecido/i.test(String(f.error || ''))) folderDrop = false;
    return { error: FOLDER_DROP_HELP };
  }
  folderDrop = true;
  return outcomeFromFolder(folder, f.candidates);
}
/** `dropped` = promessa de nativeFiles('droppedFiles', …), já disparada dentro do evento de soltar. */
async function outcomeFromDropped(dropped) {
  let r = null;
  try { r = await dropped; } catch { r = null; }
  if (!r || !Array.isArray(r.paths)) return { error: P.describeBridgeError(r, P.DROP_MESSAGES.invalid) };
  const pick = P.pickDropped(r.paths);
  if (!pick.ok) return { error: pick.message };
  const out = pick.kind === 'folder' || pick.kind === 'unknown' ? await outcomeFromUncertain(pick) : await outcomeFromPath(pick.path);
  if (pick.extra > 0 && out.program) out.note = 'Você soltou mais de um item: usei só o primeiro.';
  return out;
}

/**
 * Abre a janela do passo 1.
 *  apps    = lista atual de aplicativos (para marcar "já está na lista")
 *  dropped = promessa de arquivos soltos (começa já lendo o que foi solto; se der certo logo, nem abre a janela)
 *  change  = trocar o programa de um aplicativo (sem o link "Preencher tudo manualmente")
 */
export async function chooseProgram({ apps = state.apps, dropped = null, change = false } = {}) {
  probeFolderDrop();                   // (sem esperar) descobre se pastas soltas funcionam, para os textos não prometerem o que não existe
  if (dropped) {
    const task = outcomeFromDropped(dropped);
    const quick = await Promise.race([task, sleep(250).then(() => null)]);
    if (quick?.program) {
      if (quick.note) toast(quick.note);
      return { program: quick.program };
    }
    return runDialog({ apps, change, start: quick ? { outcome: quick } : { pending: task } });
  }
  return runDialog({ apps, change, start: {} });
}

function runDialog({ apps, change, start }) {
  let result = null;
  let dlg = null;
  let closed = false;
  let token = 0;                       // cada tela nova invalida as respostas atrasadas da anterior
  const body = h('div', { class: 'gm-pw', tabindex: '-1' });
  const dropText = h('span', { text: dropHint() });
  const dropMark = h('div', { class: 'gm-drop gm-drop-in', 'aria-hidden': 'true', hidden: true },
    h('div', { class: 'gm-drop-box' }, icon('upload_file'), h('strong', { text: 'Solte aqui para adicionar' }), dropText));

  const finish = (res) => {
    if (closed || !dlg) return;
    if (res?.note) toast(res.note);
    result = res;
    dlg.querySelector('[data-done]')?.click();
  };
  const fill = (box, ...nodes) => box.replaceChildren(...nodes.filter(Boolean));   // (replaceChildren escreveria "null" no lugar de um nó ausente)
  const setBody = (...nodes) => { fill(body, ...nodes); body.scrollTop = 0; };
  const focusFirst = (sel) => { const el = body.querySelector(sel); if (el) el.focus(); else body.focus(); };
  const backBtn = (to = () => showHome()) => h('button', { class: 'btn ghost gm-back', type: 'button', on: { click: () => to() } }, icon('arrow_back'), 'Voltar');
  const errorBanner = (msg) => (msg ? h('div', { class: 'banner bad', role: 'alert' }, icon('error'), h('div', {}, msg)) : null);

  /* ----- tela inicial ----- */
  function showHome(error = '') {
    token++;
    const opt = (key, ic, title, text, fn) => h('button', { class: 'gm-opt', type: 'button', dataset: { opt: key }, on: { click: fn } },
      h('span', { class: 'gm-opt-ic' }, icon(ic)), h('strong', { text: title }), h('span', { class: 'gm-opt-tx', text }));
    setBody(
      errorBanner(error),
      h('h4', { class: 'gm-q', text: change ? 'Qual programa você quer usar?' : 'De onde vem o programa?' }),
      h('div', { class: 'gm-opts' },
        opt('installed', 'apps', 'Programas instalados', 'Escolha na lista de programas deste computador.', () => showList()),
        opt('file', 'file_open', 'Escolher o arquivo do jogo', 'Procure o arquivo que abre o jogo. Costuma terminar em .exe (um atalho ou um .bat também serve).', pickFile),
        opt('folder', 'folder_open', 'Escolher a pasta do jogo', 'O R3D PLAY procura sozinho o programa do jogo dentro da pasta.', pickFolder)),
      h('p', { class: 'gm-dropnote' }, icon('upload_file'), folderDrop === true ? 'Ou arraste o arquivo do jogo (.exe) ou a pasta dele para esta janela.' : 'Ou arraste o arquivo do jogo (.exe) para esta janela.'),
      change ? null : h('button', { class: 'gm-link', type: 'button', dataset: { opt: 'manual' }, on: { click: () => finish({ manual: true }) } }, 'Preencher tudo manualmente'));
    focusFirst('.gm-opt');
  }

  /* ----- esperando (janela do Windows aberta, lendo o arquivo…) ----- */
  function showWorking(title, hint = '') {
    token++;
    setBody(h('div', { class: 'gm-pw-state', role: 'status' }, h('span', { class: 'spinner' }), h('strong', { text: title }), hint ? h('span', { class: 'f-help', text: hint }) : null));
    body.focus();
    return token;
  }
  function handleOutcome(out, t) {
    if (closed || t !== token) return;
    if (out.program) return finish({ program: out.program, note: out.note });
    if (out.choose) return showCandidates(out.choose);
    if (out.nofile) return showNoFile(out.nofile);
    return showHome(out.error || 'Não consegui ler este programa.');
  }

  /* ----- arquivo e pasta (janelas do Windows) ----- */
  async function pickFile() {
    const t = showWorking('Escolha o arquivo na janela do Windows…', 'O arquivo do jogo costuma ter o nome dele e terminar em .exe.');
    const r = await safeNative('pickFile', { title: 'Escolha o arquivo do jogo' });
    if (closed || t !== token) return;
    if (r.cancelled) return showHome();
    if (typeof r.path !== 'string' || !r.path.trim()) return showHome(P.describeBridgeError(r, 'Não consegui abrir a janela para escolher o arquivo.'));
    const t2 = showWorking('Lendo o programa…');
    handleOutcome(await outcomeFromPath(r.path), t2);
  }
  async function pickFolder() {
    const t = showWorking('Escolha a pasta na janela do Windows…', 'Escolha a pasta onde o jogo está instalado.');
    const r = await safeNative('pickFolder', { title: 'Escolha a pasta do jogo' });
    if (closed || t !== token) return;
    if (r.cancelled) return showHome();
    if (typeof r.folder !== 'string' || !r.folder.trim()) return showHome(P.describeBridgeError(r, 'Não consegui abrir a janela para escolher a pasta.'));
    const t2 = showWorking('Procurando o programa na pasta…');
    handleOutcome(await outcomeFromFolder(r.folder, Array.isArray(r.candidates) ? r.candidates : []), t2);
  }

  /* ----- lista de programas instalados ----- */
  function showList({ force = false } = {}) {
    const t = ++token;
    let programs = [];
    let status = 'loading';              // loading | ready | error
    let message = '';
    let query = '';
    const rows = new Map();              // exe + argumentos -> <li> (não recria os ícones a cada letra digitada; o mesmo .exe pode ter várias linhas)

    const search = h('input', {
      // (type "text" e não "search": no campo de busca do navegador o Esc só limpa o texto e a janela não fecharia)
      type: 'text', id: 'gm-pw-q', inputmode: 'search', enterkeyhint: 'search', placeholder: 'Digite o nome do programa…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Buscar programa instalado',
      on: {
        input: () => { query = search.value; paint(); },
        keydown: (e) => {
          if (e.key === 'ArrowDown') { const first = listBox.querySelector('.gm-pw-row'); if (first) { e.preventDefault(); first.focus(); } }
          else if (e.key === 'Enter' && query.trim()) { const first = listBox.querySelector('.gm-pw-row'); if (first) { e.preventDefault(); first.click(); } }
        },
      },
    });
    const info = h('p', { class: 'gm-pw-count', 'aria-live': 'polite' });
    const listBox = h('div', { class: 'gm-pw-listbox' });
    const refresh = h('button', { class: 'btn ghost gm-icon-only', type: 'button', title: 'Atualizar a lista', 'aria-label': 'Atualizar a lista de programas', on: { click: () => load(true) } }, icon('refresh'));
    listBox.addEventListener('keydown', (e) => {
      const rowsEl = [...listBox.querySelectorAll('.gm-pw-row')];
      const i = rowsEl.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); rowsEl[Math.min(rowsEl.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) search.focus(); else rowsEl[i - 1].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); rowsEl[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); rowsEl[rowsEl.length - 1].focus(); }
      else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) search.focus();   // digitar em qualquer ponto vai para a busca (o Espaço continua sendo o clique do botão da linha)
    });

    function row(p) {
      const key = P.programKey(p.exe, p.args);
      let li = rows.get(key);
      if (li) return li;
      const ic = p.icon ? h('img', { src: `data:image/png;base64,${p.icon}`, alt: '', width: 32, height: 32, draggable: 'false' }) : icon(p.exe.toLowerCase().endsWith('.exe') ? 'apps' : 'terminal');
      li = h('li', {}, h('button', {
        class: `gm-pw-row${p.used ? ' used' : ''}`, type: 'button', title: p.exe, 'aria-label': `${p.name}${p.used ? ' (já está na lista)' : ''}`,
        on: { click: () => finish({ program: P.programFromList(p) }) },
      }, h('span', { class: 'gm-pw-ic' }, ic),
      h('span', { class: 'gm-pw-tx' }, h('strong', { text: p.name }), h('small', { class: 'mono', text: P.ellipsizePath(p.dir || P.dirOf(p.exe), 70) })),
      p.used ? h('span', { class: 'badge', text: 'Já está na lista' }) : null));
      rows.set(key, li);
      return li;
    }
    function paint() {
      if (status === 'loading') {
        info.textContent = '';
        fill(listBox, h('div', { class: 'gm-pw-state', role: 'status' }, h('span', { class: 'spinner' }), h('strong', { text: 'Procurando os programas instalados…' }), h('span', { class: 'f-help', text: 'Isso leva só alguns segundos.' })));
        return;
      }
      if (status === 'error') {
        info.textContent = '';
        fill(listBox, errorBanner(message || 'Não consegui listar os programas instalados.'),
          h('p', { class: 'f-help', text: 'Você ainda pode escolher o arquivo do jogo diretamente.' }),
          h('div', { class: 'row-actions gm-row-start' },
            h('button', { class: 'btn', type: 'button', on: { click: () => load(true) } }, icon('refresh'), 'Tentar de novo'),
            h('button', { class: 'btn primary', type: 'button', on: { click: () => pickFile() } }, icon('file_open'), 'Escolher o arquivo do jogo')));
        return;
      }
      if (!programs.length) {
        info.textContent = '';
        fill(listBox, h('div', { class: 'empty gm-pw-empty' }, icon('apps'), h('h4', { class: 'gm-q', text: 'Não encontrei programas instalados' }),
          h('p', { class: 'f-help', text: 'Escolha o arquivo do jogo (.exe) ou a pasta onde ele está instalado.' }),
          h('div', { class: 'row-actions gm-center' }, h('button', { class: 'btn primary', type: 'button', on: { click: () => pickFile() } }, icon('file_open'), 'Escolher o arquivo do jogo'))));
        return;
      }
      const found = P.searchPrograms(P.markUsed(programs, apps), query);
      info.textContent = query.trim() ? `${found.length} de ${programs.length} programas` : `${programs.length} programas instalados`;
      if (!found.length) {
        fill(listBox, h('div', { class: 'empty gm-pw-empty' }, icon('search_off'), h('h4', { class: 'gm-q', text: `Nenhum programa com "${query.trim()}"` }),
          h('p', { class: 'f-help', text: 'Confira o nome ou escolha o arquivo do jogo direto no computador. Jogos da Steam, Epic, GOG e Ubisoft são adicionados em "Detectar jogos".' }),
          h('div', { class: 'row-actions gm-center' }, h('button', { class: 'btn', type: 'button', on: { click: () => pickFile() } }, icon('file_open'), 'Escolher o arquivo do jogo'))));
        return;
      }
      const shown = found.slice(0, P.MAX_ROWS);
      fill(listBox, 
        h('ul', { class: 'gm-pw-list', 'aria-label': 'Programas instalados' }, shown.map(row)),
        found.length > shown.length ? h('p', { class: 'gm-pw-more f-help', text: `Mostrando ${shown.length} de ${found.length}. ${query.trim() ? 'Continue digitando para afinar a busca.' : 'Digite o nome do programa para achá-lo.'}` }) : null);
    }
    async function load(again) {
      status = 'loading'; paint();
      const r = await loadInstalled({ force: again });
      if (closed || t !== token) return;
      if (r.error) { status = 'error'; message = r.error; } else { status = 'ready'; programs = r.programs; rows.clear(); }
      paint();
    }

    setBody(
      h('div', { class: 'gm-pw-bar' }, backBtn(), h('div', { class: 'search' }, icon('search'), search), refresh),
      info, listBox);
    paint();
    load(force);
    search.focus();
  }

  /* ----- vários programas na pasta ----- */
  function showCandidates({ folder, ranked }, error = '') {
    const t = ++token;
    const folderName = P.fileNameOf(folder);
    const pick = async (c) => {
      const t2 = showWorking('Lendo o programa…');
      const out = await outcomeFromPath(c.path, { folderName });
      if (closed || t2 !== token) return;
      if (out.program) return finish({ program: out.program });
      showCandidates({ folder, ranked }, out.error || 'Não consegui ler este programa.');
    };
    setBody(
      h('div', { class: 'gm-pw-bar' }, backBtn()),
      errorBanner(error),
      h('h4', { class: 'gm-q', text: 'Qual destes abre o jogo?' }),
      h('p', { class: 'f-help' }, 'Achei mais de um programa na pasta ', h('strong', { text: folderName || folder }), '. Escolha o que inicia o jogo.'),
      h('ul', { class: 'gm-pw-list', 'aria-label': 'Programas encontrados na pasta' }, ranked.list.map((c, i) => h('li', {}, h('button', {
        class: 'gm-pw-row', type: 'button', title: c.path, on: { click: () => pick(c) },
      }, h('span', { class: 'gm-pw-ic' }, icon('play_circle')),
      h('span', { class: 'gm-pw-tx' }, h('strong', { text: P.candidateTitle(c) }), h('small', { class: 'mono', text: P.ellipsizePath(P.relativeTo(c.path, folder), 70) })),
      i === 0 && ranked.confident ? h('span', { class: 'badge ok', text: 'Mais provável' }) : null,
      c.size ? h('span', { class: 'gm-pw-size', text: P.humanSize(c.size) }) : null)))));
    focusFirst('.gm-pw-row');
    return t;
  }
  /* ----- nenhum programa na pasta ----- */
  function showNoFile(folder) {
    token++;
    setBody(
      h('div', { class: 'gm-pw-bar' }, backBtn()),
      h('div', { class: 'empty gm-pw-empty' }, icon('search_off'), h('h4', { class: 'gm-q', text: 'Não achei o programa nesta pasta' }),
        h('p', { class: 'f-help' }, 'Procurei dentro de ', h('strong', { text: P.fileNameOf(folder) || folder }), ' e não vi nenhum arquivo .exe que pareça ser o jogo. Ele pode estar em outra pasta. Se você sabe qual é, escolha o arquivo direto.'),
        h('div', { class: 'row-actions gm-center' },
          h('button', { class: 'btn primary', type: 'button', on: { click: () => pickFile() } }, icon('file_open'), 'Escolher o arquivo do jogo'),
          h('button', { class: 'btn', type: 'button', on: { click: () => pickFolder() } }, icon('folder_open'), 'Escolher outra pasta'))));
    focusFirst('.btn.primary');
  }

  /* ----- arrastar e soltar nesta janela ----- */
  const markDrop = (on) => { if (on) dropText.textContent = dropHint(); dropMark.hidden = !on; };
  function onDragOver(e) {
    if (!P.hasFiles(e)) return;
    e.preventDefault();                  // um arquivo solto nunca pode navegar a página
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    markDrop(true);
  }
  function onDrop(e) {
    if (!P.hasFiles(e)) return;
    e.preventDefault();
    markDrop(false);
    // a ponte precisa receber os arquivos enquanto o evento ainda está ativo: nada de await antes desta linha
    const dropped = nativeFiles('droppedFiles', e.dataTransfer.files);
    const t = showWorking('Lendo o que foi solto…');
    outcomeFromDropped(dropped).then((out) => handleOutcome(out, t));
  }

  /* ----- janela ----- */
  const promise = modal({
    title: change ? 'Trocar o programa' : 'Adicionar aplicativo',
    wide: true,
    body,
    actions: [{ label: 'Cancelar', value: null }, { label: 'ok', value: 'done' }],
    onOpen: (d) => {
      dlg = d;
      d.classList.add('gm-pw-dlg');
      const done = d.querySelector('.row-actions button:last-child');
      done.hidden = true;
      done.dataset.done = '';
      d.append(dropMark);
      // se o navegador fechar a janela sozinho (Esc com o foco fora dela), termina o fechamento do jeito normal: sem isto a tela ficaria esperando a resposta para sempre
      d.addEventListener('close', () => setTimeout(() => { if (d.isConnected && !d.open) d.querySelector('.row-actions button')?.click(); }, 0));
      d.addEventListener('dragover', onDragOver);
      d.addEventListener('dragleave', (e) => { if (!d.contains(e.relatedTarget)) markDrop(false); });
      d.addEventListener('drop', onDrop);
      d.addEventListener('dragend', () => markDrop(false));
      if (start.outcome) { const t = showWorking('Lendo o programa…'); handleOutcome(start.outcome, t); } else if (start.pending) {
        const t = showWorking('Lendo o programa…');
        start.pending.then((out) => handleOutcome(out, t));
      } else showHome();
    },
  });
  return promise.then(() => { closed = true; return result; });
}
