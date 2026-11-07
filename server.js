const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'corridoio.db');
const SESSION_SECRET = process.env.SESSION_SECRET || 'corridoio-secret-key';
const ALLOWED_SCHOOL_DOMAINS = (process.env.ALLOWED_SCHOOL_DOMAINS || 'liceo-demo.it')
  .split(',')
  .map((domain) => String(domain).trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_CLASSES = (process.env.ALLOWED_CLASSES || '1A,1B,2A,2B,3A,3B')
  .split(',')
  .map((cls) => String(cls).trim().toUpperCase())
  .filter(Boolean);
const verificationCodes = new Map();
const resetCodes = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new sqlite3.Database(DB_PATH);

function hashPassword(salt, pass) {
  return crypto.createHash('sha256').update(String(salt) + String(pass)).digest('hex');
}

function randomId(prefix = 'id') {
  const suffix = crypto.randomBytes(6).toString('hex');
  return `${prefix}_${Date.now()}_${suffix}`;
}

function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += Math.floor(Math.random() * 10);
  return out;
}

function asyncDb(method, query, params = []) {
  return new Promise((resolve, reject) => {
    db[method](query, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function schoolDomainMatch(email) {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(email)) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && ALLOWED_SCHOOL_DOMAINS.includes(domain);
}

function normalizeClassName(value) {
  const next = String(value || '').trim().toUpperCase();
  return next;
}

function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    nick: row.nick,
    nome: row.nome,
    cognome: row.cognome,
    school: row.school,
    cls: row.cls,
    role: row.role,
    theme: row.theme,
    born: row.born,
    parent: row.parent_email,
    verified: !!row.verified,
    createdAt: row.created_at,
  };
}

async function getUserById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(serializeUser(row));
    });
  });
}

async function getUserByEmail(email) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
      if (err) reject(err);
      else resolve(serializeUser(row));
    });
  });
}

function canViewPost(user, post) {
  if (!user || !post) return false;
  if (post.scope_type === 'scuola') return user.school === post.school;
  if (post.scope_type === 'classe') return user.school === post.school && user.cls === post.scope_value;
  if (post.scope_type === 'anno') return user.school === post.school && String(parseInt(user.cls, 10)) === String(post.scope_value);
  return false;
}

