/**
 * @weaveintel/geneweave — Embedded web UI
 *
 * Returns the full SPA HTML as a string. The UI includes:
 *  - Auth screens (login / register)
 *  - Chat interface with streaming & sidebar
 *  - Dashboard with metrics, cost, latency & eval charts
 *
 * Everything is self-contained — no CDN, no build step, no external assets.
 */

export function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>geneWeave — AI Chat &amp; Observability</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--bg2:#141414;--bg3:#1e1e1e;--bg4:#282828;
  --fg:#e5e5e5;--fg2:#a3a3a3;--fg3:#737373;
  --accent:#06b6d4;--accent2:#0891b2;--accent-dim:rgba(6,182,212,.12);
  --danger:#ef4444;--success:#22c55e;--warn:#f59e0b;
  --radius:8px;--radius-lg:12px;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;
  --mono:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
}
html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--fg)}
a{color:var(--accent);text-decoration:none}
button{font-family:inherit;cursor:pointer;border:none;outline:none}
input{font-family:inherit;outline:none}

/* ── Auth ───────────────────────────────────── */
.auth-wrap{display:flex;align-items:center;justify-content:center;height:100vh}
.auth-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:40px;width:380px}
.auth-card h1{font-size:24px;margin-bottom:4px;display:flex;align-items:center;gap:8px}
.auth-card h1 span{color:var(--accent)}
.auth-card p.sub{color:var(--fg3);font-size:13px;margin-bottom:24px}
.auth-card .field{margin-bottom:16px}
.auth-card label{display:block;font-size:13px;color:var(--fg2);margin-bottom:4px}
.auth-card input{width:100%;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:14px}
.auth-card input:focus{border-color:var(--accent)}
.auth-card .btn{width:100%;padding:10px;border-radius:var(--radius);background:var(--accent);color:#000;font-weight:600;font-size:14px;margin-top:8px}
.auth-card .btn:hover{background:var(--accent2)}
.auth-card .toggle{text-align:center;margin-top:16px;font-size:13px;color:var(--fg3)}
.auth-card .toggle a{cursor:pointer}
.auth-card .err{color:var(--danger);font-size:13px;margin-top:8px;min-height:18px}

/* ── Layout ─────────────────────────────────── */
.app{display:flex;height:100vh;overflow:hidden}
.sidebar{width:260px;background:var(--bg2);border-right:1px solid var(--bg4);display:flex;flex-direction:column}
.sidebar-hdr{padding:16px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between}
.sidebar-hdr h2{font-size:15px;display:flex;align-items:center;gap:6px}
.sidebar-hdr h2 span{color:var(--accent)}
.new-chat-btn{padding:6px 12px;border-radius:var(--radius);background:var(--accent-dim);color:var(--accent);font-size:13px;font-weight:500}
.new-chat-btn:hover{background:var(--accent);color:#000}
.chat-list{flex:1;overflow-y:auto;padding:8px}
.chat-item{padding:10px 12px;border-radius:var(--radius);font-size:13px;color:var(--fg2);cursor:pointer;display:flex;justify-content:space-between;align-items:center}
.chat-item:hover{background:var(--bg3)}
.chat-item.active{background:var(--bg4);color:var(--fg)}
.chat-item .del{opacity:0;color:var(--fg3);font-size:16px;padding:0 4px}
.chat-item:hover .del{opacity:1}
.chat-item .del:hover{color:var(--danger)}
.sidebar-footer{padding:12px 16px;border-top:1px solid var(--bg4);display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--fg3)}
.sidebar-footer .user-email{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-btn{padding:4px 10px;border-radius:var(--radius);font-size:12px;color:var(--fg2);background:var(--bg3)}
.nav-btn:hover{background:var(--bg4);color:var(--fg)}
.nav-btn.active{background:var(--accent-dim);color:var(--accent)}
.logout-btn{padding:4px 10px;border-radius:var(--radius);font-size:12px;color:var(--danger);background:var(--bg3)}
.logout-btn:hover{background:var(--bg4)}

/* ── Main content area ──────────────────────── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}

/* ── Chat view ──────────────────────────────── */
.chat-view{flex:1;display:flex;flex-direction:column;overflow:hidden}
.messages{flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:16px}
.msg{max-width:720px;width:100%:margin:0 auto;display:flex;gap:12px;align-items:flex-start}
.msg.user{flex-direction:row-reverse}
.msg .avatar{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0}
.msg.user .avatar{background:var(--accent);color:#000}
.msg.assistant .avatar{background:var(--bg4);color:var(--fg2)}
.msg .bubble{padding:12px 16px;border-radius:var(--radius-lg);font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user .bubble{background:var(--accent-dim);color:var(--fg);border-bottom-right-radius:4px}
.msg.assistant .bubble{background:var(--bg3);color:var(--fg);border-bottom-left-radius:4px}
.msg .meta{font-size:11px;color:var(--fg3);margin-top:4px}
.msg .meta span{margin-right:10px}
.empty-chat{flex:1;display:flex;align-items:center;justify-content:center;color:var(--fg3);font-size:14px;flex-direction:column;gap:8px}
.empty-chat .logo{font-size:40px;color:var(--accent);margin-bottom:8px}

/* ── Input bar ──────────────────────────────── */
.input-bar{padding:16px 24px;border-top:1px solid var(--bg4);display:flex;gap:10px;align-items:flex-end}
.input-bar textarea{flex:1;padding:12px 14px;border-radius:var(--radius-lg);border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:14px;resize:none;min-height:44px;max-height:160px;line-height:1.5;font-family:var(--font)}
.input-bar textarea:focus{border-color:var(--accent)}
.input-bar .send-btn{padding:10px 20px;border-radius:var(--radius-lg);background:var(--accent);color:#000;font-weight:600;font-size:14px;height:44px}
.input-bar .send-btn:disabled{opacity:.5;cursor:not-allowed}
.input-bar .model-sel{padding:8px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);font-size:12px;height:44px}

/* ── Agent steps & tool calls ───────────── */
.step-card{background:var(--bg4);border:1px solid rgba(6,182,212,.2);border-radius:var(--radius);padding:10px 14px;margin:6px 0;font-size:13px}
.step-card .step-hdr{display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:500;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:.3px}
.step-card .step-body{color:var(--fg2);white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;max-height:200px;overflow-y:auto}
.step-card.tool{border-color:rgba(245,158,11,.25)}
.step-card.tool .step-hdr{color:var(--warn)}
.step-card.delegation{border-color:rgba(139,92,246,.25)}
.step-card.delegation .step-hdr{color:#8b5cf6}
.step-card.thinking{border-color:rgba(163,163,163,.2)}
.step-card.thinking .step-hdr{color:var(--fg3)}
.redaction-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(239,68,68,.12);color:var(--danger);font-size:11px;padding:2px 8px;border-radius:10px;margin-bottom:4px}
.eval-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:10px;margin-left:8px}
.eval-badge.pass{background:rgba(34,197,94,.12);color:var(--success)}
.eval-badge.fail{background:rgba(239,68,68,.12);color:var(--danger)}
.mode-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:10px;background:var(--accent-dim);color:var(--accent);text-transform:uppercase;letter-spacing:.5px}

/* ── Settings panel ─────────────────────── */
.settings-panel{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:20px;margin-bottom:16px}
.settings-panel h3{font-size:14px;color:var(--fg2);margin-bottom:12px}
.settings-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;font-size:13px}
.settings-row label{min-width:100px;color:var(--fg3)}
.settings-row select,.settings-row input[type="text"]{padding:6px 10px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:13px}
.settings-row select{min-width:140px}
.tool-toggle{display:flex;flex-wrap:wrap;gap:6px}
.tool-chip{padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);transition:all .15s}
.tool-chip.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.tool-chip:hover{border-color:var(--fg3)}
.toggle-switch{position:relative;width:36px;height:20px;background:var(--bg4);border-radius:10px;cursor:pointer;transition:background .2s}
.toggle-switch.on{background:var(--accent)}
.toggle-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s}
.toggle-switch.on::after{transform:translateX(16px)}

