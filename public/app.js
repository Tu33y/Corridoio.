const state = {
  page: 'welcome',
  user: null,
  posts: [],
  error: '',
  form: {},
  composer: { open: false, text: '', image: '', scope: 'classe', options: ['', ''], poll: false },
  filters: { scope: 0, sort: 'rec', q: '' },
  moderation: [],
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'Errore di richiesta');
    error.data = data;
    throw error;
  }
  return data;
}

function getSchoolClasses() {
  return Array.from({ length: 5 }, (_, year) => 'ABCDEFGH'.split('').map((letter) => `${year + 1}${letter}`)).flat();
}

function getSchoolClassOptions(selectedClass) {
  return getSchoolClasses()
    .map((cls) => '<option value="' + cls + '" ' + (selectedClass === cls ? 'selected' : '') + '>' + cls + '</option>')
    .join('');
}

function setError(msg) {
  state.error = msg;
  render();
}

function setToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function allUsersVisiblePosts(posts) {
  const q = state.filters.q.toLowerCase();
  const filtered = posts.filter((post) => {
    const scopeMatch = state.filters.scope === 0 || post.scopeType === (state.filters.scope === 1 ? 'classe' : state.filters.scope === 2 ? 'anno' : 'scuola');
    const textMatch = !q || `${post.text} ${post.author.nick}`.toLowerCase().includes(q);
    return scopeMatch && textMatch;
  });

  filtered.sort((a, b) => (state.filters.sort === 'pop' ? (b.likes + b.comments.length * 2) - (a.likes + a.comments.length * 2) : b.createdAt - a.createdAt));
  return filtered;
}

