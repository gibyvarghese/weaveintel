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

import { ADMIN_TAB_GROUPS, ADMIN_TABS } from './admin-schema.js';

export function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>geneWeave — AI Chat &amp; Observability</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#F4F4F2;--bg2:#FFFFFF;--bg3:#F8F8F6;--bg4:#E7E7E4;
  --fg:#111111;--fg2:#5F5F5F;--fg3:#8A8A8A;
  --accent:#2563EB;--accent2:#1d4ed8;--accent-dim:rgba(37,99,235,.08);
  --danger:#dc2626;--success:#16a34a;--warn:#d97706;
  --radius:12px;--radius-lg:16px;
  --font:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
  --shadow-soft:0 1px 2px rgba(17,17,17,.04),0 8px 24px rgba(17,17,17,.04);
  --shadow-hover:0 2px 6px rgba(17,17,17,.06),0 12px 30px rgba(17,17,17,.08);
}
html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
button{font-family:inherit;cursor:pointer;border:none;outline:none;background:none}
input{font-family:inherit;outline:none}

/* ── Auth ───────────────────────────────────── */
.auth-wrap{display:flex;align-items:center;justify-content:center;height:100vh;background:var(--bg)}
.auth-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:40px;width:400px;box-shadow:var(--shadow-soft)}
.auth-card h1{font-size:24px;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.auth-card h1 span{color:var(--accent)}
.auth-card p.sub{color:var(--fg3);font-size:14px;margin-bottom:24px}
.auth-card .field{margin-bottom:16px}
.auth-card label{display:block;font-size:13px;color:var(--fg2);margin-bottom:6px;font-weight:500}
.auth-card input{width:100%;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;transition:border-color .18s ease}
.auth-card input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.auth-card .btn{width:100%;padding:12px;border-radius:999px;background:var(--fg);color:#FFFFFF;font-weight:600;font-size:14px;margin-top:8px;transition:background .18s ease}
.auth-card .btn:hover{background:#1D1D1D}
.auth-card .toggle{text-align:center;margin-top:16px;font-size:13px;color:var(--fg3)}
.auth-card .toggle a{cursor:pointer;color:var(--accent);font-weight:500}
.auth-card .err{color:var(--danger);font-size:13px;margin-top:8px;min-height:18px}

/* ── Layout ─────────────────────────────────── */
.app{display:flex;height:100vh;overflow:hidden;background:var(--bg)}
.sidebar{width:280px;background:var(--bg2);border-right:1px solid var(--bg4);display:flex;flex-direction:column}
.sidebar-hdr{padding:20px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between}
.sidebar-hdr h2{font-size:16px;font-weight:700;display:flex;align-items:center;gap:6px;color:var(--fg)}
.sidebar-hdr h2 span{color:var(--accent)}
.new-chat-btn{padding:8px 16px;border-radius:999px;background:var(--fg);color:#FFFFFF;font-size:13px;font-weight:600;transition:background .18s ease}
.new-chat-btn:hover{background:#1D1D1D}
.chat-list{flex:1;overflow-y:auto;padding:8px 12px}
.chat-item{padding:10px 14px;border-radius:var(--radius);font-size:14px;color:var(--fg2);cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:all .18s ease}
.chat-item:hover{background:var(--bg3)}
.chat-item.active{background:var(--fg);color:#FFFFFF}
.chat-item .del{opacity:0;color:var(--fg3);font-size:16px;padding:0 4px;transition:opacity .18s}
.chat-item:hover .del{opacity:1}
.chat-item.active .del{color:rgba(255,255,255,.6)}
.chat-item .del:hover{color:var(--danger)}
.sidebar-footer{padding:16px 20px;border-top:1px solid var(--bg4);display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--fg3)}
.sidebar-footer .user-email{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-btn{padding:6px 14px;border-radius:999px;font-size:12px;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);font-weight:500;transition:all .18s ease}
.nav-btn:hover{background:var(--bg);border-color:var(--fg3);color:var(--fg)}
.nav-btn.active{background:var(--fg);color:#FFFFFF;border-color:var(--fg)}
.logout-btn{padding:6px 14px;border-radius:999px;font-size:12px;color:var(--danger);background:var(--bg3);border:1px solid var(--bg4)}
.logout-btn:hover{background:rgba(220,38,38,.06);border-color:var(--danger)}

/* ── Main content area ──────────────────────── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}

/* ── Chat view ──────────────────────────────── */
.chat-view{flex:1;display:flex;flex-direction:column;overflow:hidden}
.messages{flex:1;overflow-y:auto;padding:32px;display:flex;flex-direction:column;gap:20px}
.msg{max-width:720px;width:100%;margin:0 auto;display:flex;gap:12px;align-items:flex-start}
.msg.user{flex-direction:row-reverse}
.msg .avatar{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0}
.msg.user .avatar{background:var(--fg);color:#FFFFFF}
.msg.assistant .avatar{background:var(--bg3);color:var(--fg2);border:1px solid var(--bg4)}
.msg .bubble{padding:14px 18px;border-radius:var(--radius-lg);font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user .bubble{background:var(--fg);color:#FFFFFF;border-bottom-right-radius:4px}
.msg.assistant .bubble{background:var(--bg2);color:var(--fg);border:1px solid var(--bg4);border-bottom-left-radius:4px;box-shadow:var(--shadow-soft);white-space:normal}
.msg .meta{font-size:11px;color:var(--fg3);margin-top:6px}
.msg .meta span{margin-right:10px}

/* ── Rich text (assistant bubble) ───────── */
.msg.assistant .bubble h1,.msg.assistant .bubble h2,.msg.assistant .bubble h3,.msg.assistant .bubble h4{margin:16px 0 8px;font-weight:700;color:var(--fg);line-height:1.3}
.msg.assistant .bubble h1{font-size:20px}
.msg.assistant .bubble h2{font-size:17px}
.msg.assistant .bubble h3{font-size:15px}
.msg.assistant .bubble h4{font-size:14px}
.msg.assistant .bubble p{margin:0 0 10px;line-height:1.65}
.msg.assistant .bubble ul,.msg.assistant .bubble ol{margin:0 0 10px 20px}
.msg.assistant .bubble li{margin-bottom:4px}
.msg.assistant .bubble code{font-family:var(--mono);font-size:12.5px;background:var(--bg3);border:1px solid var(--bg4);padding:2px 6px;border-radius:6px}
.msg.assistant .bubble pre{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:14px 16px;margin:10px 0;overflow-x:auto;position:relative}
.msg.assistant .bubble pre code{background:none;border:none;padding:0;font-size:12px;line-height:1.5}
.msg.assistant .bubble blockquote{border-left:3px solid var(--bg4);padding:6px 14px;margin:10px 0;color:var(--fg2);background:var(--bg3);border-radius:0 var(--radius) var(--radius) 0}
.msg.assistant .bubble table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
.msg.assistant .bubble th,.msg.assistant .bubble td{padding:8px 12px;text-align:left;border:1px solid var(--bg4)}
.msg.assistant .bubble th{background:var(--bg3);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.3px;color:var(--fg2)}
.msg.assistant .bubble hr{border:none;height:1px;background:var(--bg4);margin:16px 0}
.msg.assistant .bubble a{color:var(--accent);text-decoration:underline}
.msg.assistant .bubble strong{font-weight:600}
.msg.assistant .bubble em{font-style:italic}

/* ── Response toolbar ───────────────────── */
.response-toolbar{display:flex;gap:4px;margin-top:8px;opacity:0;transition:opacity .18s ease}
.msg.assistant:hover .response-toolbar{opacity:1}
.tb-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:500;color:var(--fg3);background:var(--bg3);border:1px solid var(--bg4);cursor:pointer;transition:all .18s ease;font-family:var(--font)}
.tb-btn:hover{color:var(--fg);background:var(--bg);border-color:var(--fg3)}
.tb-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.tb-btn.copied{color:var(--success);border-color:var(--success);background:rgba(22,163,74,.06)}
.copy-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:var(--fg);color:#fff;padding:8px 20px;border-radius:999px;font-size:13px;font-weight:500;z-index:10001;opacity:0;transition:opacity .2s;pointer-events:none}
.copy-toast.show{opacity:1}
.empty-chat{flex:1;display:flex;align-items:center;justify-content:center;color:var(--fg3);font-size:15px;flex-direction:column;gap:8px}
.empty-chat .logo{font-size:48px;margin-bottom:8px}

/* ── Input bar ──────────────────────────────── */
.input-bar{padding:20px 32px;border-top:1px solid var(--bg4);display:flex;gap:12px;align-items:flex-end;background:var(--bg2)}
.input-bar textarea{flex:1;padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;resize:none;min-height:48px;max-height:160px;line-height:1.5;font-family:var(--font);transition:border-color .18s ease}
.input-bar textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.input-bar .send-btn{padding:12px 24px;border-radius:999px;background:var(--fg);color:#FFFFFF;font-weight:600;font-size:14px;height:48px;transition:background .18s ease}
.input-bar .send-btn:hover{background:#1D1D1D}
.input-bar .send-btn:disabled{opacity:.4;cursor:not-allowed}
.input-bar .model-sel{padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);font-size:13px;height:48px}

/* ── Agent steps & tool calls ───────────── */
.step-card{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:12px 16px;margin:8px 0;font-size:13px}
.step-card .step-hdr{display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:.3px}
.step-card .step-body{color:var(--fg2);white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;max-height:200px;overflow-y:auto}
.step-card.tool{border-color:rgba(217,119,6,.2)}
.step-card.tool .step-hdr{color:var(--warn)}
.step-card.delegation{border-color:rgba(124,58,237,.2)}
.step-card.delegation .step-hdr{color:#7c3aed}
.step-card.thinking{border-color:var(--bg4)}
.step-card.thinking .step-hdr{color:var(--fg3)}
.redaction-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(220,38,38,.06);color:var(--danger);font-size:11px;padding:3px 10px;border-radius:999px;margin-bottom:4px;border:1px solid rgba(220,38,38,.15)}
.eval-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 10px;border-radius:999px;margin-left:8px}
.eval-badge.pass{background:rgba(22,163,74,.06);color:var(--success);border:1px solid rgba(22,163,74,.15)}
.eval-badge.fail{background:rgba(220,38,38,.06);color:var(--danger);border:1px solid rgba(220,38,38,.15)}
.mode-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:3px 10px;border-radius:999px;background:var(--accent-dim);color:var(--accent);text-transform:uppercase;letter-spacing:.5px;font-weight:600;border:1px solid rgba(37,99,235,.15)}

/* ── Chat header bar ─────────────────────── */
.chat-header{display:flex;align-items:center;justify-content:space-between;padding:12px 24px;border-bottom:1px solid var(--bg4);background:var(--bg2);flex-shrink:0;min-height:56px}
.chat-header-left{display:flex;align-items:center;gap:12px}
.chat-header-right{display:flex;align-items:center;gap:10px}
.hdr-icon-btn{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);transition:all .18s ease}
.hdr-icon-btn:hover{background:var(--bg);border-color:var(--fg3);color:var(--fg)}
.hdr-icon-btn.active{background:var(--accent-dim);color:var(--accent);border-color:var(--accent)}
.profile-avatar{width:38px;height:38px;border-radius:50%;background:var(--fg);color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;cursor:pointer;border:2px solid transparent;transition:all .18s ease}
.profile-avatar:hover{border-color:var(--fg3)}
.model-sel{padding:8px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);font-size:13px;font-weight:500}

/* ── Dropdown wrapper ───────────────────── */
.dropdown-anchor{position:relative}
.dropdown{position:fixed;background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);box-shadow:var(--shadow-hover);z-index:10000;min-width:200px;max-height:calc(100vh - 80px);overflow-y:auto;animation:dropIn .15s ease-out}
@keyframes dropIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}

/* ── Profile dropdown ───────────────────── */
.profile-dd{width:260px;padding:20px}
.profile-dd .pf-name{font-size:15px;font-weight:600;margin-bottom:2px;color:var(--fg)}
.profile-dd .pf-email{font-size:13px;color:var(--fg3);margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.profile-dd .pf-divider{height:1px;background:var(--bg4);margin:10px 0}
.profile-dd .pf-btn{display:block;width:100%;text-align:left;padding:10px 12px;border-radius:var(--radius);font-size:14px;color:var(--fg2);background:none;transition:all .18s ease}
.profile-dd .pf-btn:hover{background:var(--bg3);color:var(--fg)}
.profile-dd .pf-btn.danger{color:var(--danger)}
.profile-dd .pf-btn.danger:hover{background:rgba(220,38,38,.06)}

/* ── Settings dropdown ──────────────────── */
.settings-dd{width:360px;padding:24px}
.settings-dd h3{font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.settings-dd h3 .ai-icon{color:var(--fg3)}

/* ── Settings panel (shared styles) ─────── */
.settings-panel{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:24px;margin-bottom:16px;box-shadow:var(--shadow-soft)}
.settings-panel h3{font-size:14px;color:var(--fg2);margin-bottom:12px;font-weight:600}
.settings-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;font-size:13px}
.settings-row label{min-width:100px;color:var(--fg3);font-weight:500}
.settings-row select,.settings-row input[type="text"]{padding:8px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:13px;transition:border-color .18s}
.settings-row select{min-width:140px}
.settings-row select:focus,.settings-row input:focus{border-color:var(--accent)}
.mode-cards{display:flex;flex-direction:column;gap:8px}
.mode-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);cursor:pointer;transition:all .18s ease}
.mode-card:hover{border-color:var(--fg3);background:var(--bg3)}
.mode-card.selected{border-color:var(--accent);background:var(--accent-dim)}
.mode-card .mc-icon{font-size:18px;width:28px;text-align:center}
.mode-card .mc-body{flex:1}
.mode-card .mc-title{font-size:13px;font-weight:600;color:var(--fg)}
.mode-card .mc-desc{font-size:11px;color:var(--fg3);margin-top:2px}
.mode-card.selected .mc-title{color:var(--accent)}
.tool-toggle{display:flex;flex-wrap:wrap;gap:6px}
.tool-chip{padding:5px 12px;border-radius:999px;font-size:11px;cursor:pointer;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);transition:all .18s ease;font-weight:500}
.tool-chip.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.tool-chip:hover{border-color:var(--fg3)}
.toggle-switch{position:relative;width:36px;height:20px;background:var(--bg4);border-radius:10px;cursor:pointer;transition:background .2s}
.toggle-switch.on{background:var(--accent)}
.toggle-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(17,17,17,.1)}
.toggle-switch.on::after{transform:translateX(16px)}
.settings-section{margin-bottom:16px}
.settings-section:last-child{margin-bottom:0}
.settings-section .sec-label{font-size:11px;color:var(--fg3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;font-weight:600}
.settings-section .sec-row{display:flex;align-items:center;gap:8px;font-size:13px}

/* ── Trace viewer ───────────────────────── */
.trace-tree{font-size:12px;font-family:var(--mono)}
.trace-span{padding:6px 10px;margin:2px 0;border-radius:var(--radius);background:var(--bg2);border:1px solid var(--bg4);display:flex;justify-content:space-between;align-items:center}
.trace-span .span-name{color:var(--accent);font-weight:500}
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
.dash-view{flex:1;overflow-y:auto;padding:32px}
.dash-view h2{font-size:22px;font-weight:700;margin-bottom:24px;color:var(--fg)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:32px}
.card{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:24px;box-shadow:var(--shadow-soft);transition:box-shadow .18s ease}
.card:hover{box-shadow:var(--shadow-hover)}
.card .label{font-size:12px;color:var(--fg3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.card .value{font-size:28px;font-weight:700;color:var(--fg)}
.card .value.cost{color:var(--success)}
.card .value.tokens{color:var(--accent)}
.card .value.latency{color:var(--warn)}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:32px}
.chart-box{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);padding:24px;box-shadow:var(--shadow-soft)}
.chart-box h3{font-size:14px;color:var(--fg2);margin-bottom:12px;font-weight:600}
.chart-box canvas{width:100%;height:200px}
.eval-table{width:100%;border-collapse:collapse;font-size:13px}
.eval-table th,.eval-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--bg4)}
.eval-table th{color:var(--fg3);font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.eval-table td{color:var(--fg2)}
.table-wrap{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-soft)}
.table-wrap h3{font-size:14px;color:var(--fg2);padding:20px 20px 0;font-weight:600}