async function getPostDetails(postId, userId) {
  const post = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM posts WHERE id = ? AND deleted = 0', [postId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
  if (!post) return null;

  const author = await getUserById(post.user_id);
  const comments = await new Promise((resolve, reject) => {
    db.all(
      `SELECT c.*, u.nick AS author_nick FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.created_at ASC`,
      [postId],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });
  const likes = await new Promise((resolve, reject) => {
    db.all('SELECT user_id FROM likes WHERE post_id = ?', [postId], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const liked = likes.some((item) => item.user_id === userId);
  const saved = await new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM saves WHERE user_id = ? AND post_id = ?', [userId, postId], (err, row) => (err ? reject(err) : resolve(!!row)));
  });
  const reports = await new Promise((resolve, reject) => {
    db.all('SELECT user_id FROM reports WHERE post_id = ?', [postId], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const polls = await new Promise((resolve, reject) => {
    db.all('SELECT * FROM polls WHERE post_id = ? ORDER BY id ASC', [postId], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

  const pollData = await Promise.all(polls.map(async (poll) => {
    const votes = await new Promise((resolve, reject) => {
      db.all('SELECT user_id FROM poll_votes WHERE poll_id = ?', [poll.id], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    return {
      id: poll.id,
      text: poll.text,
      votes: votes.map((vote) => vote.user_id),
    };
  }));

  return {
    id: post.id,
    school: post.school,
    scopeType: post.scope_type,
    scopeValue: post.scope_value,
    text: post.text,
    image: post.image,
    createdAt: post.created_at,
    author,
    liked,
    saved,
    reports: reports.length,
    comments: comments.map((comment) => ({
      id: comment.id,
      userId: comment.user_id,
      authorNick: comment.author_nick,
      text: comment.text,
      createdAt: comment.created_at,
    })),
    likes: likes.length,
    polls: pollData,
  };
}

async function getPostsForUser(user) {
  const rows = await new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM posts WHERE school = ? AND deleted = 0 ORDER BY created_at DESC',
      [user.school],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });

  const visible = rows.filter((post) => canViewPost(user, post));
  const posts = await Promise.all(visible.map((post) => getPostDetails(post.id, user.id)));
  return posts.filter(Boolean);
}

async function seedData() {
  const count = await new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) AS c FROM users', (err, row) => (err ? reject(err) : resolve(row.c)));
  });

  if (count > 0) return;

  const modSalt = 's1';
  const modHash = hashPassword(modSalt, 'Moderatore1!');

  await asyncDb('run', `INSERT INTO users (id, email, nick, nome, cognome, school, cls, role, salt, password_hash, born, verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, ['u_mod', 'mod@liceo-demo.it', 'moderatore', 'Moderatore', '', 'liceo-demo', '3A', 'mod', modSalt, modHash, '2009-01-01', Date.now()]);

  const now = Date.now();
  const posts = [
    {
      id: 'p1',
      user_id: 'u_mod',
      school: 'liceo-demo',
      scope_type: 'classe',
      scope_value: '3A',
      text: 'Qualcuno ha capito gli integrali per parti? Domani c’è la verifica e il secondo esercizio non mi torna. #matematica',
      image: '',
      created_at: now - 12 * 60 * 1000,
    },
    {
      id: 'p2',
      user_id: 'u_mod',
      school: 'liceo-demo',
      scope_type: 'scuola',
      scope_value: 'scuola',
      text: 'A quello con la felpa gialla al bar, ieri alle 2a ricreazione, ti è caduta la tessera. L’ho data al bidello. #spotted',
      image: '',
      created_at: now - 60 * 60 * 1000,
    },
  ];

  for (const post of posts) {
    await asyncDb('run', `INSERT INTO posts (id, user_id, school, scope_type, scope_value, text, image, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [post.id, post.user_id, post.school, post.scope_type, post.scope_value, post.text, post.image, post.created_at]);
  }

  await asyncDb('run', `INSERT INTO comments (id, post_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)`, ['c1', 'p1', 'u_mod', 'Scegli come fare la parte che si semplifica derivando.', now - 10 * 60 * 1000]);
  await asyncDb('run', `INSERT INTO likes (id, post_id, user_id) VALUES (?, ?, ?)`, ['l1', 'p1', 'u_mod']);
}

async function initDatabase() {
  await asyncDb('run', `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    nick TEXT,
    nome TEXT,
    cognome TEXT,
    school TEXT,
    cls TEXT,
    role TEXT,
    salt TEXT,
    password_hash TEXT,
    born TEXT,
    parent_email TEXT,
    verified INTEGER DEFAULT 0,
    theme TEXT,
    created_at INTEGER
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    school TEXT,
    scope_type TEXT,
    scope_value TEXT,
    text TEXT,
    image TEXT,
    created_at INTEGER,
    deleted INTEGER DEFAULT 0
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    user_id TEXT,
    text TEXT,
    created_at INTEGER
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS likes (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    user_id TEXT
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS saves (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    post_id TEXT
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    post_id TEXT
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    text TEXT
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS poll_votes (
    id TEXT PRIMARY KEY,
    poll_id TEXT,
    user_id TEXT
  )`);

  await seedData();
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax' },
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  return next();
}

app.get('/api/session', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await getUserById(req.session.userId);
  res.json({ user });
});

app.post('/api/register', async (req, res) => {
  const { email, nome, cognome, born, parent, nick, pw, cls, school, accept } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const normalizedClass = normalizeClassName(cls || '3A');

  if (!normalizedEmail || !schoolDomainMatch(normalizedEmail)) {
    return res.status(400).json({ error: `Email non valida. Usa un account scolastico autorizzato: ${ALLOWED_SCHOOL_DOMAINS.join(', ')}` });
  }
  if (!nome || !cognome || !born || !nick || !pw) {
    return res.status(400).json({ error: 'Completa tutti i campi richiesti.' });
  }
  if (!ALLOWED_CLASSES.length || !ALLOWED_CLASSES.includes(normalizedClass)) {
    return res.status(400).json({ error: `Classe non valida. Usa una delle classi autorizzate: ${ALLOWED_CLASSES.join(', ')}` });
  }
  if (!accept) {
    return res.status(400).json({ error: 'Devi accettare le regole e la privacy.' });
  }
  if (String(nick).length < 3 || !/^[a-z0-9_.]{3,20}$/i.test(String(nick))) {
    return res.status(400).json({ error: 'Nickname non valido.' });
  }
  if ((String(pw).length < 8) || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return res.status(400).json({ error: 'Password troppo debole.' });
  }

  const existing = await getUserByEmail(normalizedEmail);
  if (existing) return res.status(400).json({ error: 'Esiste già un account con questa email.' });

  const userId = randomId('u');
  const salt = randomId('s').slice(0, 10);
  const hash = hashPassword(salt, pw);

  const schoolName = String(school || 'liceo-demo').trim().toLowerCase();

  await asyncDb('run', `INSERT INTO users (id, email, nick, nome, cognome, school, cls, role, salt, password_hash, born, parent_email, verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, [userId, normalizedEmail, String(nick).trim().toLowerCase(), String(nome).trim(), String(cognome).trim(), schoolName, normalizedClass, 'student', salt, hash, String(born), parent ? String(parent).trim().toLowerCase() : null, Date.now()]);

  const code = randomCode(6);
  verificationCodes.set(userId, code);

  req.session.pendingUserId = userId;
  return res.json({ success: true, verificationCode: code, userId });
});

app.post('/api/verify', async (req, res) => {
  const { code } = req.body || {};
  const userId = req.session.pendingUserId || req.session.userId;
  if (!userId) return res.status(400).json({ error: 'Nessun utente da verificare.' });
  const expected = verificationCodes.get(userId);
  if (!expected || String(code) !== String(expected)) {
    return res.status(400).json({ error: 'Codice non corretto.' });
  }

  await asyncDb('run', 'UPDATE users SET verified = 1 WHERE id = ?', [userId]);
  verificationCodes.delete(userId);
  req.session.userId = userId;
  req.session.pendingUserId = null;
  const user = await getUserById(userId);
  res.json({ success: true, user });
});

app.post('/api/login', async (req, res) => {
  const { email, pw } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = await getUserByEmail(normalizedEmail);
 
  if (!user) return res.status(401).json({ error: 'Credenziali non valide.' });
  const actualHash = hashPassword((await new Promise((resolve, reject) => {
    db.get('SELECT salt FROM users WHERE id = ?', [user.id], (err, row) => (err ? reject(err) : resolve(row ? row.salt : '')));
  })), pw);

  if (actualHash !== (await new Promise((resolve, reject) => {
    db.get('SELECT password_hash FROM users WHERE id = ?', [user.id], (err, row) => (err ? reject(err) : resolve(row ? row.password_hash : '')));
  }))) {
    return res.status(401).json({ error: 'Credenziali non valide.' });
  }

  if (!user.verified) {
    const code = randomCode(6);
    verificationCodes.set(user.id, code);
    req.session.pendingUserId = user.id;
    return res.status(403).json({ error: 'Account non verificato', verificationCode: code, userId: user.id });
  }

  req.session.userId = user.id;
  res.json({ success: true, user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.post('/api/forgot', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = await getUserByEmail(email);
  if (!user) return res.json({ success: true, message: 'Se l’email esiste, hai ricevuto il codice.' });
  const code = randomCode(6);
  resetCodes.set(user.id, code);
  res.json({ success: true, message: 'Codice inviato.', code });
});

app.post('/api/reset-password', async (req, res) => {
  const { userId, code, pw } = req.body || {};
  const expected = resetCodes.get(String(userId));
  if (!expected || String(code) !== String(expected)) {
    return res.status(400).json({ error: 'Codice non corretto.' });
  }
  if ((String(pw).length < 8) || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return res.status(400).json({ error: 'Password troppo debole.' });
  }

  const salt = randomId('s').slice(0, 10);
  const hash = hashPassword(salt, pw);
  await asyncDb('run', 'UPDATE users SET salt = ?, password_hash = ? WHERE id = ?', [salt, hash, userId]);
  resetCodes.delete(String(userId));
  res.json({ success: true });
});

app.get('/api/posts', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const posts = await getPostsForUser(user);
  res.json({ posts });
});

app.get('/api/moderation', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  if (user.role !== 'mod') return res.status(403).json({ error: 'Accesso negato.' });

  const rows = await new Promise((resolve, reject) => {
    db.all(`SELECT p.*, COUNT(r.id) AS report_count
      FROM posts p
      LEFT JOIN reports r ON r.post_id = p.id
      WHERE p.deleted = 0 AND p.school = ?
      GROUP BY p.id
      HAVING report_count > 0
      ORDER BY p.created_at DESC`, [user.school], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

  const posts = await Promise.all(rows.map((post) => getPostDetails(post.id, user.id)));
  res.json({ posts: posts.filter(Boolean) });
});

app.post('/api/posts', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const { text, image, scope, pollOptions } = req.body || {};
  const content = String(text || '').trim();
  if (!content && !image) return res.status(400).json({ error: 'Scrivi qualcosa o aggiungi una foto.' });

  const itemId = randomId('p');
  const scopeType = scope === 'scuola' ? 'scuola' : scope === 'anno' ? 'anno' : 'classe';
  const scopeValue = scope === 'scuola' ? 'scuola' : scope === 'anno' ? String(parseInt(user.cls, 10)) : user.cls;

  await asyncDb('run', `INSERT INTO posts (id, user_id, school, scope_type, scope_value, text, image, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [itemId, user.id, user.school, scopeType, scopeValue, content, image || '', Date.now()]);

  if (Array.isArray(pollOptions)) {
    const filtered = pollOptions.map((o) => String(o || '').trim()).filter(Boolean);
    for (let i = 0; i < filtered.length; i += 1) {
      const pollId = randomId('poll');
      await asyncDb('run', 'INSERT INTO polls (id, post_id, text) VALUES (?, ?, ?)', [pollId, itemId, filtered[i]]);
    }
  }

  const post = await getPostDetails(itemId, user.id);
  res.json({ success: true, post });
});

app.post('/api/posts/:id/like', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const postId = req.params.id;
  const exists = await new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?', [postId, user.id], (err, row) => (err ? reject(err) : resolve(!!row)));
  });
  if (exists) {
    await asyncDb('run', 'DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, user.id]);
  } else {
    await asyncDb('run', 'INSERT INTO likes (id, post_id, user_id) VALUES (?, ?, ?)', [randomId('like'), postId, user.id]);
  }
  const post = await getPostDetails(postId, user.id);
  res.json({ success: true, post });
});

app.post('/api/posts/:id/save', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const postId = req.params.id;
  const exists = await new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM saves WHERE post_id = ? AND user_id = ?', [postId, user.id], (err, row) => (err ? reject(err) : resolve(!!row)));
  });
  if (exists) {
    await asyncDb('run', 'DELETE FROM saves WHERE post_id = ? AND user_id = ?', [postId, user.id]);
  } else {
    await asyncDb('run', 'INSERT INTO saves (id, post_id, user_id) VALUES (?, ?, ?)', [randomId('save'), postId, user.id]);
  }
  res.json({ success: true });
});

app.post('/api/posts/:id/comment', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Scrivi un commento.' });

  const commentId = randomId('c');
  await asyncDb('run', 'INSERT INTO comments (id, post_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)', [commentId, req.params.id, user.id, text, Date.now()]);
  const post = await getPostDetails(req.params.id, user.id);
  res.json({ success: true, post });
});