function renderAuth() {
  const h = '<div class="auth"><h1 class="brand">corridoio<i>.</i></h1>';
  if (state.page === 'welcome') {
    return h + '<h2 style="margin-top:50px">La community privata della tua scuola</h2><p class="lead">Domande, avvisi, sondaggi e discussioni. Solo per studenti con email scolastica verificata.</p><button class="btn" onclick="state.page=\'signup\'; render();">Crea account</button><button class="btn sec" onclick="state.page=\'login\'; render();">Accedi</button><div class="hint" style="margin-top:18px">Registrazione riservata agli account @liceoleonardomi.edu.it.</div></div>';
  }
  if (state.page === 'login') {
    return h + '<h2>Accedi</h2><p class="lead">Bentornato.</p><div class="fld"><label for="login-email">Email scolastica</label><input id="login-email" type="email" value="'+esc(state.form.email||'')+'" oninput="state.form.email=this.value" /></div><div class="fld"><label for="login-pw">Password</label><input id="login-pw" type="password" value="'+esc(state.form.pw||'')+'" oninput="state.form.pw=this.value" /></div>' + (state.error ? '<div class="err">'+esc(state.error)+'</div>' : '') + '<button class="btn" onclick="login()">Accedi</button><button class="lnk" onclick="state.page=\'forgot\'; state.error=\'\'; render();">Password dimenticata?</button><br><button class="lnk" onclick="state.page=\'signup\'; state.error=\'\'; render();">Non hai un account? Registrati</button></div>';
  }
  if (state.page === 'signup') {
    return h + '<h2>I tuoi dati</h2><p class="lead">Nome e cognome restano privati: gli altri vedranno solo il nickname.</p><div class="fld"><label>Email scolastica</label><input type="email" value="'+esc(state.form.email||'')+'" oninput="state.form.email=this.value" /></div><div class="fld"><label>Nome</label><input value="'+esc(state.form.nome||'')+'" oninput="state.form.nome=this.value" /></div><div class="fld"><label>Cognome</label><input value="'+esc(state.form.cognome||'')+'" oninput="state.form.cognome=this.value" /></div><div class="fld"><label>Data di nascita</label><input type="date" value="'+esc(state.form.born||'')+'" oninput="state.form.born=this.value" /></div>' + (state.form.born && new Date().getFullYear() - new Date(state.form.born).getFullYear() < 14 ? '<div class="fld"><label>Email del genitore</label><input type="email" value="'+esc(state.form.parent||'')+'" oninput="state.form.parent=this.value" /></div>' : '') + (state.error ? '<div class="err">'+esc(state.error)+'</div>' : '') + '<button class="btn" onclick="continueSignup()">Continua</button><button class="lnk" onclick="state.page=\'welcome\'; state.error=\'\'; render();">Indietro</button></div>';
  }
  if (state.page === 'signup2') {
    const clsOptions = getSchoolClassOptions(state.form.cls);
    return h + '<h2>Profilo e sicurezza</h2><p class="lead">Scegli come ti vedranno gli altri.</p><div class="fld"><label>Nickname pubblico</label><input value="'+esc(state.form.nick||'')+'" oninput="state.form.nick=this.value" /></div><div class="fld"><label>Classe</label><select onchange="state.form.cls=this.value">'+clsOptions+'</select></div><div class="fld"><label>Password</label><input type="password" value="'+esc(state.form.pw||'')+'" oninput="state.form.pw=this.value" /></div><div class="fld"><label>Ripeti password</label><input type="password" value="'+esc(state.form.pw2||'')+'" oninput="state.form.pw2=this.value" /></div><label class="chk"><input type="checkbox" checked="'+(state.form.accept ? 'checked' : 'unchecked')+'" onchange="state.form.accept=this.checked" /><span>Accetto le regole della community e l’informativa privacy.</span></label>' + (state.error ? '<div class="err">'+esc(state.error)+'</div>' : '') + '<button class="btn" onclick="register()">Crea account</button><button class="lnk" onclick="state.page=\'signup\'; state.error=\'\'; render();">Indietro</button></div>';
  }
  if (state.page === 'verify') {
    return h + '<h2>Verifica la tua email</h2><p class="lead">Abbiamo inviato un codice a '+esc(state.form.email || '')+'. Controlla anche la cartella spam.</p><div class="fld"><label>Codice a 6 cifre</label><input inputmode="numeric" autocomplete="one-time-code" value="'+esc(state.form.code||'')+'" oninput="state.form.code=this.value" /></div>' + (state.error ? '<div class="err">'+esc(state.error)+'</div>' : '') + '<button class="btn" onclick="verifyCode()">Verifica</button><button class="lnk" onclick="resendCode()">Invia di nuovo</button></div>';
  }
  if (state.page === 'forgot') {
    return h + '<h2>Recupera la password</h2><p class="lead">Ti invieremo un codice per sceglierne una nuova.</p><div class="fld"><label>Email scolastica</label><input type="email" value="'+esc(state.form.email||'')+'" oninput="state.form.email=this.value" /></div>' + (state.error ? '<div class="err">'+esc(state.error)+'</div>' : '') + '<button class="btn" onclick="forgotPassword()">Invia codice</button><button class="lnk" onclick="state.page=\'login\'; state.error=\'\'; render();">Torna all’accesso</button></div>';
  }
  if (state.page === 'reset') {
    return h + '<h2>Nuova password</h2><p class="lead">Inserisci il codice ricevuto via email.</p><div class="fld"><label>Codice a 6 cifre</label><input inputmode="numeric" autocomplete="one-time-code" value="'+esc(state.form.code||'')+'" oninput="state.form.code=this.value" /></div><div class="fld"><label>Nuova password</label><input type="password" value="'+esc(state.form.pw||'')+'" oninput="state.form.pw=this.value" /></div>' + (state.error ? '<div class="err">'+esc(state.error)+'</div>' : '') + '<button class="btn" onclick="resetPassword()">Salva password</button></div>';
  }
  return h;
}

function getScopeLabel(post) {
  if (post.scopeType === 'scuola') return 'Scuola';
  if (post.scopeType === 'classe') return 'Classe ' + post.scopeValue;
  return 'Anno ' + post.scopeValue;
}

