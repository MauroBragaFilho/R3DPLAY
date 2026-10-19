// Editor de aplicativo (janela larga): TODOS os campos de ui/schema/apps.json, nas seções do schema, com o que é avançado
// dentro de um bloco recolhível "Avançado". O formulário só guarda estado; toda regra (normalização, validação, diff) vem do appmodel.js.
//
// Salvar = POST /api/apps com o objeto COMPLETO do app (as chaves desconhecidas do app existente são preservadas) e depois reler a lista.
// App novo vai sem uuid; como o servidor não devolve o uuid criado, relemos a lista para achá-lo (necessário para enviar a capa).
import { h, icon, state, modal, confirmDlg, busy, toast, native, log, loadApps } from '../core.js';
import * as M from './appmodel.js';
import * as L from './library.js';

const MAX_COVER_BYTES = 8 * 1024 * 1024;
/** Textos que trocamos do schema por serem confusos para quem não é técnico ("Moonlight" não aparece na interface). */
const TEXT = {
  name: { help: 'O nome que aparece na lista de jogos do celular.', placeholder: 'Ex.: Meu jogo favorito' },
  gamepad: { label: 'Tipo de controle', help: 'Qual controle o R3D PLAY simula para o jogo.', hint: '"Padrão (global)" usa a configuração geral do R3D PLAY; "Desativado" desliga o controle neste aplicativo.' },
  'terminate-on-pause': { label: 'Fechar o jogo quando o celular desconectar', help: 'Quando todos os celulares saírem da transmissão, o jogo é fechado no PC.' },
  'virtual-display': { label: 'Usar uma tela virtual', help: 'O jogo abre numa tela virtual, sem mexer na tela do seu PC. Exige o driver de tela virtual instalado.' },
  'image-path': { help: 'A capa que aparece na lista de jogos do celular. Aceita PNG, JPG ou WebP (JPG e WebP são convertidos). Sem capa, vale a imagem padrão.' },
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
 * Abre o editor. app = aplicativo existente (do GET /api/apps) ou null para um novo.
 * Devolve { saved: boolean, uuid? }.
 */
export async function openAppEditor({ app = null } = {}) {
  let schema;
  try { schema = await loadSchema(); } catch (e) {
    log(`editor de aplicativo: schema não carregou: ${e}`);
    toast('Não consegui abrir o formulário do aplicativo. Feche e abra o painel de novo.', 'err');
    return { saved: false };
  }
  return runEditor(schema, app);
}

function runEditor(schema, app) {
  const platform = state.meta.platform || 'windows';
  const isNew = !app || !app.uuid;
  const original = isNew ? M.newApp(schema) : M.normalizeApp(app, schema);
  const form = M.deepClone(original);          // estado bruto do formulário (números ainda como texto enquanto digita)
  const fmap = M.fieldMap(schema);
  const controls = new Map();                   // chave -> { root, err, warn, focus }
  const touched = new Set();
  let attempted = false;
  let pendingCover = null;                      // { b64, url }: imagem escolhida, enviada só ao salvar
  let result = { saved: false };
  let forceClose = false;
  let dlgRef = null;
  let errP = null;
  let advEl = null;
  let advBadge = null;
  let saving = false;                           // gravando: enquanto isso a janela não pode ser fechada (a gravação seguiria mesmo assim)
  let refreshCover = () => {};
  let coverMsg = () => {};                      // mensagem da capa DENTRO da janela (um aviso comum ficaria escondido atrás dela)
  let lockClose = () => {};                     // liga/desliga Cancelar e X enquanto grava

  /* ----- estado ----- */
  const isDirty = () => !!pendingCover || M.changedKeys(original, form, schema).length > 0;
  function setVal(key, value) {
    form[key] = value;
    syncVisibility();
    revalidate();
  }
  function syncVisibility() {
    for (const [key, c] of controls) {
      const f = fmap.get(key);
      if (f?.visible_if) c.root.hidden = !M.fieldVisible(f, form, platform);
    }
    if (advBadge) {
      const n = M.advancedCustomCount(form, schema, platform);
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
      on: { input: () => setVal(f.key, input.value) },
    });
    return shell(f, input);
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
    controls.set(f.key, { root, err, warn, focus: () => input.focus() });
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

  /* ----- imagem de capa ----- */
  function imageField(f) {
    const prev = h('div', { class: 'gm-cover-prev', 'aria-hidden': 'true' });
    const status = h('div', { class: 'f-hint gm-cover-status', role: 'status' });
    let note = { text: '', kind: '' };   // aviso avulso da capa (lendo a imagem, não achei capa...), mostrado aqui e não em um toast
    coverMsg = (text, kind = '') => { note = { text, kind }; refreshCover(); };
    const pathIn = h('input', {
      id: fid(f.key), type: 'text', class: 'mono', value: form[f.key], placeholder: 'Nenhuma: usa a imagem padrão', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': describedBy(f),
      on: { input: () => { pendingCover = null; note = { text: '', kind: '' }; setVal(f.key, pathIn.value); refreshCover(); } },
    });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    const pick = h('button', { class: 'btn', type: 'button', on: { click: () => file.click() } }, icon('upload'), 'Escolher imagem');
    const onlineIdle = () => [icon('travel_explore'), 'Buscar capa online'];
    const online = h('button', { class: 'btn ghost', type: 'button', on: { click: () => findOnline(online) } }, onlineIdle());
    const remove = h('button', { class: 'btn ghost', type: 'button', on: { click: () => { pendingCover = null; note = { text: '', kind: '' }; pathIn.value = ''; setVal(f.key, ''); refreshCover(); } } }, icon('hide_image'), 'Remover capa');

    function setPending(p, text = '') {
      pendingCover = p;
      note = { text, kind: '' };
      pathIn.value = form[f.key];
      revalidate();   // o aviso de "precisa ser PNG" do texto antigo deixa de valer
      refreshCover();
    }
    refreshCover = () => {
      prev.replaceChildren();
      pathIn.disabled = !!pendingCover;
      remove.disabled = !pendingCover && !form[f.key];
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
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      coverMsg('Preparando a imagem…');
      try { setPending(await readCoverFile(chosen)); } catch (e) { coverMsg(e.message || 'Não consegui ler essa imagem.', 'err'); }
    });
    async function findOnline(btn) {
      const name = M.cleanText(form.name);
      if (!name) {
        touched.add('name');
        revalidate();   // mostra "Dê um nome ao aplicativo." no campo
        coverMsg('Digite o nome do aplicativo primeiro: a capa é procurada por ele.', 'err');
        controls.get('name')?.focus();
        return;
      }
      await busy(btn, async () => {
        btn.replaceChildren(h('span', { class: 'spinner' }), 'Procurando…');
        coverMsg(`Procurando a capa de "${name}"…`);
        try {
          const det = form.uuid ? L.getDetected(form.uuid) : null;
          let r = null;
          try { r = await native('cover', det ? { source: det.source, gameId: det.id, name: det.name } : { source: 'other', gameId: '', name }); } catch { /* sem internet */ }
          if (r?.data) setPending({ b64: r.data, url: `data:image/png;base64,${r.data}` }, 'Capa encontrada. Ela será enviada quando você salvar.');
          else coverMsg(`Não encontrei uma capa para "${name}". Confira a internet ou escolha uma imagem do seu computador.`);
        } finally { btn.replaceChildren(...onlineIdle()); }
      });
    }
    const widget = h('div', { class: 'gm-cover' }, prev, h('div', { class: 'gm-cover-side' }, h('div', { class: 'gm-cover-btns' }, pick, online, remove), status));
    const root = shell(f, h('div', { class: 'gm-cover-wrap' }, widget, h('div', { class: 'gm-cover-path' }, pathIn), file));
    controls.get(f.key).focus = () => pathIn.focus();
    refreshCover();
    return root;
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
    text: textField, image: imageField, select: selectField, toggle: toggleField, number: numberField, detached: listField, prepcmds: listField,
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
  const advBody = h('div', { class: 'fold-body gm-adv-body' });
  for (const sec of schema.sections) {
    const fs = sec.fields.map((k) => fmap.get(k)).filter(show);
    const basic = fs.filter((f) => !f.advanced);
    const adv = fs.filter((f) => f.advanced);
    if (basic.length) {
      const items = basic.map(build);
      if (sec.id === 'identidade') {
        const cover = items.find((el) => el.dataset.key === 'image-path');
        body.append(h('section', { class: 'gm-sec', 'aria-label': sec.title }, h('h3', { text: sec.title }),
          h('div', { class: 'gm-ident' }, cover, h('div', { class: 'gm-ident-fields' }, items.filter((el) => el !== cover)))));
      } else {
        body.append(h('section', { class: 'gm-sec', 'aria-label': sec.title }, h('h3', { text: sec.title }), items));
      }
    }
    if (adv.length) {
      advBody.append(h('section', { class: 'gm-sec gm-adv-sec', 'aria-label': `${sec.title} (avançado)` }, h('h4', { class: 'gm-sub', text: sec.title }), adv.map(build), sec.id === 'comandos' ? varsBlock() : null));
    }
  }
  advBadge = h('span', { class: 'badge', hidden: true });
  advEl = h('details', { class: 'fold gm-adv' }, h('summary', {}, icon('tune'), 'Avançado', advBadge), advBody);
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
  function fail(msg) {
    errP.textContent = msg;
    errP.hidden = false;
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
    const v = revalidate();
    const bad = [...controls.keys()].find((k) => v.errors[k]);
    if (bad) {
      fail(`Corrija o que está em vermelho: ${v.errors[bad]}`);
      // se algum erro está escondido no bloco Avançado, abre o bloco (senão a pessoa não vê o que corrigir)
      if ([...controls].some(([k, c]) => v.errors[k] && advEl.contains(c.root))) advEl.open = true;
      controls.get(bad).focus();
      return;
    }
    if (!isNew && !isDirty()) { finish({ saved: false, unchanged: true }); return; }
    if (state.currentApp) {
      const nome = state.apps.find((a) => a.uuid === state.currentApp)?.name || 'um aplicativo';
      if (!(await confirmDlg(`Salvar encerra a transmissão em andamento (${nome}). Continuar?`, 'Salvar e encerrar', { title: 'Transmissão em andamento' }))) return;
    }
    saving = true;
    lockClose(true);
    try {
      await busy(btn, async () => {
        const edited = M.normalizeApp(form, schema);
        if (isNew) await saveNew(edited); else await saveExisting(edited);
      });
    } finally { saving = false; lockClose(false); }
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
      errP = dlg.querySelector('p.error');
      const row = dlg.querySelector('.row-actions');
      const [cancelBtn, doneBtn] = row.querySelectorAll('button');
      doneBtn.hidden = true;
      doneBtn.dataset.done = '';
      const saveBtn = h('button', { class: 'btn primary', type: 'button', dataset: { save: '' }, on: { click: () => save(saveBtn) } }, icon('save'), isNew ? 'Adicionar' : 'Salvar');
      row.append(saveBtn);

      // Descartar alterações sem querer (Esc, X, Cancelar) pede confirmação
      const askDiscard = async (after) => {
        if (await confirmDlg('Você alterou este aplicativo e ainda não salvou. Descartar as alterações?', 'Descartar', { title: 'Alterações não salvas', no: 'Continuar editando' })) { forceClose = true; after(); }
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
      dlg.addEventListener('cancel', (e) => { if (saving && !forceClose) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
      controls.get('name')?.focus();
    },
  });
  return promise.then(() => result);
}