/* ── Trace viewer ───────────────────────── */
.trace-tree{font-size:12px;font-family:var(--mono)}
.trace-span{padding:4px 8px;margin:2px 0;border-radius:4px;background:var(--bg3);display:flex;justify-content:space-between;align-items:center}
.trace-span .span-name{color:var(--accent)}
.trace-span .span-dur{color:var(--fg3);font-size:11px}
.trace-span.child{margin-left:20px;border-left:2px solid var(--bg4)}
.trace-span .span-status{width:8px;height:8px;border-radius:50%;margin-right:6px;flex-shrink:0}
.trace-span .span-status.ok{background:var(--success)}
.trace-span .span-status.error{background:var(--danger)}
.streaming-indicator span{animation:blink 1.4s infinite both}
.streaming-indicator span:nth-child(2){animation-delay:.2s}
.streaming-indicator span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}

/* ── Dashboard ──────────────────────────────── */
.dash-view{flex:1;overflow-y:auto;padding:24px}
.dash-view h2{font-size:20px;margin-bottom:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:20px}
.card .label{font-size:12px;color:var(--fg3);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
.card .value{font-size:28px;font-weight:700}
.card .value.cost{color:var(--success)}
.card .value.tokens{color:var(--accent)}
.card .value.latency{color:var(--warn)}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
.chart-box{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:20px}
.chart-box h3{font-size:14px;color:var(--fg2);margin-bottom:12px}
.chart-box canvas{width:100%;height:200px}
.eval-table{width:100%;border-collapse:collapse;font-size:13px}
.eval-table th,.eval-table td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--bg4)}
.eval-table th{color:var(--fg3);font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.table-wrap{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius-lg);overflow:hidden}
.table-wrap h3{font-size:14px;color:var(--fg2);padding:16px 16px 0}
@media(max-width:900px){.charts{grid-template-columns:1fr}.sidebar{width:200px}}
@media(max-width:640px){.sidebar{display:none}.app{flex-direction:column}}
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
const $ = (s,p) => (p||document).querySelector(s);
const $$ = (s,p) => [...(p||document).querySelectorAll(s)];
const h = (tag,attrs,...ch) => {
  const el = document.createElement(tag);
  if(attrs) Object.entries(attrs).forEach(([k,v])=>{
    if(k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(),v);
    else if(k==='className') el.className=v;
    else if(k==='htmlFor') el.setAttribute('for',v);
    else el.setAttribute(k,v);
  });
  ch.flat(Infinity).forEach(c=>{
    if(c==null) return;
    el.appendChild(typeof c==='string'?document.createTextNode(c):c);
  });
  return el;
};