/* ── Accordion / Agent Activity ─────────────── */
.agent-activity{margin-top:32px}
.agent-activity>h3{font-size:18px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.acc-item{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);margin-bottom:8px;overflow:hidden;transition:all .18s ease;box-shadow:var(--shadow-soft)}
.acc-item.open{border-color:var(--fg3)}
.acc-hdr{display:flex;align-items:center;gap:10px;padding:14px 20px;cursor:pointer;user-select:none;transition:background .18s ease}
.acc-hdr:hover{background:var(--bg3)}
.acc-chevron{font-size:10px;color:var(--fg3);transition:transform .2s;flex-shrink:0;width:16px}
.acc-item.open .acc-chevron{transform:rotate(90deg)}
.acc-icon{font-size:16px;width:28px;text-align:center;flex-shrink:0}
.acc-title{flex:1;min-width:0}
.acc-title .acc-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg)}
.acc-title .acc-sub{font-size:12px;color:var(--fg3);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap}
.acc-badges{display:flex;gap:6px;flex-shrink:0}
.acc-badge{font-size:10px;padding:3px 10px;border-radius:999px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
.acc-badge.mode-direct{background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4)}
.acc-badge.mode-agent{background:var(--accent-dim);color:var(--accent);border:1px solid rgba(37,99,235,.15)}
.acc-badge.mode-supervisor{background:rgba(124,58,237,.06);color:#7c3aed;border:1px solid rgba(124,58,237,.15)}
.acc-body{display:none;padding:0 20px 20px;border-top:1px solid var(--bg4)}
.acc-item.open .acc-body{display:block}
.acc-section{margin-top:12px}
.acc-section .asl{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:600}
.acc-kv{display:grid;grid-template-columns:120px 1fr;gap:4px 12px;font-size:12px;margin-bottom:6px}
.acc-kv .ak{color:var(--fg3);font-weight:500}
.acc-kv .av{color:var(--fg);word-break:break-all}
.acc-kv .av.mono{font-family:var(--mono);font-size:11px;color:var(--accent2)}
.acc-prompt{font-family:var(--mono);font-size:11px;background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:12px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto;color:var(--fg2)}
.acc-tools{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.acc-tool-tag{font-size:10px;padding:3px 10px;border-radius:999px;background:var(--accent-dim);color:var(--accent);font-family:var(--mono);border:1px solid rgba(37,99,235,.12)}
.step-acc{margin-top:8px}
.step-acc-item{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);margin-bottom:4px;overflow:hidden}
.step-acc-hdr{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-size:12px;transition:background .15s}
.step-acc-hdr:hover{background:var(--bg)}
.step-acc-chevron{font-size:9px;color:var(--fg3);transition:transform .2s;width:12px;flex-shrink:0}
.step-acc-item.open .step-acc-chevron{transform:rotate(90deg)}
.step-acc-icon{font-size:14px;width:20px;text-align:center}
.step-acc-title{flex:1;font-weight:500;color:var(--fg)}
.step-acc-dur{font-size:11px;color:var(--fg3);font-family:var(--mono)}
.step-acc-body{display:none;padding:10px 14px;border-top:1px solid var(--bg4);font-size:11px;font-family:var(--mono)}
.step-acc-item.open .step-acc-body{display:block}
.step-acc-body pre{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius);padding:10px;white-space:pre-wrap;word-break:break-word;overflow-x:auto;max-height:200px;overflow-y:auto;margin:4px 0}
.step-acc-body .step-label{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px}

