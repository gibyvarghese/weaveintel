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
.input-tools{display:flex;align-items:center;gap:8px}
.tool-btn{width:42px;height:42px;border-radius:12px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg2);font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .18s ease}
.tool-btn:hover{background:var(--bg2);border-color:var(--fg3);color:var(--fg)}
.tool-btn.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
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
.settings-dd{width:360px;padding:24px}
.settings-dd h3{font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--fg)}
.mode-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2);cursor:pointer;transition:all .18s ease}
.mode-card:hover{border-color:var(--fg3);background:var(--bg3)}
.mode-card.selected{border-color:var(--accent);background:var(--accent-dim)}
.mode-card .mc-icon{font-size:18px;width:28px;text-align:center}
.mode-card .mc-title{font-size:13px;font-weight:600;color:var(--fg)}
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
`;
