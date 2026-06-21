// CSS styles for geneWeave UI
// This is embedded in the HTML as a <style> tag

export const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;700&family=JetBrains+Mono:wght@400;500&family=Fira+Code:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#EDF5F0;--bg2:#F7FBF8;--bg3:#F5F7F6;--bg4:#E2EAE5;
  --fg:#1A2B23;--fg2:#5A6B63;--fg3:#8A9B93;
  --accent:#2AB090;--accent2:#1E8A6F;--accent-dim:#E0F5EE;
  --solid:#1A2B23;--solid-hover:#24382F;--solid-contrast:#FFFFFF;
  --danger:#dc2626;--success:#16a34a;--warn:#d97706;
  --radius:12px;--radius-lg:16px;
  --font:'DM Sans','Plus Jakarta Sans',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-display:'Plus Jakarta Sans','DM Sans',sans-serif;
  --mono:'JetBrains Mono','Fira Code',SFMono-Regular,Menlo,Consolas,monospace;
  --shadow-soft:0 1px 3px rgba(26,43,35,.06),0 8px 20px rgba(26,43,35,.06);
  --shadow-hover:0 2px 8px rgba(26,43,35,.10),0 14px 28px rgba(26,43,35,.10);
}
html[data-theme='dark']{
  --bg:#0E1713;--bg2:#121E19;--bg3:#1A2B23;--bg4:#2E4339;
  --fg:#E5F2EC;--fg2:#B4CBC0;--fg3:#88A498;
  --accent:#34C9A5;--accent2:#2AB090;--accent-dim:#1C3A31;
  --solid:#28453A;--solid-hover:#315447;--solid-contrast:#F7FBF8;
  --danger:#F87171;--success:#4ADE80;--warn:#FBBF24;
  --shadow-soft:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.35);
  --shadow-hover:0 2px 8px rgba(0,0,0,.45),0 16px 32px rgba(0,0,0,.45);
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
.auth-card .btn{width:100%;padding:12px;border-radius:999px;background:var(--solid);color:var(--solid-contrast);font-weight:600;font-size:14px;margin-top:8px;transition:background .18s ease}
.auth-card .btn:hover{background:var(--solid-hover)}
.auth-card .divider{margin:16px 0;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fg3)}
.auth-card .divider .line{flex:1;height:1px;background:var(--bg4)}
.auth-card .oauth-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.auth-card .oauth-btn{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 12px;border:1px solid var(--bg4);border-radius:var(--radius);background:var(--bg3);color:var(--fg2);font-weight:600;font-size:12px;transition:all .18s ease;cursor:pointer}
.auth-card .oauth-btn:hover{background:var(--bg4);border-color:var(--fg3);color:var(--fg)}
.auth-card .toggle{text-align:center;margin-top:16px;font-size:13px;color:var(--fg3)}
.auth-card .toggle a{cursor:pointer;color:var(--accent);font-weight:500}
.auth-card .err{color:var(--danger);font-size:13px;margin-top:8px;min-height:18px}

/* ── Layout ─────────────────────────────────── */
.app{display:flex;height:100vh;overflow:hidden;background:var(--bg)}
.sidebar{width:280px;background:var(--bg2);border-right:1px solid var(--bg4);display:flex;flex-direction:column}
.sidebar-hdr{padding:20px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between}
.sidebar-hdr h2{font-size:16px;font-weight:700;display:flex;align-items:center;gap:6px;color:var(--fg)}
.sidebar-hdr h2 span{color:var(--accent)}
.new-chat-btn{padding:8px 16px;border-radius:999px;background:var(--solid);color:var(--solid-contrast);font-size:13px;font-weight:600;transition:background .18s ease}
.new-chat-btn:hover{background:var(--solid-hover)}
.chat-list{flex:1;overflow-y:auto;padding:8px 12px}
.chat-item{padding:10px 14px;border-radius:var(--radius);font-size:14px;color:var(--fg2);cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:all .18s ease}
.chat-item:hover{background:var(--bg3)}
.chat-item.active{background:var(--solid);color:var(--solid-contrast)}
.chat-item .del{opacity:0;color:var(--fg3);font-size:16px;padding:0 4px;transition:opacity .18s}
.chat-item:hover .del{opacity:1}
.chat-item.active .del{color:rgba(255,255,255,.6)}
.chat-item .del:hover{color:var(--danger)}
.sidebar-footer{padding:16px 20px;border-top:1px solid var(--bg4);display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--fg3)}
.sidebar-footer .user-email{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-btn{padding:6px 14px;border-radius:999px;font-size:12px;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);font-weight:500;transition:all .18s ease}
.nav-btn:hover{background:var(--bg);border-color:var(--fg3);color:var(--fg)}
.nav-btn.active{background:var(--solid);color:var(--solid-contrast);border-color:var(--solid)}
.logout-btn{padding:6px 14px;border-radius:999px;font-size:12px;color:var(--danger);background:var(--bg3);border:1px solid var(--bg4)}
.logout-btn:hover{background:rgba(220,38,38,.06);border-color:var(--danger)}

