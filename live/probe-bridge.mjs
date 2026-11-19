// One-shot probe: send a single `evaluate` through the bridge and print the
// entire response envelope, including any error fields, with a short budget.
import { openTransport } from '../cli/loop.mjs';

const transport = await openTransport({});
const tabs = await transport.listTabs();
const tab = tabs.find((t) => /^https?:/.test(t.url ?? ''));
if (!tab) {
  console.log('no http tab');
  process.exit(1);
}
console.log('tab', tab.id, tab.url);

const started = Date.now();
try {
  const value = await transport.evaluate(tab.id, 'document.title');
  console.log('ok', JSON.stringify(value), 'in', Date.now() - started, 'ms');
} catch (error) {
  console.log('failed in', Date.now() - started, 'ms');
  console.log('name:', error.name);
  console.log('message:', error.message);
  console.log('code:', error.code ?? '(none)');
  console.log('payload:', JSON.stringify(error.payload ?? null));
  console.log('stack head:', String(error.stack ?? '').split('\n').slice(0, 3).join(' | '));
}
