var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var worker_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method;
    const cookie = req.headers.get("Cookie");
    const sessionId = cookie ? cookie.split(";").find((c) => c.trim().startsWith("sess="))?.split("=")[1] : null;
    let user = null;
    if (sessionId) user = await env.DB.prepare("SELECT * FROM sessions WHERE id = ? AND expires > ?").bind(sessionId, Date.now()).first();
    if (url.pathname === "/login" && method === "POST") {
      const fd = await req.formData();
      const dbUser = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?").bind(fd.get("u"), await hash(fd.get("p"))).first();
      if (!dbUser) return new Response("Invalid credentials", { status: 401 });
      const newSess = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO sessions (id, username, role, expires) VALUES (?, ?, ?, ?)").bind(newSess, dbUser.username, dbUser.role, Date.now() + 864e5).run();
      return new Response("OK", { headers: { "Set-Cookie": `sess=${newSess}; HttpOnly; Secure; SameSite=Strict; Path=/` } });
    }
    if (url.pathname === "/register" && method === "POST") {
      const fd = await req.formData();
      const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(fd.get("u")).first();
      if (existing) return new Response("Username taken", { status: 400 });
      await env.DB.prepare("INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)").bind(fd.get("u"), await hash(fd.get("p")), "user", Date.now()).run();
      return new Response("OK");
    }
    if (url.pathname === "/logout") {
      if (sessionId) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
      return new Response("Logged out", { status: 302, headers: { "Location": "/", "Set-Cookie": "sess=; Max-Age=0; Path=/" } });
    }
    if (!user) return new Response(renderLogin(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname === "/api/board/create" && method === "POST") {
      const fd = await req.formData();
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO boards (id, username, name, created_at) VALUES (?, ?, ?, ?)").bind(id, user.username, fd.get("name"), Date.now()).run();
      return new Response(JSON.stringify({ id }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/board/delete" && method === "POST") {
      const fd = await req.formData();
      await env.DB.prepare("DELETE FROM boards WHERE id = ? AND username = ?").bind(fd.get("id"), user.username).run();
      return new Response("OK");
    }
    if (url.pathname === "/api/list/create" && method === "POST") {
      const fd = await req.formData();
      const { results: lists } = await env.DB.prepare("SELECT * FROM lists WHERE board_id = ? ORDER BY position ASC").bind(fd.get("boardId")).all();
      const pos = lists.length > 0 ? Math.max(...lists.map((l) => l.position)) + 1 : 0;
      await env.DB.prepare("INSERT INTO lists (id, board_id, username, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), fd.get("boardId"), user.username, fd.get("name"), pos, fd.get("color") || "#bb86fc", Date.now()).run();
      return new Response("OK");
    }
    if (url.pathname === "/api/list/delete" && method === "POST") {
      const fd = await req.formData();
      await env.DB.prepare("DELETE FROM lists WHERE id = ? AND username = ?").bind(fd.get("id"), user.username).run();
      return new Response("OK");
    }
    if (url.pathname === "/api/list/rename" && method === "POST") {
      const fd = await req.formData();
      await env.DB.prepare("UPDATE lists SET name = ? WHERE id = ? AND username = ?").bind(fd.get("name"), fd.get("id"), user.username).run();
      return new Response("OK");
    }
    if (url.pathname === "/api/card/create" && method === "POST") {
      const fd = await req.formData();
      const lid = fd.get("listId");
      const { results: cards } = await env.DB.prepare("SELECT * FROM cards WHERE list_id = ? ORDER BY position ASC").bind(lid).all();
      const pos = cards.length > 0 ? Math.max(...cards.map((c) => c.position)) + 1 : 0;
      const list = await env.DB.prepare("SELECT board_id FROM lists WHERE id = ?").bind(lid).first();
      await env.DB.prepare("INSERT INTO cards (id, list_id, board_id, username, title, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), lid, list.board_id, user.username, fd.get("title"), "", pos, Date.now()).run();
      return new Response("OK");
    }
    if (url.pathname === "/api/card/update" && method === "POST") {
      const fd = await req.formData();
      await env.DB.prepare("UPDATE cards SET title = ?, description = ? WHERE id = ? AND username = ?").bind(fd.get("title"), fd.get("description"), fd.get("id"), user.username).run();
      return new Response("OK");
    }
    if (url.pathname === "/api/card/delete" && method === "POST") {
      const fd = await req.formData();
      await env.DB.prepare("DELETE FROM cards WHERE id = ? AND username = ?").bind(fd.get("id"), user.username).run();
      return new Response("OK");
    }
    if (url.pathname === "/api/card/move" && method === "POST") {
      const fd = await req.formData();
      const cid = fd.get("cardId"), nlid = fd.get("newListId"), npos = parseInt(fd.get("newPosition"));
      const card = await env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(cid).first();
      await env.DB.prepare("UPDATE cards SET position = position - 1 WHERE list_id = ? AND position > ?").bind(card.list_id, card.position).run();
      await env.DB.prepare("UPDATE cards SET position = position + 1 WHERE list_id = ? AND position >= ?").bind(nlid, npos).run();
      await env.DB.prepare("UPDATE cards SET list_id = ?, position = ? WHERE id = ?").bind(nlid, npos, cid).run();
      return new Response("OK");
    }
    if (url.pathname === "/api/password" && method === "POST") {
      const fd = await req.formData();
      await env.DB.prepare("UPDATE users SET password = ? WHERE username = ?").bind(await hash(fd.get("p")), user.username).run();
      return new Response("OK");
    }
    if (url.pathname === "/settings") return new Response(renderSettings(user), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname.startsWith("/board/")) {
      const bid = url.pathname.split("/board/")[1];
      const board = await env.DB.prepare("SELECT * FROM boards WHERE id = ? AND username = ?").bind(bid, user.username).first();
      if (!board) return new Response("404", { status: 404 });
      const { results: lists } = await env.DB.prepare("SELECT * FROM lists WHERE board_id = ? ORDER BY position ASC").bind(bid).all();
      const { results: cards } = await env.DB.prepare("SELECT * FROM cards WHERE board_id = ? ORDER BY position ASC").bind(bid).all();
      return new Response(renderBoard(user, board, lists, cards), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/" || url.pathname === "") {
      const { results: boards } = await env.DB.prepare("SELECT * FROM boards WHERE username = ? ORDER BY created_at DESC").bind(user.username).all();
      return new Response(renderDash(user, boards), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("404", { status: 404 });
  }
};
async function hash(str) {
  const buf = new TextEncoder().encode(str);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hash, "hash");
var CSS = `
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
.list{min-width:300px;max-width:300px;background:var(--card);border:1px solid #333;border-radius:8px;display:flex;flex-direction:column;max-height:calc(100vh - 180px)}
.list-header{background:#2a2a2a;padding:12px 15px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333}
.list-header input{background:transparent;border:none;color:var(--txt);font-weight:bold;font-size:1em;padding:0;margin:0;flex:1}
.list-header input:focus{outline:none}
.list-header .count{background:#333;color:#aaa;padding:2px 8px;border-radius:10px;font-size:0.75em;margin:0 10px}
.list-header button{background:transparent;color:#777;border:none;padding:4px;font-size:0.9em;cursor:pointer}
.list-header button:hover{color:var(--err)}
.cards{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.task-card{background:#2a2a2a;border:1px solid #333;border-radius:6px;padding:12px;cursor:grab;position:relative}
.task-card:hover{border-color:#444}
.task-card:hover .card-actions{opacity:1}
.task-card:active{cursor:grabbing}
.task-card.dragging{opacity:0.5}
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
function renderNav(active) {
  return `<div style="display:flex;gap:10px">
    <a href="/" class="nav-link ${active === "boards" ? "active" : ""}">\u{1F4CB} Boards</a>
    <a href="/settings" class="nav-link ${active === "settings" ? "active" : ""}">\u2699 Settings</a>
    <a href="/logout" style="color:var(--err);align-self:center;margin-left:auto">Logout</a>
  </div>`;
}
__name(renderNav, "renderNav");
function renderLogin() {
  return `<!DOCTYPE html><html lang="en"><head><title>Login</title><style>${CSS}</style></head>
  <body style="display:flex;justify-content:center;align-items:center;height:100vh">
    <div class="card" style="width:300px;text-align:center">
      <h2>\u{1F4CB} Kanban Board</h2>
      <div id="forms">
        <form onsubmit="event.preventDefault();doLogin(this)">
          <input type="text" name="u" placeholder="Username" required style="width:90%"><br>
          <input type="password" name="p" placeholder="Password" required style="width:90%"><br>
          <button style="width:100%">LOGIN</button>
        </form>
        <p style="font-size:0.8em;color:#aaa;cursor:pointer;margin-top:15px" onclick="toggleReg()">Create account</p>
      </div>
      <div id="reg" style="display:none">
        <form onsubmit="event.preventDefault();doReg(this)">
          <input type="text" name="u" placeholder="New Username" required style="width:90%"><br>
          <input type="password" name="p" placeholder="New Password" required style="width:90%"><br>
          <button style="width:100%;background:var(--s)">REGISTER</button>
        </form>
        <p style="font-size:0.8em;color:#aaa;cursor:pointer;margin-top:15px" onclick="toggleReg()">Back to login</p>
      </div>
      <div id="msg" style="color:var(--err);margin-top:10px"></div>
    </div>
    <script>
      function toggleReg(){
        document.getElementById('forms').style.display = document.getElementById('forms').style.display === 'none' ? 'block' : 'none';
        document.getElementById('reg').style.display = document.getElementById('reg').style.display === 'none' ? 'block' : 'none';
        document.getElementById('msg').innerText = '';
      }
      async function doLogin(f){
        const r = await fetch('/login',{method:'POST',body:new FormData(f)});
        if(r.ok) location.reload();
        else document.getElementById('msg').innerText = 'Access Denied';
      }
      async function doReg(f){
        const r = await fetch('/register',{method:'POST',body:new FormData(f)});
        if(r.ok){ alert('Account created! Please log in.'); toggleReg(); }
        else document.getElementById('msg').innerText = 'Username taken';
      }
    <\/script>
  </body></html>`;
}
__name(renderLogin, "renderLogin");
function renderSettings(user) {
  return `<!DOCTYPE html><html lang="en"><head><title>Settings</title><style>${CSS}</style></head><body>
    <header class="row card" style="padding:15px">
      <div><strong>Settings</strong> | ${user.username}</div>
      ${renderNav("settings")}
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
        const r = await fetch('/api/password',{method:'POST',body:new FormData(f)});
        if(r.ok) alert('Password updated!');
      }
    <\/script>
  </body></html>`;
}
__name(renderSettings, "renderSettings");
function renderDash(user, boards) {
  return `<!DOCTYPE html><html lang="en"><head><title>Boards</title><style>${CSS}</style></head><body>
    <header class="row card" style="padding:15px">
      <div><strong>\u{1F4CB} My Boards</strong> | ${user.username}</div>
      ${renderNav("boards")}
    </header>
    <div style="margin-bottom:20px">
      <button onclick="showModal()">+ New Board</button>
    </div>
    <div class="board-grid">
      ${boards.length === 0 ? '<div class="card" style="grid-column:1/-1;text-align:center;color:#777">No boards yet. Create your first board!</div>' : ""}
      ${boards.map((b) => `
        <div class="board-item" onclick="location.href='/board/${b.id}'">
          <h3>${b.name}</h3>
          <div class="meta">Created ${new Date(b.created_at).toLocaleDateString()}</div>
          <button onclick="event.stopPropagation();deleteBoard('${b.id}','${b.name}')" style="background:var(--err)">Delete</button>
        </div>
      `).join("")}
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
        <h3>\u26A0 Confirm Deletion</h3>
        <p id="confirmMessage" style="color:#aaa;margin:20px 0"></p>
        <div class="btn-group">
          <button id="confirmYes" class="btn-danger">Delete</button>
          <button id="confirmNo" onclick="hideConfirm()">Cancel</button>
        </div>
      </div>
    </div>

    <script>
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
        const r = await fetch('/api/board/create',{method:'POST',body:new FormData(f)});
        if(r.ok){
          const d = await r.json();
          location.href = '/board/' + d.id;
        }
      }
      function deleteBoard(id,name){
        showConfirm('Delete board "' + name + '"? All lists and cards will be deleted.', async () => {
          const fd = new FormData();
          fd.append('id', id);
          await fetch('/api/board/delete',{method:'POST',body:fd});
          location.reload();
        });
      }
    <\/script>
  </body></html>`;
}
__name(renderDash, "renderDash");
function renderBoard(user, board, lists, cards) {
  const cardsByList = {};
  cards.forEach((c) => {
    if (!cardsByList[c.list_id]) cardsByList[c.list_id] = [];
    cardsByList[c.list_id].push(c);
  });
  return `<!DOCTYPE html><html lang="en"><head><title>${board.name}</title><style>${CSS}</style></head><body>
    <header class="row card" style="padding:15px">
      <div><strong>${board.name}</strong> | ${user.username}</div>
      ${renderNav("")}
    </header>

    <div style="margin-bottom:15px">
      <button onclick="showListModal()">+ Add List</button>
    </div>

    <div class="kanban">
      ${lists.map((list) => `
        <div class="list" data-list-id="${list.id}">
          <div class="list-header">
            <input value="${list.name}" onblur="renameList('${list.id}',this.value)">
            <span class="count">${(cardsByList[list.id] || []).length}</span>
            <button onclick="deleteList('${list.id}','${list.name}')">\u{1F5D1}</button>
          </div>
          <div class="cards" ondrop="drop(event,'${list.id}')" ondragover="allowDrop(event)">
            ${(cardsByList[list.id] || []).map((card) => `
              <div class="task-card" draggable="true" ondragstart="drag(event,'${card.id}')" data-card-id="${card.id}">
                <div class="card-title">${card.title}</div>
                ${card.description ? `<div class="card-desc">${card.description}</div>` : ""}
                <div class="card-actions">
                  <button onmousedown="event.stopPropagation()" onclick="event.stopPropagation();editCard('${card.id}','${escapeHtml(card.title)}','${escapeHtml(card.description)}')">Edit</button>
                  <button class="del" onmousedown="event.stopPropagation()" onclick="event.stopPropagation();deleteCard('${card.id}')">Delete</button>
                </div>
              </div>
            `).join("")}
          </div>
          <div class="add-card" onclick="showCardModal('${list.id}')">+ Add Card</div>
        </div>
      `).join("")}
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
        <h3>\u26A0 Confirm Deletion</h3>
        <p id="confirmMessage" style="color:#aaa;margin:20px 0"></p>
        <div class="btn-group">
          <button id="confirmYes" class="btn-danger">Delete</button>
          <button id="confirmNo" onclick="hideConfirm()">Cancel</button>
        </div>
      </div>
    </div>

    <script>
      const boardId = '${board.id}';
      let draggedCardId = null;
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
        await fetch('/api/list/create',{method:'POST',body:fd});
        location.reload();
      }

      function deleteList(id, name){
        showConfirm('Delete list "' + name + '"? All cards will be deleted.', async () => {
          const fd = new FormData();
          fd.append('id', id);
          await fetch('/api/list/delete',{method:'POST',body:fd});
          location.reload();
        });
      }

      async function renameList(id, name){
        const fd = new FormData();
        fd.append('id', id);
        fd.append('name', name);
        await fetch('/api/list/rename',{method:'POST',body:fd});
      }

      async function createCard(f){
        await fetch('/api/card/create',{method:'POST',body:new FormData(f)});
        location.reload();
      }

      function editCard(id, title, desc){
        editCardId.value = id;
        editTitle.value = title;
        editDesc.value = desc;
        editModal.classList.add('active');
      }

      async function updateCard(f){
        await fetch('/api/card/update',{method:'POST',body:new FormData(f)});
        location.reload();
      }

      function deleteCard(id){
        showConfirm('Delete this card?', async () => {
          const fd = new FormData();
          fd.append('id', id);
          await fetch('/api/card/delete',{method:'POST',body:fd});
          location.reload();
        });
      }

      function drag(e, cardId){
        draggedCardId = cardId;
        e.target.classList.add('dragging');
      }

      function allowDrop(e){ e.preventDefault(); }

      async function drop(e, newListId){
        e.preventDefault();
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
        await fetch('/api/card/move',{method:'POST',body:fd});
        location.reload();
      }
    <\/script>
  </body></html>`;
}
__name(renderBoard, "renderBoard");
function escapeHtml(text) {
  return text.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}
__name(escapeHtml, "escapeHtml");

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-1kSBhZ/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-1kSBhZ/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
