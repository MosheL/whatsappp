// Isolated browser regression check: synthetic data, no WhatsApp connection.
// Run with: node test/client-performance.browser.js
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import WebSocket from 'ws'

const root = path.resolve(import.meta.dirname, '..')
const edge = process.env.BROWSER_BINARY || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-performance-'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const html = `<!doctype html><html dir="rtl"><meta charset="utf-8"><div id="app"></div>
<script>
localStorage.clear(); localStorage.setItem('wa-ui-selected-bot', 'bot1');
window.fixture = { calls: [], errors: [], sockets: [], aborted: 0 };
window.addEventListener('error', e => fixture.errors.push(e.message));
window.addEventListener('unhandledrejection', e => fixture.errors.push(String(e.reason)));
const bots = [{id:'bot1', label:'Client One'}, {id:'bot2', label:'Client Two'}];
const chats = Array.from({length:2000}, (_,i) => ({jid:'97250'+String(i).padStart(7,'0')+'@s.whatsapp.net', name:'Contact '+i,
  timestamp:1700000000000-i*1000, lastMessage:'Preview '+i, unread:0, isGroup:false}));
const originalFetch = window.fetch;
window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.origin);
  if (!url.pathname.startsWith('/api/')) return originalFetch(input, options);
  fixture.calls.push(url.pathname + url.search);
  await new Promise((resolve,reject) => {
    const timer = setTimeout(resolve, url.pathname === '/api/messages' ? 120 : 30);
    const abort = () => { clearTimeout(timer); fixture.aborted++; reject(new DOMException('Aborted','AbortError')); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort',abort,{once:true});
  });
  let data = {};
  if (url.pathname === '/api/session') data = {bots};
  if (url.pathname === '/api/chats') data = {chats};
  if (url.pathname === '/api/contacts') data = {contacts:chats.map(c => ({jid:c.jid,name:c.name,phoneNumber:c.jid}))};
  if (url.pathname === '/api/messages') data = {messages:Array.from({length:1000}, (_,i) => ({
    id:'message-'+i, jid:url.searchParams.get('jid'), timestamp:1700000000000+i*1000,
    fromMe:i%2===0, sender:'Sender', type:'conversation', status:2,
    text: (i===3 ? 'UniqueNativeFindMarker ' : '') + url.searchParams.get('bot')+' message '+i+' '+('variable text '.repeat(i%6))
  }))};
  return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
};
const NativeSocket = window.WebSocket;
window.WebSocket = class {
  static OPEN=1; static CLOSED=3;
  constructor(url,protocol) {
    if (!String(url).endsWith('/ws')) return new NativeSocket(url,protocol);
    this.readyState=1; fixture.sockets.push(this);
    setTimeout(() => { this.onopen?.(); this.onmessage?.({data:JSON.stringify({type:'init',bots})}); },20);
  }
  send() { this.onmessage?.({data:JSON.stringify({type:'pong'})}); }
  close() { this.readyState=3; this.onclose?.(); }
};
fixture.push = data => fixture.sockets.at(-1).onmessage({data:JSON.stringify(data)});
</script>
<script type="module" src="/src/main.js"></script></html>`

let browser, socket, server
try {
  server = await createServer({
    configFile: false, root: path.join(root, 'web'), plugins: [vue(), {
      name: 'performance-fixture',
      configureServer(server) {
        server.middlewares.use('/__performance', (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(html)
        })
      }
    }],
    server: { host: '127.0.0.1', port: 0 }, logLevel: 'error'
  })
  await server.listen()
  console.log('Fixture server started')
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__performance`
  browser = spawn(edge, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let port
  for (let i = 0; i < 100; i++) {
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch {}
    await delay(100)
  }
  assert.ok(port, 'Headless browser did not start')
  console.log('Headless browser started')
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  console.log('Connecting DevTools')
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve,reject) => { socket.once('open',resolve); socket.once('error',reject); setTimeout(()=>reject(new Error('DevTools socket timeout')),5000).unref() })
  console.log('DevTools connected')
  const pending = new Map()
  let nextId = 0
  socket.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
  })
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout=setTimeout(()=>reject(new Error('DevTools command timed out: '+method)),15000)
    timeout.unref()
    pending.set(id, message => { clearTimeout(timeout); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result) })
    socket.send(JSON.stringify({id,method,params}))
  })
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true})
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.result?.description)
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await delay(50) }
    throw new Error('Timed out: '+expression+'; errors: '+JSON.stringify(await evaluate('window.fixture?.errors')))
  }
  await command('Page.navigate', {url})
  console.log('Checking rendered fixture')
  await until("document.querySelectorAll('.message-row').length === 1000")
  assert.equal(await evaluate("fixture.calls.filter(x=>x.startsWith('/api/chats?')).length"), 1, 'one initial chat fetch')
  assert.equal(await evaluate("fixture.calls.filter(x=>x.startsWith('/api/contacts?')).length"), 1, 'one initial contact fetch')
  assert.equal(await evaluate("window.find('UniqueNativeFindMarker', false, false, true)"), true, 'native find reaches off-screen loaded history')
  assert.ok(await evaluate("document.querySelectorAll('.chat-item').length < 80"), 'sidebar stays virtualized')
  await evaluate(`document.querySelector('.menu-search').value='Contact 1999'; document.querySelector('.menu-search').dispatchEvent(new Event('input',{bubbles:true}))`)
  await until("document.querySelectorAll('.chat-item').length===1 && document.querySelector('.chat-item').textContent.includes('Contact 1999')")
  await evaluate(`fixture.push({type:'connection',bot:'bot1',status:{id:'account@s.whatsapp.net',unreadSessionCount:2}})`)
  assert.equal(await evaluate("document.querySelector('.client-select').value"), 'bot1')
  await evaluate(`document.querySelector('.menu-search').value=''; document.querySelector('.menu-search').dispatchEvent(new Event('input',{bubbles:true}))`)
  await until("document.querySelectorAll('.chat-item').length>1")
  // Start another conversation load, then switch clients before it finishes.
  await evaluate("document.querySelectorAll('.chat-item')[1].click()")
  await delay(20)
  await evaluate(`const select=document.querySelector('.client-select'); select.value='bot2'; select.dispatchEvent(new Event('change',{bubbles:true}))`)
  await until("document.querySelector('.message-text')?.textContent.includes('bot2 message')")
  assert.ok(await evaluate('fixture.aborted > 0'), 'obsolete message fetch was aborted')
  assert.deepEqual(await evaluate('fixture.errors'), [])
  console.log('Browser checks passed: one initial fetch per resource, 1,000 searchable messages, indexed search, stable client IDs, cancelled obsolete loads.')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  socket?.close()
  browser?.kill()
  await Promise.race([server?.close(), delay(3000)])
  setTimeout(() => process.exit(process.exitCode || 0), 100).unref()
  // Leave the temporary browser profile to OS cleanup; it contains only fixtures.
}