/* ── Main content area ──────────────────────── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
.main-header{padding:18px 22px 0;flex:0 0 auto}

/* ── Workspace shell (new UI) ───────────────── */
.workspace-nav{width:252px;background:var(--bg2);border-right:1px solid var(--bg4);padding:20px 14px;display:flex;flex-direction:column;gap:18px;transition:width .18s ease,padding .18s ease;height:100vh;min-height:100vh;max-height:100vh;overflow:hidden}
.workspace-nav.collapsed{width:74px;padding:20px 10px}
.workspace-nav-scroll{display:flex;flex-direction:column;gap:18px;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;overscroll-behavior:contain}
.workspace-nav-scroll::-webkit-scrollbar{width:11px}
.workspace-nav-scroll::-webkit-scrollbar-track{background:color-mix(in oklab,var(--bg4) 45%, transparent);border-radius:999px}
.workspace-nav-scroll::-webkit-scrollbar-thumb{background:color-mix(in oklab,var(--fg2) 55%, var(--bg4));border-radius:999px;border:2px solid var(--bg2)}
.workspace-nav-scroll::-webkit-scrollbar-thumb:hover{background:var(--fg2)}
.sidebar-scroll-controls{display:flex;align-items:center;gap:6px;margin-top:-8px}
.sidebar-scroll-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);font-size:12px;font-weight:700}
.sidebar-scroll-btn:hover{background:var(--bg);color:var(--fg)}
.brand{display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-weight:700;font-size:20px;color:var(--fg);padding:4px 10px}
.brand-mark{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}
.sidebar-collapse-btn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--bg4);border-radius:7px;background:var(--bg3);color:var(--fg2);font-size:12px;cursor:pointer}
.sidebar-collapse-btn:hover{background:var(--bg);color:var(--fg)}
.workspace-menu{display:flex;flex-direction:column;gap:6px}
.workspace-menu button,.workspace-menu a{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;padding:10px 12px;border-radius:10px;color:var(--fg2);font-size:13px;font-weight:600;border:1px solid transparent;background:transparent;transition:all .16s ease;min-height:38px}
.workspace-menu button:hover,.workspace-menu a:hover{background:var(--bg3);border-color:var(--bg4);color:var(--fg)}
.workspace-menu .active{background:var(--accent-dim);color:var(--accent2);border-color:color-mix(in oklab,var(--accent) 45%, var(--bg4));box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--accent) 18%, transparent)}
.workspace-menu button:focus-visible,.workspace-menu a:focus-visible,.admin-subtab:focus-visible,.admin-group-btn:focus-visible,.workspace-history-toggle:focus-visible{outline:2px solid color-mix(in oklab,var(--accent) 78%, white);outline-offset:2px}
.nav-label{flex:1;text-align:left;letter-spacing:.01em;line-height:1.25}
.side-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--fg3);flex:0 0 16px}
.side-icon svg{width:16px;height:16px;display:block}
.workspace-menu button:hover .side-icon,.workspace-menu a:hover .side-icon{color:var(--fg2)}
.workspace-menu .active .side-icon{color:var(--accent2)}
.admin-nav-tree{display:flex;flex-direction:column;gap:6px}
.admin-parent{justify-content:space-between;width:100%}
.admin-parent .nav-label{margin-right:10px}
.admin-caret{margin-left:auto;font-size:11px;opacity:.68;transition:transform .16s ease}
.admin-caret.open{transform:rotate(180deg)}
.admin-nav-sub{margin-top:-2px;margin-left:6px;display:flex;flex-direction:column;gap:6px;padding-left:16px;border-left:1px solid color-mix(in oklab,var(--fg3) 24%, transparent)}
.admin-group-btn{display:flex;align-items:center;justify-content:space-between;width:100%;font-size:11px;font-weight:700;letter-spacing:.045em;text-transform:uppercase;color:var(--fg3);background:var(--bg3);border:1px solid var(--bg4);border-radius:9px;padding:7px 9px;min-height:34px}
.admin-group-btn:hover{background:var(--bg);color:var(--fg2)}
.admin-group-list{display:flex;flex-direction:column;gap:4px;padding-left:20px}
.admin-subtab{display:flex;align-items:center;justify-content:flex-start;text-align:left;width:100%;font-size:12px;font-weight:600;color:var(--fg2);background:transparent;border:1px solid transparent;border-radius:8px;padding:7px 10px;min-height:34px}
.admin-subtab::before{content:'';width:4px;height:4px;border-radius:50%;background:color-mix(in oklab,var(--fg3) 70%, transparent);margin-right:8px;flex:0 0 auto}
.admin-subtab:hover{background:var(--bg3);color:var(--fg)}
.admin-subtab:hover::before{background:var(--fg2)}
.admin-subtab.active{background:var(--accent-dim);color:var(--accent2);border-color:color-mix(in oklab,var(--accent) 32%, var(--bg4))}
.admin-subtab.active::before{background:var(--accent2)}
.workspace-history{display:flex;flex-direction:column;gap:8px;min-height:0}
.workspace-history-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;background:transparent;border:1px solid transparent;border-radius:10px;padding:6px 8px;color:var(--fg3);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.workspace-history-toggle:hover{background:var(--bg3);border-color:var(--bg4);color:var(--fg2)}
.workspace-history-label{padding:0 2px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:inherit}
.workspace-history-empty{padding:0 10px;font-size:12px;color:var(--fg3)}
.chat-item{align-items:flex-start;gap:10px}
.chat-item-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.chat-item-title{font-size:13px;font-weight:700;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-item-meta{font-size:11px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-item.active .chat-item-meta{color:rgba(255,255,255,.72)}
.workspace-spacer{display:none}
@media (prefers-reduced-motion: reduce){.workspace-menu button,.workspace-menu a,.admin-caret{transition:none}}

.workspace-nav.collapsed .word,
.workspace-nav.collapsed .nav-label,
.workspace-nav.collapsed .workspace-history,
.workspace-nav.collapsed .admin-caret,
.workspace-nav.collapsed .admin-nav-sub{display:none}
.workspace-nav.collapsed .workspace-menu{gap:8px}
.workspace-nav.collapsed .workspace-menu button,
.workspace-nav.collapsed .workspace-menu a{justify-content:center;padding:10px 0}
.workspace-nav.collapsed .side-icon{width:18px;height:18px;flex:0 0 18px}
.workspace-nav.collapsed .sidebar-collapse-btn{margin-left:0}
.workspace-home{flex:1;display:flex;flex-direction:column;padding:14px 22px 18px;gap:14px;overflow:hidden;min-height:0}
.workspace-top-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:18px;padding:14px 16px;display:grid;grid-template-columns:auto auto 1fr auto;gap:14px;align-items:center;box-shadow:var(--shadow-soft)}
.user-chip{display:flex;align-items:center;gap:10px;min-width:220px}
.user-chip img{width:36px;height:36px;border-radius:50%;object-fit:cover}
.user-chip .name{font-weight:700;font-size:13px;color:var(--fg)}
.user-chip .role{font-size:11px;color:var(--fg3)}
.today-badge{display:inline-flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--bg4);padding:8px 12px;border-radius:10px;font-size:12px;color:var(--fg2);font-weight:700}
.semantic-search{position:relative}
.semantic-search input{width:100%;padding:10px 14px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg3);font-size:13px;color:var(--fg)}
.semantic-search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.search-dd{position:absolute;left:0;right:0;top:46px;z-index:60;background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;box-shadow:var(--shadow-hover);max-height:280px;overflow-y:auto}
.search-item{padding:10px 12px;border-bottom:1px solid var(--bg4);cursor:pointer}
.search-item:last-child{border-bottom:none}
.search-item:hover{background:var(--bg3)}
.search-item .ttl{font-size:13px;font-weight:700;color:var(--fg)}
.search-item .sub{font-size:11px;color:var(--fg3);margin-top:2px}
.top-actions{display:flex;align-items:center;gap:8px}
.icon-circle{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg2);font-size:14px;position:relative}
.ui-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;color:var(--fg3);opacity:.85;font-size:13px;line-height:1}
.notif-dot{position:absolute;top:7px;right:9px;width:8px;height:8px;border-radius:50%;background:var(--danger)}
.profile-avatar{width:38px;height:38px;border-radius:50%;background:var(--solid);color:var(--solid-contrast);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;cursor:pointer;border:2px solid transparent;transition:all .18s ease;overflow:hidden}
.profile-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.profile-avatar:hover{border-color:var(--fg3)}
.workspace-body{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:14px;flex:1;overflow:hidden;align-items:stretch;min-height:0}
.center-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:20px;display:flex;flex-direction:column;min-height:0;overflow:hidden;box-shadow:var(--shadow-soft);height:100%;align-self:stretch}
.center-card-hdr{padding:14px 16px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between;gap:12px}
.agent-strip{display:flex;align-items:center;gap:8px}
.agent-strip .lead{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--fg)}
.agent-strip .lead img{width:34px;height:34px;border-radius:50%;object-fit:cover;border:1px solid var(--bg4)}
.worker-avatars{display:flex;align-items:center}
.worker-avatars img{width:24px;height:24px;border-radius:50%;object-fit:cover;border:2px solid var(--bg2);margin-left:-6px;background:var(--bg3)}
.center-card-hdr .title{font-size:13px;color:var(--fg2);font-weight:600}
.right-rail{display:flex;flex-direction:column;gap:10px;min-height:0;height:100%;align-self:stretch}
.side-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:18px;padding:14px;box-shadow:var(--shadow-soft)}
.side-card h3{font-size:14px;font-weight:800;font-family:var(--font-display);margin-bottom:8px}
.schedule-card{padding:0;overflow:hidden;display:flex;flex-direction:column;flex:1;min-height:0}
.schedule-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px;padding:8px 8px 7px;border-bottom:1px solid var(--bg4)}
.schedule-head .ttl{font-size:15px;font-family:var(--font-display);font-weight:700;display:flex;align-items:center;gap:6px}
.see-all{font-size:9.5px;font-weight:700;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);padding:5px 7px;border-radius:9px;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;min-width:max-content}
.month-nav{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0}
.month-pill{flex:1;text-align:center;font-size:11px;font-weight:800;color:var(--fg);background:var(--bg3);border:1px solid var(--bg4);border-radius:8px;padding:5px 0;min-width:70px}
.icon-btn-sm{width:20px;height:20px;border-radius:7px;background:var(--bg3);border:1px solid var(--bg4);display:flex;align-items:center;justify-content:center;color:var(--fg2);font-size:11px}
.day-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:8px 12px 8px}
.day-chip{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:5px 3px;text-align:center;cursor:pointer;transition:all .15s ease}
.day-chip:hover{border-color:var(--fg3)}
.day-chip .dw{font-size:9px;color:var(--fg3);font-weight:700}
.day-chip .dn{font-size:12px;line-height:1.1;font-weight:800;color:var(--fg);margin-top:2px}
.day-chip.active{background:#6B4CE6;border-color:#6B4CE6}
.day-chip.active .dw,.day-chip.active .dn{color:#fff}
.month-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;padding:8px 10px}
.month-grid .mh{font-size:10px;color:var(--fg3);text-align:center;font-weight:700;padding:2px 0}
.month-grid .md{border:1px solid var(--bg4);background:var(--bg2);border-radius:8px;min-height:24px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--fg2);cursor:pointer;transition:all .15s ease}
.month-grid .md:hover{border-color:var(--fg3)}
.month-grid .md.empty{visibility:hidden}
.month-grid .md.active{background:#6B4CE6;color:#fff;border-color:#6B4CE6}
.month-grid .md.has{background:var(--accent-dim);color:var(--accent);border-color:rgba(37,99,235,.2)}
.month-grid .md.has.active{background:#6B4CE6;color:#fff;border-color:#6B4CE6}
.schedule-search{padding:0 12px 8px}
.schedule-search .search-row{display:flex;align-items:center;gap:8px;border:1px solid var(--bg4);background:var(--bg3);border-radius:11px;padding:8px 10px;font-size:12px;color:var(--fg3)}
.schedule-tabs{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--bg4);border-bottom:1px solid var(--bg4)}
.schedule-tab{padding:9px 8px;text-align:center;font-size:11px;color:var(--fg2);font-weight:700;position:relative;cursor:pointer}
.schedule-tab.active{color:#6B4CE6}
.schedule-tab.active::after{content:'';position:absolute;left:14px;right:14px;bottom:0;height:2px;background:#6B4CE6;border-radius:2px}
.schedule-meetings{padding:9px 12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:120px}
.meet-card{border-radius:14px;padding:12px 12px 10px;border:1px solid transparent}
.meet-card.peach{background:#F6E2D2;border-color:#ECC8AA}
.meet-card.blue{background:#DDE6FB;border-color:#C5D6FA}
.meet-title{font-size:13px;font-weight:800;color:#3f2b1c}
.meet-card.blue .meet-title{color:#1f3463}
.meet-time{font-size:12px;color:rgba(39,39,39,.62);margin-top:4px}
.meet-row{display:flex;align-items:center;justify-content:space-between;margin-top:8px}
.mini-avatars{display:flex;align-items:center}
.mini-avatars img{width:18px;height:18px;border-radius:50%;object-fit:cover;border:1.5px solid rgba(255,255,255,.85);margin-left:-6px}
.mini-avatars img:first-child{margin-left:0}
.mini-more{font-size:11px;color:rgba(39,39,39,.62);margin-left:6px;font-weight:700}
.tag{font-size:10px;font-weight:800;letter-spacing:.2px;color:#A35B1E;border:1px solid #C97E3F;background:rgba(255,255,255,.55);padding:2px 8px;border-radius:999px}
.action-list{display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto}
.actions-card{margin-top:auto;display:flex;flex-direction:column;min-height:180px;max-height:200px}
.actions-card h3{margin-bottom:10px}
.action-item{padding:9px 10px;border-radius:10px;border:1px solid var(--bg4);background:var(--bg3)}
.action-item.selectable{cursor:pointer;transition:all .18s ease}
.action-item.selectable:hover{background:var(--bg2);border-color:var(--fg3)}
.action-item.active{border-color:rgba(37,99,235,.3);background:var(--accent-dim)}
.action-item .at{font-size:12px;font-weight:700;color:var(--fg)}
.action-item .as{font-size:11px;color:var(--fg3);margin-top:2px}
.notif-list{max-height:280px;overflow-y:auto}
.notif-item{padding:10px 0;border-bottom:1px solid var(--bg4)}
.notif-item:last-child{border-bottom:none}
.notif-item .nt{font-size:13px;color:var(--fg);font-weight:700}
.notif-item .ns{font-size:11px;color:var(--fg3);margin-top:2px}

/* ── Chat view ──────────────────────────────── */
.chat-view{flex:1;display:flex;flex-direction:column;overflow:hidden}
.messages{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:20px}
.msg{max-width:620px;width:100%;margin:0 auto;display:flex;gap:12px;align-items:flex-start}
.msg.user{flex-direction:row-reverse}
.msg .avatar{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0;overflow:hidden}
.msg .avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.msg.user .avatar{background:var(--solid);color:var(--solid-contrast)}
.msg.assistant .avatar{background:var(--bg3);color:var(--fg2);border:1px solid var(--bg4)}
.msg .bubble{padding:14px 18px;border-radius:var(--radius-lg);font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user .bubble{background:var(--solid);color:var(--solid-contrast);border-bottom-right-radius:4px}
.msg.assistant .bubble{background:var(--bg2);color:var(--fg);border:1px solid var(--bg4);border-bottom-left-radius:4px;box-shadow:var(--shadow-soft);white-space:normal}
.msg .meta{font-size:11px;color:var(--fg3);margin-top:6px}
.msg .meta span{margin-right:10px}
.msg-body{position:relative}
.resp-corner{position:absolute;top:-8px;right:-8px;display:flex;gap:6px;z-index:3}
.resp-ind{width:22px;height:22px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg3);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:var(--shadow-soft);cursor:help}
.resp-ind.ok{color:var(--success);border-color:rgba(22,163,74,.25)}
.resp-ind.warn{color:var(--warn);border-color:rgba(217,119,6,.3)}
.resp-ind.deny{color:var(--danger);border-color:rgba(220,38,38,.28)}

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
.msg.assistant .bubble .response-rich{display:flex;flex-direction:column;gap:12px}
.msg.assistant .bubble .response-rich-embedded{margin-top:12px}
.msg.assistant .bubble .response-note{margin:0;font-size:13px;line-height:1.6;color:var(--fg2)}
.msg.assistant .bubble .response-table-wrap{overflow:auto;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2)}
.msg.assistant .bubble .response-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
.msg.assistant .bubble .response-table th,.msg.assistant .bubble .response-table td{padding:8px 10px;border-right:1px solid var(--bg4);border-bottom:1px solid var(--bg4);text-align:left;vertical-align:top}
.msg.assistant .bubble .response-table th:last-child,.msg.assistant .bubble .response-table td:last-child{border-right:0}
.msg.assistant .bubble .response-table tr:last-child td{border-bottom:0}
.msg.assistant .bubble .response-table th{background:var(--bg3);font-weight:700;color:var(--fg);position:sticky;top:0;z-index:1}
.msg.assistant .bubble .response-table td{font-family:var(--mono);font-size:11.5px;color:var(--fg2);white-space:pre-wrap;word-break:break-word;max-width:340px}
.msg.assistant .bubble .response-chart{border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);padding:10px}
.msg.assistant .bubble .response-chart-title{font-size:12px;font-weight:700;color:var(--fg);margin-bottom:8px}
.msg.assistant .bubble .response-bars{display:flex;flex-direction:column;gap:6px}
.msg.assistant .bubble .response-bar-row{display:grid;grid-template-columns:minmax(80px,140px) 1fr minmax(56px,90px);align-items:center;gap:8px}
.msg.assistant .bubble .response-bar-label{font-size:11px;color:var(--fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msg.assistant .bubble .response-bar-track{height:8px;border-radius:999px;background:var(--bg3);overflow:hidden}
.msg.assistant .bubble .response-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),#2AB090)}
.msg.assistant .bubble .response-bar-value{font-size:11px;color:var(--fg3);text-align:right;font-family:var(--mono)}
.msg.assistant .bubble .response-line svg{width:100%;height:180px;display:block}
.msg.assistant .bubble .response-line-axis{stroke:var(--bg4);stroke-width:1}
.msg.assistant .bubble .response-line-path{fill:none;stroke:var(--accent);stroke-width:2}
.msg.assistant .bubble .response-line-dot{fill:var(--accent)}
.msg.assistant .bubble .response-line-labels{display:flex;justify-content:space-between;gap:6px;margin-top:6px}
.msg.assistant .bubble .response-line-labels span{font-size:10px;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px}
.msg.assistant .bubble .detail-block{border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);overflow:hidden}
.msg.assistant .bubble .detail-block-hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--bg4);background:var(--bg3)}
.msg.assistant .bubble .detail-lang{font-size:10px;font-weight:700;letter-spacing:.3px;color:var(--fg3);text-transform:uppercase}
.msg.assistant .bubble .detail-kind{font-size:10px;color:var(--fg3)}
.msg.assistant .bubble .detail-block-actions{display:flex;align-items:center;gap:6px}
.msg.assistant .bubble .detail-copy-btn{font-size:10px;line-height:1;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);border-radius:999px;padding:4px 8px;cursor:pointer}
.msg.assistant .bubble .detail-copy-btn:hover{border-color:var(--fg3);color:var(--fg)}
.msg.assistant .bubble .detail-copy-btn.copied{border-color:rgba(22,163,74,.25);background:rgba(22,163,74,.1);color:var(--success)}
.msg.assistant .bubble .detail-code{margin:0;padding:8px 10px;font-size:11px;line-height:1.45;color:var(--fg2);font-family:var(--mono);white-space:pre;overflow:auto;max-height:260px}

/* ── Response toolbar ───────────────────── */
.response-toolbar{display:flex;gap:4px;margin-top:8px;opacity:0;transition:opacity .18s ease}
.msg.assistant:hover .response-toolbar{opacity:1}
.tb-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:500;color:var(--fg3);background:var(--bg3);border:1px solid var(--bg4);cursor:pointer;transition:all .18s ease;font-family:var(--font)}
.tb-btn:hover{color:var(--fg);background:var(--bg);border-color:var(--fg3)}
.tb-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.tb-btn.copied{color:var(--success);border-color:var(--success);background:rgba(22,163,74,.06)}
.copy-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:var(--solid);color:var(--solid-contrast);padding:8px 20px;border-radius:999px;font-size:13px;font-weight:500;z-index:10001;opacity:0;transition:opacity .2s;pointer-events:none}
.copy-toast.show{opacity:1}
.empty-chat{flex:1;display:flex;align-items:center;justify-content:center;color:var(--fg3);font-size:15px;flex-direction:column;gap:8px}
.empty-chat .logo{font-size:48px;margin-bottom:8px}

/* ── Input bar ──────────────────────────────── */
.input-bar{padding:20px 32px;border-top:1px solid var(--bg4);display:flex;gap:12px;align-items:flex-end;background:var(--bg2)}
.input-bar textarea{flex:1;padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;resize:none;min-height:48px;max-height:160px;line-height:1.5;font-family:var(--font);transition:border-color .18s ease}
.input-bar textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.input-bar .send-btn{padding:12px 24px;border-radius:999px;background:var(--solid);color:var(--solid-contrast);font-weight:600;font-size:14px;height:48px;transition:background .18s ease}
.input-bar .send-btn:hover{background:var(--solid-hover)}
.input-bar .send-btn:disabled{opacity:.4;cursor:not-allowed}
.input-bar .model-sel{padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);font-size:13px;height:48px}
.routing-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);font-family:var(--font);font-size:13px;font-weight:500;cursor:help;white-space:nowrap;box-sizing:border-box;line-height:1.4}
.routing-badge svg{width:12px;height:12px;opacity:.5;color:var(--fg3);flex-shrink:0}
.input-tools{display:flex;align-items:center;gap:8px}
.tool-btn{width:42px;height:42px;border-radius:12px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .18s ease}
.tool-btn:hover{background:var(--bg2);border-color:var(--fg3);color:var(--fg)}
.tool-btn.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.mic-btn{background:transparent;border-color:var(--bg4);color:var(--fg3);filter:grayscale(1)}
.mic-btn svg{display:block;opacity:.75}
.mic-btn:hover{background:transparent;border-color:var(--fg3);color:var(--fg2)}
.mic-btn:hover svg{opacity:1}
.mic-btn.active{background:transparent;border-color:var(--fg2);color:var(--fg);filter:none;animation:mic-pulse 1.4s ease-in-out infinite}
.mic-btn.active svg{opacity:1}
@keyframes mic-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}50%{box-shadow:0 0 0 4px rgba(255,255,255,.08)}}
.voice-agent-btn{position:relative}
.voice-agent-btn.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.voice-agent-btn circle{display:none}
.voice-agent-btn.active circle{display:block}
/* ── Voice agent bar ─────────────────────────────── */
.voice-bar{background:var(--bg3);border:1px solid var(--accent);border-radius:var(--radius);padding:10px 14px;display:flex;flex-direction:column;gap:8px;margin-bottom:4px}
.voice-bar-top{display:flex;align-items:center;gap:8px}
.voice-status-indicator{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--fg3)}
.voice-status-indicator.voice-status-idle{background:var(--fg3)}
.voice-status-indicator.voice-status-listening{background:var(--success);animation:va-pulse 2s ease-in-out infinite}
.voice-status-indicator.voice-status-recording{background:var(--danger);animation:va-pulse 0.8s ease-in-out infinite}
.voice-status-indicator.voice-status-processing{background:var(--warn);animation:va-pulse 1.1s ease-in-out infinite}
.voice-status-indicator.voice-status-playing{background:var(--accent);animation:va-pulse 0.55s ease-in-out infinite}
.voice-status-indicator.voice-status-paused{background:var(--fg3)}
@keyframes va-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.voice-status-label{font-size:12px;font-weight:600;color:var(--fg2);flex:1}
.voice-pause-btn{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--fg3);padding:3px 10px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg2);white-space:nowrap}
.voice-pause-btn:hover{color:var(--fg);border-color:var(--fg3)}
.voice-pause-btn.resume{color:var(--success);border-color:var(--success)}
.voice-pause-btn.resume:hover{background:rgba(22,163,74,.08)}
.voice-end-btn{font-size:13px;font-weight:600;color:var(--fg3);padding:3px 8px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg2)}
.voice-end-btn:hover{color:var(--danger);border-color:var(--danger)}
.voice-settings-btn{font-size:14px;color:var(--fg3);padding:3px 7px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg2);line-height:1}
.voice-settings-btn:hover{color:var(--fg);border-color:var(--fg3)}
.voice-settings-btn.active{color:var(--accent);border-color:var(--accent);background:var(--accent-dim)}
/* ── Voice settings panel ──────────────────────────── */
.va-settings-panel{display:flex;flex-direction:column;gap:6px;padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--bg4)}
.vs-row{display:flex;align-items:center;gap:8px;min-height:28px}
.vs-label{font-size:11px;font-weight:600;color:var(--fg3);width:72px;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em}
.vs-select{font-size:12px;color:var(--fg);background:var(--bg3);border:1px solid var(--bg4);border-radius:6px;padding:2px 6px;flex:1}
.vs-select:focus{outline:none;border-color:var(--accent)}
.vs-mode-toggle{display:flex;gap:4px;flex:1}
.vs-mode-btn{font-size:11px;font-weight:600;color:var(--fg3);padding:3px 8px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg3);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.vs-mode-btn:hover{color:var(--fg);border-color:var(--fg3)}
.vs-mode-btn.active{color:var(--accent);border-color:var(--accent);background:var(--accent-dim)}
.vs-speed-wrap{display:flex;align-items:center;gap:6px;flex:1}
.vs-speed-range{flex:1;accent-color:var(--accent)}
.vs-speed-val{font-size:11px;color:var(--fg2);min-width:36px;text-align:right}
.vs-note{font-size:10px;color:var(--fg3);font-style:italic;padding:2px 0}
/* ── Waveform ──────────────────────────────────────── */
.va-waveform{display:flex;align-items:center;justify-content:center;gap:3px;height:44px;background:var(--bg2);border-radius:8px;padding:0 8px}
.va-wave-bar{width:3px;height:4px;border-radius:999px;background:var(--accent);transition:height 0.05s ease;will-change:height;flex-shrink:0}
.va-waveform.paused .va-wave-bar{background:var(--fg3)!important;height:4px!important}
/* ── Exchange ──────────────────────────────────────── */
.voice-exchange{display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.5;max-height:72px;overflow-y:auto;padding:2px 0}
.voice-you{color:var(--fg)}
.voice-agent-line{color:var(--fg2)}
.voice-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--fg3);margin-right:4px}
.voice-error{font-size:11px;color:var(--danger);padding:4px 8px;background:rgba(220,38,38,.08);border-radius:6px}
.composer-wrap{flex:1;display:flex;flex-direction:column;gap:8px}
.attach-strip{display:flex;flex-wrap:wrap;gap:8px}
.attach-chip{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg3);border:1px solid var(--bg4);border-radius:999px;font-size:12px;color:var(--fg2);max-width:340px}
.attach-chip .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attach-chip .remove{width:18px;height:18px;border-radius:999px;background:var(--bg2);border:1px solid var(--bg4);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--fg3)}
.attach-chip .remove:hover{color:var(--danger);border-color:var(--danger)}
.msg-attachments{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.msg-attachment{border:1px solid var(--bg4);background:var(--bg3);border-radius:10px;padding:8px 10px;font-size:12px;color:var(--fg2)}
.msg-attachment .title{font-weight:700;color:var(--fg);margin-bottom:2px}
.msg-attachment audio{width:100%;margin-top:6px}
.msg-attachment pre{max-height:180px;overflow:auto;margin-top:6px;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:8px}

/* ── Agent steps & tool calls ───────────– */
.step-card{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:12px 16px;margin:8px 0;font-size:13px}
.step-card .step-hdr{display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:.3px}
.step-card .step-body{color:var(--fg2);white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;max-height:200px;overflow-y:auto}

/* ── Process card ───────────────────– */
.process-card{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);margin:8px 0;overflow:hidden}
.process-card.running{border-color:rgba(42,176,144,.22)}
.process-card .process-hdr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:rgba(0,0,0,.02)}
.process-card .process-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--fg);text-transform:uppercase;letter-spacing:.3px}
.process-card .process-stage{display:inline-flex;align-items:center;gap:6px;font-size:10px;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent2);border:1px solid rgba(42,176,144,.2)}
.process-card .process-stage-icon{font-size:11px;line-height:1}
.process-card .process-hdr-main{min-width:0;flex:1}
.process-card .process-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.process-card .summary-chip{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:999px;background:var(--bg2);border:1px solid var(--bg4);color:var(--fg2);font-family:var(--mono)}
.process-card .summary-chip.ok{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.18);color:var(--success)}
.process-card .summary-chip.warn{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.18);color:var(--warn)}
.process-card .summary-chip.deny{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.18);color:var(--danger)}
.process-card .process-toggle{font-size:11px;color:var(--fg2);border:1px solid var(--bg4);background:var(--bg2);padding:4px 10px;border-radius:999px}
.process-card .process-toggle:hover{color:var(--fg);border-color:var(--fg3)}
.process-card .process-toggle:focus-visible,.process-card .detail-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.process-card .process-summary{font-size:11px;color:var(--fg3);padding:9px 14px}
.process-card .process-body-wrap{display:grid;grid-template-rows:1fr;transition:grid-template-rows .22s ease,opacity .18s ease}
.process-card .process-body-wrap.collapsed{grid-template-rows:0fr;opacity:.72}
.process-card .process-body-clip{min-height:0;overflow:hidden}
.process-card .process-body{padding:10px 14px 12px;display:flex;flex-direction:column;gap:10px}
.process-card .process-body-wrap.collapsed .process-body{opacity:0;transform:translateY(-6px)}
.process-card .process-badge-row{display:flex;flex-wrap:wrap;gap:6px}
.process-card .process-section{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:10px}
.process-card .process-section-title{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px}
.process-card .cse-lifecycle-section{border-color:rgba(42,176,144,.22);background:linear-gradient(180deg,rgba(42,176,144,.04),transparent)}
.process-card .cse-session-list{display:flex;flex-direction:column;gap:8px}
.process-card .cse-session-item{border:1px solid var(--bg4);background:var(--bg3);border-radius:10px;padding:8px 10px}
.process-card .cse-session-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.process-card .cse-session-id{font-size:11px;font-weight:700;color:var(--fg);font-family:var(--mono)}
.process-card .cse-session-meta{margin-top:4px;font-size:11px;color:var(--fg3)}
.process-card .live-thought{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .live-thought .lbl{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px}
.process-card .live-thought .txt{font-size:12px;color:var(--fg2);line-height:1.45;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.process-card .timeline{display:flex;flex-direction:column;gap:6px}
.process-card .worker-trace-section{border-color:rgba(217,119,6,.24);background:linear-gradient(180deg,rgba(217,119,6,.04),transparent)}
.process-card .worker-trace-summary{font-size:11px;color:var(--fg3);margin-bottom:8px}
.process-card .timeline-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.process-card .timeline-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:999px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg2);font-family:var(--mono)}
.process-card .timeline-badge.ok{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.18);color:var(--success)}
.process-card .timeline-badge.warn{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.18);color:var(--warn)}
.process-card .timeline-badge.deny{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.18);color:var(--danger)}
.process-card .timeline-item{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .timeline-item .t-h{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;font-weight:600;color:var(--fg)}
.process-card .timeline-item .t-summary{margin-top:4px;font-size:11px;color:var(--fg2);line-height:1.45;white-space:pre-wrap;word-break:break-word}
.process-card .timeline-item .t-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.process-card .detail-toggle{font-size:10px;color:var(--fg2);border:1px solid var(--bg4);background:var(--bg3);padding:3px 8px;border-radius:999px}
.process-card .detail-toggle:hover{color:var(--fg);border-color:var(--fg3)}
.process-card .timeline-item .t-raw{margin-top:8px;background:var(--bg3);border:1px solid var(--bg4);border-radius:8px;padding:8px}
.process-card .timeline-item .t-raw-label{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px}
.process-card .timeline-item .t-b{font-size:11px;color:var(--fg2);white-space:pre-wrap;word-break:break-word;font-family:var(--mono);max-height:160px;overflow:auto}
.process-card .detail-block{border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);overflow:hidden}
.process-card .detail-block-hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--bg4);background:var(--bg3)}
.process-card .detail-lang{font-size:10px;font-weight:700;letter-spacing:.3px;color:var(--fg3);text-transform:uppercase}
.process-card .detail-kind{font-size:10px;color:var(--fg3)}
.process-card .detail-block-actions{display:flex;align-items:center;gap:6px}
.process-card .detail-copy-btn{font-size:10px;line-height:1;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);border-radius:999px;padding:4px 8px;cursor:pointer}
.process-card .detail-copy-btn:hover{border-color:var(--fg3);color:var(--fg)}
.process-card .detail-copy-btn.copied{border-color:rgba(22,163,74,.25);background:rgba(22,163,74,.1);color:var(--success)}
.process-card .detail-code{margin:0;padding:8px 10px;font-size:11px;line-height:1.45;color:var(--fg2);font-family:var(--mono);white-space:pre;overflow:auto;max-height:260px}
.process-card .detail-table-wrap{overflow:auto;max-height:280px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2)}
.process-card .detail-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11px}
.process-card .detail-table th,.process-card .detail-table td{padding:6px 8px;border-bottom:1px solid var(--bg4);border-right:1px solid var(--bg4);text-align:left;vertical-align:top}
.process-card .detail-table th:last-child,.process-card .detail-table td:last-child{border-right:0}
.process-card .detail-table th{position:sticky;top:0;background:var(--bg3);color:var(--fg);font-weight:700;z-index:1}
.process-card .detail-table td{color:var(--fg2);font-family:var(--mono);white-space:pre-wrap;word-break:break-word;max-width:360px}
.process-card .timeline-item.thought{border-color:rgba(42,176,144,.25)}
.process-card .timeline-item.tool{border-color:rgba(217,119,6,.25)}
.process-card .timeline-item.worker{background:rgba(217,119,6,.03);border-style:dashed}
.process-card .timeline-item.delegation{border-color:rgba(124,58,237,.25)}
.process-card .timeline-item.response{border-color:rgba(59,130,246,.2)}
.process-card.running .process-stage{animation:processPulse 1.8s ease-in-out infinite}

