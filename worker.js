/**
 * KANBAN TODO LIST (14KO Compliant)
 * Features: Multi-board, Lists, Cards, Drag & Drop
 */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    // Normalize path: strip /todo prefix if present
    let path = url.pathname;
    if (path.startsWith('/todo')) {
      path = path.substring(5) || '/';
    }

    // SESSION MANAGEMENT
    const cookie = req.headers.get('Cookie');
    const sessionId = cookie ? cookie.split(';').find(c => c.trim().startsWith('sess='))?.split('=')[1] : null;
    let user = null;
    if (sessionId) user = await env.AUTH_DB.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?').bind(sessionId, Date.now()).first();

    // PROTECTED ROUTES — redirect to central auth if not logged in
    if (!user) {
      const redirectUrl = `/auth/login?redirect=${encodeURIComponent(url.pathname)}`;
      return new Response(null, { status: 302, headers: { 'Location': redirectUrl } });
    }

    // API: BOARD
    if (path === '/api/board/create' && method === 'POST') {
      const fd = await req.formData();
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO boards (id, username, name, created_at) VALUES (?, ?, ?, ?)').bind(id, user.username, fd.get('name'), Date.now()).run();
      return new Response(JSON.stringify({ id }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/api/board/delete' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('DELETE FROM boards WHERE id = ? AND username = ?').bind(fd.get('id'), user.username).run();
      return new Response('OK');
    }

    // API: LIST
    if (path === '/api/list/create' && method === 'POST') {
      const fd = await req.formData();
      const { results: lists } = await env.DB.prepare('SELECT * FROM lists WHERE board_id = ? ORDER BY position ASC').bind(fd.get('boardId')).all();
      const pos = lists.length > 0 ? Math.max(...lists.map(l => l.position)) + 1 : 0;
      await env.DB.prepare('INSERT INTO lists (id, board_id, username, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), fd.get('boardId'), user.username, fd.get('name'), pos, fd.get('color') || '#bb86fc', Date.now()).run();
      return new Response('OK');
    }

    if (path === '/api/list/delete' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('DELETE FROM lists WHERE id = ? AND username = ?').bind(fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/list/rename' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('UPDATE lists SET name = ? WHERE id = ? AND username = ?').bind(fd.get('name'), fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/list/reorder' && method === 'POST') {
      const fd = await req.formData();
      const lid = fd.get('listId'), npos = parseInt(fd.get('newPosition'));
      const list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(lid).first();
      await env.DB.prepare('UPDATE lists SET position = position - 1 WHERE board_id = ? AND position > ?').bind(list.board_id, list.position).run();
      await env.DB.prepare('UPDATE lists SET position = position + 1 WHERE board_id = ? AND position >= ?').bind(list.board_id, npos).run();
      await env.DB.prepare('UPDATE lists SET position = ? WHERE id = ?').bind(npos, lid).run();
      return new Response('OK');
    }

    // API: CARD
    if (path === '/api/card/create' && method === 'POST') {
      const fd = await req.formData();
      const lid = fd.get('listId');
      const { results: cards } = await env.DB.prepare('SELECT * FROM cards WHERE list_id = ? ORDER BY position ASC').bind(lid).all();
      const pos = cards.length > 0 ? Math.max(...cards.map(c => c.position)) + 1 : 0;
      const list = await env.DB.prepare('SELECT board_id FROM lists WHERE id = ?').bind(lid).first();
      await env.DB.prepare('INSERT INTO cards (id, list_id, board_id, username, title, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), lid, list.board_id, user.username, fd.get('title'), '', pos, Date.now()).run();
      return new Response('OK');
    }

    if (path === '/api/card/update' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('UPDATE cards SET title = ?, description = ? WHERE id = ? AND username = ?').bind(fd.get('title'), fd.get('description'), fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/card/delete' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('DELETE FROM cards WHERE id = ? AND username = ?').bind(fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/card/move' && method === 'POST') {
      const fd = await req.formData();
      const cid = fd.get('cardId'), nlid = fd.get('newListId'), npos = parseInt(fd.get('newPosition'));
      const card = await env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(cid).first();
      await env.DB.prepare('UPDATE cards SET position = position - 1 WHERE list_id = ? AND position > ?').bind(card.list_id, card.position).run();
      await env.DB.prepare('UPDATE cards SET position = position + 1 WHERE list_id = ? AND position >= ?').bind(nlid, npos).run();
      await env.DB.prepare('UPDATE cards SET list_id = ?, position = ? WHERE id = ?').bind(nlid, npos, cid).run();
      return new Response('OK');
    }

    if (path === '/api/password' && method === 'POST') {
      const fd = await req.formData();
      await env.AUTH_DB.prepare('UPDATE users SET password = ? WHERE username = ?').bind(await hash(fd.get('p')), user.username).run();
      return new Response('OK');
    }

    // PAGES
    const basePath = url.pathname.startsWith('/todo') ? '/todo' : '';
    if (path === '/settings') return new Response(renderSettings(user, basePath), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    if (path.startsWith('/board/')) {
      const bid = path.split('/board/')[1];
      const board = await env.DB.prepare('SELECT * FROM boards WHERE id = ? AND username = ?').bind(bid, user.username).first();
      if (!board) return new Response('404', { status: 404 });
      const { results: lists } = await env.DB.prepare('SELECT * FROM lists WHERE board_id = ? ORDER BY position ASC').bind(bid).all();
      const { results: cards } = await env.DB.prepare('SELECT * FROM cards WHERE board_id = ? ORDER BY position ASC').bind(bid).all();
      return new Response(renderBoard(user, board, lists, cards, basePath), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (path === '/' || url.pathname === '') {
      const { results: boards } = await env.DB.prepare('SELECT * FROM boards WHERE username = ? ORDER BY created_at DESC').bind(user.username).all();
      return new Response(renderDash(user, boards, basePath), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response('404', { status: 404 });
  }
};

async function hash(str) {
  const buf = new TextEncoder().encode(str);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper: Get base path prefix
const BASE_PATH = (path) => path.startsWith('/todo') ? '/todo' : '';

// CSS - Simple Dark Theme (like Habit Tracker)
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500&display=swap');
:root{
  --bg:#0F1115;--surface:#1A1D24;--surface-hover:#20242C;--surface-soft:#151820;
  --text:#F1F5F9;--text-secondary:#94A3B8;--text-muted:#64748B;--border:#262A33;
  --accent:#A855F7;--accent-pink:#EC4899;
  --accent-soft:rgba(168,85,247,0.10);--accent-glow:rgba(168,85,247,0.20);
  --danger:#F43F5E;--danger-soft:rgba(244,63,94,0.12);
  --good:#10B981;--good-soft:rgba(16,185,129,0.12);
  --warn:#F59E0B;
  --radius-sm:6px;--radius:8px;--radius-md:10px;--radius-lg:12px;--radius-xl:16px;
  --transition:150ms ease-out;
  --shadow-sm:0 1px 3px rgba(0,0,0,0.25);--shadow:0 4px 16px rgba(0,0,0,0.30);--shadow-lg:0 16px 48px rgba(0,0,0,0.40);
  --gradient:linear-gradient(135deg,#A855F7,#EC4899);
  --gradient-subtle:linear-gradient(135deg,rgba(168,85,247,0.15),rgba(236,72,153,0.10));
  --font:"DM Sans",ui-sans-serif,system-ui,-apple-system,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  /* legacy aliases used by inline styles */
  --card:var(--surface);--txt-main:var(--text);--txt-muted:var(--text-secondary);
  --p:var(--accent);--err:var(--danger);
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0 auto;font-family:var(--font);background:var(--bg);color:var(--text);max-width:1400px;padding:20px;line-height:1.5;font-size:14px;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{letter-spacing:-0.01em;font-weight:700;margin:0}
::selection{background:rgba(168,85,247,0.30)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input,textarea,select,button{font:inherit;color:inherit}
input,textarea,select{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:9px 12px;border-radius:var(--radius);margin:4px 0;transition:all var(--transition);font-size:0.9em}
input::placeholder,textarea::placeholder{color:var(--text-muted)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);background:var(--surface);box-shadow:0 0 0 3px var(--accent-glow)}
button{cursor:pointer;background:var(--gradient);color:#fff;font-weight:600;border:none;padding:9px 16px;border-radius:var(--radius);transition:all var(--transition);font-size:0.9em;box-shadow:0 2px 8px rgba(168,85,247,0.30)}
button:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(168,85,247,0.40)}
button:active{transform:translateY(0)}
.card{background:var(--surface);padding:22px;border-radius:var(--radius-lg);margin-bottom:20px;border:1px solid var(--border);box-shadow:var(--shadow-sm)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
a{color:var(--accent);text-decoration:none;transition:color var(--transition)}
a:hover{color:var(--accent-pink)}
header{display:flex;justify-content:space-between;align-items:center;min-height:64px;padding:12px 24px;background:var(--surface);border:1px solid var(--border);margin-bottom:24px;border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);flex-wrap:nowrap;gap:12px}
header strong{font-size:1.05em;letter-spacing:-0.02em}
.user-wrap{position:relative}
.user-btn{display:flex;align-items:center;gap:8px;color:var(--text);font-size:0.84rem;font-weight:500;padding:6px 12px 6px 10px;border-radius:var(--radius);background:transparent;border:1px solid var(--border);cursor:pointer;transition:all var(--transition);white-space:nowrap;box-shadow:none}
.user-btn:hover{background:var(--surface-hover);transform:none;box-shadow:none}
.user-btn .caret{transition:transform var(--transition);margin-left:2px;color:var(--text-muted)}
.user-wrap.open .user-btn .caret{transform:rotate(180deg)}
.user-dropdown{display:none;position:absolute;right:0;top:calc(100% + 8px);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);min-width:220px;box-shadow:var(--shadow-lg);z-index:999;overflow:hidden}
.user-wrap.open .user-dropdown{display:block;animation:fadeInDropdown 150ms ease-out}
@keyframes fadeInDropdown{from{opacity:0;transform:translateY(-4px) scale(0.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.user-dropdown-header{padding:14px 16px 10px;border-bottom:1px solid var(--border)}
.user-dropdown-header .uname{font-weight:700;color:var(--text);font-size:0.92rem}
.user-dropdown-header .role{color:var(--text-muted);font-size:0.76rem;margin-top:2px}
.user-dropdown a{display:flex;align-items:center;gap:10px;padding:10px 16px;color:var(--text);text-decoration:none;font-size:0.86rem;font-weight:500;transition:background var(--transition)}
.user-dropdown a:hover{background:var(--accent-soft)}
.user-dropdown .sep{height:1px;background:var(--border);margin:4px 0}
.user-dropdown .signout{color:var(--danger)}
.user-dropdown .signout:hover{background:var(--danger-soft);color:var(--danger)}
.nav-link{padding:7px 14px;border-radius:999px;background:var(--surface-soft);border:1px solid var(--border);color:var(--text-secondary);font-weight:600;font-size:0.82rem;transition:all var(--transition);display:inline-flex;align-items:center;gap:6px}
.nav-link:hover{background:var(--surface-hover);color:var(--text)}
.nav-link.active{background:var(--gradient);color:#fff;border-color:transparent;box-shadow:0 2px 8px rgba(168,85,247,0.35)}
.board-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;margin-top:20px}
.board-item{background:var(--surface);padding:22px;border-radius:var(--radius-lg);border:1px solid var(--border);cursor:pointer;transition:all var(--transition);box-shadow:var(--shadow-sm);position:relative;overflow:hidden}
.board-item::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--gradient);opacity:0;transition:opacity var(--transition)}
.board-item:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 12px 28px rgba(0,0,0,0.35), 0 0 0 1px rgba(168,85,247,0.3) inset;background:var(--surface-hover)}
.board-item:hover::before{opacity:1}
.board-item h3{margin-bottom:10px;font-size:1.05rem;font-weight:700;letter-spacing:-0.01em}
.board-item .meta{color:var(--text-muted);font-size:0.8rem;margin-bottom:16px;font-family:var(--font-mono)}
.board-item button{background:transparent;border:1px solid var(--border);color:var(--text-secondary);box-shadow:none;padding:6px 12px;font-size:0.82rem}
.board-item button:hover{background:var(--danger-soft);color:var(--danger);border-color:rgba(244,63,94,0.35);transform:none;box-shadow:none}
.kanban{display:flex;gap:16px;overflow-x:auto;padding:6px 4px 20px;min-height:70vh}
.kanban::-webkit-scrollbar{height:8px}
.kanban::-webkit-scrollbar-thumb{background:var(--border);border-radius:999px}
.list{min-width:300px;max-width:300px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);display:flex;flex-direction:column;max-height:calc(100vh - 180px);transition:transform var(--transition),opacity var(--transition);box-shadow:var(--shadow-sm)}
.list.dragging{opacity:0.4;transform:scale(0.97)}
.list.placeholder{background:var(--accent-soft);border:2px dashed var(--accent);opacity:0.7;min-height:200px;border-radius:var(--radius-lg)}
.list-header{background:var(--surface-soft);padding:12px 14px;border-radius:var(--radius-lg) var(--radius-lg) 0 0;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);user-select:none;gap:8px}
.list-header input{background:transparent;border:none;color:var(--text);font-weight:700;font-size:0.92rem;padding:3px 6px;margin:0;flex:1;box-shadow:none;letter-spacing:-0.01em}
.list-header input:focus{background:var(--bg);border-radius:var(--radius-sm);box-shadow:0 0 0 2px var(--accent-glow)}
.list-header .count{background:var(--accent-soft);color:var(--accent);padding:2px 9px;border-radius:999px;font-size:0.7rem;font-weight:700;font-family:var(--font-mono)}
.list-header button{background:transparent;color:var(--text-muted);border:none;padding:5px 7px;font-size:0.9em;cursor:pointer;border-radius:var(--radius-sm);box-shadow:none}
.list-header button:hover{color:var(--danger);background:var(--danger-soft);transform:none;box-shadow:none}
.cards{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
.cards::-webkit-scrollbar{width:4px}
.cards::-webkit-scrollbar-thumb{background:var(--border);border-radius:999px}
.task-card{background:var(--surface-soft);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;cursor:grab;position:relative;transition:all var(--transition);box-shadow:var(--shadow-sm)}
.task-card:hover{border-color:var(--accent);box-shadow:0 4px 14px rgba(0,0,0,0.3), 0 0 0 1px rgba(168,85,247,0.2) inset;transform:translateY(-1px)}
.task-card:hover .card-actions{opacity:1}
.task-card:active{cursor:grabbing;transform:scale(0.98)}
.task-card.dragging{opacity:0.4;transform:scale(0.95);box-shadow:none}
.card-title{font-weight:600;margin-bottom:4px;line-height:1.4;color:var(--text);font-size:0.92rem}
.card-desc{color:var(--text-secondary);font-size:0.82rem;margin-top:6px;line-height:1.5}
.card-actions{opacity:0;display:flex;gap:6px;margin-top:10px;transition:opacity var(--transition);pointer-events:auto;border-top:1px solid var(--border);padding-top:10px}
.task-card:hover .card-actions,.card-actions:hover,.card-actions:focus-within{opacity:1!important}
.card-actions button{background:transparent;color:var(--text-muted);border:1px solid var(--border);padding:5px 10px;border-radius:var(--radius-sm);font-size:0.76rem;cursor:pointer;pointer-events:all;box-shadow:none;font-weight:500;flex:1}
.card-actions button:hover{background:var(--surface-hover);color:var(--text);transform:none;box-shadow:none}
.card-actions button.del:hover{color:var(--danger);background:var(--danger-soft);border-color:rgba(244,63,94,0.3)}
.add-card{padding:10px;margin:10px;background:transparent;border:1px dashed var(--border);border-radius:var(--radius);color:var(--text-muted);text-align:center;cursor:pointer;font-size:0.84rem;font-weight:600;transition:all var(--transition)}
.add-card:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,17,21,0.75);backdrop-filter:blur(6px);z-index:1000;align-items:center;justify-content:center}
.modal.active{display:flex;animation:fadeIn 0.2s ease-out}
@keyframes fadeIn{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}
.modal-content{background:var(--surface);padding:28px;border-radius:var(--radius-xl);border:1px solid var(--border);max-width:500px;width:90%;box-shadow:var(--shadow-lg)}
.modal-content h3{margin-bottom:20px;font-size:1.1rem;font-weight:700;letter-spacing:-0.01em}
.form-group{margin-bottom:16px}
.form-group label{display:block;margin-bottom:6px;color:var(--text-secondary);font-size:0.82rem;font-weight:600;letter-spacing:0.02em}
.form-group input,.form-group textarea,.form-group select{width:100%}
.btn-group{display:flex;gap:10px;margin-top:24px}
.btn-group button{flex:1}
.btn-danger{background:transparent;border:1px solid var(--border);color:var(--text);box-shadow:none}
.btn-danger:hover{background:var(--danger-soft);color:var(--danger);border-color:rgba(244,63,94,0.35);transform:none;box-shadow:none}
`;

const FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23A855F7'/%3E%3Cstop offset='1' stop-color='%23EC4899'/%3E%3C/LinearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Ctext x='16' y='21' font-family='Arial,sans-serif' font-weight='900' font-size='12' fill='white' text-anchor='middle'%3E111%3C/text%3E%3C/svg%3E`;

function renderBrand(appName) {
  return `<a href="/" style="text-decoration:none;display:flex;align-items:center;gap:10px;flex-shrink:0">
    <span style="width:36px;height:36px;background:linear-gradient(135deg,#A855F7,#EC4899);border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.9em;color:#fff;flex-shrink:0;box-shadow:0 2px 8px rgba(168,85,247,0.3)">111</span>
    <div style="display:flex;flex-direction:column;line-height:1.25">
      <span style="font-weight:700;font-size:1.1em;color:#fff;letter-spacing:-0.02em">111<span style="color:#A855F7;text-shadow:0 0 20px rgba(168,85,247,0.5)">iridescence</span></span>
      <span style="font-size:0.72em;color:#94a3b8;font-weight:500;letter-spacing:0.03em">${appName}</span>
    </div>
  </a>`;
}

function renderUserDropdown(username, appName) {
  const id = 'uw' + Math.random().toString(36).slice(2, 6);
  return `<div class="user-wrap" id="${id}">
    <button class="user-btn" onclick="document.getElementById('${id}').classList.toggle('open')">
      ${username}
      <svg class="caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="user-dropdown">
      <div class="user-dropdown-header"><div class="uname">${username}</div><div class="role">${appName}</div></div>
      <a href="/auth/account">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>
        Account Preferences
      </a>
      <a href="/auth/admin">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        Admin Panel
      </a>
      <div class="sep"></div>
      <a href="/auth/logout" class="signout">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Sign Out
      </a>
    </div>
  </div>
  <script>document.addEventListener('click',e=>{const w=document.getElementById('${id}');if(w&&!w.contains(e.target))w.classList.remove('open')});</script>`;
}

function renderNav(active, username, basePath = '') {
  return `<div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
    <a href="${basePath}/" class="nav-link ${active === 'boards' ? 'active' : ''}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
      Boards</a>
    ${renderUserDropdown(username, 'Todo List')}
  </div>`;
}


function renderSettings(user, basePath = '') {
  return `<!DOCTYPE html><html lang="en"><head><title>111 Todo List</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="${FAVICON}"><style>${CSS}</style></head><body>
    <header>
      ${renderBrand('Todo List')}
      ${renderNav('settings', user.username, basePath)}
    </header>
    <div class="card">
      <h3>Change Password</h3>
      <form onsubmit="event.preventDefault();changePw(this)">
        <input type="password" name="p" placeholder="New Password" required><br>
        <button style="margin-top:12px">Update Password</button>
      </form>
    </div>
    <script>
      async function changePw(f){
        const r = await fetch(BASE + '/api/password',{method:'POST',body:new FormData(f)});
        if(r.ok) alert('Password updated!');
      }
    </script>
  </body></html>`;
}


function renderDash(user, boards, basePath = '') {
  return `<!DOCTYPE html><html lang="en"><head><title>111 Todo List</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="${FAVICON}"><style>${CSS}</style></head><body>
  <header>
    ${renderBrand('Todo List')}
    ${renderNav('boards', user.username, basePath)}
  </header>
  <div style="margin-bottom:20px">
    <button onclick="showModal()">+ New Board</button>
  </div>
  <div class="board-grid">
    ${boards.length === 0 ? '<div class="card" style="grid-column:1/-1;text-align:center;color:#777">No boards yet. Create your first board!</div>' : ''}
    ${boards.map(b => `
        <div class="board-item" onclick="location.href='${basePath}/board/${b.id}'">
          <h3>${b.name}</h3>
          <div class="meta">Created ${new Date(b.created_at).toLocaleDateString()}</div>
          <button onclick="event.stopPropagation();deleteBoard('${b.id}','${b.name}')" style="background:var(--err)">Delete</button>
        </div>
      `).join('')}
  </div>

  <div id="modal" class="modal">
    <div class="modal-content">
      <h3>Create Board</h3>
      <form onsubmit="event.preventDefault();createBoard(this)">
        <div class="form-group">
          <label>Board Name</label>
          <input type="text" name="name" required autofocus>
        </div>
        <div class="btn-group">
          <button>Create</button>
          <button type="button" class="btn-danger" onclick="hideModal()">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Confirmation Modal -->
  <div id="confirmModal" class="modal">
    <div class="modal-content" style="max-width:400px">
      <h3>⚠ Confirm Deletion</h3>
      <p id="confirmMessage" style="color:#aaa;margin:20px 0"></p>
      <div class="btn-group">
        <button id="confirmYes" class="btn-danger">Delete</button>
        <button id="confirmNo" onclick="hideConfirm()">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    const BASE = location.pathname.startsWith('/todo') ? '/todo' : '';
    let confirmCallback = null;

    function showConfirm(message, onConfirm) {
      confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmModal.classList.add('active');
      }

    function hideConfirm() {
      confirmModal.classList.remove('active');
    confirmCallback = null;
      }

      confirmYes.onclick = () => {
        if (confirmCallback) confirmCallback();
    hideConfirm();
      };

    function showModal(){modal.classList.add('active'); }
    function hideModal(){modal.classList.remove('active'); }
    async function createBoard(f){
        const r = await fetch(BASE + '/api/board/create',{method:'POST',body:new FormData(f)});
    if(r.ok){
          const d = await r.json();
    location.href = BASE + '/board/' + d.id;
        }
      }
    function deleteBoard(id,name){
      showConfirm('Delete board "' + name + '"? All lists and cards will be deleted.', async () => {
        const fd = new FormData();
        fd.append('id', id);
        await fetch(BASE + '/api/board/delete', { method: 'POST', body: fd });
        location.reload();
      });
      }
  </script>
</body></html>`;
}

function renderBoard(user, board, lists, cards, basePath = '') {
  const cardsByList = {};
  cards.forEach(c => {
    if (!cardsByList[c.list_id]) cardsByList[c.list_id] = [];
    cardsByList[c.list_id].push(c);
  });

  return `<!DOCTYPE html><html lang="en"><head><title>${board.name} · 111iridescence</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>
    <header>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        ${renderBrand()}
        <span style="color:var(--border);font-size:1.2em">/</span>
        <a href="${basePath}/" style="color:var(--txt-muted);text-decoration:none;font-size:0.95em;transition:color 0.2s" onmouseover="this.style.color='var(--txt-main)'" onmouseout="this.style.color='var(--txt-muted)'">Boards</a>
        <span style="color:var(--border);font-size:1.2em">/</span>
        <strong style="color:var(--txt-main);font-size:0.95em">${board.name}</strong>
      </div>
      ${renderNav('', user.username, basePath)}
    </header>

  <div style="margin-bottom:15px">
    <button onclick="showListModal()">+ Add List</button>
  </div>

  <div class="kanban" ondrop="dropList(event)" ondragover="dragOverList(event)">
    ${lists.map(list => `
        <div class="list" data-list-id="${list.id}" draggable="true" ondragstart="dragList(event,'${list.id}')" ondragend="dragEndList(event)">
          <div class="list-header" style="cursor:grab">
            <input value="${list.name}" onblur="renameList('${list.id}',this.value)" ondragstart="event.stopPropagation()" draggable="false">
            <span class="count">${(cardsByList[list.id] || []).length}</span>
            <button onclick="deleteList('${list.id}','${list.name}')" ondragstart="event.stopPropagation()">🗑</button>
          </div>
          <div class="cards" ondrop="drop(event,'${list.id}')" ondragover="allowDrop(event)">
            ${(cardsByList[list.id] || []).map(card => `
              <div class="task-card" draggable="true" ondragstart="drag(event,'${card.id}')" data-card-id="${card.id}">
                <div class="card-title">${card.title}</div>
                ${card.description ? `<div class="card-desc">${card.description}</div>` : ''}
                <div class="card-actions">
                  <button onmousedown="event.stopPropagation()" onclick="event.stopPropagation();editCard('${card.id}','${escapeHtml(card.title)}','${escapeHtml(card.description)}')">Edit</button>
                  <button class="del" onmousedown="event.stopPropagation()" onclick="event.stopPropagation();deleteCard('${card.id}')">Delete</button>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="add-card" onclick="showCardModal('${list.id}')" ondragstart="event.stopPropagation()">+ Add Card</div>
        </div>
      `).join('')}
  </div>

  <!-- List Modal -->
  <div id="listModal" class="modal">
    <div class="modal-content">
      <h3>Create List</h3>
      <form onsubmit="event.preventDefault();createList(this)">
        <div class="form-group">
          <label>List Name</label>
          <input type="text" name="name" required autofocus>
        </div>
        <div class="btn-group">
          <button>Create</button>
          <button type="button" class="btn-danger" onclick="hideModals()">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Card Modal -->
  <div id="cardModal" class="modal">
    <div class="modal-content">
      <h3>Create Card</h3>
      <form onsubmit="event.preventDefault();createCard(this)">
        <input type="hidden" name="listId" id="cardListId">
          <div class="form-group">
            <label>Card Title</label>
            <input type="text" name="title" required>
          </div>
          <div class="btn-group">
            <button>Create</button>
            <button type="button" class="btn-danger" onclick="hideModals()">Cancel</button>
          </div>
      </form>
    </div>
  </div>

  <!-- Edit Card Modal -->
  <div id="editModal" class="modal">
    <div class="modal-content">
      <h3>Edit Card</h3>
      <form onsubmit="event.preventDefault();updateCard(this)">
        <input type="hidden" name="id" id="editCardId">
          <div class="form-group">
            <label>Title</label>
            <input type="text" name="title" id="editTitle" required>
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea name="description" id="editDesc" rows="4"></textarea>
          </div>
          <div class="btn-group">
            <button>Save</button>
            <button type="button" class="btn-danger" onclick="hideModals()">Cancel</button>
          </div>
      </form>
    </div>
  </div>

  <!-- Confirmation Modal -->
  <div id="confirmModal" class="modal">
    <div class="modal-content" style="max-width:400px">
      <h3>⚠ Confirm Deletion</h3>
      <p id="confirmMessage" style="color:#aaa;margin:20px 0"></p>
      <div class="btn-group">
        <button id="confirmYes" class="btn-danger">Delete</button>
        <button id="confirmNo" onclick="hideConfirm()">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    const BASE = location.pathname.startsWith('/todo') ? '/todo' : '';
    const boardId = '${board.id}';
    let draggedCardId = null;
    let draggedListId = null;
    let confirmCallback = null;

    function showConfirm(message, onConfirm) {
      confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmModal.classList.add('active');
      }

    function hideConfirm() {
      confirmModal.classList.remove('active');
    confirmCallback = null;
      }

      confirmYes.onclick = () => {
        if (confirmCallback) confirmCallback();
    hideConfirm();
      };

    function showListModal(){listModal.classList.add('active'); }
    function showCardModal(listId){cardListId.value = listId; cardModal.classList.add('active'); }
    function hideModals(){document.querySelectorAll('.modal').forEach(m => m.classList.remove('active')); }

    async function createList(f){
        const fd = new FormData(f);
    fd.append('boardId', boardId);
    await fetch(BASE + '/api/list/create',{method:'POST',body:fd});
    location.reload();
      }

    function deleteList(id, name){
      showConfirm('Delete list "' + name + '"? All cards will be deleted.', async () => {
        const fd = new FormData();
        fd.append('id', id);
        await fetch(BASE + '/api/list/delete', { method: 'POST', body: fd });
        location.reload();
      });
      }

    async function renameList(id, name){
        const fd = new FormData();
    fd.append('id', id);
    fd.append('name', name);
    await fetch(BASE + '/api/list/rename',{method:'POST',body:fd});
      }

    async function createCard(f){
      await fetch(BASE + '/api/card/create', { method: 'POST', body: new FormData(f) });
    location.reload();
      }

    function editCard(id, title, desc){
      editCardId.value = id;
    editTitle.value = title;
    editDesc.value = desc;
    editModal.classList.add('active');
      }

    async function updateCard(f){
      await fetch(BASE + '/api/card/update', { method: 'POST', body: new FormData(f) });
    location.reload();
      }

    function deleteCard(id){
      showConfirm('Delete this card?', async () => {
        const fd = new FormData();
        fd.append('id', id);
        await fetch(BASE + '/api/card/delete', { method: 'POST', body: fd });
        location.reload();
      });
      }

    // Card drag and drop
    function drag(e, cardId){
      draggedCardId = cardId;
    e.target.classList.add('dragging');
    e.stopPropagation();
      }

    function allowDrop(e){e.preventDefault(); }

    async function drop(e, newListId){
      e.preventDefault();
    e.stopPropagation();
    if (!draggedCardId) return;

    const cardsContainer = e.currentTarget;
    const cards = Array.from(cardsContainer.children);
    const dropY = e.clientY;
    let newPosition = 0;

    for(let i = 0; i < cards.length; i++){
          const rect = cards[i].getBoundingClientRect();
    if(dropY < rect.top + rect.height / 2){
      newPosition = i;
    break;
          }
    newPosition = i + 1;
        }

    const fd = new FormData();
    fd.append('cardId', draggedCardId);
    fd.append('newListId', newListId);
    fd.append('newPosition', newPosition);
    await fetch(BASE + '/api/card/move',{method:'POST',body:fd});
    draggedCardId = null;
    location.reload();
      }

    // List drag and drop with live preview
    let draggedListElement = null;
    let placeholderElement = null;

    function dragList(e, listId){
      draggedListId = listId;
    draggedListElement = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';

    // Create placeholder
    placeholderElement = document.createElement('div');
    placeholderElement.className = 'list placeholder';
    placeholderElement.innerHTML = '<div style="padding:20px;text-align:center;color:var(--p);opacity:0.5">Drop here</div>';
      }

    function dragOverList(e){
      e.preventDefault();
    if (!draggedListId || !placeholderElement) return;

    const kanban = e.currentTarget;
    const afterElement = getDragAfterElement(kanban, e.clientX);

    // Insert placeholder at the right position
    if (afterElement == null) {
      kanban.appendChild(placeholderElement);
        } else {
      kanban.insertBefore(placeholderElement, afterElement);
        }
      }

    function getDragAfterElement(container, x) {
        const draggableElements = [...container.querySelectorAll('.list:not(.dragging):not(.placeholder)')];
        
        return draggableElements.reduce((closest, child) => {
          const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;

    if (offset < 0 && offset > closest.offset) {
            return {offset: offset, element: child };
          } else {
            return closest;
          }
        }, {offset: Number.NEGATIVE_INFINITY }).element;
      }

    async function dropList(e){
      e.preventDefault();
    if (!draggedListId || !placeholderElement) return;

    const kanban = e.currentTarget;
    const lists = Array.from(kanban.querySelectorAll('.list:not(.dragging):not(.placeholder)'));

    // Find position of placeholder
    let newPosition = 0;
    const allChildren = Array.from(kanban.children);
    const placeholderIndex = allChildren.indexOf(placeholderElement);

    // Count non-dragging, non-placeholder lists before the placeholder
    for(let i = 0; i < placeholderIndex; i++){
          if (!allChildren[i].classList.contains('dragging') && !allChildren[i].classList.contains('placeholder')) {
      newPosition++;
          }
        }

    // Clean up
    if (placeholderElement.parentNode) {
      placeholderElement.parentNode.removeChild(placeholderElement);
        }
    draggedListElement.classList.remove('dragging');

    const fd = new FormData();
    fd.append('listId', draggedListId);
    fd.append('newPosition', newPosition);
    await fetch(BASE + '/api/list/reorder',{method:'POST',body:fd});

    draggedListId = null;
    draggedListElement = null;
    placeholderElement = null;
    location.reload();
      }

    function dragEndList(e){
      e.target.classList.remove('dragging');
    if (placeholderElement && placeholderElement.parentNode) {
      placeholderElement.parentNode.removeChild(placeholderElement);
        }
    draggedListId = null;
    draggedListElement = null;
    placeholderElement = null;
      }
  </script>
</body></html>`;
}

function escapeHtml(text) {
  return text.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}
