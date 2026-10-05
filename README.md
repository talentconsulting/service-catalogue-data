# service-catalogue-data

Generated database schemas, events and commands, and OpenAPI specifications for
the repositories in `manifest.json`.

## Catalogue viewer

The `visualizer` project provides a manifest-driven browser for the generated
catalogue, including database relationships, event and command details,
generated service dependencies with source evidence, and OpenAPI operations. It
reads the data at runtime, so regenerated files appear after a page refresh
without rebuilding the image.

Start it with Docker Compose:

```bash
cd visualizer
docker compose up --build
```

Open <http://localhost:8080>. The parent repository is mounted read-only at
`/data` inside the container.

To run without Docker (Node.js 22 or later):

```bash
cd visualizer
npm start
```

Set `CATALOGUE_DATA_DIR` when the data repository is not the parent directory.
Run the API tests with `npm test`.

### Password protection

The viewer is open by default. To require a login, copy `visualizer/.env.example`
to `visualizer/.env` (already gitignored — never commit real credentials) and
set `AUTH_PASSWORD`:

```bash
cd visualizer
cp .env.example .env
# edit .env and set AUTH_PASSWORD (AUTH_USERNAME defaults to "admin")
docker compose up --build
```

Docker Compose reads `.env` automatically. Running with `npm start` instead,
export the same variables in your shell first. Leaving `AUTH_PASSWORD` unset
(or deleting `.env`) runs the viewer without authentication, as before.

## Generated security reports

This repository only stores the security reports; the AI services in
[`talentconsulting-azure-foundry`](https://github.com/talentconsulting/talentconsulting-azure-foundry)
generate them and open pull requests here:

- **Dependabot alerts** — `<repo>/dependency-alerts/dependabot-alerts.json` for
  every manifest repository, from the weekly (or manually run) **Check Dependabot
  Alerts** workflow (`scripts/check_dependabot_alerts.py`). It needs the
  `DEPENDABOT_ALERTS_TOKEN` secret in that repository.
- **API security audit** — `<repo>/api-security-audit/report.json`, from the weekly
  (or manually run) **API Security Audit** workflow, which lints every generated
  OpenAPI spec against the OWASP API Security Top 10
  (`scripts/api-security/`). It reads and writes here with
  `SERVICE_CATALOGUE_PR_TOKEN`.