/* Ensemble section */
.process-card .ensemble-section{border-color:rgba(124,58,237,.22);background:linear-gradient(180deg,rgba(124,58,237,.04),transparent)}
.process-card .ensemble-rationale{font-size:11px;color:var(--fg2);margin-bottom:10px;padding:8px 10px;background:var(--bg3);border:1px solid rgba(124,58,237,.18);border-radius:8px;line-height:1.5}
.process-card .ensemble-candidates{display:flex;flex-direction:column;gap:8px}
.process-card .ensemble-candidate{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .ensemble-candidate.winner{border-color:rgba(124,58,237,.4);background:rgba(124,58,237,.04)}
.process-card .ensemble-candidate-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.process-card .ensemble-agent-name{font-size:11px;font-weight:700;color:var(--fg);font-family:var(--mono)}
.process-card .ensemble-winner-badge{font-size:10px;padding:2px 8px;border-radius:999px;background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.3);color:rgb(124,58,237)}
.process-card .ensemble-candidate-output{font-size:11px;color:var(--fg2);line-height:1.5;white-space:pre-wrap;word-break:break-word}

/* Reflection section */
.process-card .reflect-section{border-color:rgba(59,130,246,.22);background:linear-gradient(180deg,rgba(59,130,246,.04),transparent)}
.process-card .reflect-list{display:flex;flex-direction:column;gap:8px}
.process-card .reflect-item{border:1px solid rgba(59,130,246,.2);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .reflect-item-hdr{font-size:10px;font-weight:700;color:rgb(59,130,246);text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px}
.process-card .reflect-feedback{font-size:11px;color:var(--fg2);line-height:1.5;white-space:pre-wrap;word-break:break-word}

/* Evaluator/verify section */
.process-card .verify-section{border-color:rgba(234,88,12,.22);background:linear-gradient(180deg,rgba(234,88,12,.04),transparent)}
.process-card .verify-list{display:flex;flex-direction:column;gap:8px}
.process-card .verify-item{border:1px solid var(--bg4);background:var(--bg2);border-radius:10px;padding:8px 10px}
.process-card .verify-item-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:600;color:var(--fg);margin-bottom:4px}
.process-card .verify-reason{font-size:11px;color:var(--fg2);line-height:1.5;white-space:pre-wrap;word-break:break-word}

