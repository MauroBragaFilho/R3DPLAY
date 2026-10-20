// Janela do aplicativo (passo 2 de "Adicionar aplicativo" e também "Editar aplicativo"). Simples por padrão: o programa, o nome e a capa.
// Todo o resto que o schema (ui/schema/apps.json) tem (tipo de controle, comando bruto, pasta de trabalho, saída, comandos de preparo,
// ciclo de vida, tela virtual, identidade…) fica dentro de "Opções avançadas", recolhida. O formulário só guarda estado; toda regra
// (normalização, validação, diff) vem do appmodel.js e do programs.js.
//
// Novo aplicativo: passo 1 (addwizard.js: programas instalados, arquivo, pasta ou arrastar e soltar) -> esta janela já preenchida.
// Salvar = POST /api/apps com o objeto COMPLETO do app (as chaves desconhecidas do app existente são preservadas) e depois reler a lista.
// App novo vai sem uuid; como o servidor não devolve o uuid criado, relemos a lista para achá-lo (necessário para enviar a capa).
import { h, icon, state, modal, confirmDlg, busy, toast, log, loadApps } from '../core.js';
import * as M from './appmodel.js';
import * as L from './library.js';
import * as P from './programs.js';
import { chooseProgram, safeNative } from './addwizard.js';

const MAX_COVER_BYTES = 8 * 1024 * 1024;
/** Textos que trocamos do schema por serem confusos para quem não é técnico ("Moonlight" não aparece na interface). */
const TEXT = {
  name: { label: 'Nome', help: 'O nome que aparece na lista de jogos do celular.', placeholder: 'Ex.: Meu jogo favorito' },
  gamepad: { label: 'Tipo de controle', help: 'Qual controle o R3D PLAY simula para o jogo.', hint: '"Padrão (global)" usa a configuração geral do R3D PLAY; "Desativado" desliga o controle neste aplicativo.' },
  'terminate-on-pause': { label: 'Fechar o jogo quando o celular desconectar', help: 'Quando todos os celulares saírem da transmissão, o jogo é fechado no PC.' },
  'virtual-display': { label: 'Usar uma tela virtual', help: 'O jogo abre numa tela virtual, sem mexer na tela do seu PC. Exige o driver de tela virtual instalado.' },
  'image-path': { label: 'Arquivo da capa', help: 'A capa que aparece na lista de jogos do celular. Aceita PNG, JPG ou WebP (JPG e WebP são convertidos). Sem capa, vale a imagem padrão.' },
  cmd: { placeholder: '"C:\\Jogos\\MeuJogo\\jogo.exe"' },
  'working-dir': { placeholder: 'Opcional: em branco usa a pasta do programa' },
  output: { placeholder: 'Opcional: arquivo para guardar as mensagens do programa' },
};
const VDISPLAY_PROBLEMS = {
  1: 'O estado do driver do monitor virtual é desconhecido.',
  '-1': 'O driver do monitor virtual falhou ao iniciar.',
  '-2': 'A versão instalada do driver do monitor virtual é incompatível.',
  '-3': 'O monitor virtual parou de responder (watchdog).',
};
/** Aplicativos cuja capa já foi procurada sozinha nesta janela do painel (a busca automática roda uma vez por aplicativo). */
const autoCoverTried = new Set();

/* ---------- Schema (carregado uma vez) ---------- */
let schemaPromise = null;
export function loadSchema() {
  schemaPromise ??= fetch(new URL('../../schema/apps.json', import.meta.url))
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .catch((e) => { schemaPromise = null; throw e; });
  return schemaPromise;
}

/* ---------- Imagem de capa ---------- */
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** JPG/WebP viram PNG (o servidor só aceita PNG), reduzidos a no máximo 1200 px. */
async function toPngBytes(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('Não consegui abrir essa imagem. Use um arquivo PNG, JPG ou WebP.'); }
  const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
  if (!blob) throw new Error('Não consegui converter a imagem para PNG.');
  return new Uint8Array(await blob.arrayBuffer());
}
/** Lê o arquivo escolhido e devolve { b64, url } de um PNG de verdade. */
async function readCoverFile(file) {
  if (file.size > MAX_COVER_BYTES) throw new Error('A imagem é grande demais (o limite é 8 MB).');
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (!M.isPngBytes(bytes)) bytes = await toPngBytes(file);
  const b64 = bytesToBase64(bytes);
  return { b64, url: `data:image/png;base64,${b64}` };
}

/**
 * Abre a janela. app = aplicativo existente (do GET /api/apps): edita direto. Sem app: começa pelo passo 1 (escolher o programa).
 * Entradas opcionais para app novo: program (já escolhido) e dropped (promessa de nativeFiles('droppedFiles', …) de um arquivo solto).
 * Devolve { saved: boolean, uuid?, unchanged? }.
 */
export async function openAppEditor({ app = null, program = null, dropped = null } = {}) {
  let schema;
  try { schema = await loadSchema(); } catch (e) {
    log(`editor de aplicativo: schema não carregou: ${e}`);
    toast('Não consegui abrir o formulário do aplicativo. Feche e abra o painel de novo.', 'err');
    return { saved: false };
  }
  if (app) return runEditor(schema, { app });
  let chosen = program;
  let manual = false;
  if (!chosen) {
    const pick = await chooseProgram({ apps: state.apps, dropped });
    if (!pick) return { saved: false };
    if (pick.manual) manual = true; else chosen = pick.program;
  }
  return runEditor(schema, { program: chosen, manual });
}

