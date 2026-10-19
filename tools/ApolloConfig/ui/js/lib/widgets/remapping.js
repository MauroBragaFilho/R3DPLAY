// Remapeamento de modos de tela (dd_mode_remapping): três listas no arquivo (mixed, resolution_only, refresh_rate_only),
// mas só UMA é editada de cada vez, conforme "Resolução" e "Taxa de atualização" estejam em automático ou não.
// As outras listas continuam intactas. Regras e textos vêm do widgetConfig do schema.
import { h, icon } from '../../core.js';
import { registerWidget } from './registry.js';
import { activeRemapList, brandSafe } from '../schema.js';
import { ensureRemap, remapFields } from '../serialize.js';

const LIST_NAMES = {
  mixed: 'Resolução e taxa de atualização pedidas pelo celular',
  resolution_only: 'Só a resolução pedida pelo celular',
  refresh_rate_only: 'Só a taxa de atualização pedida pelo celular',
};

function factory(ctx) {
  const wc = ctx.opt.widgetConfig || {};
  const labels = wc.columnLabels || {};
  const holders = wc.placeholders || {};
  const el = h('div', { class: 'st-remap' });
  const info = h('div', { class: 'st-remap-info' });
  const list = h('div', { class: 'st-cmd-list', role: 'list' });
  const addBtn = h('button', { class: 'btn st-cmd-add', type: 'button', on: { click: () => add() } }, icon('add'), wc.addButtonLabel || 'Adicionar entrada de remapeamento');
  const inactive = h('p', { class: 'banner', hidden: true }, icon('info'),
    'Este editor só vale quando a configuração de tela está ativada e “Resolução” ou “Taxa de atualização” usa o valor pedido pelo celular. Se as duas estiverem em “Não alterar” ou digitadas manualmente, não há o que remapear.');
  el.append(inactive, info, list, h('div', { class: 'row-actions st-cmd-actions' }, addBtn));

  let current = null;     // nome da lista ativa renderizada
  let value = ctx.value();
  let cells = [];

  const active = () => activeRemapList(ctx.get);

  // As frases gerais (helpLines.always) já aparecem na ajuda do próprio campo (settings.js); aqui só entram as que dependem da lista em edição.
  function helpText(listName) {
    const lines = [];
    const fin = wc.helpLines?.finalValues;
    if (fin) lines.push(listName === 'mixed' ? fin.mixed : fin.non_mixed);
    const sops = wc.helpLines?.sops?.[listName];
    if (sops) lines.push(sops);
    return lines.filter(Boolean).map(brandSafe);
  }

  function buildRow(item, i, listName) {
    const ref = {};
    const fields = h('div', { class: 'st-cmd-fields st-remap-fields' });
    for (const f of remapFields(listName)) {
      const input = h('input', {
        type: 'text', class: 'mono', value: item[f] ?? '', placeholder: holders[f] || '', spellcheck: 'false', autocomplete: 'off',
        'aria-label': `${labels[f] || f}, linha ${i + 1}`,
        on: { input: () => { value[listName][i][f] = input.value; ctx.set(value); }, blur: () => ctx.touch() },
      });
      const err = h('span', { class: 'f-error', role: 'alert', hidden: true });
      ref[f] = { input, err, cell: h('label', { class: 'st-cmd-cell' }, h('span', { class: 'st-cmd-colname', text: labels[f] || f }), input, err) };
      fields.append(ref[f].cell);
    }
    cells[i] = ref;
    return h('div', { class: 'st-cmd-row', role: 'listitem' }, fields,
      h('div', { class: 'st-cmd-rowbtns' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Remover esta linha', 'aria-label': `Remover a linha ${i + 1}`, on: { click: () => remove(i) } }, icon('delete'))));
  }

  function render(focusLast = false) {
    const name = active();
    current = name;
    cells = [];
    inactive.hidden = name !== null;
    list.hidden = addBtn.parentElement.hidden = info.hidden = name === null;
    if (name === null) { list.replaceChildren(); info.replaceChildren(); return; }
    value = ctx.value();
    const items = ensureRemap(value)[name];
    if (!Array.isArray(value[name])) value[name] = items;
    info.replaceChildren(
      h('p', { class: 'f-hint', text: `Lista em edição: ${LIST_NAMES[name]}.` }),
      h('p', { class: 'f-help', text: helpText(name).join('\n') }),
    );
    list.replaceChildren(...value[name].map((it, i) => buildRow(it, i, name)));
    list.hidden = value[name].length === 0;
    if (focusLast) cells[value[name].length - 1]?.[remapFields(name)[0]]?.input.focus();
  }

  function add() {
    const name = active();
    if (!name) return;
    value = ctx.value();
    value[name] = Array.isArray(value[name]) ? value[name] : [];
    value[name].push(Object.fromEntries(remapFields(name).map((f) => [f, ''])));
    ctx.set(value); ctx.touch();
    render(true);
  }
  function remove(i) {
    const name = active();
    value[name].splice(i, 1);
    ctx.set(value); ctx.touch();
    render();
    addBtn.focus();
  }

  function refresh({ rows = [] } = {}) {
    if (active() !== current || ctx.value() !== value) render();
    const byCell = new Map(rows.map((r) => [`${r.i}:${r.field}`, r.message]));
    cells.forEach((ref, i) => {
      for (const [field, c] of Object.entries(ref)) {
        const msg = byCell.get(`${i}:${field}`);
        c.cell.classList.toggle('invalid', !!msg);
        c.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
        c.err.textContent = msg || '';
        c.err.hidden = !msg;
      }
    });
  }

  render();
  return { el, refresh };
}

registerWidget('display_mode_remapping', factory);