.skill-list{display:flex;flex-direction:column;gap:8px}
.skill-item{border:1px solid rgba(42,176,144,.25);background:var(--bg2);border-radius:10px;padding:8px 10px}
.skill-item-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px}
.skill-name{font-size:12px;font-weight:700;color:var(--fg)}
.skill-score{font-size:10px;font-family:var(--mono);color:var(--accent2);background:var(--accent-dim);border:1px solid rgba(42,176,144,.2);border-radius:999px;padding:2px 8px}
.skill-category{font-size:10px;color:var(--fg3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
.skill-tags{display:flex;flex-wrap:wrap;gap:4px}
.skill-tag{font-size:10px;padding:2px 8px;border-radius:999px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg2);font-family:var(--mono)}
.skill-summary{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.skill-summary .skill-tag{background:var(--accent-dim);border-color:rgba(42,176,144,.22);color:var(--accent2)}

.validation-list{display:flex;flex-direction:column;gap:8px}
.validation-item{border:1px solid var(--bg4);background:var(--bg3);border-radius:10px;padding:8px 10px}
.validation-item.ok{border-color:rgba(22,163,74,.2)}
.validation-item.warn{border-color:rgba(217,119,6,.22)}
.validation-item.deny{border-color:rgba(220,38,38,.24)}
.validation-item-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}
.validation-name{font-size:12px;font-weight:700;color:var(--fg)}
.validation-status{font-size:10px;padding:2px 8px;border-radius:999px;border:1px solid var(--bg4);text-transform:uppercase;letter-spacing:.3px}
.validation-status.ok{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.18);color:var(--success)}
.validation-status.warn{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.18);color:var(--warn)}
.validation-status.deny{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.18);color:var(--danger)}
.validation-body{font-size:11px;color:var(--fg2);line-height:1.45;white-space:pre-wrap;word-break:break-word}

.mode-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:3px 10px;border-radius:999px;background:var(--accent-dim);color:var(--accent);text-transform:uppercase;letter-spacing:.5px;font-weight:600;border:1px solid rgba(37,99,235,.15)}

.streaming-indicator span{animation:blink 1.4s infinite both}
.streaming-indicator span:nth-child(2){animation-delay:.2s}
.streaming-indicator span:nth-child(3){animation-delay:.4s}

@keyframes processPulse{0%,100%{box-shadow:0 0 0 0 rgba(42,176,144,0)}50%{box-shadow:0 0 0 4px rgba(42,176,144,.08)}}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}

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