function runEditor(schema, { app = null, program = null, manual = false } = {}) {
  const platform = state.meta.platform || 'windows';
  const isNew = !app || !app.uuid;
  const initial = !isNew ? M.normalizeApp(app, schema) : program ? P.appFromProgram(program, schema) : M.newApp(schema);
  const original = M.deepClone(initial);       // "Alterou algo?" compara com o que a janela abriu (para app novo, já com o programa escolhido)
  const form = M.deepClone(initial);           // estado bruto do formulário (números ainda como texto enquanto digita)
  // Referência do selo "N personalizados": o que o R3D PLAY define sozinho. Num jogo detectado (Steam, Epic…), o comando de abrir pela loja
  // e o de fechar o jogo ao sair também são dele: só contam se a pessoa mexer neles.
  let base = isNew && !program ? M.newApp(schema) : P.policyBaseline(schema);
  if (!isNew && (M.guessSource(initial) || L.isDetectedGame(initial.uuid))) {
    base.detached = M.deepClone(initial.detached);
    base['prep-cmd'] = (initial['prep-cmd'] || []).filter((c) => L.isCloseDirCmd(c?.undo)).map((c) => M.deepClone(c));
  }
  const fmap = M.fieldMap(schema);
  const controls = new Map();                   // chave -> { root, err, warn, focus, set }
  const touched = new Set();
  let attempted = false;
  let pendingCover = null;                      // { b64, url, auto? }: imagem escolhida/achada, enviada só ao salvar
  let result = { saved: false };
  let forceClose = false;
  let closed = false;
  let dlgRef = null;
  let errP = null;
  let advEl = null;
  let advBadge = null;
  let saving = false;                           // gravando: enquanto isso a janela não pode ser fechada (a gravação seguiria mesmo assim)
  let showingValidation = false;                // a mensagem de baixo é "corrija o que está em vermelho" (some quando tudo for corrigido)
  let nameEdited = false;                       // a pessoa mexeu no nome (então trocar de programa não o sobrescreve)
  let refreshCover = () => {};
  let coverMsg = () => {};                      // mensagem da capa DENTRO da janela (um aviso comum ficaria escondido atrás dela)
  let lockClose = () => {};                     // liga/desliga Cancelar e X enquanto grava
  let paintCard = () => {};
  let cancelCoverSearch = () => {};
  let searchCover = () => {};

  /* O que sabemos do arquivo mostrado no cartão do programa (ícone e se existe no PC). exists: true | false | null (não sabemos). */
  let card = { key: '', icon: null, exists: null, note: '' };
  const firstExe = P.exeOfCommand(form.cmd);
  if (program) card = { key: P.pathKey(program.exe), icon: program.icon || null, exists: true, note: '' };
  let autoDirKey = firstExe ? P.pathKey(P.dirOf(firstExe)) : '';   // pasta de trabalho que o R3D PLAY deduz do programa (acompanha o programa)

  /* ----- estado ----- */
  /** Há algo que a PESSOA mudou? (a capa achada sozinha não conta: fechar a janela não deve perguntar "descartar?") */
  const isDirty = () => !!(pendingCover && !pendingCover.auto) || M.changedKeys(original, form, schema).length > 0;
  /** Há algo para gravar? (inclui a capa achada sozinha) */
  const hasChanges = () => !!pendingCover || M.changedKeys(original, form, schema).length > 0;
  function setVal(key, value) {
    form[key] = value;
    if (key === 'cmd') { paintCard(); scheduleInspect(); }
    syncVisibility();
    revalidate();
  }
  /** Troca o valor de um campo por código (não por digitação): atualiza o formulário e o controle, sem efeitos colaterais. */
  function setInput(key, value) {
    form[key] = value;
    controls.get(key)?.set?.(value);
  }
  function syncVisibility() {
    for (const [key, c] of controls) {
      const f = fmap.get(key);
      if (f?.visible_if) c.root.hidden = !M.fieldVisible(f, form, platform);
    }
    if (advBadge) {
      const n = P.customOptionCount(form, schema, { platform, base });
      advBadge.textContent = n ? M.plural(n, 'personalizado', 'personalizados') : '';
      advBadge.hidden = !n;
    }
  }
  function revalidate() {
    // com imagem nova escolhida, o texto do campo vai ser trocado pelo caminho do envio: não vale barrar por ele
    const v = M.validateApp(form, schema, { platform, skipImage: !!pendingCover });
    for (const [key, c] of controls) {
      const msg = attempted || touched.has(key) ? v.errors[key] : '';
      c.err.textContent = msg || '';
      c.err.hidden = !msg;
      c.root.classList.toggle('invalid', !!msg);
      // o aviso "sem comando" não faz sentido enquanto a pessoa ainda nem começou a preencher um aplicativo novo
      const aviso = isNew && !attempted && !touched.has(key) && !M.cleanText(form[key]) ? '' : v.warnings[key];
      c.warn.textContent = aviso || '';
      c.warn.hidden = !aviso;
    }
    if (showingValidation && errP && !Object.keys(v.errors).length) { errP.hidden = true; showingValidation = false; }   // o que estava em vermelho foi corrigido
    return v;
  }

  /* ----- peças de formulário ----- */
  const fid = (key) => `gm-f-${key}`;
  const labelOf = (f) => TEXT[f.key]?.label ?? f.label;
  function helpOf(f) {
    return [
      h('div', { class: 'f-help', id: `gm-h-${f.key}`, text: TEXT[f.key]?.help ?? f.help }),
      f.note ? h('div', { class: 'f-help' }, h('strong', { text: `${f.note_label || 'Observação:'} ` }), f.note) : null,
      TEXT[f.key]?.hint ? h('div', { class: 'f-hint', text: TEXT[f.key].hint }) : null,
    ];
  }
  /** Casca comum: rótulo, controle, ajuda, aviso (laranja) e erro (vermelho). */
  function shell(f, control, { labelFor = fid(f.key), extra = [] } = {}) {
    const err = h('div', { class: 'f-error', id: `gm-e-${f.key}`, role: 'alert', hidden: true });
    const warn = h('div', { class: 'f-hint gm-warn', id: `gm-w-${f.key}`, hidden: true });
    const label = labelFor
      ? h('label', { class: 'f-label', for: labelFor }, labelOf(f), f.required ? h('span', { class: 'req', 'aria-hidden': 'true', text: '*' }) : null)
      : h('div', { class: 'f-label', id: `gm-l-${f.key}` }, labelOf(f));
    const root = h('div', { class: 'field', dataset: { key: f.key } }, label, control, helpOf(f), extra, warn, err);
    controls.set(f.key, { root, err, warn, focus: () => (control.matches?.('input,select,button') ? control : control.querySelector('input,select,button'))?.focus() });
    return root;
  }
  const describedBy = (f) => `gm-h-${f.key} gm-w-${f.key} gm-e-${f.key}`;

  function textField(f, props = {}) {
    const input = h('input', {
      id: fid(f.key), type: 'text', class: f.mono ? 'mono' : '', value: form[f.key] ?? '', autocomplete: 'off', spellcheck: 'false',
      placeholder: TEXT[f.key]?.placeholder, 'aria-describedby': describedBy(f), 'aria-required': f.required ? 'true' : null, ...props,
      on: {
        input: () => { if (f.key === 'name') nameEdited = true; setVal(f.key, input.value); },
        // ao terminar de editar o comando, a pasta de trabalho acompanha o programa novo (se a pessoa não personalizou a pasta)
        change: () => { if (f.key === 'cmd') followProgramDir(); },
      },
    });
    const root = shell(f, input);
    controls.get(f.key).set = (v) => { input.value = v ?? ''; };
    return root;
  }
  function toggleField(f) {
    const id = fid(f.key);
    const input = h('input', {
      id, type: 'checkbox', checked: M.toggleChecked(f, form[f.key]), 'aria-describedby': describedBy(f),
      on: { change: () => setVal(f.key, M.toggleFromChecked(f, input.checked)) },
    });
    const err = h('div', { class: 'f-error', id: `gm-e-${f.key}`, role: 'alert', hidden: true });
    const warn = h('div', { class: 'f-hint gm-warn', id: `gm-w-${f.key}`, hidden: true });
    const root = h('div', { class: 'field row', dataset: { key: f.key } },
      h('div', { class: 'f-text' },
        h('label', { class: 'f-label', for: id }, labelOf(f)),
        helpOf(f), h('span', { class: 'f-hint', text: M.toggleHint(f, schema) }), warn, err),
      h('span', { class: 'switch' }, input, h('span', { class: 'track' })));
    controls.set(f.key, { root, err, warn, focus: () => input.focus(), set: (v) => { input.checked = M.toggleChecked(f, v); } });
    return root;
  }
  function numberField(f) {
    const id = fid(f.key);
    const unit = f.unit === '%' ? '%' : f.unit ? ` ${f.unit}` : '';
    let control;
    if (f.widget === 'range') {
      const out = h('output', { class: 'gm-range-val', for: id, text: `${form[f.key]}${unit}` });
      const input = h('input', {
        id, type: 'range', min: f.min, max: f.max, step: f.step || 1, value: form[f.key], 'aria-describedby': describedBy(f),
        on: { input: () => { out.textContent = `${input.value}${unit}`; setVal(f.key, input.value); } },
      });
      control = h('div', { class: 'gm-range' }, input, out);
    } else {
      const input = h('input', {
        id, type: 'number', inputmode: 'numeric', min: f.min, max: f.max, step: 1, placeholder: f.placeholder, value: form[f.key], 'aria-describedby': describedBy(f),
        on: { input: () => setVal(f.key, input.validity.badInput ? 'inválido' : input.value) },
      });
      control = f.unit ? h('div', { class: 'input-unit' }, input, h('span', { class: 'unit', text: f.unit })) : input;
    }
    return shell(f, control);
  }
  function selectField(f) {
    const select = h('select', {
      id: fid(f.key), 'aria-describedby': describedBy(f),
      on: { change: () => setVal(f.key, select.value) },
    }, M.selectOptions(f, platform).map((o) => h('option', { value: o.value, selected: o.value === form[f.key], text: o.label })));
    return shell(f, select);
  }
  function uuidField(f) {
    const input = h('input', { id: fid(f.key), type: 'text', class: 'mono', readOnly: true, value: form.uuid || '', placeholder: 'Será criado ao salvar', 'aria-describedby': describedBy(f) });
    return shell(f, input);
  }

  /* ----- listas editáveis (detached e prep-cmd/state-cmd) ----- */
  function listField(f) {
    const isCmds = f.type === 'prepcmds';
    const list = form[f.key];
    const box = h('div', { class: 'gm-list', role: 'group', 'aria-labelledby': `gm-l-${f.key}` });
    const mini = (text, input) => h('label', { class: 'gm-mini' }, h('span', { text }), input);
    const labels = f.key === 'state-cmd'
      ? ['Executar comando: ao retomar', 'Desfazer comando: ao pausar']
      : ['Executar comando: antes de iniciar', 'Desfazer comando: ao encerrar'];

    function paint(focus) {
      box.replaceChildren();
      if (!list.length) box.append(h('p', { class: 'gm-empty', text: isCmds ? 'Nenhum comando. Clique em "Adicionar" para criar o primeiro.' : 'Nenhum comando desvinculado.' }));
      list.forEach((item, i) => {
        const btns = [
          ['arrow_upward', 'Subir', () => move(i, -1), i === 0],
          ['arrow_downward', 'Descer', () => move(i, 1), i === list.length - 1],
          ['delete', 'Remover', () => remove(i), false],
        ].map(([ic, label, fn, off]) => h('button', {
          class: 'icon-btn', type: 'button', disabled: off, title: label, 'aria-label': `${label} o comando ${i + 1}`, dataset: { btn: label }, on: { click: fn },
        }, icon(ic)));
        let row;
        if (isCmds) {
          const doIn = h('input', { type: 'text', class: 'mono', value: item.do, autocomplete: 'off', spellcheck: 'false', dataset: { col: 'do' }, on: { input: () => { item.do = doIn.value; setVal(f.key, list); } } });
          const undoIn = h('input', { type: 'text', class: 'mono', value: item.undo, autocomplete: 'off', spellcheck: 'false', dataset: { col: 'undo' }, on: { input: () => { item.undo = undoIn.value; setVal(f.key, list); } } });
          const elev = h('input', { type: 'checkbox', checked: !!item.elevated, 'aria-label': `Comando ${i + 1}: executar como administrador`, on: { change: () => { item.elevated = elev.checked; setVal(f.key, list); } } });
          row = h('div', { class: 'gm-cmd-row' },
            mini(labels[0], doIn), mini(labels[1], undoIn),
            platform === 'windows' ? h('div', { class: 'gm-mini gm-elev' }, h('span', { text: 'Como administrador' }), h('span', { class: 'switch' }, elev, h('span', { class: 'track' }))) : null,
            h('div', { class: 'gm-row-btns' }, btns));
        } else {
          const inp = h('input', { type: 'text', class: 'mono', value: item, autocomplete: 'off', spellcheck: 'false', 'aria-label': `Comando desvinculado ${i + 1}`, dataset: { col: 'do' }, on: { input: () => { list[i] = inp.value; setVal(f.key, list); } } });
          row = h('div', { class: 'gm-cmd-row gm-cmd-single' }, inp, h('div', { class: 'gm-row-btns' }, btns));
        }
        box.append(row);
      });
      box.append(h('button', {
        class: 'btn ghost gm-add', type: 'button', dataset: { btn: 'add' },
        on: { click: () => { list.push(isCmds ? { do: '', undo: '', elevated: false } : ''); paint({ row: list.length - 1, col: 'do' }); setVal(f.key, list); } },
      }, icon('add'), f.add_label || 'Adicionar'));
      if (focus) {
        const rows = [...box.querySelectorAll('.gm-cmd-row')];
        const row = rows[Math.min(focus.row ?? 0, rows.length - 1)];
        let target = null;
        if (focus.toAdd) target = box.querySelector('.gm-add');
        else if (focus.btn) target = row?.querySelector(`[data-btn="${focus.btn}"]:not([disabled])`) || row?.querySelector('.icon-btn:not([disabled])');
        else target = row?.querySelector(`[data-col="${focus.col || 'do'}"]`);
        (target || box.querySelector('.gm-add'))?.focus();
      }
    }
    function move(i, d) {
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      paint({ row: j, btn: d < 0 ? 'Subir' : 'Descer' });
      setVal(f.key, list);
    }
    function remove(i) {
      list.splice(i, 1);
      paint(list.length ? { row: Math.min(i, list.length - 1), btn: 'Remover' } : { toAdd: true });
      setVal(f.key, list);
    }
    paint();
    return shell(f, box, { labelFor: null });
  }

  /* ----- imagem de capa -----
     Devolve o conjunto de prévia + botões (fica à esquerda, sempre visível) e o campo do caminho do arquivo (vai para as Opções avançadas). */
  function imageField(f) {
    const prev = h('div', { class: 'gm-cover-prev', 'aria-hidden': 'true' });
    const status = h('div', { class: 'f-hint gm-cover-status', role: 'status' });
    let note = { text: '', kind: '' };   // aviso avulso da capa (lendo a imagem, não achei capa...), mostrado aqui e não em um toast
    let searching = false;
    let coverSeq = 0;                    // cada busca nova (ou cancelamento) invalida a resposta atrasada da anterior
    coverMsg = (text, kind = '') => { note = { text, kind }; refreshCover(); };
    const pathIn = h('input', {
      id: fid(f.key), type: 'text', class: 'mono', value: form[f.key], placeholder: 'Nenhuma: usa a imagem padrão', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': describedBy(f),
      on: { input: () => { cancelCoverSearch(); pendingCover = null; note = { text: '', kind: '' }; setVal(f.key, pathIn.value); refreshCover(); } },
    });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    const pick = h('button', { class: 'btn', type: 'button', on: { click: () => file.click() } }, icon('upload'), 'Escolher imagem');
    const onlineIdle = () => [icon('travel_explore'), 'Buscar capa online'];
    // (durante a busca o botão fica "aria-disabled" e não "disabled": um botão desligado com o foco perde o foco para o <body>)
    const online = h('button', { class: 'btn ghost', type: 'button', on: { click: () => { if (!searching) searchCover({ auto: false }); } } }, onlineIdle());
    const remove = h('button', { class: 'btn ghost', type: 'button', on: { click: () => { cancelCoverSearch(); pendingCover = null; note = { text: '', kind: '' }; pathIn.value = ''; setVal(f.key, ''); refreshCover(); } } }, icon('hide_image'), 'Remover capa');

    function setPending(p, text = '') {
      pendingCover = p;
      note = { text, kind: '' };
      pathIn.value = form[f.key];
      revalidate();   // o aviso de "precisa ser PNG" do texto antigo deixa de valer
      refreshCover();
    }
    refreshCover = () => {
      prev.replaceChildren();
      // (nada que tenha o foco pode ser desligado: o foco iria para o <body> e o Esc deixaria de perguntar "descartar?")
      pathIn.readOnly = !!pendingCover;
      pathIn.classList.toggle('gm-dim', !!pendingCover);
      const noCover = !pendingCover && !form[f.key];
      if (noCover && document.activeElement === remove) pick.focus();
      remove.disabled = noCover;
      status.textContent = note.text || (pendingCover ? 'Nova imagem escolhida: ela será enviada quando você salvar.' : '');
      status.classList.toggle('gm-status-err', note.kind === 'err');
      const url = pendingCover?.url;
      if (url) { prev.append(h('img', { src: url, alt: '', draggable: 'false' })); return; }
      const fake = { name: form.name, 'image-path': form[f.key] };
      const cached = L.peekCover(fake);
      if (cached) { prev.append(h('img', { src: cached, alt: '', draggable: 'false' })); return; }
      const ph = M.placeholderFor(fake);
      prev.append(ph.kind === 'icon' ? icon(ph.name, 'big') : h('span', { class: 'letter', text: ph.text }));
      if (L.coverPathOf(fake)) {
        const token = form[f.key];
        L.loadCover(fake).then((u) => { if (u && !pendingCover && form[f.key] === token) { prev.replaceChildren(h('img', { src: u, alt: '', draggable: 'false' })); } });
      }
    };
    const idle = () => { searching = false; online.removeAttribute('aria-disabled'); online.replaceChildren(...onlineIdle()); };
    cancelCoverSearch = () => { coverSeq++; if (searching) { idle(); coverMsg(''); } };
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      cancelCoverSearch();
      coverMsg('Preparando a imagem…');
      try { setPending(await readCoverFile(chosen)); } catch (e) { coverMsg(e.message || 'Não consegui ler essa imagem.', 'err'); }
    });
    /** Procura a capa pelo nome (o mesmo fluxo do botão "Buscar capa online"). auto = busca sozinha ao abrir. */
    searchCover = async ({ auto = false, again = false } = {}) => {
      const name = M.cleanText(form.name);
      if (!name) {
        if (auto) return;
        touched.add('name');
        revalidate();   // mostra "Dê um nome ao aplicativo." no campo
        coverMsg('Digite o nome do aplicativo primeiro: a capa é procurada por ele.', 'err');
        controls.get('name')?.focus();
        return;
      }
      const seq = ++coverSeq;
      searching = true;
      online.setAttribute('aria-disabled', 'true');
      online.replaceChildren(h('span', { class: 'spinner' }), 'Procurando…');
      coverMsg(`Procurando a capa de "${name}"…`);
      const det = form.uuid ? L.getDetected(form.uuid) : null;
      // sem resposta em 45 s vira "não achei" (o botão nunca fica travado); sem internet também
      const r = await safeNative('cover', det ? { source: det.source, gameId: det.id, name: det.name } : { source: 'other', gameId: '', name }, { timeout: 45000 });
      if (closed || seq !== coverSeq) return;   // a janela fechou, ou a pessoa escolheu/tirou a capa, ou veio outra busca
      idle();
      if (M.cleanText(form.name) !== name) {   // o nome mudou enquanto procurava: a capa seria de outro jogo
        if (!again && M.cleanText(form.name)) return searchCover({ auto, again: true });   // procura de novo, com o nome de agora (uma vez só)
        coverMsg('O nome mudou durante a busca. Clique em "Buscar capa online" para procurar de novo.');
        return;
      }
      if (typeof r.data === 'string' && r.data) setPending({ b64: r.data, url: `data:image/png;base64,${r.data}`, auto }, 'Capa encontrada. Ela será enviada quando você salvar.');
      else coverMsg(`Não achei a capa de "${name}". Escolha uma imagem do seu computador.`);
    };
    const widget = h('div', { class: 'gm-cover' }, prev, h('div', { class: 'gm-cover-side' }, h('div', { class: 'gm-cover-btns' }, pick, online, remove), status), file);
    const root = shell(f, pathIn);
    controls.get(f.key).focus = () => pathIn.focus();
    refreshCover();
    return { widget, root };
  }

  /* ----- cartão do programa ----- */
  let inspectTimer = null;
  let inspectSeq = 0;
  function scheduleInspect() {
    clearTimeout(inspectTimer);
    inspectTimer = setTimeout(runInspect, 600);
  }
  /** Pergunta ao app nativo se o arquivo do comando existe e qual é o ícone dele (nunca executa o programa). */
  async function runInspect() {
    const exe = P.exeOfCommand(form.cmd);
    const key = exe ? P.pathKey(exe) : '';
    if (!exe || exe.includes('$(') || exe.includes('%')) { card = { key, icon: null, exists: null, note: '' }; paintCard(); return; }
    if (key === card.key && card.exists !== null) return;
    const seq = ++inspectSeq;
    const r = await safeNative('inspectProgram', { path: exe }, { timeout: 20000 });
    if (closed || seq !== inspectSeq || P.pathKey(P.exeOfCommand(form.cmd) || '') !== key) return;   // o comando mudou enquanto isso
    if (r.ok === true) card = { key, icon: P.cleanIcon(r.icon), exists: true, note: '' };
    else if (r.ok === false) card = { key, icon: null, exists: false, note: typeof r.error === 'string' ? P.describeBridgeError(r, '') : '' };
    else card = { key, icon: null, exists: null, note: '' };   // a ponte não soube responder (versão antiga): sem alarme
    paintCard();
  }
  /** Depois de editar o comando à mão, a pasta de trabalho acompanha o programa, a não ser que a pessoa tenha escolhido outra. */
  function followProgramDir() {
    const exe = P.exeOfCommand(form.cmd);
    if (!exe || exe.includes('$(') || exe.includes('%')) return;
    const wd = M.cleanText(form['working-dir']);
    if (wd && P.pathKey(P.unescapeDollar(wd)) !== autoDirKey) return;
    const dir = P.dirOf(exe);
    if (!dir) return;
    autoDirKey = P.pathKey(dir);
    setInput('working-dir', P.escapeDollar(dir));
    syncVisibility();
    revalidate();
  }

  function programCard() {
    const iconBox = h('div', { class: 'gm-prog-icon', 'aria-hidden': 'true' });
    const title = h('strong', { class: 'gm-prog-title' });
    const pathEl = h('div', { class: 'gm-prog-path mono' });
    const hint = h('div', { class: 'f-help gm-prog-hint' });
    const swap = h('button', { class: 'btn', type: 'button', on: { click: () => changeProgram() } });
    const warn = h('div', { class: 'banner warn gm-prog-warn', role: 'status' });
    const dup = h('div', { class: 'banner gm-prog-dup', role: 'status' });
    const store = h('div', { class: 'banner gm-prog-store', role: 'status' });
    const root = h('div', { class: 'gm-prog-wrap' },
      h('div', { class: 'gm-prog', role: 'group', 'aria-label': 'Programa que será aberto' }, iconBox, h('div', { class: 'gm-prog-text' }, title, pathEl, hint), swap, warn),
      dup, store);
    paintCard = () => {
      const parsed = P.parseCommand(form.cmd);
      const detached = (Array.isArray(form.detached) ? form.detached : []).filter((c) => M.cleanText(c));
      let ic = 'apps';
      let heading;
      let path = '';
      let note = '';
      let canSwap = true;
      let swapLabel = 'Trocar';
      let problem = '';
      if (parsed.kind === 'path') {
        heading = P.fileNameOf(parsed.exe) || parsed.exe;
        path = parsed.exe;
        if (P.extOf(parsed.exe) !== 'exe') ic = 'terminal';
        if (card.exists === false) problem = card.note ? `${card.note} Clique em Trocar para escolher o programa de novo.` : 'Não encontrei este arquivo no computador. Se o programa foi movido ou desinstalado, clique em Trocar para escolher de novo.';
      } else if (parsed.kind === 'url') {
        heading = 'Abre por um link'; path = parsed.exe; ic = 'link';
      } else if (parsed.kind === 'command') {
        heading = 'Comando personalizado'; path = M.cleanText(form.cmd); ic = 'terminal';
      } else if (detached.length) {
        const src = M.guessSource({ detached });
        heading = src ? `Abre pela ${M.SOURCE_LABELS[src]}` : 'Abre por um comando avançado';
        ic = src ? 'sports_esports' : 'tune'; canSwap = false;
        // jogo de loja: o comando (steam://…, --launch-steam…) não diz nada a quem não é técnico e fica nas Opções avançadas
        if (src) note = `Este jogo abre pela ${M.SOURCE_LABELS[src]}. Para mudar como ele abre, use as Opções avançadas.`;
        else { path = detached[0]; note = 'Para mudar como ele abre, use as Opções avançadas.'; }
      } else {
        heading = 'Nenhum programa escolhido'; ic = 'help'; swapLabel = 'Escolher';
        note = 'Sem programa, o R3D PLAY só mostra a área de trabalho do PC. Clique em Escolher para indicar o jogo.';
      }
      const img = card.icon && parsed.kind === 'path' && card.key === P.pathKey(parsed.exe) ? h('img', { src: `data:image/png;base64,${card.icon}`, alt: '', width: 40, height: 40, draggable: 'false' }) : icon(ic);
      iconBox.replaceChildren(img);
      title.textContent = heading;
      pathEl.textContent = !path ? '' : parsed.kind === 'path' ? P.ellipsizePath(path, 78) : P.ellipsizeText(path, 90);
      pathEl.title = path;
      pathEl.hidden = !path;
      hint.textContent = note;
      hint.hidden = !note;
      swap.hidden = !canSwap;
      swap.replaceChildren(icon('swap_horiz'), swapLabel);
      swap.setAttribute('aria-label', swapLabel === 'Trocar' ? 'Trocar o programa' : 'Escolher o programa');
      warn.hidden = !problem;
      warn.replaceChildren(...(problem ? [icon('warning'), h('div', { text: problem })] : []));
      // (mesmo .exe com outros argumentos é outro programa: "Sticky Notes" e "OneNote" usam o mesmo ONENOTE.EXE)
      const other = parsed.kind === 'path' ? P.findAppUsingExe(state.apps, parsed.exe, isNew ? '' : original.uuid, parsed.args) : '';
      dup.hidden = !other;
      dup.replaceChildren(...(other ? [icon('info'), h('div', { text: isNew ? `Este programa já está na lista como "${other}". Adicionar de novo cria um segundo item.` : `Outro aplicativo da lista ("${other}") já abre este mesmo programa.` })] : []));
      // jogo de loja escolhido pelo .exe: aberto direto, ele tende a falhar sem a loja aberta; "Detectar jogos" o liga pela loja
      const shop = isNew && !other && parsed.kind === 'path' ? P.storeOfPath(parsed.exe) : '';
      store.hidden = !shop;
      store.replaceChildren(...(shop ? [icon('info'), h('div', { text: `Este jogo parece ser da ${M.SOURCE_LABELS[shop]}. Para ele abrir pela loja, do jeito certo, feche esta janela e use "Detectar jogos". Se mesmo assim quiser abrir direto pelo arquivo, é só continuar.` })] : []));
    };
    paintCard();
    return root;
  }

  /** "Trocar": abre a escolha de programa por cima desta janela e aplica o programa escolhido. */
  async function changeProgram() {
    const pick = await chooseProgram({ apps: state.apps, change: true });
    if (closed || !pick?.program) return;
    applyProgram(pick.program);
    controls.get('name')?.focus();
  }
  function applyProgram(p) {
    const fields = P.programFields(p);
    card = { key: P.pathKey(p.exe), icon: p.icon || null, exists: true, note: '' };
    setInput('cmd', fields.cmd);
    setInput('working-dir', fields['working-dir'] ?? '');
    autoDirKey = P.pathKey(P.dirOf(p.exe));
    if (isNew) {   // política dos programas escolhidos (a edição de um app existente não mexe nelas)
      for (const [k, v] of Object.entries(P.PROGRAM_POLICY)) setInput(k, v);
      base = P.policyBaseline(schema);
    }
    const before = M.cleanText(form.name);
    const autoName = isNew ? !nameEdited : !before;
    if (autoName && p.name) { setInput('name', p.name); nameEdited = false; }
    paintCard();
    syncVisibility();
    revalidate();
    refreshCover();
    if (isNew && M.cleanText(form.name) !== before) maybeAutoCover();   // o nome mudou: a capa antiga (se foi achada sozinha) já não serve
  }
  /** Procura a capa sozinha: uma vez ao abrir (app novo; app existente só se não tem capa nem foi tirada de propósito). */
  function maybeAutoCover() {
    if (closed || !M.cleanText(form.name)) return;
    if (pendingCover && !pendingCover.auto) return;           // a pessoa já escolheu uma imagem
    if (pendingCover) { pendingCover = null; refreshCover(); }   // a capa achada antes era de outro nome: some até a nova busca terminar
    if (!isNew) {
      if (form['image-path'] || L.getOptOut(original.uuid).includes('cover') || autoCoverTried.has(original.uuid)) return;
      autoCoverTried.add(original.uuid);
    }
    searchCover({ auto: true });
  }

  /* ----- variáveis de ambiente (ajuda dos comandos) ----- */
  function varsBlock() {
    const vars = (schema.variables || []).filter((v) => v.scope === 'apollo');
    const ex = (schema.variables_ui?.examples || []).find((e) => e.platform === platform);
    return h('details', { class: 'gm-vars' },
      h('summary', {}, icon('help'), 'Variáveis que os comandos podem usar'),
      h('div', { class: 'gm-vars-body' },
        h('p', { class: 'f-help', text: 'Todos os comandos deste aplicativo recebem estas informações, que podem ser lidas pelo programa:' }),
        h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', { text: schema.variables_ui?.table_header || 'Variável' }), h('th', { text: 'O que é' }))),
          h('tbody', {}, vars.map((v) => h('tr', {}, h('td', { class: 'mono nowrap', text: v.name }), h('td', { text: v.desc }))))),
        ex ? h('div', {}, h('p', { class: 'f-help', text: ex.title }), h('code', { class: 'gm-code', text: ex.code })) : null,
        // texto em linguagem comum; a explicação técnica completa (parse_env_val etc.) fica no schema, para quem mantém o painel
        h('div', { class: 'banner warn' }, icon('warning'), h('div', {},
          h('strong', { text: 'Cuidado com o símbolo $. ' }),
          'Nos comandos, o texto $(NOME) é trocado pelo valor de uma variável do Windows antes de o jogo abrir, e um "$(" sem o ")" faz a lista de jogos parar de carregar. '
          + 'Para escrever um cifrão comum, digite "$$". As variáveis da tabela acima não funcionam com $(...): use %NOME% no comando, ou $env:NOME no PowerShell.'))));
  }

  /* ----- montagem ----- */
  const builders = {
    text: textField, select: selectField, toggle: toggleField, number: numberField, detached: listField, prepcmds: listField,
  };
  function build(f) {
    if (f.key === 'uuid') return uuidField(f);
    return (builders[f.type] || textField)(f);
  }
  const show = (f) => !!f && (f.key === 'uuid' || !f.hidden) && (!Array.isArray(f.platform) || f.platform.includes(platform));

  const body = h('form', { class: 'gm-form', novalidate: true, on: { submit: (e) => e.preventDefault() } });
  if (state.currentApp) {
    const live = state.apps.find((a) => a.uuid === state.currentApp);
    body.append(h('div', { class: 'banner warn' }, icon('warning'), `Há uma transmissão em andamento${live ? ` (${live.name})` : ''}. Salvar encerra a transmissão.`));
  }

  // Parte simples: o programa, o nome e a capa
  const nameEl = build(fmap.get('name'));
  const cover = imageField(fmap.get('image-path'));
  body.append(h('div', { class: 'gm-ident' },
    h('section', { class: 'gm-sec gm-cover-sec', 'aria-label': 'Capa' }, h('h3', { text: 'Capa' }), cover.widget),
    h('div', { class: 'gm-ident-fields' },
      h('section', { class: 'gm-sec', 'aria-label': 'Programa' }, h('h3', { text: 'Programa' }), programCard()),
      h('section', { class: 'gm-sec', 'aria-label': 'Nome' }, h('h3', { text: 'Nome' }), nameEl))));

  // Opções avançadas: todos os outros campos do schema, nas seções dele
  const advBody = h('div', { class: 'fold-body gm-adv-body' },
    h('p', { class: 'f-help gm-adv-intro', text: 'Para quem quer controlar cada detalhe. Se o programa abre normalmente na transmissão, não é preciso mexer aqui.' }));
  for (const sec of schema.sections) {
    const fs = sec.fields.map((k) => fmap.get(k)).filter(show).filter((f) => f.key !== 'name');
    if (!fs.length) continue;
    const items = fs.map((f) => (f.key === 'image-path' ? cover.root : build(f)));
    advBody.append(h('section', { class: 'gm-sec gm-adv-sec', 'aria-label': `${sec.title} (avançado)` }, h('h4', { class: 'gm-sub', text: sec.title }), items, sec.id === 'comandos' ? varsBlock() : null));
  }
  advBadge = h('span', { class: 'badge', hidden: true });
  advEl = h('details', { class: 'fold gm-adv' }, h('summary', {}, icon('tune'), 'Opções avançadas', advBadge), advBody);
  if (manual) advEl.open = true;   // "Preencher tudo manualmente": o formulário completo já aberto
  body.append(advEl);

  // Enter dentro de um campo de texto salva (os botões ficam fora do <form>, na barra da janela)
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox]):not([type=range]):not([type=file])')) { e.preventDefault(); save(dlgRef.querySelector('[data-save]')); }
  });
  body.addEventListener('focusout', (e) => {
    const key = e.target.closest?.('[data-key]')?.dataset.key;
    if (key && !touched.has(key)) { touched.add(key); revalidate(); }
  });
  syncVisibility();
  revalidate();

  /* ----- virtual-display: avisa quando o driver não funciona ----- */
  const vdStatus = state.meta.vdisplayStatus === undefined || state.meta.vdisplayStatus === null || state.meta.vdisplayStatus === '' ? null : Number(state.meta.vdisplayStatus);
  if (vdStatus !== null && vdStatus !== 0 && VDISPLAY_PROBLEMS[String(vdStatus)]) {
    const c = controls.get('virtual-display');
    if (c) c.root.querySelector('.f-text')?.append(h('div', { class: 'banner warn' }, icon('warning'), `${VDISPLAY_PROBLEMS[String(vdStatus)]} Esta opção pode não funcionar.`));
  }

  /* ----- salvar ----- */
  function fail(msg, { validation = false } = {}) {
    errP.textContent = msg;
    errP.hidden = false;
    showingValidation = validation;
  }
  function finish(res) {
    result = res;
    forceClose = true;
    dlgRef.querySelector('[data-done]').click();
  }
  async function save(btn) {
    if (!btn || btn.disabled) return;
    attempted = true;
    errP.hidden = true;
    showingValidation = false;
    const v = revalidate();
    const bad = [...controls.keys()].find((k) => v.errors[k]);
    if (bad) {
      fail(`Corrija o que está em vermelho: ${v.errors[bad]}`, { validation: true });
      // se algum erro está escondido nas Opções avançadas, abre o bloco (senão a pessoa não vê o que corrigir)
      if ([...controls].some(([k, c]) => v.errors[k] && advEl.contains(c.root))) advEl.open = true;
      controls.get(bad).focus();
      return;
    }
    if (!isNew && !hasChanges()) { finish({ saved: false, unchanged: true }); return; }
    if (state.currentApp) {
      const nome = state.apps.find((a) => a.uuid === state.currentApp)?.name || 'um aplicativo';
      if (!(await confirmDlg(`Salvar encerra a transmissão em andamento (${nome}). Continuar?`, 'Salvar e encerrar', { title: 'Transmissão em andamento' }))) return;
    }
    cancelCoverSearch();   // não espera a busca da capa terminar: salva o que já tem
    saving = true;
    lockClose(true);
    try {
      await busy(btn, async () => {
        const edited = M.normalizeApp(form, schema);
        if (isNew) await saveNew(edited); else await saveExisting(edited);
      });
    } finally {
      saving = false;
      lockClose(false);
      // o botão se desligou enquanto gravava e levou o foco com ele; se a janela segue aberta (a gravação falhou), o foco volta ao botão
      if (!forceClose && !closed && (!document.activeElement || document.activeElement === document.body)) btn.focus();
    }
  }
  async function saveExisting(edited) {
    let finalEdited = edited;
    if (pendingCover) {
      const up = await L.uploadCover(original.uuid, pendingCover.b64);
      if (!up.ok) return fail(up.error);
      finalEdited = { ...edited, 'image-path': up.path };
    }
    // Sempre grava (mesmo sem campo alterado) quando há capa nova: o servidor só recalcula a imagem ao reler o apps.json.
    const res = await L.mutateApp(original.uuid, (fresh) => M.mergeEdit(fresh, original, finalEdited, schema));
    if (!res.ok) return fail(res.gone ? 'Este aplicativo não existe mais (foi removido enquanto você editava). Feche esta janela e atualize a lista.' : res.error);
    if (pendingCover) L.invalidateCover(finalEdited['image-path']);
    L.setOptOut(original.uuid, L.optOutAfterEdit(L.getOptOut(original.uuid), original, finalEdited, L.getDetected(original.uuid)));
    await loadApps();
    toast('Aplicativo salvo. No celular, reabra o R3D LAUNCHER para ver a mudança.', 'ok');
    finish({ saved: true, uuid: original.uuid });
  }
  async function saveNew(edited) {
    const before = await L.fetchApps();
    if (!before) return fail('Não consegui falar com o R3D PLAY. Confira se ele está ligado.');
    const known = new Set((before.apps || []).map((a) => a.uuid));
    const res = await L.postApp(M.toPayload(edited, schema));
    if (!res.ok) return fail(res.error);
    // o servidor não devolve o uuid criado: acha o app novo comparando as listas
    const after = await L.fetchApps();
    const created = (after?.apps || []).filter((a) => !known.has(a.uuid));
    const mine = created.find((a) => a.name === edited.name) || created.at(-1) || null;
    let note = '';
    if (pendingCover) {
      if (!mine) note = ' Não consegui enviar a capa: abra o aplicativo e escolha a imagem de novo.';
      else {
        const up = await L.uploadCover(mine.uuid, pendingCover.b64);
        const w = up.ok ? await L.mutateApp(mine.uuid, (cur) => ({ ...cur, 'image-path': up.path })) : up;
        if (!w.ok) note = ` A capa não foi enviada (${(up.error || w.error || '').replace(/^[^:]*: /, '')}). Edite o aplicativo para tentar de novo.`;
      }
    }
    await loadApps();
    toast(`"${edited.name}" foi adicionado ao fim da lista. No celular, reabra o R3D LAUNCHER para vê-lo.${note}`, note ? '' : 'ok');
    finish({ saved: true, uuid: mine?.uuid });
  }

  /* ----- janela ----- */
  const promise = modal({
    title: isNew ? 'Adicionar aplicativo' : 'Editar aplicativo',
    wide: true,
    body,
    actions: [{ label: 'Cancelar', value: null }, { label: 'ok', value: 'done' }],
    onOpen: (dlg) => {
      dlgRef = dlg;
      dlg.classList.add('gm-editor');
      errP = dlg.querySelector('p.error');
      const row = dlg.querySelector('.row-actions');
      const [cancelBtn, doneBtn] = row.querySelectorAll('button');
      doneBtn.hidden = true;
      doneBtn.dataset.done = '';
      const saveBtn = h('button', { class: 'btn primary gm-save', type: 'button', dataset: { save: '' }, on: { click: () => save(saveBtn) } }, icon(isNew ? 'add' : 'save'), isNew ? 'Adicionar' : 'Salvar');
      row.append(saveBtn);

      // Descartar alterações sem querer (Esc, X, Cancelar) pede confirmação
      let asking = false;   // a pergunta já está na tela (Esc + cancel não podem abrir duas)
      const askDiscard = async (after) => {
        if (asking) return;
        asking = true;
        try {
          if (await confirmDlg('Você alterou este aplicativo e ainda não salvou. Descartar as alterações?', 'Descartar', { title: 'Alterações não salvas', no: 'Continuar editando' })) { forceClose = true; after(); }
        } finally { asking = false; }
      };
      const closeX = dlg.querySelector('.modal-head .icon-btn');
      // Gravando: fechar agora não cancelaria nada (o pedido já saiu) e a pessoa acharia que descartou. Esperamos terminar.
      lockClose = (on) => { cancelBtn.disabled = on; closeX.disabled = on; };
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest?.('button');
        if (forceClose || !b || (b !== closeX && b !== cancelBtn)) return;
        if (saving) { e.stopImmediatePropagation(); e.preventDefault(); return; }
        if (!isDirty()) return;
        e.stopImmediatePropagation(); e.preventDefault();
        askDiscard(() => b.click());
      }, true);
      dlg.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || forceClose) return;
        if (saving) { e.preventDefault(); e.stopPropagation(); return; }
        if (!isDirty()) return;
        e.preventDefault(); e.stopPropagation();
        askDiscard(() => cancelBtn.click());
      }, true);
      // O Esc também chega como "cancel" da janela, e é o único caminho quando o foco está no <body> (depois de um botão se desligar sozinho,
      // por exemplo uma gravação que falhou): sem isto o Esc fechava a janela sem perguntar e a pessoa perdia o que digitou.
      // O navegador nem sempre respeita o preventDefault desse evento: se ele fechar a janela mesmo assim, ela é reaberta (o que foi digitado
      // continua nos campos) e a pergunta aparece. Sem esta rede, a janela sumia e a tela ficava esperando para sempre.
      const guardClose = () => setTimeout(() => {
        if (!dlg.isConnected || forceClose) return;           // fechada do jeito normal (o modal() já a removeu)
        if (!dlg.open) {
          if (!saving && !isDirty()) { cancelBtn.click(); return; }   // nada a perder: termina o fechamento (devolve o resultado, remove a janela)
          dlg.showModal();
          controls.get('name')?.focus();
        }
        if (!saving) askDiscard(() => cancelBtn.click());
      }, 0);
      dlg.addEventListener('cancel', (e) => {
        if (forceClose) return;
        if (!saving && !isDirty()) return;
        e.preventDefault(); e.stopImmediatePropagation();
        guardClose();
      }, true);
      dlg.addEventListener('close', guardClose);
      // um arquivo solto aqui nunca pode navegar a página (só a tela Jogos e o passo 1 usam arquivos soltos)
      dlg.addEventListener('dragover', (e) => { if (P.hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; } });
      dlg.addEventListener('drop', (e) => { if (P.hasFiles(e)) e.preventDefault(); });

      const name = dlg.querySelector('#gm-f-name');
      name?.focus();
      if (isNew && M.cleanText(form.name)) name?.select();
      if (firstExe && !program) runInspect();                  // ícone e "o arquivo existe?" (o programa vindo do passo 1 já foi lido)
      maybeAutoCover();
    },
  });
  return promise.then(() => { closed = true; clearTimeout(inspectTimer); return result; });
}
