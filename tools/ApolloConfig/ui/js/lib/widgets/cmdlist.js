// Lista de comandos editável: global_prep_cmd e global_state_cmd (widget "cmd_do_undo_list": Executar/Desfazer)
// e server_cmd (widget "server_cmd_list": Nome/Comando). As colunas vêm do widgetConfig do schema.
// Cada linha é um mini-formulário (em vez de tabela) para continuar legível em janela estreita.
import { h, icon } from '../../core.js';
import { registerWidget } from './registry.js';
import { listColumns, newListItem } from '../serialize.js';

/** Rótulos mais claros para quem não é técnico (o schema usa "Elevado"). */
const FRIENDLY = { elevated: 'Executar como administrador' };

function factory(ctx) {
  const { opt, platform } = ctx;
  const cols = listColumns(opt, platform);
  const textCols = cols.filter((c) => c.input === 'text');
  const checkCols = cols.filter((c) => c.input === 'checkbox');
  const addLabel = opt.widgetConfig?.addButtonLabel || 'Adicionar';
  const el = h('div', { class: 'st-cmd' });
  const list = h('div', { class: 'st-cmd-list', role: 'list' });
  const empty = h('p', { class: 'f-hint st-cmd-empty', text: 'Nenhum comando cadastrado.' });
  const addBtn = h('button', { class: 'btn st-cmd-add', type: 'button', on: { click: () => add(-1) } }, icon('add'), addLabel);
  el.append(list, empty, h('div', { class: 'row-actions st-cmd-actions' }, addBtn));

  let items = ctx.value();
  let cells = [];                                   // por linha: { field: { input|check, cell, err } }

  const commit = () => ctx.set(items);

  function rowLabel(c, i) { return `${c.label}, linha ${i + 1}`; }

  function buildRow(item, i) {
    const ref = {};
    const fields = h('div', { class: 'st-cmd-fields' });
    for (const c of textCols) {
      const input = h('input', {
        type: 'text', class: c.monospace ? 'mono' : '', value: item[c.field] ?? '', spellcheck: 'false', autocomplete: 'off',
        'aria-label': rowLabel(c, i), placeholder: c.field === 'cmd' ? 'ex.: calc.exe' : '',
        on: {
          input: () => { items[i][c.field] = input.value; commit(); },
          blur: () => ctx.touch(),
        },
      });
      const err = h('span', { class: 'f-error', role: 'alert', hidden: true });
      const cell = h('label', { class: 'st-cmd-cell' }, h('span', { class: 'st-cmd-colname' }, c.icon ? icon(iconName(c.icon)) : null, c.label), input, err);
      ref[c.field] = { input, cell, err };
      fields.append(cell);
    }
    for (const c of checkCols) {
      const check = h('input', {
        type: 'checkbox', checked: !!item[c.field], 'aria-label': rowLabel({ label: FRIENDLY[c.field] || c.label }, i),
        on: { change: () => { items[i][c.field] = check.checked; commit(); } },
      });
      const cell = h('label', { class: 'check st-cmd-check' }, check, FRIENDLY[c.field] || c.label);
      ref[c.field] = { input: check, cell, err: null };
      fields.append(cell);
    }
    const actions = h('div', { class: 'st-cmd-rowbtns' },
      h('button', { class: 'icon-btn', type: 'button', title: 'Inserir uma linha acima', 'aria-label': `Inserir uma linha acima da linha ${i + 1}`, on: { click: () => add(i) } }, icon('add')),
      h('button', { class: 'icon-btn', type: 'button', title: 'Remover esta linha', 'aria-label': `Remover a linha ${i + 1}`, on: { click: () => remove(i) } }, icon('delete')));
    cells[i] = ref;
    return h('div', { class: 'st-cmd-row', role: 'listitem' }, fields, actions);
  }

  function render(focusRow = -1) {
    cells = [];
    list.replaceChildren(...items.map(buildRow));
    list.hidden = items.length === 0;
    empty.hidden = items.length > 0;
    if (focusRow >= 0) cells[focusRow]?.[textCols[0]?.field]?.input.focus();
  }

  function add(at) {
    const item = newListItem(opt, platform);
    if (at < 0) { items.push(item); at = items.length - 1; } else items.splice(at, 0, item);
    commit(); ctx.touch();
    render(at);
  }
  function remove(i) {
    items.splice(i, 1);
    commit(); ctx.touch();
    render();
    addBtn.focus();
  }
  function iconName(n) {   // nomes do schema -> nomes do Material Symbols
    return ({ play: 'play_arrow', undo: 'undo', shield: 'shield', trash: 'delete', plus: 'add', tag: 'label', terminal: 'terminal' })[n] || n;
  }

  function refresh({ rows = [] } = {}) {
    // O modelo pode ter trocado o array (descartar/restaurar): recria a lista.
    const current = ctx.value();
    if (current !== items) { items = current; render(); }
    const byCell = new Map(rows.map((r) => [`${r.i}:${r.field}`, r.message]));
    cells.forEach((ref, i) => {
      for (const [field, c] of Object.entries(ref)) {
        const msg = byCell.get(`${i}:${field}`);
        c.cell.classList.toggle('invalid', !!msg);
        c.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
        if (c.err) { c.err.textContent = msg || ''; c.err.hidden = !msg; }
      }
    });
  }

  render();
  return { el, refresh };
}

registerWidget('cmd_do_undo_list', factory);
registerWidget('server_cmd_list', factory);