app.post('/api/posts/:id/delete', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const post = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM posts WHERE id = ?', [req.params.id], (err, row) => (err ? reject(err) : resolve(row)));
  });
  if (!post) return res.status(404).json({ error: 'Post non trovato.' });
  if (post.user_id !== user.id && user.role !== 'mod') return res.status(403).json({ error: 'Non autorizzato.' });
  await asyncDb('run', 'UPDATE posts SET deleted = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/posts/:id/report', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const postId = req.params.id;
  const exists = await new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM reports WHERE post_id = ? AND user_id = ?', [postId, user.id], (err, row) => (err ? reject(err) : resolve(!!row)));
  });
  if (!exists) {
    await asyncDb('run', 'INSERT INTO reports (id, post_id, user_id) VALUES (?, ?, ?)', [randomId('report'), postId, user.id]);
  }
  const post = await getPostDetails(postId, user.id);
  res.json({ success: true, post });
});

app.post('/api/posts/:id/vote', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const { pollId } = req.body || {};
  if (!pollId) return res.status(400).json({ error: 'Poll non valida.' });

  const already = await new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ?', [pollId, user.id], (err, row) => (err ? reject(err) : resolve(!!row)));
  });
  if (!already) {
    await asyncDb('run', 'INSERT INTO poll_votes (id, poll_id, user_id) VALUES (?, ?, ?)', [randomId('vote'), pollId, user.id]);
  }

  const post = await getPostDetails(req.params.id, user.id);
  res.json({ success: true, post });
});

