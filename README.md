# The Fair Use Database

Source code for [thefairusedatabase.com](https://thefairusedatabase.com), a free research tool for exploring every published United States judicial opinion that decides a copyright fair use question.

The database covers fair use decisions from *Folsom v. Marsh* (1841) to the present. Each opinion is coded at the level of the individual work/use pairing, capturing the outcome, the disposition of each statutory factor under 17 U.S.C. § 107, procedural posture, work type, use type, and technology context. The site provides faceted browsing, full-text search, statistical summaries with charts, and Folsom, a research assistant that answers questions about the corpus with citations to the underlying cases.

## Architecture

The site is a single Cloudflare Worker with static assets:

- `src/worker.js` — HTTP routing, Google and Microsoft OAuth sign-in, session handling, and the query API over the corpus database (Cloudflare D1).
- `src/folsom.js` — the Folsom chat assistant: tool-calling loop over the corpus (search, case lookup, statistics with chart payloads), per-user budgets and quotas, and turn telemetry.
- `src/vocab.js` — the controlled vocabulary for coded fields.
- `public/` — the frontend: a single-page application in vanilla JavaScript with no build step, including the chart renderers for statistical figures and PNG export.

Storage is Cloudflare D1 (two databases: the corpus and an operational database for chat accounting) and R2 (opinion documents).

## Running locally

Requires Node.js and Wrangler.

```bash
npm install -g wrangler
wrangler dev
```

Local development needs a `.dev.vars` file with OAuth client secrets and model API keys, and D1 databases provisioned under your own Cloudflare account. The corpus data itself is not part of this repository.

## Data

This repository contains the application source only. The coded corpus is served from the live site and is not distributed here.

## License

MIT. See [LICENSE](LICENSE).
