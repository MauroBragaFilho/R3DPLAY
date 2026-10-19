// Registro de widgets: todo `widget` citado nos schemas precisa existir (senão a opção apareceria sem editor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog } from './settings.fixtures.test.mjs';
import { getWidget, registerWidget, widgetNames } from '../../ui/js/lib/widgets/index.js';

test('todos os widgets dos schemas estão registrados', () => {
  const used = [...new Set(catalog.options.filter((o) => o.kind === 'json').map((o) => o.widget))].sort();
  assert.deepEqual(used, ['cmd_do_undo_list', 'display_mode_remapping', 'server_cmd_list']);
  for (const name of used) assert.equal(typeof getWidget(name), 'function', name);
  assert.ok(widgetNames().length >= used.length);
});

test('registro: widget desconhecido devolve null e factory inválida é recusada', () => {
  assert.equal(getWidget('nao_existe'), null);
  assert.throws(() => registerWidget('x', 'não é função'), /factory inválida/);
  registerWidget('teste_unico', () => ({ el: null, refresh() {} }));
  assert.equal(typeof getWidget('teste_unico'), 'function');
});

test('cada opção "custom" aponta para um widget e traz as colunas/regras de que ele precisa', () => {
  for (const o of catalog.options.filter((x) => x.kind === 'json')) {
    assert.ok(getWidget(o.widget), `${o.key}: ${o.widget}`);
    assert.ok(o.widgetConfig, `${o.key}: sem widgetConfig`);
    if (o.widget !== 'display_mode_remapping') {
      assert.ok(o.widgetConfig.columns.length >= 2, `${o.key}: colunas`);
      assert.ok(o.widgetConfig.keepItemWhen, `${o.key}: regra de itens vazios`);
    } else {
      assert.deepEqual(Object.keys(o.widgetConfig.columnLabels).sort(), ['final_refresh_rate', 'final_resolution', 'requested_fps', 'requested_resolution']);
    }
  }
});