/* ── Settings panel ────────────────────– */
.settings-dd{width:380px;padding:24px;max-height:82vh;overflow-y:auto}
.settings-dd h3{font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mode-card{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);cursor:pointer;transition:all .18s ease}
.mode-card:hover{border-color:var(--fg3);background:var(--bg3)}
.mode-card.selected{border-color:var(--accent);background:var(--accent-dim)}
.mode-card .mc-icon{font-size:16px;width:24px;text-align:center;flex:0 0 auto}
.mode-card .mc-title{font-size:12px;font-weight:600;color:var(--fg)}
.mode-card .mc-desc{font-size:10px;color:var(--fg3);margin-top:1px;line-height:1.3}
.setting-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);cursor:pointer;transition:border-color .18s}
.setting-row:hover{border-color:var(--fg3)}
.setting-row-label{font-size:13px;font-weight:600;color:var(--fg)}
.setting-row-desc{font-size:11px;color:var(--fg3);margin-top:2px}
.setting-sub{display:flex;align-items:center;justify-content:space-between;padding:5px 12px 5px 22px;font-size:12px;color:var(--fg2)}
.setting-sub input[type=number]{width:56px;text-align:center;padding:3px 6px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg3);color:var(--fg);font-size:12px;font-family:inherit}
.setting-section-label{font-size:10px;color:var(--fg3);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
.setting-sep{height:1px;background:var(--bg4);margin:6px 0}
.resolver-option{display:flex;align-items:center;gap:8px;padding:5px 2px;cursor:pointer;font-size:12px;color:var(--fg)}
.resolver-dot{width:14px;height:14px;border-radius:50%;border:2px solid var(--fg3);background:transparent;flex:0 0 auto;transition:all .15s}
.resolver-dot.active{border-color:var(--accent);background:var(--accent)}
.toggle-switch{position:relative;width:36px;height:20px;background:var(--bg4);border-radius:10px;cursor:pointer;transition:background .2s}
.toggle-switch.on{background:var(--accent)}
.toggle-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s}
.toggle-switch.on::after{transform:translateX(16px)}

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
.eval-table th,.eval-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--bg4);vertical-align:middle}
.eval-table th{color:var(--fg3);font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.eval-table td{color:var(--fg2)}
.table-wrap{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-soft)}
.table-wrap h3{font-size:14px;color:var(--fg2);padding:20px 20px 0;font-weight:600}
.admin-main-panel{display:flex;flex-direction:column;gap:12px;min-width:0}
.admin-content-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
.admin-content-grid.editing{grid-template-columns:minmax(0,1fr) minmax(300px,380px)}
.admin-list-panel{min-width:0}
.admin-list-header{display:flex;align-items:center;justify-content:space-between;padding:20px 20px 0}
.admin-list-header h3{margin:0;font-size:14px;color:var(--fg2);font-weight:600}
.admin-list-toolbar{display:flex;align-items:center;gap:10px;padding:14px 20px 10px;flex-wrap:wrap;justify-content:flex-end}
.admin-list-search-wrap{position:relative;width:260px;min-width:180px;flex:1 1 260px;max-width:360px}
.admin-list-search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--fg3);font-size:13px;pointer-events:none;line-height:1}
.admin-list-search{width:100%;padding:6px 10px 6px 28px;border-radius:9px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:12px;box-sizing:border-box}
.admin-list-search:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 18%, transparent)}
.fast-tip{position:fixed;background:var(--bg2);color:var(--fg);border:1px solid var(--bg4);border-radius:8px;padding:6px 10px;font-size:11px;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;z-index:10000;opacity:0;transform:translateY(-2px);transition:opacity .08s ease, transform .08s ease}
.fast-tip.show{opacity:1;transform:translateY(0)}
.admin-list-groupby{padding:8px 10px;border-radius:9px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);font-size:12px;cursor:pointer;white-space:nowrap}
.admin-grouped-hint{font-size:11px;color:var(--accent2);background:var(--accent-dim);border:1px solid var(--accent);border-radius:7px;padding:4px 10px;white-space:nowrap;user-select:none}
.admin-exclude-hint{color:var(--warn,#e88);border-color:var(--warn,#e88);background:color-mix(in oklab,var(--warn,#e88) 12%, var(--bg2));cursor:pointer}
.admin-exclude-hint:hover{opacity:.8}
.eval-table td[oncontextmenu]:hover{background:color-mix(in oklab,var(--accent) 7%, transparent);cursor:context-menu}
.eval-table th.col-grouped{color:var(--accent2)}
.col-group-badge{font-size:10px;margin-left:4px;color:var(--accent2);vertical-align:middle}
.col-ctx-menu{position:fixed;z-index:9999;background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.2);padding:6px 0;min-width:200px;max-width:280px;font-size:13px;animation:ctx-pop .12s ease}
@keyframes ctx-pop{from{opacity:0;transform:scale(.95) translateY(-4px)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes admin-toast-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.col-ctx-header{padding:5px 14px 3px;font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--fg3);user-select:none}
.col-ctx-sep{height:1px;background:var(--bg4);margin:4px 0}
.col-ctx-item{display:flex;align-items:center;gap:8px;padding:7px 14px;cursor:pointer;color:var(--fg2);border-radius:0;transition:background .1s}
.col-ctx-item:hover{background:color-mix(in oklab,var(--accent) 10%, var(--bg3));color:var(--fg)}
.col-ctx-item.ctx-active{color:var(--accent2);font-weight:600}
.col-ctx-item.ctx-active:hover{background:var(--accent-dim)}
.col-ctx-item.ctx-disabled{opacity:.38;cursor:default;pointer-events:none}
.col-ctx-item.ctx-danger{color:#e05252}
.col-ctx-item.ctx-danger:hover{background:color-mix(in oklab,#e05252 12%, var(--bg3))}
.col-ctx-item.ctx-has-submenu{padding-right:10px}
.ctx-icon{width:16px;text-align:center;font-size:12px;color:var(--fg3);flex-shrink:0}
.col-ctx-item.ctx-active .ctx-icon{color:var(--accent2)}
.ctx-caret{margin-left:auto;color:var(--fg3);font-size:12px;line-height:1}
.col-ctx-submenu{min-width:170px;max-width:240px}
.admin-list-footer{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-top:1px solid var(--bg4);background:var(--bg2);gap:12px;flex-wrap:wrap}
.admin-list-info{font-size:12px;color:var(--fg3)}
.admin-list-pagination{display:flex;align-items:center;gap:4px}
.admin-page-btn{padding:5px 10px;font-size:12px;border-radius:7px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);cursor:pointer;min-width:32px;text-align:center}
.admin-page-btn:hover:not([disabled]){background:var(--bg);color:var(--fg);border-color:var(--fg3)}
.admin-page-btn[disabled]{opacity:.4;cursor:default;pointer-events:none}
.admin-page-btn.active{background:var(--accent-dim);color:var(--accent2);border-color:var(--accent);font-weight:700}
.admin-page-ellipsis{font-size:12px;color:var(--fg3);padding:0 4px;line-height:1}
.eval-table th.sortable{cursor:pointer;user-select:none;white-space:nowrap}
.eval-table th.sortable:hover{color:var(--fg);background:color-mix(in oklab,var(--bg4) 55%, transparent)}
.eval-table th.sort-active{color:var(--accent2)}
.sort-indicator{font-size:10px;opacity:.55;display:inline-block}
.eval-table th.sort-active .sort-indicator{opacity:1}
.admin-group-header-row td{background:color-mix(in oklab,var(--bg4) 55%, var(--bg2));color:var(--fg2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:7px 14px;cursor:pointer;user-select:none}
.admin-group-header-row td:hover{background:var(--bg4)}
.admin-group-count{font-size:10px;font-weight:400;color:var(--fg3);margin-left:8px;text-transform:none;letter-spacing:0}
.admin-editor-panel{position:sticky;top:16px;align-self:start}
.admin-editor-panel .chart-box{margin:0}
.admin-detail-panel .chart-box{margin:0}
.admin-breadcrumbs{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);font-size:12px;color:var(--fg2)}
.admin-breadcrumb-back{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid transparent;background:transparent;color:var(--fg2);border-radius:999px;padding:0;font-weight:700;line-height:1;cursor:pointer}
.admin-breadcrumb-back:hover{background:var(--bg3);color:var(--fg);border-color:var(--bg4)}
.admin-breadcrumb-back:focus-visible,.admin-breadcrumb-link:focus-visible{outline:2px solid color-mix(in oklab,var(--accent) 78%, white);outline-offset:2px}
.admin-breadcrumb-list{list-style:none;display:flex;align-items:center;gap:0;margin:0;padding:0;min-width:0;flex-wrap:nowrap}
.admin-breadcrumb-item{display:inline-flex;align-items:center;min-width:0;color:var(--fg2)}
.admin-breadcrumb-item + .admin-breadcrumb-item::before{content:'›';margin:0 8px;color:var(--fg3);font-weight:700}
.admin-breadcrumb-link{border:1px solid transparent;background:transparent;color:var(--accent2);border-radius:6px;padding:2px 4px;font-weight:600;cursor:pointer;white-space:nowrap}
.admin-breadcrumb-link:hover{background:var(--bg3);border-color:var(--bg4);color:var(--fg)}
.admin-breadcrumb-item-current{color:var(--fg);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(52vw,420px)}
.row-actions{display:flex;gap:8px;align-items:center}
.row-btn{padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);cursor:pointer}
.row-btn:hover{border-color:var(--fg3);background:var(--bg)}
.row-btn-edit{color:var(--accent2);border-color:var(--accent);background:var(--accent-dim)}
.row-btn-del{color:#DC2626;border-color:#FCA5A5;background:#FEF2F2}
.admin-data-row{cursor:pointer;transition:background .1s}
.admin-data-row:hover td{background:color-mix(in oklab,var(--accent) 7%, transparent)}
.admin-data-row-selected td{background:color-mix(in oklab,var(--accent) 16%, transparent)}
.admin-data-row-selected:hover td{background:color-mix(in oklab,var(--accent) 20%, transparent)}
.admin-col-mgr-btn{font-size:11px;padding:3px 10px;gap:5px}
.admin-col-manager{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.18);padding:8px 0 6px;min-width:220px;max-width:300px;font-size:13px;animation:ctx-pop .12s ease}
.admin-col-manager-header{display:flex;align-items:center;justify-content:space-between;padding:4px 14px 8px;border-bottom:1px solid var(--bg4);margin-bottom:4px;font-weight:600;color:var(--fg)}
.admin-col-manager-reset{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg3);cursor:pointer}
.admin-col-manager-reset:hover{background:var(--bg4);color:var(--fg)}
.admin-col-manager-section-label{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--fg3);padding:6px 14px 2px}
.admin-col-manager-section-label-hidden{padding-top:10px;border-top:1px solid var(--bg4);margin-top:4px}
.admin-col-manager-item{display:flex;align-items:center;gap:4px;padding:4px 10px 4px 14px;transition:background .1s}
.admin-col-manager-item:hover{background:color-mix(in oklab,var(--accent) 8%, var(--bg3))}
.admin-col-manager-item-hidden .admin-col-manager-name{color:var(--fg3)}
.admin-col-manager-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)}
.admin-col-manager-btn{font-size:12px;padding:1px 6px;border-radius:5px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg3);cursor:pointer;line-height:1.5;min-width:22px;text-align:center}
.admin-col-manager-btn:hover:not(:disabled){background:var(--accent-dim);border-color:var(--accent);color:var(--accent2)}
.admin-col-manager-btn:disabled{opacity:.3;cursor:default}
.admin-col-manager-hide:hover:not(:disabled){background:color-mix(in oklab,#e05252 12%, var(--bg3));border-color:#e05252;color:#e05252}
.admin-col-manager-add:hover:not(:disabled){background:color-mix(in oklab,var(--accent) 14%, var(--bg3));border-color:var(--accent);color:var(--accent2)}
.admin-form-action-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--bg4)}
.admin-form-title{font-size:15px;font-weight:700;color:var(--fg)}
.admin-form-action-btns{display:flex;align-items:center;gap:8px}
.admin-form-btn{padding:6px 16px;font-size:13px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg);cursor:pointer;font-weight:500;transition:background .1s,border-color .1s}
.admin-form-btn:hover{background:var(--bg);border-color:var(--fg3)}
.admin-form-btn-save{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.admin-form-btn-save:hover{opacity:.88;background:var(--accent)}
.admin-form-btn-delete{color:#DC2626;border-color:#FCA5A5;background:#FEF2F2}
.admin-form-btn-delete:hover{background:#FEE2E2;border-color:#F87171}
.admin-form-btn-share{color:var(--fg2);border-color:var(--bg4);background:var(--bg2)}
.admin-form-btn-share:hover{background:var(--bg3);color:var(--fg)}
/* Copied toast */
.admin-share-toast{background:var(--bg3);color:var(--fg);border:1px solid var(--bg4);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;pointer-events:none;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.18);animation:admin-toast-in .15s ease}

/* ── Prompt Setup Wizard ─────────────────── */
.prompt-wizard{margin:12px 12px 18px;border:1px solid var(--bg4);background:linear-gradient(180deg,var(--bg2),var(--bg3))}
.prompt-wizard-head h3{margin:0 0 2px;font-size:16px;color:var(--fg)}
.prompt-wizard-sub{font-size:12px;color:var(--fg2)}
.prompt-wizard-top-actions{margin-top:8px}
.prompt-wizard-mode{margin-top:8px;font-size:12px;color:var(--fg2);padding:6px 10px;border:1px dashed var(--bg4);border-radius:8px;background:var(--bg2)}
.prompt-wizard-section{margin-top:16px;padding:14px;border:1px solid var(--bg4);border-radius:12px;background:var(--bg)}
.prompt-wizard-section h4{margin:0 0 10px;font-size:13px;color:var(--fg)}
.prompt-wizard-section label{display:block;font-size:12px;color:var(--fg2);margin-bottom:4px;font-weight:600}
.prompt-wizard-section input[type="text"],.prompt-wizard-section select,.prompt-wizard-section textarea{width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg)}
.prompt-wizard-section textarea{font-family:var(--mono)}
.prompt-wizard-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.prompt-wizard-inline{display:flex;gap:8px;align-items:center}
.prompt-wizard-inline select{flex:1}
.prompt-wizard-hint{font-size:12px;color:var(--fg3);margin-top:6px}
.prompt-token-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--fg2)}
.prompt-token{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg2);font-size:11px;color:var(--fg2)}
.prompt-token-variable{background:var(--accent-dim);border-color:var(--accent);color:var(--accent2)}
.prompt-token-fragment{background:#edf9f5;border-color:#b9e9d8;color:#135e4a}
.prompt-token-fragment.warn{background:#fff7ed;border-color:#fed7aa;color:#9a3412}
.prompt-token-empty{background:var(--bg2);border-color:var(--bg4);color:var(--fg3)}
.prompt-template-preview{margin-top:8px;padding:10px;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);white-space:pre-wrap;word-break:break-word;color:var(--fg2);max-height:220px;overflow:auto}
.prompt-template-empty{color:var(--fg3);font-style:italic}
.prompt-wizard-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:8px}
.prompt-wizard-checks label,.prompt-wizard-toggle{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:var(--fg2)}
.prompt-wizard-list{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.prompt-wizard-list-item{display:flex;justify-content:space-between;align-items:center;padding:8px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);font-size:12px;color:var(--fg2)}
.prompt-section-item{align-items:flex-start;gap:10px}
.prompt-section-main{flex:1;display:flex;flex-direction:column;gap:8px}
.prompt-section-actions{display:flex;flex-direction:column;gap:6px;min-width:72px}
.prompt-wizard-actions{display:flex;gap:8px;margin-top:16px}
.prompt-wizard-status{margin-top:10px;font-size:12px;color:#0f766e;background:#ecfeff;border:1px solid #99f6e4;padding:8px;border-radius:8px}
.prompt-wizard-error{margin-top:10px;font-size:12px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;padding:8px;border-radius:8px}

/* ── Action Feed (WC1) ─────────────────── */
.af-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 6px}
.af-title{font-size:12px;font-weight:600;color:var(--fg2);letter-spacing:.04em;text-transform:uppercase}
.af-title-row{display:flex;align-items:center;gap:6px}
.af-count{font-size:11px;font-weight:600;background:var(--accent);color:#fff;border-radius:999px;padding:1px 6px;line-height:1.4}
.af-loading{padding:12px;font-size:12px;color:var(--fg3);text-align:center}
.af-filters{display:flex;gap:4px;padding:0 12px 8px;flex-wrap:wrap}
.af-filter{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg2);cursor:pointer;transition:background .15s}
.af-filter:hover{background:var(--bg3)}
.af-filter.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.af-body{display:flex;flex-direction:column;gap:1px}
.af-row{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;cursor:pointer;transition:background .15s;border-left:3px solid transparent;position:relative}
.af-row:hover{background:var(--bg2)}
.af-row[data-urgency="overdue"]{border-left-color:#ef4444}
.af-row[data-urgency="due-soon"]{border-left-color:#f59e0b}
.af-row[data-urgency="proposed"]{border-left-color:#3b82f6}
.af-badge{font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;white-space:nowrap;flex-shrink:0;margin-top:2px}
.af-badge[data-kind="approval"]{background:#dbeafe;color:#1d4ed8}
.af-badge[data-kind="task"]{background:#ede9fe;color:#7c3aed}
.af-badge[data-kind="reminder"]{background:#fef3c7;color:#92400e}
.af-badge[data-kind="agenda"]{background:#d1fae5;color:#065f46}
.af-row-body{flex:1;min-width:0}
.af-row-title{font-size:13px;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.af-row-due{font-size:11px;color:var(--fg3);margin-top:2px}
.af-row-due.overdue{color:#ef4444}
.af-row-due.due-soon{color:#f59e0b}
.af-more{padding:8px 12px;font-size:12px;color:var(--accent);text-align:center;cursor:pointer}
.af-more:hover{text-decoration:underline}

/* ── Calendar widget + full view (WC2-WC4) ─ */
.cal-bucket{margin-bottom:12px}
.cal-bucket-label{font-size:11px;font-weight:600;color:var(--fg3);text-transform:uppercase;letter-spacing:.05em;padding:4px 0 6px}
.cal-bucket-label.overdue{color:#ef4444}
.cal-bucket-label.today{color:var(--accent)}
.cal-bucket-list{display:flex;flex-direction:column;gap:4px}
.cal-item-chip{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;background:var(--bg2);transition:background .15s;border-left:3px solid var(--accent)}
.cal-item-chip:hover{background:var(--bg3)}
.cal-item-title{font-size:12px;color:var(--fg1);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-item-time{font-size:11px;color:var(--fg3);white-space:nowrap}
.cal-quick-add{display:flex;gap:6px;padding:8px 0 4px}
.cal-qa-input{flex:1;padding:6px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg1);font-size:12px}
.cal-qa-input:focus{outline:none;border-color:var(--accent)}
.cal-qa-btn{padding:6px 12px;border-radius:8px;background:var(--accent);color:#fff;font-size:12px;font-weight:600;border:none;cursor:pointer}
.cal-empty{color:var(--fg3);font-size:12px;padding:8px 0;text-align:center}
.cal-full-view{display:flex;flex-direction:column;height:100%;overflow:hidden}
.cal-top-bar{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--bg4);gap:12px;flex-shrink:0}
.cal-top-left{display:flex;align-items:center;gap:12px}
.cal-back-btn{font-size:12px;color:var(--fg3);background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px}
.cal-back-btn:hover{background:var(--bg3);color:var(--fg1)}
.cal-month-nav{display:flex;align-items:center;gap:6px}
.cal-month-label{font-size:14px;font-weight:600;color:var(--fg1);min-width:140px;text-align:center}
.cal-nav-arrow{font-size:16px;background:none;border:none;cursor:pointer;color:var(--fg2);padding:2px 8px;border-radius:6px}
.cal-nav-arrow:hover{background:var(--bg3)}
.cal-today-btn{font-size:12px;padding:4px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg2);cursor:pointer}
.cal-today-btn:hover{background:var(--bg3)}
.cal-view-toggle{display:flex;gap:2px;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:2px}
.cal-nav-btn{font-size:12px;padding:4px 12px;border:none;border-radius:6px;background:none;color:var(--fg2);cursor:pointer;transition:background .15s}
.cal-nav-btn:hover{background:var(--bg3)}
.cal-nav-btn.active{background:var(--accent);color:#fff}
.cal-qa-bar{display:flex;gap:8px;padding:12px 20px;border-bottom:1px solid var(--bg4);flex-shrink:0}
.cal-qa-full-input{flex:1;padding:8px 14px;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2);color:var(--fg1);font-size:13px}
.cal-qa-full-input:focus{outline:none;border-color:var(--accent);background:var(--bg1)}
.cal-qa-submit{padding:8px 16px;border-radius:10px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;border:none;cursor:pointer;white-space:nowrap}
.cal-qa-submit:hover{opacity:.88}
.cal-qa-submit:disabled{opacity:.5;cursor:not-allowed}
.cal-loading{padding:24px;text-align:center;color:var(--fg3);font-size:14px}
.cal-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:48px 24px;flex:1}
.cal-empty-icon{font-size:40px}
.cal-empty-msg{font-size:16px;font-weight:600;color:var(--fg2)}
.cal-empty-sub{font-size:13px;color:var(--fg3);text-align:center}
/* Agenda sub-view */
.cal-agenda-view{flex:1;overflow-y:auto;padding:16px 20px}
.cal-sections{display:flex;flex-direction:column;gap:16px}
.cal-section{display:flex;flex-direction:column;gap:6px}
.cal-section-label{font-size:11px;font-weight:700;color:var(--fg3);text-transform:uppercase;letter-spacing:.06em;padding-bottom:4px;border-bottom:1px solid var(--bg4)}
.cal-section-label.overdue{color:#ef4444}
.cal-section-label.today{color:var(--accent)}
.cal-agenda-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--bg3)}
.cal-agenda-row:last-child{border-bottom:none}
.cal-agenda-color{width:4px;border-radius:2px;height:40px;flex-shrink:0;background:var(--accent)}
.cal-agenda-content{flex:1;min-width:0}
.cal-agenda-title{font-size:13px;font-weight:500;color:var(--fg1);margin-bottom:4px}
.cal-agenda-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cal-cat-chip{font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
.cal-agenda-loc{font-size:11px;color:var(--fg3)}
.cal-agenda-amount{font-size:11px;color:var(--fg3)}
.cal-agenda-time{font-size:12px;color:var(--fg3);margin-top:4px}
.cal-agenda-edit{background:none;border:none;color:var(--fg3);cursor:pointer;padding:4px 8px;border-radius:6px;font-size:13px;flex-shrink:0;margin-top:4px}
.cal-agenda-edit:hover{background:var(--bg3);color:var(--fg1)}
/* Week sub-view */
.cal-week-view{flex:1;display:flex;flex-direction:column;overflow:hidden}
.cal-week-header{display:grid;grid-template-columns:52px repeat(7,1fr);border-bottom:1px solid var(--bg4);flex-shrink:0}
.cal-week-time-gutter{font-size:10px;color:var(--fg3);padding:6px 4px;text-align:right}
.cal-week-day-hdr{display:flex;flex-direction:column;align-items:center;padding:6px 4px;cursor:pointer;border-left:1px solid var(--bg4)}
.cal-week-day-hdr:hover{background:var(--bg2)}
.cal-week-dw{font-size:10px;color:var(--fg3);font-weight:600;text-transform:uppercase}
.cal-week-dn{font-size:20px;font-weight:300;color:var(--fg1);line-height:1}
.cal-week-dn.today{background:var(--accent);color:#fff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:16px}
.cal-week-allday-row{display:grid;grid-template-columns:52px repeat(7,1fr);border-bottom:1px solid var(--bg4);flex-shrink:0;min-height:32px}
.cal-week-allday-cell{border-left:1px solid var(--bg4);padding:2px;display:flex;flex-direction:column;gap:1px}
.cal-week-grid{flex:1;overflow-y:auto}
.cal-week-row{display:grid;grid-template-columns:52px repeat(7,1fr);border-bottom:1px solid var(--bg3);min-height:40px}
.cal-week-cell{border-left:1px solid var(--bg4);padding:2px;display:flex;flex-direction:column;gap:1px}
/* Month sub-view */
.cal-month-view{flex:1;display:flex;flex-direction:column;overflow:hidden;padding:12px 20px}
.cal-month-header{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px}
.cal-month-wh{font-size:11px;color:var(--fg3);font-weight:600;text-align:center;padding:4px 0;text-transform:uppercase}
.cal-month-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;flex:1;overflow-y:auto}
.cal-month-cell{padding:4px;border:1px solid var(--bg4);border-radius:6px;min-height:80px;cursor:pointer;position:relative;overflow:visible}
.cal-month-cell:hover{background:var(--bg2)}
.cal-month-cell.today{border-color:var(--accent)}
.cal-month-cell.focused{background:var(--bg2)}
.cal-month-cell.empty{border-color:transparent;cursor:default}
.cal-month-dn{font-size:12px;font-weight:500;color:var(--fg2);margin-bottom:2px;line-height:1}
.cal-month-cell.today .cal-month-dn{background:var(--accent);color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
/* Event chip (shared) */
.cal-chip{display:flex;flex-direction:column;gap:1px;padding:2px 5px;border-radius:3px;font-size:10px;overflow:hidden;cursor:pointer;margin-bottom:1px}
.cal-chip.compact{font-size:10px;padding:1px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-chip-title{font-size:11px;font-weight:500;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-chip-title-sm{font-size:10px;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-chip-time{font-size:10px;color:var(--fg3)}
.cal-chip-more{font-size:10px;color:var(--accent);cursor:pointer;padding:1px 4px;font-weight:600}
.cal-chip-more:hover{text-decoration:underline}
.cal-chip-popover{position:absolute;top:100%;left:0;z-index:100;background:var(--bg1);border:1px solid var(--bg4);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:10px;min-width:200px;display:flex;flex-direction:column;gap:4px}
.cal-popover-title{font-size:12px;font-weight:600;color:var(--fg1);margin-bottom:6px}
.cal-popover-close{position:absolute;top:6px;right:8px;background:none;border:none;color:var(--fg3);cursor:pointer;font-size:14px}
/* Widget "full view" link */
.cal-full-view-link{font-size:12px;color:var(--accent);text-align:right;padding:4px 0 0;cursor:pointer}
.cal-full-view-link:hover{text-decoration:underline}
.schedule-view-toggle{display:flex;gap:4px;margin-bottom:8px}

/* ── Notes full view (WC6-WC9) ─────────── */
.notes-full-view{display:flex;flex-direction:column;height:100%;overflow:hidden}
.notes-layout{display:grid;grid-template-columns:260px 1fr;height:100%;overflow:hidden}
.notes-sidebar{border-right:1px solid var(--bg4);overflow-y:auto;display:flex;flex-direction:column}
.notes-main{flex:1;overflow:hidden;display:flex;flex-direction:column}
/* List panel */
.notes-list-panel{display:flex;flex-direction:column;height:100%}
.notes-list-header{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 8px;flex-shrink:0}
.notes-list-title{font-size:13px;font-weight:600;color:var(--fg1)}
.notes-list-actions{display:flex;gap:6px}
.notes-new-btn{font-size:12px;padding:4px 10px;border-radius:8px;background:var(--accent);color:#fff;border:none;cursor:pointer;font-weight:600}
.notes-new-btn:hover{opacity:.88}
.notes-templates-btn{font-size:12px;padding:4px 10px;border-radius:8px;background:var(--bg2);color:var(--fg2);border:1px solid var(--bg4);cursor:pointer}
.notes-templates-btn:hover{background:var(--bg3)}
.notes-search-bar{padding:0 12px 8px;flex-shrink:0}
.notes-search-input{width:100%;padding:6px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg1);font-size:12px;box-sizing:border-box}
.notes-search-input:focus{outline:none;border-color:var(--accent)}
.notes-loading{padding:16px;text-align:center;color:var(--fg3);font-size:12px}
.notes-items{flex:1;overflow-y:auto;padding:0 8px 12px}
.notes-section{margin-bottom:8px}
.notes-section-label{font-size:10px;font-weight:700;color:var(--fg3);text-transform:uppercase;letter-spacing:.06em;padding:8px 6px 4px}
.notes-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 12px;color:var(--fg3);font-size:12px;text-align:center}
.notes-new-btn-lg{margin-top:4px;font-size:12px;padding:8px 16px;border-radius:8px;background:var(--accent);color:#fff;border:none;cursor:pointer;font-weight:600}
/* Note row */
.note-row{display:flex;align-items:center;gap:8px;padding:8px 8px;border-radius:8px;cursor:pointer;transition:background .15s;position:relative}
.note-row:hover{background:var(--bg2)}
.note-row.active{background:var(--bg3)}
.note-row-icon{font-size:16px;width:24px;text-align:center;flex-shrink:0}
.note-row-body{flex:1;min-width:0}
.note-row-title{font-size:13px;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.note-row-meta{font-size:11px;color:var(--fg3);display:flex;gap:6px;align-items:center;margin-top:2px}
.note-fav-btn{background:none;border:none;color:var(--fg3);cursor:pointer;font-size:14px;padding:2px;opacity:.5;flex-shrink:0}
.note-fav-btn:hover{opacity:1}
.note-fav-btn.active{color:#f59e0b;opacity:1}
.note-sens-badge{font-size:10px;padding:1px 5px;border-radius:4px;background:#fef3c7;color:#92400e;font-weight:600}
/* Templates gallery */
.notes-templates{display:flex;flex-direction:column;padding:16px}
.notes-templates-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.notes-templates-title{font-size:15px;font-weight:600;color:var(--fg1)}
.notes-template-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.notes-template-card{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 16px;border:1px solid var(--bg4);border-radius:12px;cursor:pointer;background:var(--bg2);transition:border-color .15s,box-shadow .15s}
.notes-template-card:hover{border-color:var(--accent);box-shadow:0 2px 12px rgba(0,0,0,.08)}
.notes-template-icon{font-size:28px}
.notes-template-title{font-size:12px;font-weight:500;color:var(--fg1);text-align:center}
/* Editor panel */
.notes-editor-panel{display:flex;flex-direction:column;height:100%;overflow:hidden}
.notes-editor-top{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--bg4);flex-shrink:0}
.notes-editor-toolbar{display:flex;gap:6px;align-items:center}
.notes-back-btn{font-size:12px;color:var(--fg3);background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px}
.notes-back-btn:hover{background:var(--bg3);color:var(--fg1)}
.notes-fav-btn{background:none;border:none;color:var(--fg3);cursor:pointer;font-size:16px;padding:4px;border-radius:6px}
.notes-fav-btn:hover{background:var(--bg3)}
.notes-fav-btn.active{color:#f59e0b}
.notes-extract-btn{font-size:12px;padding:4px 10px;border-radius:8px;background:var(--bg2);color:var(--fg2);border:1px solid var(--bg4);cursor:pointer}
.notes-extract-btn:hover{background:var(--bg3)}
.notes-delete-btn{font-size:14px;padding:4px 8px;border-radius:6px;background:none;color:var(--fg3);border:none;cursor:pointer}
.notes-delete-btn:hover{background:#fef2f2;color:#dc2626}
.notes-extract-result{margin:0 16px;padding:8px 12px;background:#d1fae5;color:#065f46;border-radius:8px;font-size:12px;font-weight:500}
.notes-editor-header{display:flex;align-items:center;gap:12px;padding:16px 20px 8px;flex-shrink:0}
.notes-editor-icon{font-size:28px;cursor:pointer;width:36px;text-align:center;border-radius:6px;padding:2px}
.notes-editor-icon:hover{background:var(--bg2)}
.notes-title-input{flex:1;font-size:22px;font-weight:700;color:var(--fg1);border:none;background:transparent;outline:none;padding:4px 0}
.notes-title-input::placeholder{color:var(--fg3)}
.notes-editor-mount{flex:1;overflow-y:auto;padding:0 20px 24px}
.notes-editor-content{min-height:300px;outline:none}
.notes-editor-content .ProseMirror{outline:none;min-height:300px;font-size:14px;line-height:1.7;color:var(--fg1)}
.notes-editor-content .ProseMirror p.is-editor-empty:first-child::before{content:attr(data-placeholder);color:var(--fg3);pointer-events:none;float:left;height:0}
.notes-editor-content h1{font-size:22px;font-weight:700;color:var(--fg1);margin:1em 0 .3em}
.notes-editor-content h2{font-size:18px;font-weight:600;color:var(--fg1);margin:.9em 0 .3em}
.notes-editor-content h3{font-size:15px;font-weight:600;color:var(--fg2);margin:.8em 0 .3em}
.notes-editor-content ul{padding-left:1.4em;list-style:disc}
.notes-editor-content ol{padding-left:1.4em;list-style:decimal}
.notes-editor-content blockquote{border-left:3px solid var(--bg4);padding-left:12px;color:var(--fg2);margin:8px 0}
.notes-editor-content pre{background:var(--bg2);border-radius:6px;padding:10px 14px;font-family:monospace;font-size:13px;overflow-x:auto}
.notes-editor-content code{background:var(--bg3);border-radius:3px;padding:1px 4px;font-family:monospace;font-size:12px}
.notes-editor-content hr{border:none;border-top:1px solid var(--bg4);margin:12px 0}
.notes-editor-content li[data-type="taskItem"]{display:flex;gap:8px;align-items:flex-start;list-style:none;padding-left:0}
.notes-editor-content li[data-type="taskItem"] input[type="checkbox"]{margin-top:3px;flex-shrink:0;accent-color:var(--accent)}
/* Bubble toolbar */
.notes-bubble-wrapper{position:absolute;z-index:200;pointer-events:none}
.notes-bubble-toolbar{display:flex;gap:2px;background:var(--bg1);border:1px solid var(--bg4);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:3px;pointer-events:all}
.notes-bubble-btn{font-size:12px;font-weight:700;padding:4px 8px;border-radius:5px;border:none;background:none;color:var(--fg1);cursor:pointer}
.notes-bubble-btn:hover{background:var(--bg3)}
/* Slash menu */
.notes-slash-menu{background:var(--bg1);border:1px solid var(--bg4);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:4px;min-width:200px;z-index:300}
.notes-slash-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--fg1)}
.notes-slash-item:hover{background:var(--bg2)}
.notes-slash-icon{font-size:13px;font-weight:700;color:var(--fg2);width:22px;text-align:center;flex-shrink:0}
.notes-slash-empty{padding:10px;font-size:12px;color:var(--fg3);text-align:center}
/* Error / prompt states */
.notes-editor-error{padding:16px;color:#dc2626;background:#fef2f2;border-radius:8px;font-size:13px}
.notes-select-prompt{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;color:var(--fg3)}
.notes-select-icon{font-size:40px}
.notes-select-msg{font-size:16px;font-weight:600;color:var(--fg2)}
.notes-select-sub{font-size:13px}

.sv-hidden{display:none!important}
/* ── Scientific Validation Submit ──────────────────────── */
.sv-page{max-width:880px;margin:0 auto;padding-bottom:60px}
.sv-page-header{display:flex;align-items:center;gap:14px;margin-bottom:28px}
.sv-page-icon{width:48px;height:48px;border-radius:14px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.sv-page-title{font-size:24px;font-weight:800;color:var(--fg);margin:0 0 4px}
.sv-page-sub{color:var(--fg3);font-size:14px;margin:0}
.sv-tips-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:22px}
.sv-tip-card{padding:12px 14px;border-radius:10px;background:var(--bg2);border:1px solid var(--bg4);display:flex;flex-direction:column;gap:4px}
.sv-tip-head{display:flex;align-items:center;gap:7px}
.sv-tip-icon{font-size:16px;line-height:1}
.sv-tip-title{font-size:13px;font-weight:700;color:var(--fg)}
.sv-tip-body{font-size:12px;color:var(--fg3);line-height:1.45;margin-top:2px}
.sv-section-title{font-size:13px;font-weight:700;color:var(--fg2);margin-bottom:12px}
.sv-tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:24px}
.sv-tpl-card{padding:14px 16px;border-radius:12px;border:2px solid var(--bg4);background:var(--bg2);cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:border-color .18s,background .18s}
.sv-tpl-card:hover{border-color:var(--accent);background:var(--accent-dim)}
.sv-tpl-card.sv-active{border-color:var(--accent);background:var(--accent-dim)}
.sv-tpl-head{display:flex;align-items:center;justify-content:space-between}
.sv-tpl-icon{font-size:20px;line-height:1}
.sv-tpl-badge{font-size:9px;font-weight:700;padding:2px 7px;border-radius:999px;background:var(--accent);color:white;text-transform:uppercase;letter-spacing:.05em}
.sv-tpl-name{font-size:13px;font-weight:700;color:var(--fg)}
.sv-tpl-name.sv-active{color:var(--accent)}
.sv-tpl-cat{font-size:11px;color:var(--fg3)}
.sv-form-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:16px;padding:28px 32px}
.sv-form-head{font-size:16px;font-weight:700;color:var(--fg);margin-bottom:22px;display:flex;align-items:center;gap:8px}
.sv-form-head-icon{font-size:18px}
.sv-form-sec{margin-bottom:20px}
.sv-label{font-size:13px;font-weight:700;color:var(--fg2);margin-bottom:2px}
.sv-label-hint{font-size:11px;color:var(--fg3);margin-bottom:8px}
.sv-field{width:100%;padding:13px 16px;border-radius:10px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:15px;font-weight:500;box-sizing:border-box;font-family:inherit;transition:border-color .18s}
.sv-field:focus{outline:none;border-color:var(--accent)}
.sv-textarea{width:100%;padding:13px 16px;border-radius:10px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:14px;resize:vertical;line-height:1.6;box-sizing:border-box;font-family:inherit;min-height:180px;transition:border-color .18s}
.sv-textarea:focus{outline:none;border-color:var(--accent)}
.sv-tag-input{width:100%;padding:9px 13px;border-radius:8px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:13px;box-sizing:border-box;font-family:inherit;transition:border-color .18s}
.sv-tag-input:focus{outline:none;border-color:var(--accent)}
.sv-char-count{font-size:11px;color:var(--fg3);text-align:right;margin-top:4px}
.sv-char-count.sv-warn{color:var(--warn)}
.sv-chips-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;min-height:4px}
.sv-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;background:var(--accent-dim);border:1px solid var(--accent);color:var(--accent);font-size:12px;font-weight:600}
.sv-chip-remove{font-size:14px;line-height:1;color:var(--accent);padding:0 0 0 2px;background:none;border:none;cursor:pointer}
.sv-sugg-label{font-size:11px;color:var(--fg3);margin:10px 0 6px}
.sv-sugg-row{display:flex;flex-wrap:wrap;gap:6px}
.sv-sugg-btn{padding:4px 12px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg3);font-size:12px;cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s,background .15s}
.sv-sugg-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}
.sv-error{display:none;padding:10px 14px;border-radius:9px;background:rgba(220,38,38,.09);border:1px solid rgba(220,38,38,.25);color:var(--danger);font-size:13px;margin-bottom:14px}
.sv-error.sv-show{display:block}
.sv-submit-row{display:flex;justify-content:flex-end;margin-top:8px}
.sv-submit-btn{padding:13px 36px;border-radius:999px;background:var(--solid);color:white;font-size:15px;font-weight:700;cursor:pointer;border:none;transition:opacity .18s}
.sv-submit-btn:hover{opacity:.88}
.sv-submit-btn:disabled{opacity:.5;cursor:default}
.sv-recent-wrap{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:14px 18px;margin-bottom:20px}
.sv-recent-head{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:10px}
.sv-recent-list{display:flex;flex-direction:column;gap:5px}
.sv-recent-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;background:var(--bg);border:1px solid var(--bg4);cursor:pointer;transition:background .15s}
.sv-recent-row:hover{background:var(--bg3)}
.sv-recent-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}
.sv-recent-title{font-size:13px;color:var(--fg);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-recent-status{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;flex-shrink:0}
.sv-recent-arr{font-size:11px;flex-shrink:0}
.sv-dot-running{background:#f59e0b}.sv-dot-queued{background:#6366f1}.sv-dot-verdict{background:#059669}.sv-dot-abandoned{background:#6b7280}
.sv-status-running{color:#f59e0b}.sv-status-queued{color:#6366f1}.sv-status-verdict{color:#059669}.sv-status-abandoned{color:#6b7280}
/* ── SV Agent / Kind Colours ─────────────────────────────── */
.sv-color-decomposer{color:#6366f1}.sv-color-literature{color:#0ea5e9}.sv-color-statistical{color:#8b5cf6}.sv-color-mathematical{color:#d97706}.sv-color-simulation{color:#14b8a6}.sv-color-adversarial{color:#ef4444}.sv-color-supervisor{color:#059669}.sv-color-unknown{color:#6b7280}
.sv-bg-decomposer{background:#6366f118;border-color:#6366f1}.sv-bg-literature{background:#0ea5e918;border-color:#0ea5e9}.sv-bg-statistical{background:#8b5cf618;border-color:#8b5cf6}.sv-bg-mathematical{background:#d9770618;border-color:#d97706}.sv-bg-simulation{background:#14b8a618;border-color:#14b8a6}.sv-bg-adversarial{background:#ef444418;border-color:#ef4444}.sv-bg-supervisor{background:#05966918;border-color:#059669}.sv-bg-unknown{background:#6b728018;border-color:#6b7280}
.sv-kp{font-size:10px;font-weight:700;color:white;border-radius:4px;padding:2px 7px;letter-spacing:.04em;text-transform:uppercase;flex-shrink:0}
.sv-kp-tool-call{background:#0ea5e9}.sv-kp-tool-error{background:#ef4444}.sv-kp-model-inference{background:#8b5cf6}.sv-kp-supports{background:#059669}.sv-kp-refutes{background:#ef4444}.sv-kp-neutral{background:#6b7280}.sv-kp-inconclusive{background:#d97706}.sv-kp-default{background:#6b7280}
/* ── SV Live View ────────────────────────────────────────── */
.sv-live-pg{max-width:960px;margin:0 auto;padding-bottom:48px}
.sv-live-header{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;flex-wrap:wrap}
.sv-live-icon{width:44px;height:44px;border-radius:12px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.sv-live-hyp{flex:1;min-width:200px}
.sv-live-hyp-title{font-size:17px;font-weight:700;color:var(--fg);margin-bottom:4px}
.sv-live-hyp-stmt{font-size:12px;color:var(--fg3);line-height:1.5;max-height:56px;overflow:hidden}
.sv-live-hyp-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.sv-live-tag{font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)}
.sv-live-ctrl{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0}
.sv-live-meta{display:flex;align-items:center;gap:8px}
.sv-live-status{font-size:12px;color:var(--fg3)}
.sv-live-sep{color:var(--fg3)}
.sv-live-elapsed{font-size:12px;color:var(--fg3);font-variant-numeric:tabular-nums}
.sv-live-btns{display:flex;gap:7px}
.sv-live-cancel-btn{padding:6px 14px;border-radius:8px;border:1px solid rgba(220,38,38,.4);background:transparent;color:var(--danger);font-size:13px;font-weight:600;cursor:pointer;transition:background .15s}
.sv-live-cancel-btn:hover{background:rgba(220,38,38,.08)}
.sv-live-back-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--bg4);background:transparent;color:var(--fg2);font-size:13px;font-weight:600;cursor:pointer;transition:background .15s}
.sv-live-back-btn:hover{background:var(--bg3)}
.sv-live-agents{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:12px 16px;margin-bottom:18px}
.sv-live-agents-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:8px}
.sv-live-pills{display:flex;flex-wrap:wrap;gap:6px}
.sv-live-pill{display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;border:1px solid var(--bg4);background:transparent;transition:all .3s}
.sv-live-pill.sv-active{background:var(--accent-dim);border-color:var(--accent)}
.sv-live-pill-emoji{font-size:12px}
.sv-live-pill-name{font-size:11px;font-weight:600;color:var(--fg3)}
.sv-live-pill.sv-active .sv-live-pill-name{color:var(--accent)}
.sv-live-pill-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:sv-pulse 1.2s ease-in-out infinite;flex-shrink:0}
.sv-live-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.sv-live-panel{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;display:flex;flex-direction:column;overflow:hidden}
.sv-live-panel-head{padding:10px 14px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between}
.sv-live-panel-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3)}
.sv-live-panel-count{font-size:11px;color:var(--fg3)}
.sv-live-panel-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;max-height:480px}
.sv-live-ev{display:flex;gap:10px;align-items:flex-start;background:var(--bg);border:1px solid var(--bg4);border-radius:10px;padding:10px 13px;animation:sv-fadein .25s ease-out}
.sv-live-ev-av{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;border:1px solid transparent}
.sv-live-ev-body{flex:1;min-width:0}
.sv-live-ev-meta{display:flex;align-items:center;gap:7px;margin-bottom:4px;flex-wrap:wrap}
.sv-live-ev-name{font-size:12px;font-weight:700}
.sv-live-ev-role{font-size:10px;color:var(--fg3)}
.sv-live-ev-tool{font-size:10px;color:var(--fg3);font-family:var(--mono);background:var(--bg3);padding:1px 6px;border-radius:4px;border:1px solid var(--bg4)}
.sv-live-ev-text{font-size:12px;color:var(--fg);line-height:1.5}
.sv-live-turn{display:flex;gap:9px;align-items:flex-start;background:var(--bg);border:1px solid var(--bg4);border-radius:10px;padding:9px 12px;animation:sv-fadein .25s ease-out}
.sv-live-turn.sv-dissent{background:rgba(239,68,68,.06);border-color:rgba(239,68,68,.25)}
.sv-live-turn-av{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;border:1px solid transparent}
.sv-live-turn-body{flex:1;min-width:0}
.sv-live-turn-meta{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}
.sv-live-turn-name{font-size:12px;font-weight:700}
.sv-live-turn-to{font-size:10px;color:var(--fg3)}
.sv-live-turn-round{font-size:10px;color:var(--fg3)}
.sv-live-turn-dissent{font-size:10px;font-weight:700;color:var(--danger);background:rgba(239,68,68,.1);padding:1px 6px;border-radius:4px}
.sv-live-turn-msg{font-size:12px;color:var(--fg);line-height:1.5;white-space:pre-wrap;word-break:break-word}
.sv-live-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 0;gap:10px}
.sv-live-spinner{width:36px;height:36px;border-radius:50%;border:3px solid var(--bg4);border-top-color:var(--accent);animation:sv-spin 1s linear infinite}
.sv-live-empty-text{font-size:12px;color:var(--fg3)}
/* ── SV Verdict View ─────────────────────────────────────── */
.sv-vd-pg{max-width:860px;margin:0 auto;padding-bottom:48px}
.sv-vd-topbar{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.sv-vd-topbar-icon{width:40px;height:40px;border-radius:10px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.sv-vd-topbar-text{flex:1;min-width:0}
.sv-vd-topbar-title{font-size:20px;font-weight:800;color:var(--fg);margin:0 0 2px}
.sv-vd-topbar-sub{font-size:12px;color:var(--fg3)}
.sv-vd-topbar-btns{display:flex;gap:8px;flex-shrink:0}
.sv-vd-hero{border:2px solid transparent;border-radius:16px;padding:24px 28px;margin-bottom:16px}
.sv-vd-hero-supported{background:rgba(5,150,105,.1);border-color:rgba(5,150,105,.4)}
.sv-vd-hero-refuted{background:rgba(220,38,38,.1);border-color:rgba(220,38,38,.4)}
.sv-vd-hero-inconclusive{background:rgba(217,119,6,.1);border-color:rgba(217,119,6,.4)}
.sv-vd-hero-ill-posed{background:rgba(124,58,237,.1);border-color:rgba(124,58,237,.4)}
.sv-vd-hero-out-of-scope{background:rgba(107,114,128,.1);border-color:rgba(107,114,128,.4)}
.sv-vd-hero-row{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.sv-vd-vleft{display:flex;align-items:center;gap:12px;flex:1;min-width:200px}
.sv-vd-vicon{font-size:36px;flex-shrink:0}
.sv-vd-vlabel{font-size:24px;font-weight:900}
.sv-vd-text-supported{color:#059669}.sv-vd-text-refuted{color:#dc2626}.sv-vd-text-inconclusive{color:#d97706}.sv-vd-text-ill-posed{color:#7c3aed}.sv-vd-text-out-of-scope{color:#6b7280}
.sv-vd-badges{display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap}
.sv-vd-grade{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;border:1px solid}
.sv-grade-high{color:#059669;background:rgba(5,150,105,.15);border-color:#059669}.sv-grade-moderate{color:#d97706;background:rgba(217,119,6,.15);border-color:#d97706}.sv-grade-low{color:#ef4444;background:rgba(239,68,68,.15);border-color:#ef4444}.sv-grade-very-low{color:#dc2626;background:rgba(220,38,38,.15);border-color:#dc2626}
.sv-vd-bh{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:rgba(99,102,241,.15);color:#6366f1;border:1px solid #6366f1}
.sv-vd-emitted{font-size:11px;color:var(--fg3)}
.sv-vd-ci-side{min-width:200px;flex:1}
.sv-vd-ci-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:4px;margin-top:6px}
.sv-vd-ci-svg{display:block;width:100%;height:8px;margin-top:6px;overflow:visible}
.sv-vd-ci-track{fill:var(--bg4)}
.sv-vd-ci-nums{display:flex;justify-content:space-between;font-size:11px;color:var(--fg3);margin-top:3px}
.sv-vd-summary{margin-top:16px;font-size:13px;color:var(--fg);line-height:1.6;background:rgba(0,0,0,.05);border-radius:8px;padding:12px 14px}
.sv-vd-sec{background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:18px 20px;margin-bottom:14px}
.sv-vd-sec-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:12px}
.sv-vd-hyp-stmt{font-size:13px;color:var(--fg);line-height:1.6}
.sv-vd-hyp-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.sv-vd-hyp-tag{font-size:10px;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)}
.sv-vd-subclaims{display:flex;flex-direction:column;gap:8px}
.sv-vd-sc{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:9px;background:var(--bg);border:1px solid var(--bg4)}
.sv-vd-sc-icon{font-size:16px;flex-shrink:0;margin-top:1px}
.sv-vd-sc-body{flex:1;min-width:0}
.sv-vd-sc-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:3px}
.sv-vd-sc-stmt{font-size:12px;color:var(--fg2);line-height:1.5}
.sv-vd-vpill{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid}
.sv-vp-supported{background:rgba(5,150,105,.1);color:#059669;border-color:#059669}.sv-vp-refuted{background:rgba(220,38,38,.1);color:#dc2626;border-color:#dc2626}.sv-vp-inconclusive{background:rgba(217,119,6,.1);color:#d97706;border-color:#d97706}
.sv-vd-sw-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
.sv-vd-strengths{background:rgba(5,150,105,.07);border:1px solid rgba(5,150,105,.2);border-radius:12px;padding:14px 16px}
.sv-vd-weaknesses{background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:12px;padding:14px 16px}
.sv-vd-sw-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.sv-vd-s-title{color:#059669}.sv-vd-w-title{color:#ef4444}
.sv-vd-sw-list{display:flex;flex-direction:column;gap:5px;padding:0;list-style:none}
.sv-vd-sw-item{display:flex;gap:6px;font-size:12px;color:var(--fg2);line-height:1.45}
.sv-vd-s-dot{flex-shrink:0;color:#059669;margin-top:1px}.sv-vd-w-dot{flex-shrink:0;color:#ef4444;margin-top:1px}
.sv-vd-steps{display:flex;flex-direction:column;gap:7px;padding:0;list-style:none}
.sv-vd-step{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--fg2);line-height:1.5}
.sv-vd-step-num{width:22px;height:22px;border-radius:50%;background:var(--accent-dim);color:var(--accent);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sv-vd-evlist{display:flex;flex-direction:column;gap:6px}
.sv-vd-ev{display:flex;gap:9px;align-items:flex-start;padding:8px 10px;background:var(--bg);border:1px solid var(--bg4);border-radius:8px}
.sv-vd-ev-icon{font-size:13px;flex-shrink:0;margin-top:1px}
.sv-vd-ev-body{flex:1;min-width:0}
.sv-vd-ev-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:2px}
.sv-vd-ev-agent{font-size:11px;font-weight:600;color:var(--fg2)}
.sv-vd-ev-kind{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4)}
.sv-vd-ev-tool{font-size:10px;font-family:var(--mono);color:var(--fg3)}
.sv-vd-ev-text{font-size:12px;color:var(--fg2);line-height:1.45}
.sv-vd-extra{font-size:12px;color:var(--fg3);text-align:center;padding:6px}
.sv-vd-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.sv-vd-dl-link{text-decoration:none}
.sv-vd-error{background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.2);border-radius:10px;padding:14px 16px;color:var(--danger);font-size:13px}
.sv-vd-loading{color:var(--fg3);font-size:13px;text-align:center;padding:40px 0}
/* ── SV Keyframe Animations ──────────────────────────────── */
@keyframes sv-pulse{0%,100%{opacity:.4;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}
@keyframes sv-spin{to{transform:rotate(360deg)}}
@keyframes sv-fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}

/* ── Scrollbar ────────────────────────────– */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--fg3)}

@media(max-width:1100px){.workspace-body{grid-template-columns:1fr}.right-rail{display:none}}
@media(max-width:900px){.charts{grid-template-columns:1fr}.workspace-nav{width:78px}}
@media(max-width:900px){.prompt-wizard-grid{grid-template-columns:1fr}}
@media(max-width:1200px){.admin-content-grid.editing{grid-template-columns:minmax(0,1fr)}}
@media(max-width:1200px){.admin-editor-panel{position:static}}
@media(max-width:640px){.workspace-nav{display:none}.app{flex-direction:column}}
@media(max-width:900px){.notes-layout{grid-template-columns:1fr}.notes-sidebar{display:none}}
@media(max-width:900px){.cal-week-view .cal-week-header,.cal-week-grid .cal-week-row{grid-template-columns:40px repeat(7,1fr)}}
`;