app.post('/api/profile', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const { nick, cls, theme } = req.body || {};
  const nextNick = String(nick || user.nick).trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,20}$/.test(nextNick)) return res.status(400).json({ error: 'Nickname non valido.' });

  await asyncDb('run', 'UPDATE users SET nick = ?, cls = ?, theme = ? WHERE id = ?', [nextNick, cls || user.cls, theme || user.theme, user.id]);
  const updated = await getUserById(user.id);
  res.json({ success: true, user: updated });
});

app.post('/api/profile/password', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  const { currentPw, newPw } = req.body || {};
  const storedSalt = await new Promise((resolve, reject) => {
    db.get('SELECT salt FROM users WHERE id = ?', [user.id], (err, row) => (err ? reject(err) : resolve(row ? row.salt : '')));
  });
  const storedHash = await new Promise((resolve, reject) => {
    db.get('SELECT password_hash FROM users WHERE id = ?', [user.id], (err, row) => (err ? reject(err) : resolve(row ? row.password_hash : '')));
  });

  if (hashPassword(storedSalt, String(currentPw || '')) !== storedHash) {
    return res.status(400).json({ error: 'Password attuale non corretta.' });
  }
  if ((String(newPw).length < 8) || !/[A-Z]/.test(newPw) || !/[a-z]/.test(newPw) || !/[0-9]/.test(newPw)) {
    return res.status(400).json({ error: 'Nuova password troppo debole.' });
  }

  const salt = randomId('s').slice(0, 10);
  const hash = hashPassword(salt, newPw);
  await asyncDb('run', 'UPDATE users SET salt = ?, password_hash = ? WHERE id = ?', [salt, hash, user.id]);
  res.json({ success: true });
});

app.post('/api/moderation/:id', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  if (user.role !== 'mod') return res.status(403).json({ error: 'Accesso negato.' });
  const action = String(req.body?.action || '').toLowerCase();
  const postId = req.params.id;

  if (action === 'remove') {
    await asyncDb('run', 'UPDATE posts SET deleted = 1 WHERE id = ?', [postId]);
  } else {
    await asyncDb('run', 'DELETE FROM reports WHERE post_id = ?', [postId]);
  }
  res.json({ success: true });
});

app.delete('/api/profile', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  await asyncDb('run', 'DELETE FROM users WHERE id = ?', [user.id]);
  await asyncDb('run', 'DELETE FROM posts WHERE user_id = ?', [user.id]);
  await asyncDb('run', 'DELETE FROM comments WHERE user_id = ?', [user.id]);
  await asyncDb('run', 'DELETE FROM likes WHERE user_id = ?', [user.id]);
  await asyncDb('run', 'DELETE FROM saves WHERE user_id = ?', [user.id]);
  await asyncDb('run', 'DELETE FROM reports WHERE user_id = ?', [user.id]);
  req.session.destroy(() => res.json({ success: true }));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Corridoio full-stack running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });
}

module.exports = app;