/* ── Scrollbar ────────────────────────────── */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--fg3)}

@media(max-width:900px){.charts{grid-template-columns:1fr}.sidebar{width:220px}}
@media(max-width:640px){.sidebar{display:none}.app{flex-direction:column}}
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
var ADMIN_GROUPS = ${JSON.stringify(ADMIN_TAB_GROUPS)};
var ADMIN_SCHEMA = ${JSON.stringify(ADMIN_TABS)};
const $ = (s,p) => (p||document).querySelector(s);
const $$ = (s,p) => [...(p||document).querySelectorAll(s)];
const h = (tag,attrs,...ch) => {
  const el = document.createElement(tag);
  if(attrs) Object.entries(attrs).forEach(([k,v])=>{
    if(k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(),v);
    else if(k==='className') el.className=v;
    else if(k==='htmlFor') el.setAttribute('for',v);
    else if(v==null||v===false) el.removeAttribute(k);
    else el.setAttribute(k,v);
  });
  ch.flat(Infinity).forEach(c=>{
    if(c==null) return;
    el.appendChild(typeof c==='string'?document.createTextNode(c):c);
  });
  return el;
};

/* ── Markdown to HTML (lightweight) ─────────── */
function mdToHtml(md){
  if(!md) return '';
  let html = md;
  var BT = String.fromCharCode(96);
  // Code blocks (fenced)
  html = html.replace(new RegExp(BT+BT+BT+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+BT+BT+BT,'g'), function(m,lang,code){
    var escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<pre><code'+(lang?' class="lang-'+lang+'"':'')+'>'+ escaped.trimEnd() +'</code></pre>';
  });
  // Inline code
  html = html.replace(new RegExp(BT+'([^'+BT+']+)'+BT,'g'), '<code>$1</code>');
  // Headings
  html = html.replace(/^#### (.+)$/gm,'<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  // Bold + italic
  html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g,'<strong><em>$1</em></strong>');
  html = html.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  html = html.replace(/(?!\\*\\*)\\*([^*]+?)\\*(?!\\*)/g,'<em>$1</em>');
  // Horizontal rule
  html = html.replace(/^---$/gm,'<hr/>');
  // Blockquote
  html = html.replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>');
  // Links
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Unordered list items
  html = html.replace(/^(\\s*)[-*] (.+)$/gm,'$1<li>$2</li>');
  // Ordered list items
  html = html.replace(/^(\\s*)\\d+\\. (.+)$/gm,'$1<li>$2</li>');
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*<\\/li>\\n?)+)/g,'<ul>$1</ul>');
  // Tables
  html = html.replace(/^\\|(.+)\\|\\s*\\n\\|[-| :]+\\|\\s*\\n((?:\\|.+\\|\\s*\\n?)*)/gm, function(m,hdr,rows){
    var ths = hdr.split('|').map(function(c){return '<th>'+c.trim()+'</th>';}).join('');
    var trs = rows.trim().split('\\n').map(function(r){
      var tds = r.replace(/^\\||\\|$/g,'').split('|').map(function(c){return '<td>'+c.trim()+'</td>';}).join('');
      return '<tr>'+tds+'</tr>';
    }).join('');
    return '<table><thead><tr>'+ths+'</tr></thead><tbody>'+trs+'</tbody></table>';
  });
  // Paragraphs: wrap remaining loose lines
  html = html.replace(/^(?!<[hupbolta]|<li|<hr|<blockquote|<pre|<table|<thead|<tbody|<tr|<td|<th|<ul|<ol)(.+)$/gm,'<p>$1</p>');
  // Clean up double newlines
  html = html.replace(/\\n{2,}/g,'\\n');
  return html.trim();
}

/* ── Toolbar actions ────────────────────────── */
function copyResponse(text, btn){
  // Copy as plain text
  navigator.clipboard.writeText(text).then(()=>{
    btn.classList.add('copied');
    btn.querySelector('.tb-label').textContent = 'Copied!';
    setTimeout(()=>{ btn.classList.remove('copied'); btn.querySelector('.tb-label').textContent = 'Copy'; },1500);
  });
}

function emailResponse(text, subject){
  const body = encodeURIComponent(text);
  const subj = encodeURIComponent(subject || 'geneWeave Response');
  window.open('mailto:?subject='+subj+'&body='+body, '_blank');
}

