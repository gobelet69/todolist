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

    // PUBLIC ROUTES
    if (path === '/login' && method === 'POST') {
      const fd = await req.formData();
      const dbUser = await env.AUTH_DB.prepare('SELECT * FROM users WHERE username = ? AND password = ?').bind(fd.get('u'), await hash(fd.get('p'))).first();
      if (!dbUser) return new Response('Invalid credentials', { status: 401 });
      const newSess = crypto.randomUUID();
      await env.AUTH_DB.prepare('INSERT INTO sessions (id, username, role, expires) VALUES (?, ?, ?, ?)').bind(newSess, dbUser.username, dbUser.role, Date.now() + 86400000).run();
      return new Response('OK', { headers: { 'Set-Cookie': `sess=${newSess}; HttpOnly; Secure; SameSite=Strict; Path=/` } });
    }

    if (path === '/register' && method === 'POST') {
      const fd = await req.formData();
      const existing = await env.AUTH_DB.prepare('SELECT username FROM users WHERE username = ?').bind(fd.get('u')).first();
      if (existing) return new Response('Username taken', { status: 400 });
      await env.AUTH_DB.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)').bind(fd.get('u'), await hash(fd.get('p')), 'user', Date.now()).run();
      return new Response('OK');
    }

    if (path === '/logout') {
      if (sessionId) await env.AUTH_DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      return new Response('Logged out', { status: 302, headers: { 'Location': '/', 'Set-Cookie': 'sess=; Max-Age=0; Path=/' } });
    }

    // PROTECTED ROUTES
    if (!user) return new Response(renderLogin(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

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
:root{--bg:#121212;--card:#1e1e1e;--txt:#e0e0e0;--p:#bb86fc;--s:#03dac6;--err:#cf6679;--good:#4caf50}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt);max-width:1400px;margin:0 auto;padding:20px}
input,textarea{background:#333;border:1px solid #444;color:#fff;padding:8px;border-radius:4px;margin:5px 0}
button{cursor:pointer;background:var(--p);color:#000;font-weight:bold;border:none;padding:8px;border-radius:4px}
button:hover{opacity:0.9}
.card{background:var(--card);padding:20px;border-radius:8px;margin-bottom:20px;border:1px solid #333}
.row{display:flex;justify-content:space-between;align-items:center}
a{color:var(--s);text-decoration:none}
.nav-link{padding:5px 10px;border-radius:4px;background:#333;color:#fff}
.nav-link.active{background:var(--p);color:#000}
.board-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;margin-top:20px}
.board-item{background:var(--card);padding:20px;border-radius:8px;border:1px solid #333;cursor:pointer;transition:border-color 0.2s}
.board-item:hover{border-color:var(--p)}
.board-item h3{margin-bottom:10px}
.board-item .meta{color:#777;font-size:0.85em;margin-bottom:15px}
.kanban{display:flex;gap:15px;overflow-x:auto;padding:10px 0}
.list{min-width:300px;max-width:300px;background:var(--card);border:1px solid #333;border-radius:8px;display:flex;flex-direction:column;max-height:calc(100vh - 180px);transition:transform 0.2s,opacity 0.2s}
.list.dragging{opacity:0.4;transform:scale(0.95)}
.list.placeholder{background:transparent;border:2px dashed var(--p);opacity:0.6;min-height:200px}
.list-header{background:#2a2a2a;padding:12px 15px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;user-select:none}
.list-header input{background:transparent;border:none;color:var(--txt);font-weight:bold;font-size:1em;padding:0;margin:0;flex:1}
.list-header input:focus{outline:none}
.list-header .count{background:#333;color:#aaa;padding:2px 8px;border-radius:10px;font-size:0.75em;margin:0 10px}
.list-header button{background:transparent;color:#777;border:none;padding:4px;font-size:0.9em;cursor:pointer}
.list-header button:hover{color:var(--err)}
.cards{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.task-card{background:#2a2a2a;border:1px solid #333;border-radius:6px;padding:12px;cursor:grab;position:relative;transition:opacity 0.2s,transform 0.2s}
.task-card:hover{border-color:#444}
.task-card:hover .card-actions{opacity:1}
.task-card:active{cursor:grabbing}
.task-card.dragging{opacity:0.4;transform:scale(0.95)}
.card-title{font-weight:600;margin-bottom:6px}
.card-desc{color:#aaa;font-size:0.85em;margin-top:6px}
.card-actions{opacity:0;display:flex;gap:6px;margin-top:8px;transition:opacity 0.2s;pointer-events:auto}
.task-card:hover .card-actions,.card-actions:hover,.card-actions:focus-within{opacity:1!important}
.card-actions button{background:#333;color:#aaa;border:none;padding:4px 8px;border-radius:4px;font-size:0.8em;cursor:pointer;pointer-events:all}
.card-actions button:hover{background:#444;color:#fff}
.card-actions button.del:hover{color:var(--err)}
.add-card{padding:10px;margin:10px;background:transparent;border:1px dashed #444;border-radius:6px;color:#777;text-align:center;cursor:pointer;font-size:0.9em}
.add-card:hover{border-color:var(--p);color:var(--p)}
.modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:1000;align-items:center;justify-content:center}
.modal.active{display:flex}
.modal-content{background:var(--card);padding:25px;border-radius:8px;border:1px solid #333;max-width:500px;width:90%}
.modal-content h3{margin-bottom:20px}
.form-group{margin-bottom:15px}
.form-group label{display:block;margin-bottom:6px;color:#aaa;font-size:0.9em}
.form-group input,.form-group textarea,.form-group select{width:100%}
.btn-group{display:flex;gap:10px}
.btn-danger{background:var(--err)}
`;

function renderNav(active, basePath = '') {
  return `<div style="display:flex;gap:10px">
    <a href="${basePath}/" class="nav-link ${active === 'boards' ? 'active' : ''}">📋 Boards</a>
    <a href="${basePath}/settings" class="nav-link ${active === 'settings' ? 'active' : ''}">⚙ Settings</a>
    <a href="${basePath}/logout" style="color:var(--err);align-self:center;margin-left:auto">Logout</a>
  </div>`;
}

function renderLogin() {
  return `<!DOCTYPE html><html lang="en"><head><title>Login</title><style>${CSS}</style></head>
  <body style="display:flex;justify-content:center;align-items:center;height:100vh">
    <div class="card" style="width:300px;text-align:center">
      <h2>📋 Kanban Board</h2>
      <div id="forms">
        <form onsubmit="event.preventDefault();doLogin(this)" action="/login" method="post">
          <input type="text" name="u" placeholder="Username" required style="width:90%" autocomplete="username"><br>
          <input type="password" name="p" placeholder="Password" required style="width:90%" autocomplete="current-password"><br>
          <button type="submit" style="width:100%">LOGIN</button>
        </form>
        <p style="font-size:0.8em;color:#aaa;cursor:pointer;margin-top:15px" onclick="toggleReg()">Create account</p>
      </div>
      <div id="reg" style="display:none">
        <form onsubmit="event.preventDefault();doReg(this)" action="/register" method="post">
          <input type="text" name="u" placeholder="New Username" required style="width:90%" autocomplete="username"><br>
          <input type="password" name="p" placeholder="New Password" required style="width:90%" autocomplete="new-password"><br>
          <button type="submit" style="width:100%;background:var(--s)">REGISTER</button>
        </form>
        <p style="font-size:0.8em;color:#aaa;cursor:pointer;margin-top:15px" onclick="toggleReg()">Back to login</p>
      </div>
      <div id="msg" style="color:var(--err);margin-top:10px"></div>
    </div>
    <script>
      const BASE = location.pathname.startsWith('/todo') ? '/todo' : '';
      function toggleReg(){
        document.getElementById('forms').style.display = document.getElementById('forms').style.display === 'none' ? 'block' : 'none';
        document.getElementById('reg').style.display = document.getElementById('reg').style.display === 'none' ? 'block' : 'none';
        document.getElementById('msg').innerText = '';
      }
      async function doLogin(f){
        const r = await fetch(BASE + '/login',{method:'POST',body:new FormData(f)});
        if(r.ok) location.reload();
        else document.getElementById('msg').innerText = 'Access Denied';
      }
      async function doReg(f){
        const r = await fetch(BASE + '/register',{method:'POST',body:new FormData(f)});
        if(r.ok){ alert('Account created! Please log in.'); toggleReg(); }
        else document.getElementById('msg').innerText = 'Username taken';
      }
    </script>
  </body></html>`;
}

function renderSettings(user, basePath = '') {
  return `<!DOCTYPE html><html lang="en"><head><title>Settings</title><style>${CSS}</style></head><body>
    <header class="row card" style="padding:15px">
      <div><strong>Settings</strong> | ${user.username}</div>
      ${renderNav('settings', basePath)}
    </header>
    <div class="card">
      <h3>Change Password</h3>
      <form onsubmit="event.preventDefault();changePw(this)">
        <input type="password" name="p" placeholder="New Password" required><br>
        <button>Update</button>
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
  return `<!DOCTYPE html><html lang="en"><head><title>Boards</title><style>${CSS}</style></head><body>
    <header class="row card" style="padding:15px">
      <div><strong>📋 My Boards</strong> | ${user.username}</div>
      ${renderNav('boards', basePath)}
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

      function showModal(){ modal.classList.add('active'); }
      function hideModal(){ modal.classList.remove('active'); }
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
          await fetch(BASE + '/api/board/delete',{method:'POST',body:fd});
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

  return `<!DOCTYPE html><html lang="en"><head><title>${board.name}</title><style>${CSS}</style></head><body>
    <header class="row card" style="padding:15px">
      <div><strong>${board.name}</strong> | ${user.username}</div>
      ${renderNav('', basePath)}
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

      function showListModal(){ listModal.classList.add('active'); }
      function showCardModal(listId){ cardListId.value = listId; cardModal.classList.add('active'); }
      function hideModals(){ document.querySelectorAll('.modal').forEach(m => m.classList.remove('active')); }

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
          await fetch(BASE + '/api/list/delete',{method:'POST',body:fd});
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
        await fetch(BASE + '/api/card/create',{method:'POST',body:new FormData(f)});
        location.reload();
      }

      function editCard(id, title, desc){
        editCardId.value = id;
        editTitle.value = title;
        editDesc.value = desc;
        editModal.classList.add('active');
      }

      async function updateCard(f){
        await fetch(BASE + '/api/card/update',{method:'POST',body:new FormData(f)});
        location.reload();
      }

      function deleteCard(id){
        showConfirm('Delete this card?', async () => {
          const fd = new FormData();
          fd.append('id', id);
          await fetch(BASE + '/api/card/delete',{method:'POST',body:fd});
          location.reload();
        });
      }

      // Card drag and drop
      function drag(e, cardId){
        draggedCardId = cardId;
        e.target.classList.add('dragging');
        e.stopPropagation();
      }

      function allowDrop(e){ e.preventDefault(); }

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
            return { offset: offset, element: child };
          } else {
            return closest;
          }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
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