function renderPost(post) {
  const authorNick = post.author ? '@' + post.author.nick : 'Utente';
  const tagColor = post.scopeType === 'scuola' ? 't3' : post.scopeType === 'classe' ? 't1' : 't2';
  const myLike = post.liked ? 'on' : '';
  const mySaved = post.saved ? 'on' : '';
  const voteMarkup = (post.polls || []).map((poll) => {
    const total = poll.votes.length;
    return '<div class="opt" onclick="voteOnPost(\'' + post.id + '\', \'' + poll.id + '\')"><i style="width:' + (total ? Math.round((poll.votes.filter((v) => v === state.user.id).length / total) * 100) : 0) + '%"></i><span><span>' + esc(poll.text) + (poll.votes.includes(state.user.id) ? ' ✔' : '') + '</span><span>' + (poll.votes.includes(state.user.id) ? poll.votes.length : '') + '</span></span></div>';
  }).join('');
  const comments = (post.comments || []).map((comment) => '<div class="cm"><b>' + esc(comment.authorNick || '@utente') + '</b><br>' + esc(comment.text) + '</div>').join('');
  return '<div class="post"><div class="hd"><div class="av" style="background:' + ['#b4570b','#0b7a82','#5b3fd6','#c62f3d','#12805c','#8a5a00'][Math.abs(post.author.nick.length) % 6] + '">' + esc((post.author.nick || '?')[0].toUpperCase()) + '</div><div><div class="nm">' + esc(authorNick) + '</div><div class="meta">' + esc(new Date(post.createdAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) + '</div></div><span class="tag ' + tagColor + '">' + esc(getScopeLabel(post)) + '</span></div><div class="txt">' + esc(post.text).replace(/#(\w+)/g, '<b>#$1</b>') + '</div>' + (post.image ? '<img class="img" src="' + post.image + '" alt="" />' : '') + (voteMarkup ? '<div style="margin-top:8px">' + voteMarkup + '</div>' : '') + '<div class="act"><button class="' + myLike + '" onclick="toggleLike(\'' + post.id + '\')">▲ Utile ' + post.likes + '</button><button onclick="toggleComment(\'' + post.id + '\')">Commenti ' + (post.comments || []).length + '</button><button class="' + mySaved + '" onclick="toggleSave(\'' + post.id + '\')">' + (post.saved ? 'Salvato' : 'Salva') + '</button>' + (post.author.id === state.user.id ? '<button onclick="deletePost(\'' + post.id + '\')">Elimina</button>' : '<button onclick="reportPost(\'' + post.id + '\')">Segnala</button>') + '</div>' + (comments ? '<div class="ch">Commenti (' + post.comments.length + ')</div>' + comments : '<div class="meta">Ancora nessun commento.</div>') + '<div class="row"><input id="comment-' + post.id + '" placeholder="Commenta come @' + esc(state.user.nick) + '"><button class="btn" onclick="addComment(\'' + post.id + '\')">Invia</button></div>' + '</div>';
}

function renderHome() {
  const posts = allUsersVisiblePosts(state.posts || []);
  return '<header><div class="hrow"><h1 class="brand" style="font-size:24px">corridoio<i>.</i></h1><span class="sch">' + esc(state.user.school) + ' · ' + esc(state.user.cls) + '</span></div><div class="tabs"><button class="' + (state.filters.scope === 0 ? 'on' : '') + '" onclick="state.filters.scope=0; render();">Per te</button><button class="' + (state.filters.scope === 1 ? 'on' : '') + '" onclick="state.filters.scope=1; render();">Classe ' + esc(state.user.cls) + '</button><button class="' + (state.filters.scope === 2 ? 'on' : '') + '" onclick="state.filters.scope=2; render();">Anno ' + esc(String(parseInt(state.user.cls, 10))) + '</button><button class="' + (state.filters.scope === 3 ? 'on' : '') + '" onclick="state.filters.scope=3; render();">Scuola</button></div></header><div class="bar"><span><button class="' + (state.filters.sort === 'rec' ? 'on' : '') + '" onclick="state.filters.sort=\'rec\'; render();">Recenti</button><button class="' + (state.filters.sort === 'pop' ? 'on' : '') + '" onclick="state.filters.sort=\'pop\'; render();">Popolari</button></span><button onclick="state.filters.q = state.filters.q ? \"\" : state.filters.q; render();">Cerca</button></div><input id="search-box" placeholder="Cerca parole o #hashtag" value="' + esc(state.filters.q) + '" oninput="state.filters.q=this.value; render();" />' + (posts.length ? posts.map(renderPost).join('') : '<div class="empty">Niente da vedere qui. Pubblica tu per primo.</div>') + '<nav><div><button class="on"><b>⌂</b>Home</button><button class="pub" onclick="state.composer.open=true; render();">Pubblica</button>' + (state.user.role === 'mod' ? '<button onclick="state.page=\'moderation\'; loadModeration(); render();"><b>⚑</b>Revisione</button>' : '') + '<button onclick="state.page=\'profile\'; render();"><b>☺</b>Profilo</button></div></nav>';
}

function renderProfile() {
  return '<h2>Profilo</h2><div class="card"><div class="hd"><div class="av" style="background:' + ['#b4570b','#0b7a82','#5b3fd6','#c62f3d','#12805c','#8a5a00'][Math.abs(state.user.nick.length) % 6] + '">' + esc((state.user.nick || '?')[0].toUpperCase()) + '</div><div><div class="nm">@' + esc(state.user.nick) + '</div><div class="meta">' + (state.user.role === 'student' ? 'Studente' : 'Moderatore') + ' · ' + esc(state.user.school) + ' · ' + esc(state.user.cls) + '</div></div></div></div><div class="card"><h3>Account</h3><div class="kv"><span>Email</span><span>' + esc(state.user.email) + '</span></div><div class="kv"><span>Nome (privato)</span><span>' + esc(state.user.nome) + ' ' + esc(state.user.cognome) + '</span></div><button class="btn sec sm" onclick="state.page=\'profile-edit\'; state.form.nick=state.user.nick; state.form.cls=state.user.cls; render();">Cambia nickname o classe</button><button class="btn sec sm" onclick="state.page=\'password-change\'; render();">Cambia password</button></div><div class="card"><h3>Aspetto</h3><div class="seg"><button onclick="toggleTheme()">Tema: ' + (state.user.theme || 'auto') + '</button></div></div><button class="btn sec" onclick="logout()">Esci</button>';
}

function renderModerator() {
  const items = (state.moderation || []).map((post) => '<div class="card"><h3>Post da verificare</h3>' + renderPost(post) + '<div class="row"><button class="btn sec" onclick="moderatePost(\'' + post.id + '\', \"keep\")">Mantieni</button><button class="btn bad" onclick="moderatePost(\'' + post.id + '\', \"remove\")">Rimuovi</button></div></div>').join('');
  return '<h2>Moderazione</h2><p class="lead">Contenuti segnalati da controllare. Una segnalazione non significa violazione.</p>' + (items || '<div class="empty">Nessuna segnalazione in coda.</div>');
}

function render() {
  const app = document.getElementById('app');
  if (!state.user) {
    app.innerHTML = renderAuth();
    return;
  }

  if (state.page === 'home') {
    app.innerHTML = renderHome();
  } else if (state.page === 'profile' || state.page === 'profile-edit' || state.page === 'password-change') {
    if (state.page === 'profile-edit') {
        app.innerHTML = '<h2>Profilo</h2><div class="card"><div class="fld"><label>Nickname</label><input value="' + esc(state.form.nick || state.user.nick) + '" oninput="state.form.nick=this.value" /></div><div class="fld"><label>Classe</label><select onchange="state.form.cls=this.value">' + getSchoolClassOptions(state.form.cls) + '</select></div>' + (state.error ? '<div class="err">' + esc(state.error) + '</div>' : '') + '<button class="btn" onclick="updateProfile()">Salva</button><button class="lnk" onclick="state.page=\'profile\'; state.error=\'\'; render();">Indietro</button></div>';
      return;
    }
    if (state.page === 'password-change') {
      app.innerHTML = '<h2>Nuova password</h2><div class="card"><div class="fld"><label>Password attuale</label><input type="password" value="' + esc(state.form.currentPw || '') + '" oninput="state.form.currentPw=this.value" /></div><div class="fld"><label>Nuova password</label><input type="password" value="' + esc(state.form.newPw || '') + '" oninput="state.form.newPw=this.value" /></div>' + (state.error ? '<div class="err">' + esc(state.error) + '</div>' : '') + '<button class="btn" onclick="changePassword()">Aggiorna password</button><button class="lnk" onclick="state.page=\'profile\'; state.error=\'\'; render();">Indietro</button></div>';
      return;
    }
    app.innerHTML = renderProfile();
  } else if (state.page === 'moderation') {
    app.innerHTML = renderModerator();
  }

  const sheetRoot = document.getElementById('sheet-root');
  if (state.composer.open) {
    sheetRoot.innerHTML = '<div class="sheet" onclick="if(event.target===this){state.composer.open=false; render();}"><div><div class="meta" style="font-weight:700">Chi può vederlo?</div><div class="seg"><button class="' + (state.composer.scope === 'classe' ? 'on' : '') + '" onclick="state.composer.scope=\'classe\'; render();">Classe ' + esc(state.user.cls) + '</button><button class="' + (state.composer.scope === 'anno' ? 'on' : '') + '" onclick="state.composer.scope=\'anno\'; render();">Anno ' + esc(String(parseInt(state.user.cls, 10))) + '</button><button class="' + (state.composer.scope === 'scuola' ? 'on' : '') + '" onclick="state.composer.scope=\'scuola\'; render();">Scuola</button></div><textarea aria-label="Testo" placeholder="Cosa vuoi dire alla scuola?" oninput="state.composer.text=this.value">' + esc(state.composer.text) + '</textarea>' + (state.composer.poll ? '<div>' + state.composer.options.map((option, idx) => '<input style="margin-bottom:8px" placeholder="Opzione ' + (idx + 1) + '" value="' + esc(option) + '" oninput="state.composer.options[' + idx + ']=this.value" />').join('') + (state.composer.options.length < 5 ? '<button class="lnk" onclick="state.composer.options.push(\'\'); render();">Aggiungi opzione</button>' : '') + '</div>' : '') + '<div><label class="chip" for="composer-file">Foto</label><input id="composer-file" type="file" accept="image/*" hidden onchange="handleComposerFile(this)" /><button class="chip ' + (state.composer.poll ? 'on' : '') + '" onclick="state.composer.poll=!state.composer.poll; render();">Sondaggio</button></div><button class="btn" onclick="publishPost()">Pubblica</button></div></div>';
  } else {
    sheetRoot.innerHTML = '';
  }
}

function handleComposerFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.composer.image = reader.result;
    render();
  };
  reader.readAsDataURL(file);
}

