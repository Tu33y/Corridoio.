# Corridoio

Community scolastica full-stack con account verificati tramite email, classi, post, commenti, sondaggi e moderazione.

## Requisiti

- Node.js 20+
- PostgreSQL gestito (Neon consigliato per Vercel)
- Un dominio mittente verificato su Resend

La registrazione è limitata a indirizzi `@liceoleonardomi.edu.it`. Le classi ammesse vanno da `1A` a `5H`. Il codice di verifica e quello di recupero password vengono inviati via email e scadono dopo 10 minuti.

La verifica email conferma il possesso di una casella del dominio scolastico; la classe selezionata resta autodichiarata e non viene confrontata con un registro ufficiale. Per verificarla davvero serve un elenco autorizzato fornito dalla scuola o un processo di conferma gestito da personale scolastico.

## Variabili d'ambiente

Copia `.env.example` in `.env` per lo sviluppo locale. Non committare mai `.env` o credenziali.

- `DATABASE_URL`: stringa PostgreSQL Neon, usando l'URL pooled fornito da Neon
- `SESSION_SECRET`: segreto lungo e casuale per firmare le sessioni
- `RESEND_API_KEY`: chiave API di Resend
- `EMAIL_FROM`: mittente autorizzato su Resend, per esempio `Corridoio <noreply@liceoleonardomi.edu.it>`
- `ALLOWED_CLASSES`: classi autorizzate, separate da virgola (default: `1A`–`5H`)
- `MODERATOR_EMAILS`: email scolastiche abilitate alla moderazione, separate da virgola
- `PORT`: porta locale (default: `3000`)

Il database e la tabella delle sessioni vengono inizializzati automaticamente al primo avvio. In produzione, i dati non sono memorizzati sul filesystem effimero di Vercel.

## Avvio locale

```bash
npm install
npm start
```

Il server richiede `DATABASE_URL` e `SESSION_SECRET`; le operazioni di registrazione e recupero password richiedono anche `RESEND_API_KEY` e `EMAIL_FROM`.

## Deploy su Vercel

1. Crea un database Neon e copia la sua pooled connection string in `DATABASE_URL`.
2. In Resend, verifica il dominio mittente e crea una API key.
3. Importa questo repository in Vercel.
4. Aggiungi le variabili d'ambiente elencate sopra per gli ambienti Production e Preview.
5. Imposta `MODERATOR_EMAILS` con l'indirizzo scolastico del moderatore iniziale.
6. Esegui il deploy e prova registrazione, ricezione del codice, verifica, login e pubblicazione.
7. Collega `corridoio.runs-on.dev` al dominio assegnato da Vercel. Usa esattamente il target CNAME mostrato da Vercel/Runs On e attendi l'attivazione automatica di HTTPS.

## Docker

```bash
docker build -t corridoio .
docker run -p 3000:3000 --env-file .env corridoio
```