/* ── State ──────────────────────────────────── */
let state = {
  user:null, csrfToken:null,
  chats:[], currentChatId:null, messages:[],
  view:'chat', // 'chat' | 'dashboard'
  streaming:false, models:[], selectedModel:'',
  dashboard:null, authMode:'login', authError:'',
  // New: settings, tools, traces
  chatSettings:null, availableTools:[], showSettings:false,
  traces:[]
};

/* ── API ────────────────────────────────────── */
const api = {
  async post(path,body){
    const headers = {'Content-Type':'application/json'};
    if(state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    const r = await fetch('/api'+path,{method:'POST',headers,body:JSON.stringify(body),credentials:'same-origin'});
    return r;
  },
  async get(path){
    return fetch('/api'+path,{credentials:'same-origin'});
  },
  async del(path){
    const headers = {};
    if(state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    return fetch('/api'+path,{method:'DELETE',headers,credentials:'same-origin'});
  }
};

/* ── Auth ───────────────────────────────────── */
async function doLogin(email,password){
  const r = await api.post('/auth/login',{email,password});
  const d = await r.json();
  if(!r.ok){ state.authError = d.error||'Login failed'; render(); return; }
  state.user = d.user; state.csrfToken = d.csrfToken; state.authError='';
  await loadChats(); await Promise.all([loadModels(), loadTools()]); render();
}
async function doRegister(name,email,password){
  const r = await api.post('/auth/register',{name,email,password});
  const d = await r.json();
  if(!r.ok){ state.authError = d.error||'Register failed'; render(); return; }
  state.user = d.user; state.csrfToken = d.csrfToken; state.authError='';
  await loadChats(); await Promise.all([loadModels(), loadTools()]); render();
}
async function doLogout(){
  await api.post('/auth/logout',{});
  state.user=null; state.csrfToken=null; state.chats=[]; state.currentChatId=null; state.messages=[]; state.dashboard=null;
  render();
}

/* ── Chats ──────────────────────────────────── */
async function loadChats(){
  const r = await api.get('/chats');
  if(r.ok) state.chats = (await r.json()).chats ?? [];
}
async function loadModels(){
  const r = await api.get('/models');
  if(r.ok){
    const d = await r.json();
    state.models = d.models ?? [];
    if(!state.selectedModel && d.defaultModel) state.selectedModel = d.defaultModel;
  }
}
async function loadTools(){
  const r = await api.get('/tools');
  if(r.ok) state.availableTools = (await r.json()).tools ?? [];
}
async function loadChatSettings(chatId){
  if(!chatId){state.chatSettings=null;return;}
  const r = await api.get('/chats/'+chatId+'/settings');
  if(r.ok){
    const d = (await r.json()).settings;
    state.chatSettings = {
      mode: d.mode||'direct',
      systemPrompt: d.system_prompt||'',
      enabledTools: d.enabled_tools ? JSON.parse(d.enabled_tools) : [],
      redactionEnabled: !!d.redaction_enabled,
      redactionPatterns: d.redaction_patterns ? JSON.parse(d.redaction_patterns) : ['email','phone','ssn','credit_card'],
      workers: d.workers ? JSON.parse(d.workers) : []
    };
  }
}
async function saveChatSettings(){
  if(!state.currentChatId||!state.chatSettings) return;
  await api.post('/chats/'+state.currentChatId+'/settings', state.chatSettings);
}
async function loadChatTraces(chatId){
  const r = await api.get('/chats/'+chatId+'/traces');
  if(r.ok) state.traces = (await r.json()).traces ?? [];
}
async function createChat(){
  const mParts = state.selectedModel.split(':');
  const r = await api.post('/chats',{model:mParts[1]||state.selectedModel,provider:mParts[0]||''});
  if(r.ok){ const d=await r.json(); state.chats.unshift(d.chat); state.currentChatId=d.chat.id; state.messages=[]; render(); }
}
async function selectChat(id){
  state.currentChatId=id;
  const r = await api.get('/chats/'+id+'/messages');
  if(r.ok) state.messages = (await r.json()).messages ?? [];
  await loadChatSettings(id);
  state.showSettings=false;
  render();
}
async function deleteChat(id){
  await api.del('/chats/'+id);
  state.chats = state.chats.filter(c=>c.id!==id);
  if(state.currentChatId===id){ state.currentChatId=null; state.messages=[]; }
  render();
}

/* ── Send message with streaming ────────────── */
async function sendMessage(content){
  if(!content.trim()||state.streaming) return;
  if(!state.currentChatId) await createChat();
  const chatId = state.currentChatId;
  state.messages.push({role:'user',content,created_at:new Date().toISOString()});
  state.streaming=true; render();
  scrollMessages();

  const mParts = state.selectedModel.split(':');
  const body = {content,stream:true,model:mParts[1]||undefined,provider:mParts[0]||undefined};
  const headers = {'Content-Type':'application/json'};
  if(state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

  try {
    const resp = await fetch('/api/chats/'+chatId+'/messages',{method:'POST',headers,body:JSON.stringify(body),credentials:'same-origin'});
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let assistantMsg = {role:'assistant',content:'',usage:null,cost:0,latency_ms:0,created_at:new Date().toISOString(),steps:[],evalResult:null,redaction:null,mode:state.chatSettings?.mode||'direct'};
    state.messages.push(assistantMsg);
    render(); scrollMessages();

    let buf = '';
    while(true){
      const {done,value} = await reader.read();
      if(done) break;
      buf += decoder.decode(value,{stream:true});
      const lines = buf.split('\\n');
      buf = lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if(d.type==='text') assistantMsg.content += d.text;
          else if(d.type==='step') assistantMsg.steps.push(d.step||d);
          else if(d.type==='tool_start') assistantMsg.steps.push({kind:'tool_start',name:d.name,input:d.input});
          else if(d.type==='tool_end'){ const last=assistantMsg.steps[assistantMsg.steps.length-1]; if(last&&last.kind==='tool_start') last.result=d.result; }
          else if(d.type==='redaction') assistantMsg.redaction=d;
          else if(d.type==='eval') assistantMsg.evalResult=d;
          else if(d.type==='done'){ assistantMsg.usage=d.usage; assistantMsg.cost=d.cost; assistantMsg.latency_ms=d.latencyMs; if(d.steps) assistantMsg.steps=d.steps; if(d.eval) assistantMsg.evalResult=d.eval; }
          else if(d.type==='error') assistantMsg.content += '\\n[Error: '+d.error+']';
        } catch{}
      }
      renderMessages(); scrollMessages();
    }
  } catch(e){
    state.messages.push({role:'assistant',content:'[Connection error: '+(e.message||e)+']',created_at:new Date().toISOString()});
  }
  state.streaming=false;
  // Update chat title from first message
  const chat = state.chats.find(c=>c.id===chatId);
  if(chat && chat.title==='New Chat' && content.length>0){
    chat.title = content.slice(0,40) + (content.length>40?'…':'');
  }
  render();
}

/* ── Dashboard ──────────────────────────────── */
async function loadDashboard(){
  const [ov,cost,perf,evals,traces] = await Promise.all([
    api.get('/dashboard/overview').then(r=>r.json()),
    api.get('/dashboard/costs').then(r=>r.json()),
    api.get('/dashboard/performance').then(r=>r.json()),
    api.get('/dashboard/evals').then(r=>r.json()),
    api.get('/dashboard/traces?limit=50').then(r=>r.ok?r.json():{traces:[]}).catch(()=>({traces:[]})),
  ]);
  state.dashboard = {overview:ov,costs:cost,performance:perf,evals,traces:traces.traces||[]};
  render();
  setTimeout(drawCharts, 50);
}

/* ── Drawing charts ─────────────────────────── */
function drawCharts(){
  if(!state.dashboard) return;
  drawBarChart('costModelChart', state.dashboard.costs.byModel||[], m=>m.model, m=>m.cost, '$');
  drawLineChart('costDayChart', state.dashboard.costs.byDay||[], d=>d.date.slice(5), d=>d.cost, '$');
  drawBarChart('latencyChart', state.dashboard.performance.byModel||[], m=>m.model, m=>m.avgLatency, 'ms');
}
function drawBarChart(id,data,labelFn,valueFn,unit){
  const canvas = document.getElementById(id); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio||1;
  canvas.width = canvas.offsetWidth*dpr; canvas.height = 200*dpr;
  ctx.scale(dpr,dpr);
  const W = canvas.offsetWidth, H = 200;
  ctx.clearRect(0,0,W,H);
  if(!data.length){ctx.fillStyle='#737373';ctx.font='13px sans-serif';ctx.fillText('No data yet',W/2-30,H/2);return;}
  const max = Math.max(...data.map(valueFn),1);
  const barW = Math.min(40, (W-40)/data.length - 8);
  const startX = (W - data.length*(barW+8))/2;
  data.forEach((d,i)=>{
    const x = startX + i*(barW+8);
    const val = valueFn(d);
    const barH = (val/max)*(H-50);
    ctx.fillStyle = '#06b6d4';
    ctx.roundRect(x,H-30-barH,barW,barH,4); ctx.fill();
    ctx.beginPath();
    ctx.fillStyle='#a3a3a3'; ctx.font='10px sans-serif'; ctx.textAlign='center';
    ctx.fillText(labelFn(d).slice(0,8),x+barW/2,H-14);
    ctx.fillStyle='#e5e5e5'; ctx.font='11px sans-serif';
    ctx.fillText(unit+(val<1?val.toFixed(4):val.toFixed(2)),x+barW/2,H-34-barH);
  });
}
function drawLineChart(id,data,labelFn,valueFn,unit){
  const canvas = document.getElementById(id); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio||1;
  canvas.width = canvas.offsetWidth*dpr; canvas.height = 200*dpr;
  ctx.scale(dpr,dpr);
  const W = canvas.offsetWidth, H = 200;
  ctx.clearRect(0,0,W,H);
  if(!data.length){ctx.fillStyle='#737373';ctx.font='13px sans-serif';ctx.fillText('No data yet',W/2-30,H/2);return;}
  const max = Math.max(...data.map(valueFn),0.001);
  const pad = 40;
  ctx.strokeStyle='#1e1e1e'; ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=pad+(H-pad*2)/4*i;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(W-10,y);ctx.stroke();}
  ctx.strokeStyle='#06b6d4'; ctx.lineWidth=2; ctx.beginPath();
  data.forEach((d,i)=>{
    const x = pad + i*((W-pad-10)/(data.length-1||1));
    const y = pad + (1-valueFn(d)/max)*(H-pad*2);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
  ctx.fillStyle='#06b6d4';
  data.forEach((d,i)=>{
    const x = pad + i*((W-pad-10)/(data.length-1||1));
    const y = pad + (1-valueFn(d)/max)*(H-pad*2);
    ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
  });
  ctx.fillStyle='#a3a3a3'; ctx.font='10px sans-serif'; ctx.textAlign='center';
  data.forEach((d,i)=>{
    if(data.length>10 && i%Math.ceil(data.length/10)!==0) return;
    const x = pad + i*((W-pad-10)/(data.length-1||1));
    ctx.fillText(labelFn(d),x,H-8);
  });
}

/* ── Scrolling ──────────────────────────────── */
function scrollMessages(){ const el=$('.messages'); if(el) el.scrollTop=el.scrollHeight; }

/* ── Render ─────────────────────────────────── */
function render(){
  const app = $('#app');
  app.innerHTML='';
  if(!state.user){ app.appendChild(renderAuth()); return; }
  app.appendChild(renderApp());
}
function renderMessages(){
  const container = $('.messages');
  if(!container) return;
  container.innerHTML='';
  if(!state.messages.length){
    container.appendChild(h('div',{className:'empty-chat'},
      h('div',{className:'logo'},'\\u{1F9EC}'),
      h('div',null,'Start a conversation with geneWeave'),
      h('div',null,'Select a model and type your message below')
    ));
    return;
  }
  state.messages.forEach(m=>{
    const isUser = m.role==='user';
    const extras = [];

    if(!isUser && m.mode && m.mode!=='direct'){
      extras.push(h('span',{className:'mode-badge'},m.mode));
    }
    if(!isUser && m.redaction){
      extras.push(h('span',{className:'redaction-badge'},'\\u{1F6E1} Redacted: '+(m.redaction.count||m.redaction.detections?.length||'')+ ' items'));
    }
    if(!isUser && m.steps && m.steps.length){
      m.steps.forEach(s=>{
        let cls = 'step-card';
        let label = 'Step';
        let body = '';
        if(s.kind==='tool_start'||s.type==='tool_call'){
          cls += ' tool';
          label = '\\u{1F527} Tool: '+(s.name||s.toolName||'');
          body = s.input ? (typeof s.input==='string'? s.input : JSON.stringify(s.input,null,2)) : '';
          if(s.result) body += '\\n\\u2192 '+(typeof s.result==='string'? s.result : JSON.stringify(s.result));
        } else if(s.type==='delegation'){
          cls += ' delegation';
          label = '\\u{1F91D} Delegated to: '+(s.worker||s.name||'');
          body = s.input||s.message||'';
        } else if(s.type==='thinking'){
          cls += ' thinking';
          label = '\\u{1F4AD} Thinking';
          body = s.text||s.content||'';
        } else {
          label = s.type||'Step';
          body = s.text||s.content||JSON.stringify(s);
        }
        extras.push(h('div',{className:cls},
          h('div',{className:'step-hdr'},label),
          body ? h('div',{className:'step-body'},body) : null
        ));
      });
    }
    if(!isUser && m.evalResult){
      const ev = m.evalResult;
      const passed = ev.passed ?? ev.score >= 1;
      extras.push(h('span',{className:'eval-badge '+(passed?'pass':'fail')},
        (passed?'\\u2713':'\\u2717')+' Eval: '+(ev.score != null ? (ev.score*100).toFixed(0)+'%' : (passed?'pass':'fail'))
      ));
    }

    const msgEl = h('div',{className:'msg '+(isUser?'user':'assistant')},
      h('div',{className:'avatar'},isUser?'U':'G'),
      h('div',null,
        ...extras,
        h('div',{className:'bubble'},m.content||(state.streaming?'':'...')),
        !isUser && m.usage ? h('div',{className:'meta'},
          h('span',null,'\\u{1F4CA} '+m.usage.totalTokens+' tok'),
          h('span',null,'\\u{1F4B0} $'+(m.cost||0).toFixed(6)),
          h('span',null,'\\u23F1 '+(m.latency_ms||0)+'ms')
        ) : null,
        !isUser && state.streaming && !m.content ? h('div',{className:'streaming-indicator'},h('span',null,'.'),h('span',null,'.'),h('span',null,'.')) : null
      )
    );
    container.appendChild(msgEl);
  });
}

function renderAuth(){
  const isLogin = state.authMode==='login';
  const card = h('div',{className:'auth-wrap'},
    h('div',{className:'auth-card'},
      h('h1',null,'\\u{1F9EC} ',h('span',null,'gene'),('Weave')),
      h('p',{className:'sub'},isLogin?'Sign in to your account':'Create a new account'),
      !isLogin ? h('div',{className:'field'},h('label',null,'Name'),h('input',{type:'text',id:'auth-name',placeholder:'Your name'})) : null,
      h('div',{className:'field'},h('label',null,'Email'),h('input',{type:'email',id:'auth-email',placeholder:'you@example.com'})),
      h('div',{className:'field'},h('label',null,'Password'),h('input',{type:'password',id:'auth-pass',placeholder:'\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022'})),
      h('button',{className:'btn',onClick:()=>{
        const email=$('#auth-email').value;
        const pass=$('#auth-pass').value;
        if(isLogin) doLogin(email,pass);
        else doRegister($('#auth-name').value,email,pass);
      }},isLogin?'Sign In':'Create Account'),
      h('div',{className:'err'},state.authError),
      h('div',{className:'toggle'},
        isLogin?'No account? ':'Already have an account? ',
        h('a',{onClick:()=>{state.authMode=isLogin?'register':'login';state.authError='';render();}},isLogin?'Register':'Sign In')
      )
    )
  );
  return card;
}

function renderApp(){
  const wrap = h('div',{className:'app'});

  /* Sidebar */
  const sidebar = h('div',{className:'sidebar'},
    h('div',{className:'sidebar-hdr'},
      h('h2',null,'\\u{1F9EC} ',h('span',null,'gene'),'Weave'),
      h('button',{className:'new-chat-btn',onClick:createChat},'+ New')
    ),
    h('div',{className:'chat-list'},
      ...state.chats.map(c=>
        h('div',{className:'chat-item'+(state.currentChatId===c.id?' active':''),onClick:()=>selectChat(c.id)},
          h('span',null,c.title||'New Chat'),
          h('span',{className:'del',onClick:e=>{e.stopPropagation();deleteChat(c.id);}},'\\u00D7')
        )
      )
    ),
    h('div',{className:'sidebar-footer'},
      h('div',null,
        h('button',{className:'nav-btn'+(state.view==='chat'?' active':''),onClick:()=>{state.view='chat';render();}},'Chat'),
        ' ',
        h('button',{className:'nav-btn'+(state.view==='dashboard'?' active':''),onClick:()=>{state.view='dashboard';loadDashboard();}},'Dashboard'),
      ),
      h('button',{className:'logout-btn',onClick:doLogout},'Logout')
    )
  );
  wrap.appendChild(sidebar);

  /* Main */
  const main = h('div',{className:'main'});
  if(state.view==='dashboard'){
    main.appendChild(renderDashboard());
  } else {
    main.appendChild(renderChatView());
  }
  wrap.appendChild(main);
  return wrap;
}

function renderChatView(){
  const view = h('div',{className:'chat-view'});
  const msgContainer = h('div',{className:'messages'});
  view.appendChild(msgContainer);

  /* Settings panel (collapsible) */
  if(state.showSettings && state.chatSettings){
    const s = state.chatSettings;
    const modeSelect = h('select',{className:'',onChange:function(){s.mode=this.value;saveChatSettings();render();}},
      ...['direct','agent','supervisor'].map(m=>{ const o=h('option',{value:m},m); if(m===s.mode) o.selected=true; return o; })
    );
    const sysInput = h('input',{type:'text',value:s.systemPrompt||'',placeholder:'System prompt...',onChange:function(){s.systemPrompt=this.value;saveChatSettings();}});

    const toolChips = (state.availableTools||[]).map(t=>{
      const active = s.enabledTools.includes(t.name);
      return h('span',{className:'tool-chip'+(active?' active':''),onClick:()=>{
        if(active) s.enabledTools=s.enabledTools.filter(n=>n!==t.name);
        else s.enabledTools.push(t.name);
        saveChatSettings(); render();
      }},t.name);
    });

    const redactToggle = h('div',{className:'toggle-switch'+(s.redactionEnabled?' on':''),onClick:()=>{
      s.redactionEnabled=!s.redactionEnabled; saveChatSettings(); render();
    }});

    const panel = h('div',{className:'settings-panel'},
      h('h3',null,'Chat Settings'),
      h('div',{className:'settings-row'},h('label',null,'Mode'),modeSelect),
      h('div',{className:'settings-row'},h('label',null,'System Prompt'),sysInput),
      (s.mode==='agent'||s.mode==='supervisor') ? h('div',{className:'settings-row'},h('label',null,'Tools'),h('div',{className:'tool-toggle'},...toolChips)) : null,
      h('div',{className:'settings-row'},h('label',null,'Redaction'),redactToggle,h('span',{style:'font-size:12px;color:var(--fg3)'},s.redactionEnabled?'On':'Off')),
    );
    view.appendChild(panel);
  }

  /* Input bar */
  const ta = h('textarea',{placeholder:'Type a message...',rows:'1'});
  ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage(ta.value);ta.value='';ta.style.height='auto';}});
  ta.addEventListener('input',()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,160)+'px';});

  const modelSel = h('select',{className:'model-sel',onChange:function(){state.selectedModel=this.value;}});
  state.models.forEach(m=>{
    const val=m.provider+':'+m.id;
    const opt=h('option',{value:val},m.provider+'/'+m.id);
    if(val===state.selectedModel) opt.selected=true;
    modelSel.appendChild(opt);
  });

  const settingsBtn = h('button',{className:'nav-btn'+(state.showSettings?' active':''),onClick:()=>{state.showSettings=!state.showSettings;render();}},'\\u2699');

  view.appendChild(h('div',{className:'input-bar'},
    modelSel,
    settingsBtn,
    ta,
    h('button',{className:'send-btn',onClick:()=>{sendMessage(ta.value);ta.value='';ta.style.height='auto';},disabled:state.streaming?'true':null},'Send')
  ));

  setTimeout(()=>{renderMessages();scrollMessages();},0);
  return view;
}