async function loadSession() {
  try {
    const data = await api('/api/session');
    state.user = data.user;
    if (state.user) {
      state.page = 'home';
      await loadPosts();
    }
  } catch (err) {
    state.user = null;
  }
  render();
}

async function loadPosts() {
  if (!state.user) return;
  const data = await api('/api/posts');
  state.posts = data.posts || [];
  render();
}

async function loadModeration() {
  if (!state.user || state.user.role !== 'mod') return;
  const data = await api('/api/moderation');
  state.moderation = data.posts || [];
  render();
}

async function login() {
  state.error = '';
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: state.form.email, pw: state.form.pw }) });
    state.user = data.user;
    state.page = 'home';
    state.error = '';
    await loadPosts();
    render();
  } catch (err) {
    if (err.data?.verificationRequired) {
      state.page = 'verify';
      state.form.code = '';
    }
    state.error = err.message;
    render();
  }
}

async function continueSignup() {
  state.error = '';
  const email = String(state.form.email || '').trim().toLowerCase();
  const age = state.form.born ? Math.abs(new Date().getFullYear() - new Date(state.form.born).getFullYear()) : 0;
  if (!email || !state.form.nome || !state.form.cognome || !state.form.born) {
    state.error = 'Completa tutti i campi.';
    render();
    return;
  }
  if (!/^[^@\s]+@liceoleonardomi\.edu\.it$/i.test(email)) {
    state.error = 'Usa il tuo indirizzo @liceoleonardomi.edu.it.';
    render();
    return;
  }
  if (age < 14 && !state.form.parent) {
    state.error = 'Serve l’email del genitore.';
    render();
    return;
  }
  state.page = 'signup2';
  state.form.cls = state.form.cls || '1A';
  state.form.accept = true;
  render();
}

