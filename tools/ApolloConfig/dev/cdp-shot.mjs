// Ferramenta de teste: dirige a janela REAL (WebView2) pelo protocolo de depuração do Chromium e tira capturas de tela de cada aba.
//
//   $env:R3D_ALLOW_MULTI='1'; $env:R3D_WEBVIEW_DIR="$env:TEMP\r3d-wv2"; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'
//   Start-Process tools\ApolloConfig\publish\ApolloConfig.exe
//   node tools/ApolloConfig/dev/cdp-shot.mjs --port=9333 --out=<pasta> [--tabs=home,games,devices,settings,system] [--width=1280 --height=820] [--eval="js"]
//
// A janela real fala com o servidor real: esta ferramenta só LÊ (clica nas abas e tira capturas); não clica em nenhuma ação.
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const port = Number(arg('port', 9333));
const out = arg('out', '.');
const tabs = arg('tabs', 'home,games,devices,settings,system').split(',').filter(Boolean);
const width = Number(arg('width', 1280));
const height = Number(arg('height', 820));
const evalJs = arg('eval', '');
fs.mkdirSync(out, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /r3dplay\.local/.test(t.url)) || targets.find((t) => t.type === 'page');
if (!page) throw new Error('nenhuma página encontrada: ' + JSON.stringify(targets.map((t) => t.url)));
console.log('página:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let seq = 0;
const waiting = new Map();
const problems = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') problems.push('EXCEÇÃO: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) problems.push(`log.${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url || ''}`);
};
const send = (method, params = {}) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'erro no eval');
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
console.log('ponte nativa:', await evaluate('typeof window.chrome?.webview?.postMessage'));
console.log('popover suportado:', await evaluate('typeof HTMLElement.prototype.showPopover'));

for (const t of tabs) {
  await evaluate(`document.querySelector('[data-tab="${t}"]')?.click(); 1`);
  await sleep(2500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, `${t}.png`);
  fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  console.log('captura:', file, '| título:', await evaluate('document.querySelector("#pageTitle")?.textContent'));
}
if (evalJs) console.log('eval =>', JSON.stringify(await evaluate(evalJs)));
await send('Emulation.clearDeviceMetricsOverride');
console.log(problems.length ? 'PROBLEMAS:\n' + [...new Set(problems)].join('\n') : 'sem erros no console');
ws.close();
