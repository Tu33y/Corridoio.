# Corridoio

Community scolastica full-stack con account verificati tramite email, post per anno scolastico o per tutta la scuola, commenti, sondaggi e moderazione.

## Requisiti

- Node.js 20+
- PostgreSQL gestito (Neon consigliato per Vercel)
- Un dominio mittente verificato su Resend

La registrazione accetta qualsiasi indirizzo email valido e accessibile, verificato tramite un codice che scade dopo 10 minuti. L'utente seleziona un liceo di Milano e un anno scolastico da 1 a 5; se la scuola non è presente nell'elenco iniziale, può inserirne il nome. I post e i contenuti per anno sono separati per scuola.

La verifica email conferma il possesso della casella, ma non l'appartenenza alla scuola. L'anno scolastico selezionato resta autodichiarato e non viene confrontato con un registro ufficiale.

Google Analytics 4 viene caricato solo dopo il consenso esplicito dell'utente. Il banner permette di rifiutare e le preferenze privacy restano disponibili per modificare o revocare la scelta. L'integrazione usa direttamente lo stream GA4 per evitare invii duplicati tramite tag manager.

## Variabili d'ambiente

Copia `.env.example` in `.env` per lo sviluppo locale. Non committare mai `.env` o credenziali.

- `DATABASE_URL`: stringa PostgreSQL Neon, usando l'URL pooled fornito da Neon
- `SESSION_SECRET`: segreto lungo e casuale per firmare le sessioni
- `RESEND_API_KEY`: chiave API di Resend
- `EMAIL_FROM`: mittente autorizzato su Resend, per esempio `Corridoio <noreply@corridoio.runs-on.dev>`
- `MODERATOR_EMAILS`: indirizzi email abilitati alla moderazione, separati da virgola
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
