// Local development preview only. It is not imported by the product runtime.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const files = new Map([
  ['/', ['preview.html', 'text/html']], ['/workspace.css', ['workspace.css', 'text/css']],
  ...['cases', 'workspace', 'ui', 'mock', 'activity'].map(name => [`/${name}.js`, [`${name}.ts`, 'text/javascript']]),
]);
const server = createServer(async (request, response) => {
  const item = files.get(request.url?.split('?')[0]);
  if (!item || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404); response.end(); return; }
  try {
    let content = await readFile(new URL(item[0], import.meta.url), 'utf8');
    if (item[0].endsWith('.ts')) content = stripTypeScriptTypes(content).replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2');
    response.writeHead(200, { 'Content-Type': `${item[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(500); response.end('Preview source could not be loaded.'); }
});
server.listen(4174, '127.0.0.1', () => { console.log('Offline workspace preview: http://127.0.0.1:4174'); });
process.on('SIGINT', () => { server.close(); });
process.on('SIGTERM', () => { server.close(); });