function renderDashboard(){
  const d = state.dashboard;
  const view = h('div',{className:'dash-view'},h('h2',null,'Dashboard'));
  if(!d||!d.overview){
    view.appendChild(h('div',{className:'empty-chat'},'Loading dashboard…'));
    return view;
  }
  const s = d.overview.summary||{};
  view.appendChild(h('div',{className:'cards'},
    h('div',{className:'card'},h('div',{className:'label'},'Total Tokens'),h('div',{className:'value tokens'},(s.total_tokens||0).toLocaleString())),
    h('div',{className:'card'},h('div',{className:'label'},'Total Cost'),h('div',{className:'value cost'},'$'+(s.total_cost||0).toFixed(4))),
    h('div',{className:'card'},h('div',{className:'label'},'Avg Latency'),h('div',{className:'value latency'},(s.avg_latency_ms||0)+'ms')),
    h('div',{className:'card'},h('div',{className:'label'},'Messages'),h('div',{className:'value'},(s.total_messages||0).toString())),
    h('div',{className:'card'},h('div',{className:'label'},'Chats'),h('div',{className:'value'},(s.total_chats||0).toString())),
    h('div',{className:'card'},h('div',{className:'label'},'Requests'),h('div',{className:'value'},(d.performance.totalRequests||0).toString())),
  ));

  view.appendChild(h('div',{className:'charts'},
    h('div',{className:'chart-box'},h('h3',null,'Cost by Model'),h('canvas',{id:'costModelChart'})),
    h('div',{className:'chart-box'},h('h3',null,'Cost Over Time'),h('canvas',{id:'costDayChart'})),
    h('div',{className:'chart-box'},h('h3',null,'Latency by Model'),h('canvas',{id:'latencyChart'})),
  ));

  /* Eval table */
  const evals = d.evals.evals||[];
  if(evals.length){
    const rows = evals.map(ev=>
      h('tr',null,
        h('td',null,ev.eval_name),
        h('td',null,(ev.score*100).toFixed(1)+'%'),
        h('td',null,ev.passed+'/'+ev.total),
        h('td',null,ev.created_at?.slice(0,16)||'')
      )
    );
    view.appendChild(h('div',{className:'table-wrap'},
      h('h3',null,'Evaluation Results'),
      h('table',{className:'eval-table'},
        h('thead',null,h('tr',null,h('th',null,'Name'),h('th',null,'Score'),h('th',null,'Passed'),h('th',null,'Date'))),
        h('tbody',null,...rows)
      )
    ));
  }

  /* Trace viewer */
  const traceData = d.traces||[];
  if(traceData.length){
    const roots = traceData.filter(t=>!t.parent_span_id);
    const children = traceData.filter(t=>t.parent_span_id);
    const traceEls = roots.map(r=>{
      const kids = children.filter(c=>c.parent_span_id===r.span_id);
      const dur = r.end_time && r.start_time ? (new Date(r.end_time)-new Date(r.start_time))+'ms' : '—';
      return h('div',null,
        h('div',{className:'trace-span'},
          h('span',{className:'span-status '+(r.status==='ok'?'ok':'error')}),
          h('span',{className:'span-name'},r.name||r.trace_id),
          h('span',{className:'span-dur'},dur)
        ),
        ...kids.map(k=>{
          const kd = k.end_time && k.start_time ? (new Date(k.end_time)-new Date(k.start_time))+'ms' : '—';
          return h('div',{className:'trace-span child'},
            h('span',{className:'span-status '+(k.status==='ok'?'ok':'error')}),
            h('span',{className:'span-name'},k.name||'span'),
            h('span',{className:'span-dur'},kd)
          );
        })
      );
    });
    view.appendChild(h('div',{className:'table-wrap',style:'padding:16px;margin-top:16px'},
      h('h3',{style:'margin-bottom:12px'},'Recent Traces'),
      h('div',{className:'trace-tree'},...traceEls)
    ));
  }
  return view;
}

/* ── Init: check if already authenticated ──── */
(async()=>{
  const r = await api.get('/auth/me');
  if(r.ok){
    const d = await r.json();
    state.user = d.user; state.csrfToken = d.csrfToken;
    await loadChats(); await Promise.all([loadModels(), loadTools()]);
  }
  render();
})();
</script>
</body>
</html>`;
}