function openInWord(htmlContent, plainText){
  // Create a .doc compatible HTML file (Word can open HTML)
  const wordHtml = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
    + '<head><meta charset="utf-8"/><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.6;color:#111}'
    + 'h1{font-size:18pt}h2{font-size:15pt}h3{font-size:13pt}h4{font-size:11pt}'
    + 'code{font-family:Consolas,monospace;font-size:10pt;background:#f4f4f4;padding:1px 4px}'
    + 'pre{background:#f4f4f4;padding:10px;font-family:Consolas,monospace;font-size:10pt}'
    + 'blockquote{border-left:3px solid #ccc;padding-left:12px;color:#555}'
    + 'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px}th{background:#f0f0f0}'
    + '</style></head><body>' + htmlContent + '</body></html>';
  const blob = new Blob([wordHtml], {type:'application/msword'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'geneweave-response.doc';
  a.click();
  URL.revokeObjectURL(url);
}

/* ── State ──────────────────────────────────── */
let state = {
  user:null, csrfToken:null,
  chats:[], currentChatId:null, messages:[],
  view:'chat', // 'chat' | 'dashboard' | 'admin'
  streaming:false, models:[], selectedModel:'',
  dashboard:null, authMode:'login', authError:'',
  // New: settings, tools, traces
  chatSettings:null, availableTools:[], showSettings:false, defaultMode:'direct',
  showProfile:false,
  traces:[],
  // Admin state
  adminTab:'prompts',
  adminData:{},
  adminEditing:null, adminForm:{}
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
  },
  async put(path,body){
    const headers = {'Content-Type':'application/json'};
    if(state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    return fetch('/api'+path,{method:'PUT',headers,body:JSON.stringify(body),credentials:'same-origin'});
  }
};

/* ── Auth ───────────────────────────────────── */
async function doLogin(email,password){
  const r = await api.post('/auth/login',{email,password});
  const d = await r.json();
  if(!r.ok){ state.authError = d.error||'Login failed'; render(); return; }
  state.user = d.user; state.csrfToken = d.csrfToken; state.authError='';
  await loadChats(); await Promise.all([loadModels(), loadTools(), loadUserPreferences()]); render();
}
async function doRegister(name,email,password){
  const r = await api.post('/auth/register',{name,email,password});
  const d = await r.json();
  if(!r.ok){ state.authError = d.error||'Register failed'; render(); return; }
  state.user = d.user; state.csrfToken = d.csrfToken; state.authError='';
  await loadChats(); await Promise.all([loadModels(), loadTools(), loadUserPreferences()]); render();
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
  try{
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
    } else {
      console.warn('loadChatSettings: non-ok response', r.status);
      state.chatSettings = { mode:state.defaultMode||'direct', systemPrompt:'', enabledTools:[], redactionEnabled:false, redactionPatterns:['email','phone','ssn','credit_card'], workers:[] };
    }
  }catch(e){
    console.warn('loadChatSettings error', e);
    state.chatSettings = { mode:state.defaultMode||'direct', systemPrompt:'', enabledTools:[], redactionEnabled:false, redactionPatterns:['email','phone','ssn','credit_card'], workers:[] };
  }
}
async function saveChatSettings(){
  if(!state.currentChatId||!state.chatSettings) return;
  await api.post('/chats/'+state.currentChatId+'/settings', state.chatSettings);
  // Also persist mode as user default
  if(state.chatSettings.mode && state.chatSettings.mode !== state.defaultMode){
    state.defaultMode = state.chatSettings.mode;
    api.post('/user/preferences', {default_mode:state.chatSettings.mode});
  }
}
async function loadUserPreferences(){
  try{
    const r = await api.get('/user/preferences');
    if(r.ok){ const d = await r.json(); state.defaultMode = d.preferences?.default_mode || 'direct'; }
  }catch(e){ console.warn('loadUserPreferences error', e); }
}
async function loadChatTraces(chatId){
  const r = await api.get('/chats/'+chatId+'/traces');
  if(r.ok) state.traces = (await r.json()).traces ?? [];
}
async function createChat(){
  const mParts = state.selectedModel.split(':');
  const r = await api.post('/chats',{model:mParts[1]||state.selectedModel,provider:mParts[0]||''});
  if(r.ok){ const d=await r.json(); state.chats.unshift(d.chat); state.currentChatId=d.chat.id; state.messages=[]; await loadChatSettings(d.chat.id); if(state.chatSettings && state.defaultMode){ state.chatSettings.mode=state.defaultMode; saveChatSettings(); } render(); }
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
          else if(d.type==='guardrail') assistantMsg.guardrail=d;
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
  const [ov,cost,perf,evals,traces,activity] = await Promise.all([
    api.get('/dashboard/overview').then(r=>r.json()),
    api.get('/dashboard/costs').then(r=>r.json()),
    api.get('/dashboard/performance').then(r=>r.json()),
    api.get('/dashboard/evals').then(r=>r.json()),
    api.get('/dashboard/traces?limit=50').then(r=>r.ok?r.json():{traces:[]}).catch(()=>({traces:[]})),
    api.get('/dashboard/agent-activity?limit=50').then(r=>r.ok?r.json():{activity:[]}).catch(()=>({activity:[]})),
  ]);
  state.dashboard = {overview:ov,costs:cost,performance:perf,evals,traces:traces.traces||[],agentActivity:activity.activity||[]};
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
  document.querySelectorAll('body > .dropdown').forEach(el=>el.remove());
  if(!state.user){ app.appendChild(renderAuth()); return; }
  app.appendChild(renderApp());
}
function renderMessages(){
  const container = $('.messages');
  if(!container) return;
  container.innerHTML='';
  if(!state.messages.length){
    const logoSvg=document.createElement('div');logoSvg.className='logo';logoSvg.innerHTML='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#8A8A8A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>';
    container.appendChild(h('div',{className:'empty-chat'},
      logoSvg,
      h('div',null,'Start a conversation with geneWeave'),
      h('div',null,'Choose a model above and type your message')
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
    if(!isUser && m.guardrail){
      const gd = m.guardrail.decision;
      const gc = gd==='deny'?'background:rgba(220,38,38,.08);color:#DC2626;border:1px solid rgba(220,38,38,.2)':gd==='warn'?'background:rgba(217,119,6,.08);color:#D97706;border:1px solid rgba(217,119,6,.2)':'background:rgba(22,163,74,.08);color:#16A34A;border:1px solid rgba(22,163,74,.2)';
      extras.push(h('span',{style:'display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 10px;border-radius:999px;margin-bottom:4px;'+gc},(gd==='deny'?'\\u{1F6AB}':gd==='warn'?'\\u26A0':'\\u2705')+' Guardrail: '+gd+(m.guardrail.reason?' \\u2014 '+m.guardrail.reason:'')));
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

    // Build bubble element
    let bubbleEl;
    if(!isUser && m.content){
      // Rich text for assistant
      bubbleEl = document.createElement('div');
      bubbleEl.className = 'bubble';
      bubbleEl.innerHTML = mdToHtml(m.content);
    } else {
      bubbleEl = h('div',{className:'bubble'},m.content||(state.streaming?'':'...'));
    }

    // Action toolbar for assistant messages
    const toolbar = !isUser && m.content ? (()=>{
      const rawText = m.content;
      const richHtml = mdToHtml(m.content);
      const bar = document.createElement('div');
      bar.className = 'response-toolbar';
      // Copy
      const copyBtn = document.createElement('button');
      copyBtn.className = 'tb-btn';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span class="tb-label">Copy</span>';
      copyBtn.onclick = ()=> copyResponse(rawText, copyBtn);
      // Email
      const emailBtn = document.createElement('button');
      emailBtn.className = 'tb-btn';
      emailBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg><span class="tb-label">Email</span>';
      emailBtn.onclick = ()=> emailResponse(rawText, 'geneWeave Response');
      // Word
      const wordBtn = document.createElement('button');
      wordBtn.className = 'tb-btn';
      wordBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg><span class="tb-label">Word</span>';
      wordBtn.onclick = ()=> openInWord(richHtml, rawText);
      bar.appendChild(copyBtn);
      bar.appendChild(emailBtn);
      bar.appendChild(wordBtn);
      return bar;
    })() : null;

    const msgEl = h('div',{className:'msg '+(isUser?'user':'assistant')},
      h('div',{className:'avatar'},isUser?'U':'G'),
      h('div',null,
        ...extras,
        bubbleEl,
        toolbar,
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
      h('h1',null,Object.assign(document.createElement('span'),{innerHTML:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8A8A8A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>'}),' ',h('span',null,'gene'),('Weave')),
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

function renderTopBar(){
  const headerLeft = h('div',{className:'chat-header-left'});
  if(state.view==='chat'){
    const modelSel = h('select',{className:'model-sel',onChange:function(){state.selectedModel=this.value;}});
    state.models.forEach(m=>{
      const val=m.provider+':'+m.id;
      const opt=h('option',{value:val},m.provider+'/'+m.id);
      if(val===state.selectedModel) opt.selected=true;
      modelSel.appendChild(opt);
    });
    headerLeft.appendChild(modelSel);
  } else {
    const backBtn = h('button',{className:'hdr-icon-btn',title:'Back to Chat',onClick:()=>{state.view='chat';render();}},'\\u2190');
    headerLeft.appendChild(backBtn);
    headerLeft.appendChild(h('span',{style:'font-weight:600;font-size:15px;margin-left:8px'},state.view==='admin'?'Administration':'Dashboard'));
  }

  const headerRight = h('div',{className:'chat-header-right'});

  /* Settings button + dropdown (chat only) */
  if(state.view==='chat'){
    const settingsAnchor = h('div',{className:'dropdown-anchor'});
    const settingsBtn = h('button',{className:'hdr-icon-btn'+(state.showSettings?' active':''),title:'AI Settings',onClick:async(e)=>{
      e.stopPropagation();
      if(!state.chatSettings && state.currentChatId){
        await loadChatSettings(state.currentChatId);
      }
      if(!state.chatSettings){
        state.chatSettings = { mode:state.defaultMode||'direct', systemPrompt:'', enabledTools:[], redactionEnabled:false, redactionPatterns:['email','phone','ssn','credit_card'], workers:[] };
      }
      state.showSettings=!state.showSettings; state.showProfile=false; render();
    }},'\\u2699');
    settingsAnchor.appendChild(settingsBtn);
    if(state.showSettings && state.chatSettings){
      const dd = renderSettingsDropdown();
      document.body.appendChild(dd);
      requestAnimationFrame(()=>{
        const r = settingsBtn.getBoundingClientRect();
        dd.style.top = (r.bottom + 8) + 'px';
        dd.style.right = (window.innerWidth - r.right) + 'px';
      });
    }
    headerRight.appendChild(settingsAnchor);
  }

  /* Profile button + dropdown */
  const profileAnchor = h('div',{className:'dropdown-anchor'});
  const initials = state.user?.name ? state.user.name.charAt(0).toUpperCase() : (state.user?.email ? state.user.email.charAt(0).toUpperCase() : 'U');
  const profileBtn = h('div',{className:'profile-avatar',title:state.user?.email||'Profile',onClick:(e)=>{
    e.stopPropagation();
    state.showProfile=!state.showProfile; state.showSettings=false; render();
  }},initials);
  profileAnchor.appendChild(profileBtn);
  if(state.showProfile){
    const dd = renderProfileDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(()=>{
      const r = profileBtn.getBoundingClientRect();
      dd.style.top = (r.bottom + 8) + 'px';
      dd.style.right = (window.innerWidth - r.right) + 'px';
    });
  }
  headerRight.appendChild(profileAnchor);

  return h('div',{className:'chat-header'},headerLeft,headerRight);
}

function renderApp(){
  const wrap = h('div',{className:'app'});

  /* Sidebar (chat view only) */
  if(state.view==='chat'){
    const sidebar = h('div',{className:'sidebar'},
      h('div',{className:'sidebar-hdr'},
        h('h2',null,Object.assign(document.createElement('span'),{innerHTML:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8A8A8A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>'}),' ',h('span',null,'gene'),'Weave'),
        h('button',{className:'new-chat-btn',onClick:createChat},'+ New')
      ),
      h('div',{className:'chat-list'},
        ...state.chats.map(c=>
          h('div',{className:'chat-item'+(state.currentChatId===c.id?' active':''),onClick:()=>selectChat(c.id)},
            h('span',null,c.title||'New Chat'),
            h('span',{className:'del',onClick:e=>{e.stopPropagation();deleteChat(c.id);}},'\\u00D7')
          )
        )
      )
    );
    wrap.appendChild(sidebar);
  }

  /* Main */
  const main = h('div',{className:'main'});
  main.appendChild(renderTopBar());
  if(state.view==='dashboard'){
    main.appendChild(renderDashboard());
  } else if(state.view==='admin'){
    main.appendChild(renderAdmin());
  } else {
    main.appendChild(renderChatView());
  }
  wrap.appendChild(main);
  return wrap;
}

/* ── Admin ──────────────────────────────────── */

async function loadAdmin(){
  try{
    var keys = Object.keys(ADMIN_SCHEMA);
    var promises = keys.map(function(k){
      var s = ADMIN_SCHEMA[k];
      return api.get('/'+s.apiPath).then(function(r){return r.json();}).catch(function(){var d={};d[s.listKey]=[];return d;});
    });
    var results = await Promise.all(promises);
    var data = {};
    keys.forEach(function(k,i){ var s = ADMIN_SCHEMA[k]; data[k] = results[i][s.listKey]||[]; });
    state.adminData = data;
  }catch(e){ console.error('Failed to load admin data',e); }
  render();
}

async function seedData(){
  try{
    await api.post('/admin/seed',{});
    await loadAdmin();
  }catch(e){ console.error('Seed failed',e); }
}

async function adminSave(tab){
  var schema = ADMIN_SCHEMA[tab];
  if(!schema) return;
  var f = state.adminForm;
  var isEdit = !!state.adminEditing;
  var payload = {};
  schema.fields.forEach(function(fd){
    var val = f[fd.key];
    if(fd.save==='json'){ try{val=val?JSON.parse(val):null;}catch(e){val=null;} }
    else if(fd.save==='jsonStr'){ try{val=val?JSON.stringify(JSON.parse(val)):null;}catch(e){val=null;} }
    else if(fd.save==='int'){ val=val?parseInt(val):(fd['default']!=null?fd['default']:null); }
    else if(fd.save==='float'){ val=val?parseFloat(val):(fd['default']!=null?fd['default']:null); }
    else if(fd.save==='csvArr'){ val=val?val.split(',').map(function(s){return s.trim();}).filter(Boolean):[]; }
    else if(fd.save==='bool'){ val=(val===undefined||val===null)?(fd['default']!=null?fd['default']:false):val!==false&&val!=='false'; }
    else if(fd.save==='intBool'){ val=val?1:0; }
    else { val=(val!=null&&val!=='')?val:(fd['default']!=null?fd['default']:null); }
    payload[fd.key] = val;
  });
  try{
    var resp = isEdit ? await api.put('/'+schema.apiPath+'/'+state.adminEditing,payload) : await api.post('/'+schema.apiPath,payload);
    if(resp && resp.ok){
      state.adminEditing=null; state.adminForm={};
      await loadAdmin();
    } else {
      var err = resp ? await resp.json() : {};
      alert('Save failed: '+(err.error||'Unknown error'));
    }
  }catch(e){ alert('Save error: '+e.message); }
}

async function adminDelete(tab,id){
  if(!confirm('Delete this item?')) return;
  var schema = ADMIN_SCHEMA[tab];
  if(!schema) return;
  try{
    await api.del('/'+schema.apiPath+'/'+id);
    await loadAdmin();
  }catch(e){ alert('Delete failed: '+e.message); }
}

function adminEdit(tab,item){
  state.adminEditing = item.id;
  var f = Object.assign({},item);
  var schema = ADMIN_SCHEMA[tab];
  if(schema){
    schema.fields.forEach(function(fd){
      if(fd.save==='csvArr' && f[fd.key]){
        try{f[fd.key]=JSON.parse(f[fd.key]).join(', ');}catch(e){}
      } else if((fd.textarea||fd.save==='json'||fd.save==='jsonStr') && f[fd.key]!=null && typeof f[fd.key]!=='string'){
        try{f[fd.key]=JSON.stringify(f[fd.key],null,2);}catch(e){}
      }
    });
  }
  state.adminForm = f;
  render();
}

function adminNew(){
  state.adminEditing = null;
  var f = {};
  var schema = ADMIN_SCHEMA[state.adminTab];
  if(schema){
    schema.fields.forEach(function(fd){
      if(fd['default']!=null) f[fd.key]=fd['default'];
    });
  }
  state.adminForm = f;
  render();
}

function adminCancel(){
  state.adminEditing = null;
  state.adminForm = {};
  render();
}

function inp(label,key,opts){
  var isTA = opts&&opts.textarea;
  var val = state.adminForm[key]!=null?state.adminForm[key]:'';
  var wrapper = h('div',{style:'margin-bottom:10px'});
  wrapper.appendChild(h('label',{style:'display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:3px'},label));
  if(isTA){
    var ta = document.createElement('textarea');
    ta.value = typeof val==='string'?val:JSON.stringify(val,null,2);
    ta.rows = opts.rows||3;
    Object.assign(ta.style,{cssText:'width:100%;padding:7px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;font-family:monospace;resize:vertical;box-sizing:border-box'});
    ta.addEventListener('input',function(){state.adminForm[key]=this.value;});
    wrapper.appendChild(ta);
  } else if(opts&&opts.type==='checkbox'){
    var cb = document.createElement('input');
    cb.type='checkbox'; cb.checked=!!state.adminForm[key];
    cb.addEventListener('change',function(){state.adminForm[key]=this.checked;render();});
    wrapper.appendChild(cb);
  } else if(opts&&opts.options){
    var sel = document.createElement('select');
    Object.assign(sel.style,{cssText:'width:100%;padding:7px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box'});
    opts.options.forEach(function(o){var op=document.createElement('option');op.value=o;op.textContent=o;if(val===o)op.selected=true;sel.appendChild(op);});
    if(state.adminForm[key]==null&&opts.options.length) state.adminForm[key]=opts.options[0];
    sel.addEventListener('change',function(){state.adminForm[key]=this.value;});
    wrapper.appendChild(sel);
  } else {
    var i = document.createElement('input');
    i.type = (opts&&opts.type)||'text';
    i.value = val;
    Object.assign(i.style,{cssText:'width:100%;padding:7px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;box-sizing:border-box'});
    i.addEventListener('input',function(){state.adminForm[key]=this.value;});
    wrapper.appendChild(i);
  }
  return wrapper;
}

function renderAdminForm(tab){
  var schema = ADMIN_SCHEMA[tab];
  if(!schema) return h('div');
  var form = h('div',{style:'background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:20px;margin-bottom:16px'});
  var title = state.adminEditing?'Edit':'New';
  form.appendChild(h('h3',{style:'margin:0 0 14px;font-size:15px;color:#1E293B'},title+' '+schema.singular));
  schema.fields.forEach(function(fd){
    var opts = {};
    if(fd.textarea) opts.textarea = true;
    if(fd.rows) opts.rows = fd.rows;
    if(fd.options) opts.options = fd.options;
    if(fd.type) opts.type = fd.type;
    form.appendChild(inp(fd.label,fd.key,opts));
  });
  var btns = h('div',{style:'display:flex;gap:8px;margin-top:14px'});
  btns.appendChild(h('button',{className:'nav-btn active',onClick:function(){adminSave(tab);}},state.adminEditing?'Update':'Create'));
  btns.appendChild(h('button',{className:'nav-btn',onClick:adminCancel},'Cancel'));
  form.appendChild(btns);
  return form;
}

function renderAdminTable(tab){
  var items = state.adminData[tab]||[];
  var table = h('div',{style:'background:#fff;border:1px solid #E5E7EB;border-radius:10px;overflow:hidden'});

  if(items.length===0){
    table.appendChild(h('div',{style:'padding:30px;text-align:center;color:#94A3B8;font-size:14px'},
      'No items yet. Click "+ New" to create one, or "Seed Defaults" to load sample data.'
    ));
    return table;
  }

  var schema = ADMIN_SCHEMA[tab];
  var isReadOnly = schema && schema.readOnly;
  var cols = getAdminCols(tab);
  var gridCols = cols.map(function(c){return c.w||'1fr';}).join(' ')+(isReadOnly?'':' 100px');
  var thead = h('div',{style:'display:grid;grid-template-columns:'+gridCols+';padding:10px 16px;background:#F8FAFC;border-bottom:1px solid #E5E7EB;font-size:11px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:0.5px'});
  cols.forEach(function(c){thead.appendChild(h('span',null,c.label));});
  if(!isReadOnly) thead.appendChild(h('span',null,'Actions'));
  table.appendChild(thead);

  items.forEach(function(item){
    var row = h('div',{style:'display:grid;grid-template-columns:'+gridCols+';padding:10px 16px;border-bottom:1px solid #F1F5F9;font-size:13px;align-items:center;transition:background 0.15s',onMouseEnter:function(){this.style.background='#F8FAFC'},onMouseLeave:function(){this.style.background='transparent'}});
    cols.forEach(function(c){
      var v = item[c.key];
      var cellStyle = 'color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      if(c.key==='enabled'||c.key==='is_default'||c.key==='requires_approval'||c.key==='require_human_review'||c.key==='auto_update'||c.key==='auto_link'||c.key==='handoff_enabled'||c.key==='require_versioning'||c.key==='network_access'){ v=v?'\\u2713':'\\u2717'; cellStyle=item[c.key]?'color:#16A34A':'color:#DC2626'; }
      else if(c.key==='status'){
        var st=String(v||'');
        var colors={completed:'#16A34A',paused:'#D97706',failed:'#DC2626',running:'#2563EB',pending:'#64748B'};
        cellStyle='color:'+(colors[st]||'#334155')+';font-weight:600';
      }
      else if(c.key==='overall_decision'){
        var d=String(v||'');
        var dcolors={allow:'#16A34A',deny:'#DC2626',warn:'#D97706'};
        cellStyle='color:'+(dcolors[d]||'#334155')+';font-weight:600';
      }
      else if(typeof v==='string'&&v.length>40) v=v.slice(0,40)+'...';
      else if(v===null||v===undefined) v='\\u2014';
      row.appendChild(h('span',{style:cellStyle},String(v)));
    });
    if(!isReadOnly){
      var acts = h('div',{style:'display:flex;gap:6px'});
      acts.appendChild(h('button',{style:'padding:3px 10px;font-size:12px;border:1px solid #D1D5DB;border-radius:5px;background:#fff;cursor:pointer;color:#2563EB',onClick:function(){adminEdit(tab,item);}},'Edit'));
      acts.appendChild(h('button',{style:'padding:3px 10px;font-size:12px;border:1px solid #FCA5A5;border-radius:5px;background:#FEF2F2;cursor:pointer;color:#DC2626',onClick:function(){adminDelete(tab,item.id);}},'Del'));
      row.appendChild(acts);
    }
    table.appendChild(row);
  });
  return table;
}

function getAdminCols(tab){
  var schema = ADMIN_SCHEMA[tab];
  if(!schema) return [];
  return schema.cols.map(function(key){
    var label = key.replace(/_/g,' ').replace(/\bid\b/gi,'ID').replace(/\bms\b/g,'(ms)').replace(/\burl\b/gi,'URL').replace(/\b\w/g,function(c){return c.toUpperCase();});
    var w = key==='name'?'1.5fr':(key==='enabled'||key==='auto_link'||key==='auto_update')?'0.5fr':'1fr';
    return {key:key,label:label,w:w};
  });
}

function renderAdmin(){
  var view = h('div',{style:'display:flex;flex-direction:column;flex:1;overflow:hidden'});

  /* Header */
  var hdr = h('div',{style:'display:flex;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid #E5E7EB;background:var(--bg2);flex-shrink:0'});
  hdr.appendChild(h('h2',{style:'margin:0;font-size:20px;font-weight:700;color:#1E293B'},'Administration'));
  var hdrBtns = h('div',{style:'display:flex;gap:8px'});
  hdrBtns.appendChild(h('button',{className:'nav-btn',style:'font-size:12px',onClick:seedData},'Seed Defaults'));
  hdr.appendChild(hdrBtns);
  view.appendChild(hdr);

  /* Layout: sidebar + content */
  var layout = h('div',{style:'display:flex;flex:1;overflow:hidden'});

  /* Sidebar navigation */
  var nav = h('div',{style:'width:200px;border-right:1px solid #E5E7EB;background:var(--bg2);overflow-y:auto;flex-shrink:0;padding:8px 0'});
  ADMIN_GROUPS.forEach(function(group){
    nav.appendChild(h('div',{style:'padding:14px 16px 4px;font-size:10px;font-weight:700;color:var(--fg3);text-transform:uppercase;letter-spacing:.5px'},group.icon+' '+group.label));
    group.tabs.forEach(function(t){
      var active = state.adminTab===t.key;
      nav.appendChild(h('button',{
        style:'display:block;width:100%;text-align:left;padding:7px 16px 7px 24px;font-size:13px;border:none;font-family:inherit;font-weight:'+(active?'600':'400')+';color:'+(active?'var(--accent)':'var(--fg2)')+';background:'+(active?'var(--accent-dim)':'transparent')+';cursor:pointer;transition:all 0.15s',
        onClick:function(){state.adminTab=t.key;state.adminEditing=null;state.adminForm={};render();}
      },t.label));
    });
  });
  layout.appendChild(nav);

  /* Content area */
  var content = h('div',{style:'flex:1;overflow-y:auto;padding:24px;max-width:900px'});
  var tab = state.adminTab;
  var schema = ADMIN_SCHEMA[tab];
  var isReadOnlyTab = schema && schema.readOnly;

  /* Form (if editing or creating) */
  if(!isReadOnlyTab && (state.adminEditing!==null||Object.keys(state.adminForm).length>0)){
    content.appendChild(renderAdminForm(tab));
  }

  /* Action bar */
  var actions = h('div',{style:'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px'});
  var count = (state.adminData[tab]||[]).length;
  actions.appendChild(h('span',{style:'font-size:13px;color:#64748B'},count+' item'+(count!==1?'s':'')));
  if(!isReadOnlyTab && !state.adminEditing && Object.keys(state.adminForm).length===0){
    actions.appendChild(h('button',{className:'nav-btn active',style:'font-size:12px',onClick:adminNew},'+ New'));
  }
  content.appendChild(actions);

  /* Table */
  content.appendChild(renderAdminTable(tab));

  layout.appendChild(content);
  view.appendChild(layout);
  return view;
}



function renderChatView(){
  const view = h('div',{className:'chat-view'});

  /* ── Messages ─── */
  const msgContainer = h('div',{className:'messages'});
  view.appendChild(msgContainer);

  /* ── Input bar ─── */
  const ta = h('textarea',{placeholder:'Type a message...',rows:'1'});
  ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage(ta.value);ta.value='';ta.style.height='auto';}});
  ta.addEventListener('input',()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,160)+'px';});

  view.appendChild(h('div',{className:'input-bar'},
    ta,
    h('button',{className:'send-btn',onClick:()=>{sendMessage(ta.value);ta.value='';ta.style.height='auto';},disabled:state.streaming?'true':null},'Send')
  ));

  setTimeout(()=>{renderMessages();scrollMessages();},0);
  return view;
}

function renderSettingsDropdown(){
  const s = state.chatSettings;
  if(!s) return h('div');
  const modes = [
    {id:'direct',icon:'\\u{1F4AC}',title:'Direct',desc:'Simple model chat — no tools or agents'},
    {id:'agent',icon:'\\u{1F916}',title:'Agent (ReAct)',desc:'Autonomous tool-calling agent with reasoning loop'},
    {id:'supervisor',icon:'\\u{1F9E0}',title:'Supervisor',desc:'Multi-agent hierarchy — delegates to specialist workers'},
  ];
  const modeCards = modes.map(m=>h('div',{className:'mode-card'+(s.mode===m.id?' selected':''),onClick:()=>{s.mode=m.id;saveChatSettings();render();}},
    h('div',{className:'mc-icon'},m.icon),
    h('div',{className:'mc-body'},
      h('div',{className:'mc-title'},m.title),
      h('div',{className:'mc-desc'},m.desc)
    )
  ));

  const sections = [
    h('div',{className:'settings-section'},
      h('div',{className:'sec-label'},'AI Mode'),
      h('div',{className:'mode-cards'},...modeCards)
    )
  ];

  /* Tools section (only for agent/supervisor) */
  if(s.mode==='agent'||s.mode==='supervisor'){
    const toolChips = (state.availableTools||[]).map(t=>{
      const active = s.enabledTools.includes(t.name);
      return h('span',{className:'tool-chip'+(active?' active':''),onClick:()=>{
        if(active) s.enabledTools=s.enabledTools.filter(n=>n!==t.name);
        else s.enabledTools.push(t.name);
        saveChatSettings(); render();
      }},t.name);
    });
    sections.push(h('div',{className:'settings-section'},
      h('div',{className:'sec-label'},'Tools'),
      h('div',{className:'tool-toggle'},...toolChips)
    ));
  }

  /* Redaction toggle */
  const redactToggle = h('div',{className:'toggle-switch'+(s.redactionEnabled?' on':''),onClick:()=>{
    s.redactionEnabled=!s.redactionEnabled; saveChatSettings(); render();
  }});
  sections.push(h('div',{className:'settings-section'},
    h('div',{className:'sec-row'},
      h('div',{className:'sec-label',style:'margin-bottom:0;flex:1'},'PII Redaction'),
      redactToggle
    )
  ));

  /* System prompt */
  const sysInput = h('input',{type:'text',value:s.systemPrompt||'',placeholder:'Custom system prompt...',style:'width:100%;padding:8px 10px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:13px',onChange:function(){s.systemPrompt=this.value;saveChatSettings();}});
  sections.push(h('div',{className:'settings-section'},
    h('div',{className:'sec-label'},'System Prompt'),
    sysInput
  ));

  const dd = h('div',{className:'dropdown settings-dd',onClick:e=>e.stopPropagation()},
    h('h3',null,h('span',{className:'ai-icon'},'\\u2699'),' Agentic AI Settings'),
    ...sections
  );
  return dd;
}

function renderProfileDropdown(){
  const u = state.user||{};
  const dd = h('div',{className:'dropdown profile-dd',onClick:e=>e.stopPropagation()},
    h('div',{className:'pf-name'},u.name||'User'),
    h('div',{className:'pf-email'},u.email||''),
    h('div',{className:'pf-divider'}),
    h('button',{className:'pf-btn',onClick:()=>{state.view='dashboard';state.showProfile=false;loadDashboard();}},'\\u{1F4CA} Dashboard'),
    h('button',{className:'pf-btn',onClick:()=>{state.view='admin';state.showProfile=false;loadAdmin();}},'\\u{2699}\\u{FE0F} Admin'),
    h('div',{className:'pf-divider'}),
    h('button',{className:'pf-btn danger',onClick:()=>{state.showProfile=false;doLogout();}},'\\u{1F6AA} Sign Out')
  );
  return dd;
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

  /* ── Agent Activity Accordion ─── */
  const activityData = d.agentActivity||[];
  if(activityData.length){
    const actSection = h('div',{className:'agent-activity'},
      h('h3',null,'\\u{1F916} Agent Activity')
    );

    activityData.forEach(a=>{
      const item = h('div',{className:'acc-item'});
      const modeIcon = a.mode==='supervisor'?'\\u{1F9E0}':a.mode==='agent'?'\\u{1F916}':'\\u{1F4AC}';
      const modeClass = 'acc-badge mode-'+a.mode;
      const timeStr = a.createdAt ? new Date(a.createdAt).toLocaleString() : '';
      const costStr = a.cost!=null ? '$'+a.cost.toFixed(6) : '';
      const tokStr = a.tokensUsed ? a.tokensUsed.toLocaleString()+' tok' : '';

      /* Header row */
      const hdr = h('div',{className:'acc-hdr',onClick:()=>{item.classList.toggle('open');}},
        h('span',{className:'acc-chevron'},'\\u25B6'),
        h('span',{className:'acc-icon'},modeIcon),
        h('div',{className:'acc-title'},
          h('div',{className:'acc-name'},a.agentName||a.mode+' call'),
          h('div',{className:'acc-sub'},
            h('span',null,a.provider+'/'+a.model),
            h('span',null,tokStr),
            h('span',null,costStr),
            h('span',null,(a.latencyMs||0)+'ms'),
            h('span',null,timeStr)
          )
        ),
        h('div',{className:'acc-badges'},
          h('span',{className:modeClass},a.mode),
          a.redactionEnabled ? h('span',{className:'acc-badge',style:'background:rgba(239,68,68,.15);color:var(--danger)'},'REDACT') : null,
          a.eval ? h('span',{className:'acc-badge',style:'background:'+(a.eval.passed>=a.eval.total?'rgba(34,197,94,.15);color:var(--success)':'rgba(239,68,68,.15);color:var(--danger)')},a.eval.score!=null?(a.eval.score*100).toFixed(0)+'%':'eval') : null
        )
      );
      item.appendChild(hdr);

      /* Body */
      const body = h('div',{className:'acc-body'});

      /* ─ Config section ─ */
      const configSec = h('div',{className:'acc-section'},h('div',{className:'asl'},'Configuration'));
      const configKv = h('div',{className:'acc-kv'});
      configKv.appendChild(h('span',{className:'ak'},'Agent'));
      configKv.appendChild(h('span',{className:'av mono'},a.agentName||'—'));
      configKv.appendChild(h('span',{className:'ak'},'Mode'));
      configKv.appendChild(h('span',{className:'av'},a.mode));
      configKv.appendChild(h('span',{className:'ak'},'Model'));
      configKv.appendChild(h('span',{className:'av mono'},a.provider+'/'+a.model));
      configKv.appendChild(h('span',{className:'ak'},'Chat'));
      configKv.appendChild(h('span',{className:'av'},a.chatTitle||a.chatId));
      configKv.appendChild(h('span',{className:'ak'},'Tokens'));
      configKv.appendChild(h('span',{className:'av'},tokStr||'—'));
      configKv.appendChild(h('span',{className:'ak'},'Cost'));
      configKv.appendChild(h('span',{className:'av'},costStr||'—'));
      configKv.appendChild(h('span',{className:'ak'},'Latency'));
      configKv.appendChild(h('span',{className:'av'},(a.latencyMs||0)+'ms'));
      if(a.traceId){
        configKv.appendChild(h('span',{className:'ak'},'Trace ID'));
        configKv.appendChild(h('span',{className:'av mono'},a.traceId));
      }
      configSec.appendChild(configKv);
      body.appendChild(configSec);

      /* ─ System Prompt section ─ */
      if(a.systemPrompt){
        body.appendChild(h('div',{className:'acc-section'},
          h('div',{className:'asl'},'System Prompt'),
          h('div',{className:'acc-prompt'},a.systemPrompt)
        ));
      }

      /* ─ Enabled Tools section ─ */
      if(a.enabledTools && a.enabledTools.length){
        const toolTags = a.enabledTools.map(t=>h('span',{className:'acc-tool-tag'},t));
        body.appendChild(h('div',{className:'acc-section'},
          h('div',{className:'asl'},'Enabled Tools'),
          h('div',{className:'acc-tools'},...toolTags)
        ));
      }

      /* ─ Steps accordion ─ */
      if(a.steps && a.steps.length){
        const stepsSec = h('div',{className:'acc-section'},h('div',{className:'asl'},'Execution Steps ('+a.steps.length+')'));
        const stepsWrap = h('div',{className:'step-acc'});
        a.steps.forEach((s,i)=>{
          const sItem = h('div',{className:'step-acc-item'});
          const sIcon = s.type==='thinking'?'\\u{1F4AD}':s.toolCall?'\\u{1F527}':s.delegation?'\\u{1F91D}':'\\u25CF';
          const sTitle = s.toolCall ? 'Tool: '+s.toolCall.name : s.delegation ? 'Delegate: '+(s.delegation.worker||s.delegation.name||'') : s.type||'step';
          const sDur = s.durationMs!=null ? s.durationMs+'ms' : '';

          sItem.appendChild(h('div',{className:'step-acc-hdr',onClick:()=>{sItem.classList.toggle('open');}},
            h('span',{className:'step-acc-chevron'},'\\u25B6'),
            h('span',{className:'step-acc-icon'},sIcon),
            h('span',{className:'step-acc-title'},'Step '+(i+1)+': '+sTitle),
            h('span',{className:'step-acc-dur'},sDur)
          ));

          const sBody = h('div',{className:'step-acc-body'});

          /* Step type info */
          if(s.toolCall){
            sBody.appendChild(h('div',{className:'step-label'},'Tool Name'));
            sBody.appendChild(h('pre',null,s.toolCall.name));
            if(s.toolCall.arguments!=null){
              sBody.appendChild(h('div',{className:'step-label'},'Input'));
              sBody.appendChild(h('pre',null,typeof s.toolCall.arguments==='string'?s.toolCall.arguments:JSON.stringify(s.toolCall.arguments,null,2)));
            }
            if(s.toolCall.result!=null){
              sBody.appendChild(h('div',{className:'step-label'},'Output'));
              sBody.appendChild(h('pre',null,typeof s.toolCall.result==='string'?s.toolCall.result:JSON.stringify(s.toolCall.result,null,2)));
            }
          } else if(s.delegation){
            sBody.appendChild(h('div',{className:'step-label'},'Worker'));
            sBody.appendChild(h('pre',null,JSON.stringify(s.delegation,null,2)));
          }
          if(s.content){
            sBody.appendChild(h('div',{className:'step-label'},'Content'));
            sBody.appendChild(h('pre',null,s.content));
          }

          sItem.appendChild(sBody);
          stepsWrap.appendChild(sItem);
        });
        stepsSec.appendChild(stepsWrap);
        body.appendChild(stepsSec);
      }

      /* ─ Eval section ─ */
      if(a.eval){
        const ev = a.eval;
        const evalKv = h('div',{className:'acc-kv'});
        evalKv.appendChild(h('span',{className:'ak'},'Score'));
        evalKv.appendChild(h('span',{className:'av'},(ev.score!=null?(ev.score*100).toFixed(1)+'%':'—')));
        evalKv.appendChild(h('span',{className:'ak'},'Passed'));
        evalKv.appendChild(h('span',{className:'av'},ev.passed+'/'+ev.total));
        body.appendChild(h('div',{className:'acc-section'},
          h('div',{className:'asl'},'Evaluation'),
          evalKv
        ));
      }

      /* ─ Response preview ─ */
      if(a.content){
        const preview = a.content.length>300 ? a.content.slice(0,300)+'…' : a.content;
        body.appendChild(h('div',{className:'acc-section'},
          h('div',{className:'asl'},'Response Preview'),
          h('div',{className:'acc-prompt'},preview)
        ));
      }

      item.appendChild(body);
      actSection.appendChild(item);
    });

    view.appendChild(actSection);
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
document.addEventListener('click',()=>{
  if(state.showSettings||state.showProfile){state.showSettings=false;state.showProfile=false;render();}
});
(async()=>{
  const r = await api.get('/auth/me');
  if(r.ok){
    const d = await r.json();
    state.user = d.user; state.csrfToken = d.csrfToken;
    await loadChats(); await Promise.all([loadModels(), loadTools(), loadUserPreferences()]);
  }
  render();
})();
</script>
</body>
</html>`;
}