async function register() {
  state.error = '';
  if (state.form.pw !== state.form.pw2) {
    state.error = 'Le password non coincidono.';
    render();
    return;
  }
  const payload = { email: state.form.email, nome: state.form.nome, cognome: state.form.cognome, born: state.form.born, parent: state.form.parent, nick: state.form.nick, pw: state.form.pw, cls: state.form.cls, accept: !!state.form.accept };
  try {
    await api('/api/register', { method: 'POST', body: JSON.stringify(payload) });
    state.form.email = payload.email;
    state.form.code = '';
    state.page = 'verify';
    state.error = '';
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function verifyCode() {
  try {
    const data = await api('/api/verify', { method: 'POST', body: JSON.stringify({ code: state.form.code }) });
    state.user = data.user;
    state.page = 'home';
    state.form = {};
    await loadPosts();
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function resendCode() {
  try {
    const data = await api('/api/resend-verification', { method: 'POST', body: JSON.stringify({}) });
    setToast(data.message || 'Nuovo codice inviato');
  } catch (err) {
    setError(err.message);
  }
}

async function forgotPassword() {
  try {
    const data = await api('/api/forgot', { method: 'POST', body: JSON.stringify({ email: state.form.email }) });
    state.page = 'reset';
    state.form.code = '';
    state.error = '';
    setToast(data.message || 'Codice inviato');
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function resetPassword() {
  try {
    await api('/api/reset-password', { method: 'POST', body: JSON.stringify({ code: state.form.code, pw: state.form.pw }) });
    state.form = {};
    state.page = 'login';
    setToast('Password aggiornata');
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
  state.user = null;
  state.page = 'welcome';
  state.form = {};
  render();
}

async function toggleLike(postId) {
  await api('/api/posts/' + postId + '/like', { method: 'POST', body: JSON.stringify({}) });
  await loadPosts();
}

async function toggleSave(postId) {
  await api('/api/posts/' + postId + '/save', { method: 'POST', body: JSON.stringify({}) });
  await loadPosts();
}

async function reportPost(postId) {
  await api('/api/posts/' + postId + '/report', { method: 'POST', body: JSON.stringify({}) });
  await loadPosts();
  setToast('Segnalato: lo controlla un moderatore');
}

function toggleComment(postId) {
  const el = document.getElementById('comment-' + postId);
  if (el) {
    el.focus();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

async function addComment(postId) {
  const input = document.getElementById('comment-' + postId);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  await api('/api/posts/' + postId + '/comment', { method: 'POST', body: JSON.stringify({ text }) });
  await loadPosts();
}

async function voteOnPost(postId, pollId) {
  await api('/api/posts/' + postId + '/vote', { method: 'POST', body: JSON.stringify({ pollId }) });
  await loadPosts();
}

async function publishPost() {
  const payload = { text: state.composer.text, image: state.composer.image, scope: state.composer.scope, pollOptions: state.composer.poll ? state.composer.options : [] };
  await api('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
  state.composer = { open: false, text: '', image: '', scope: 'classe', options: ['', ''], poll: false };
  state.page = 'home';
  await loadPosts();
  render();
}

async function deletePost(postId) {
  if (!confirm('Eliminare questa pubblicazione?')) return;
  await api('/api/posts/' + postId + '/delete', { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
  await loadPosts();
}

async function updateProfile() {
  try {
    const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ nick: state.form.nick || state.user.nick, cls: state.form.cls || state.user.cls, theme: state.user.theme || 'auto' }) });
    state.user = data.user;
    state.page = 'profile';
    state.form = {};
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function changePassword() {
  try {
    await api('/api/profile/password', { method: 'POST', body: JSON.stringify({ currentPw: state.form.currentPw, newPw: state.form.newPw }) });
    state.page = 'profile';
    state.form = {};
    setToast('Password aggiornata');
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function toggleTheme() {
  const next = state.user.theme === 'dark' ? 'light' : state.user.theme === 'light' ? null : 'dark';
  const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ nick: state.user.nick, cls: state.user.cls, theme: next }) });
  state.user = data.user;
  document.documentElement.setAttribute('data-theme', next || 'light');
  render();
}

async function moderatePost(postId, action) {
  await api('/api/moderation/' + postId, { method: 'POST', body: JSON.stringify({ action }) });
  await loadModeration();
  await loadPosts();
}

window.addEventListener('load', async () => {
  document.documentElement.setAttribute('data-theme', 'light');
  state.composer.options = ['', ''];
  state.form = {};
  await loadSession();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.composer.open) {
    state.composer.open = false;
    render();
  }
});

window.render = render;
window.login = login;
window.register = register;
window.continueSignup = continueSignup;
window.verifyCode = verifyCode;
window.resetPassword = resetPassword;
window.forgotPassword = forgotPassword;
window.resendCode = resendCode;
window.toggleLike = toggleLike;
window.toggleSave = toggleSave;
window.reportPost = reportPost;
window.addComment = addComment;
window.voteOnPost = voteOnPost;
window.publishPost = publishPost;
window.handleComposerFile = handleComposerFile;
window.updateProfile = updateProfile;
window.changePassword = changePassword;
window.toggleTheme = toggleTheme;
window.moderatePost = moderatePost;
window.logout = logout;
window.deletePost = deletePost;
window.toggleComment = toggleComment;
