const express = require('express');
const session = require('express-session');
const pg = require('pg');
const connectPgSimple = require('connect-pg-simple');
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || (!process.env.VERCEL ? 'local-development-only-secret' : '');
const SCHOOL_DOMAIN = 'liceoleonardomi.edu.it';
const SCHOOL_NAME = 'liceoleonardomi';
const ALLOWED_SCHOOL_DOMAINS = [SCHOOL_DOMAIN];
const ALLOWED_CLASSES = process.env.ALLOWED_CLASSES
  ? process.env.ALLOWED_CLASSES.split(',').map((cls) => cls.trim().toUpperCase()).filter(Boolean)
  : Array.from({ length: 5 }, (_, year) => 'ABCDEFGH'.split('').map((letter) => `${year + 1}${letter}`)).flat();
const MODERATOR_EMAILS = (process.env.MODERATOR_EMAILS || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
const EMAIL_FROM = process.env.EMAIL_FROM;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
const PgSessionStore = connectPgSimple(session);
const sessionStore = new PgSessionStore({ pool, tableName: 'user_sessions', createTableIfMissing: true });
let databaseReady;

function sqlPlaceholders(query) {
  let index = 0;
  return query.replace(/\?/g, () => `$${++index}`);
}

function queryWithCallback(method, query, params, callback) {
  pool.query(sqlPlaceholders(query), params, (error, result) => {
    if (error) return callback(error);
    if (method === 'get') return callback(null, result.rows[0]);
    if (method === 'all') return callback(null, result.rows);
    return callback.call({ changes: result.rowCount }, null);
  });
}

const db = {
  get(query, params, callback) {
    queryWithCallback('get', query, params, callback);
  },
  all(query, params, callback) {
    queryWithCallback('all', query, params, callback);
  },
  run(query, params, callback) {
    queryWithCallback('run', query, params, callback);
  },
};

function hashPassword(salt, pass) {
  return crypto.scryptSync(String(pass), String(salt), 64).toString('hex');
}

function randomId(prefix = 'id') {
  const suffix = crypto.randomBytes(6).toString('hex');
  return `${prefix}_${Date.now()}_${suffix}`;
}

function randomCode(length = 6) {
  return crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
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

function codeHash(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

async function sendEmail(to, subject, code, purpose) {
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM.');
  }
  const action = purpose === 'verify' ? 'verificare il tuo account Corridoio' : 'reimpostare la password';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject,
      text: `Il tuo codice per ${action} è ${code}. Scade tra 10 minuti. Se non hai richiesto questa operazione, ignora questa email.`,
      html: `<p>Il tuo codice per ${action} è:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>Scade tra 10 minuti. Se non hai richiesto questa operazione, ignora questa email.</p>`,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error('Resend email request failed', response.status, detail);
    throw new Error('Email could not be sent.');
  }
}

async function issueCode(userId, email, purpose) {
  const now = Date.now();
  const permitted = await new Promise((resolve, reject) => {
    db.get(`INSERT INTO email_send_limits (user_id, purpose, last_sent_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id, purpose) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at
      WHERE email_send_limits.last_sent_at <= ? RETURNING user_id`,
    [userId, purpose, now, now - 60 * 1000], (err, row) => (err ? reject(err) : resolve(row)));
  });
  if (!permitted) {
    const error = new Error('Attendi un minuto prima di richiedere un altro codice.');
    error.statusCode = 429;
    throw error;
  }
  const code = randomCode();
  await asyncDb('run', `DELETE FROM email_codes WHERE user_id = ? AND purpose = ?`, [userId, purpose]);
  await asyncDb('run', `INSERT INTO email_codes (user_id, purpose, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)`,
    [userId, purpose, codeHash(code), Date.now() + 10 * 60 * 1000]);
  try {
    await sendEmail(email, purpose === 'verify' ? 'Codice di verifica Corridoio' : 'Reimposta la password Corridoio', code, purpose);
  } catch (error) {
    await asyncDb('run', `DELETE FROM email_codes WHERE user_id = ? AND purpose = ?`, [userId, purpose]);
    throw error;
  }
}

async function checkEmailCode(userId, purpose, code) {
  const record = await new Promise((resolve, reject) => {
    db.get('SELECT code_hash, expires_at, attempts FROM email_codes WHERE user_id = ? AND purpose = ?', [userId, purpose],
      (err, row) => (err ? reject(err) : resolve(row)));
  });
  if (!record || Number(record.expires_at) < Date.now() || Number(record.attempts) >= 5 || !/^\d{6}$/.test(String(code || ''))) {
    return false;
  }
  const suppliedHash = codeHash(code);
  if (!crypto.timingSafeEqual(Buffer.from(record.code_hash), Buffer.from(suppliedHash))) {
    await asyncDb('run', 'UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?', [userId, purpose]);
    return false;
  }
  return true;
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

async function initDatabase() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL must be configured.');
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET must be configured.');
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
    created_at BIGINT
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    school TEXT,
    scope_type TEXT,
    scope_value TEXT,
    text TEXT,
    image TEXT,
    created_at BIGINT,
    deleted INTEGER DEFAULT 0
  )`);

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    user_id TEXT,
    text TEXT,
    created_at BIGINT
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
  await asyncDb('run', 'ALTER TABLE users ALTER COLUMN created_at TYPE BIGINT');
  await asyncDb('run', 'ALTER TABLE posts ALTER COLUMN created_at TYPE BIGINT');
  await asyncDb('run', 'ALTER TABLE comments ALTER COLUMN created_at TYPE BIGINT');

  await asyncDb('run', `CREATE TABLE IF NOT EXISTS email_codes (
    user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, purpose)
  )`);
  await asyncDb('run', `ALTER TABLE email_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
  await asyncDb('run', `CREATE TABLE IF NOT EXISTS email_send_limits (
    user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    last_sent_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, purpose)
  )`);
}

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.VERCEL || process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(async (req, res, next) => {
  try {
    if (!databaseReady) {
      databaseReady = initDatabase().catch((error) => {
        databaseReady = undefined;
        throw error;
      });
    }
    await databaseReady;
    next();
  } catch (error) {
    next(error);
  }
});
app.use(session({
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production'), httpOnly: true, sameSite: 'lax' },
}));

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
  const { email, nome, cognome, born, parent, nick, pw, cls, accept } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const normalizedClass = normalizeClassName(cls);

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
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(salt, pw);
  const role = MODERATOR_EMAILS.includes(normalizedEmail) ? 'mod' : 'student';
  await asyncDb('run', `INSERT INTO users (id, email, nick, nome, cognome, school, cls, role, salt, password_hash, born, parent_email, verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, [userId, normalizedEmail, String(nick).trim().toLowerCase(), String(nome).trim(), String(cognome).trim(), SCHOOL_NAME, normalizedClass, role, salt, hash, String(born), parent ? String(parent).trim().toLowerCase() : null, Date.now()]);

  try {
    await issueCode(userId, normalizedEmail, 'verify');
  } catch (error) {
    await asyncDb('run', 'DELETE FROM users WHERE id = ?', [userId]);
    console.error('Verification email delivery failed', error);
    return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Non è stato possibile inviare l’email di verifica. Riprova più tardi.' });
  }
  req.session.pendingUserId = userId;
  return res.json({ success: true });
});

app.post('/api/verify', async (req, res) => {
  const { code } = req.body || {};
  const userId = req.session.pendingUserId || req.session.userId;
  if (!userId) return res.status(400).json({ error: 'Nessun utente da verificare.' });
  if (!await checkEmailCode(userId, 'verify', code)) {
    return res.status(400).json({ error: 'Codice non corretto.' });
  }

  await asyncDb('run', 'UPDATE users SET verified = 1 WHERE id = ?', [userId]);
  await asyncDb('run', 'DELETE FROM email_codes WHERE user_id = ? AND purpose = ?', [userId, 'verify']);
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
  const credentials = await new Promise((resolve, reject) => {
    db.get('SELECT salt, password_hash FROM users WHERE id = ?', [user.id], (err, row) => (err ? reject(err) : resolve(row)));
  });
  const actualHash = hashPassword(credentials.salt, String(pw || ''));
  if (!crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(credentials.password_hash))) {
    return res.status(401).json({ error: 'Credenziali non valide.' });
  }

  if (!user.verified) {
    try {
      await issueCode(user.id, normalizedEmail, 'verify');
    } catch (error) {
      console.error('Verification email delivery failed', error);
      return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Non è stato possibile inviare l’email di verifica. Riprova più tardi.' });
    }
    req.session.pendingUserId = user.id;
    return res.status(403).json({ error: 'Account non verificato: abbiamo inviato un nuovo codice alla tua email.', verificationRequired: true });
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
  if (user && schoolDomainMatch(email)) {
    try {
      await issueCode(user.id, email, 'reset');
      req.session.resetUserId = user.id;
    } catch (error) {
      console.error('Password reset email delivery failed', error);
      return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Non è stato possibile inviare l’email. Riprova più tardi.' });
    }
  }
  res.json({ success: true, message: 'Se l’indirizzo è registrato, riceverai un codice per reimpostare la password.' });
});

app.post('/api/reset-password', async (req, res) => {
  const { code, pw } = req.body || {};
  const userId = req.session.resetUserId;
  if (!userId) return res.status(400).json({ error: 'Richiedi prima un codice per reimpostare la password.' });
  if (!await checkEmailCode(userId, 'reset', code)) {
    return res.status(400).json({ error: 'Codice non corretto.' });
  }
  if ((String(pw).length < 8) || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return res.status(400).json({ error: 'Password troppo debole.' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(salt, pw);
  await asyncDb('run', 'UPDATE users SET salt = ?, password_hash = ? WHERE id = ?', [salt, hash, userId]);
  await asyncDb('run', 'DELETE FROM email_codes WHERE user_id = ? AND purpose = ?', [userId, 'reset']);
  req.session.resetUserId = null;
  res.json({ success: true });
});

app.post('/api/resend-verification', async (req, res) => {
  const userId = req.session.pendingUserId;
  if (!userId) return res.status(400).json({ error: 'Richiedi nuovamente la verifica accedendo con le tue credenziali.' });
  const user = await getUserById(userId);
  if (!user || user.verified) return res.status(400).json({ error: 'Account già verificato o non trovato.' });
  try {
    await issueCode(user.id, user.email, 'verify');
    return res.json({ success: true, message: 'Nuovo codice inviato.' });
  } catch (error) {
    console.error('Verification email delivery failed', error);
    return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Non è stato possibile inviare l’email. Riprova più tardi.' });
  }
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
      HAVING COUNT(r.id) > 0
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
  const nextClass = normalizeClassName(cls || user.cls);
  if (!/^[a-z0-9_.]{3,20}$/.test(nextNick)) return res.status(400).json({ error: 'Nickname non valido.' });
  if (!ALLOWED_CLASSES.includes(nextClass)) return res.status(400).json({ error: 'Classe non valida.' });

  await asyncDb('run', 'UPDATE users SET nick = ?, cls = ?, theme = ? WHERE id = ?', [nextNick, nextClass, theme || user.theme, user.id]);
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

app.use((error, req, res, next) => {
  console.error('Request failed', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Errore interno. Riprova più tardi.' });
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
