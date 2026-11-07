# Corridoio

Community scolastica con autenticazione, verifica email, pubblicazioni, moderazione e classi.

## Requisiti

- Node.js 20+
- SQLite (gestito dal server)

## Configurazione

Copia `.env.example` in `.env` e personalizza i valori:

```bash
cp .env.example .env
```

Variabili principali:

- `SESSION_SECRET`: stringa segreta per le sessioni
- `ALLOWED_SCHOOL_DOMAINS`: domini email scolastici autorizzati, separati da virgola
- `ALLOWED_CLASSES`: classi autorizzate, separati da virgola
- `PORT`: porta del server in produzione

## Avvio locale

```bash
npm install
npm start
```

## Deploy reale

### Render

1. Connetti il repository a Render
2. Imposta build command: `npm install`
3. Imposta start command: `npm start`
4. Aggiungi le variabili d'ambiente da `.env.example`
5. Pubblica il service

### Docker

```bash
docker build -t corridoio .
docker run -p 3000:3000 --env-file .env corridoio
```

L'app accetta solo utenti con email scolastica riconosciuta e associa l'account alla classe scelta.
