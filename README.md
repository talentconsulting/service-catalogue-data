# talentsuite-atlas

The generated service catalogue for the repositories listed in `manifest.json`,
and the viewer that browses it.

Nothing in the per-repository folders is written by hand. The agents and
scheduled jobs in
[`talentsuite-atlas-backend`](https://github.com/talentconsulting/talentsuite-atlas-backend)
scan each repository and open pull requests here.

## What's in this repository

| Path | Contents | Produced by |
| --- | --- | --- |
| `manifest.json` | The repositories to catalogue, and for each flow the path to scan and the last commit scanned | Edited by hand; commit hashes updated by each flow's pull request |
| `<repo>/open-api/` | Generated OpenAPI specifications, one per controller | OpenAPI flow |
| `<repo>/db-schema/` | Tables, columns, relationships and indexes, with each table flagged if it may hold personal data | Database-schema flow |
| `<repo>/event-catalog/` | Events and commands, their fields and handlers | Event catalogue flow |
| `<repo>/service-dependencies/` | Outbound dependencies on other services, with source evidence | Service-dependency flow |
| `<repo>/local-dev-config/` | Local services and configuration keys needed to run the repository | Local-dev-config flow |
| `<repo>/repo-metadata/` | Target frameworks, .NET end-of-support dates and last commit date | Repo-metadata flow |
| `<repo>/repo-topics/` | GitHub topics | Weekly **Fetch Repository Topics** job |
| `<repo>/dependency-alerts/` | Open Dependabot alerts | Weekly **Check Dependabot Alerts** job |
| `<repo>/api-security-audit/` | OWASP API Security Top 10 findings for the generated specs | Weekly **API Security Audit** job |
| `system-summaries.json` | A short summary of what each system does | System-summary flow |
| `dfe-overlay/` | DfE-specific APIM routing (see below) | Weekly **Resolve APIM routing (DfE overlay)** workflow in this repository |
| `visualizer/` | The catalogue viewer | — |

The flows and jobs are run from `talentsuite-atlas-backend`, and are not
triggered by changes here. To rescan a repository, clear its
`last-commit-hash-scanned` for that flow in `manifest.json` and run the flow
again.

## Catalogue viewer

The `visualizer` project is a manifest-driven browser for the catalogue. It
includes:

- **Dashboard**: Dependabot alerts, API security findings, repository metadata
  (filterable by framework, with out-of-support frameworks in red) and databases
  (tables flagged as holding personal data).
- **System landscape**: every catalogued system and the relationships between
  them, plus external systems.
- **Topics**: systems grouped by GitHub topic, with the links between topics.
- **Per-service views**: database schema, events and commands, dependencies,
  OpenAPI operations (with Postman collection downloads) and local dev
  configuration.

It reads the data at runtime, so regenerated files appear after a page refresh
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

Run the API tests with `npm test`.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CATALOGUE_DATA_DIR` | The parent directory | Where the catalogue data lives |
| `PORT` | `8080` | Port to listen on |
| `AUTH_PASSWORD` | Unset (no login) | Require a login; see below |
| `AUTH_USERNAME` | `admin` | Login username |
| `CATALOGUE_REPOSITORY_URL` | Read from the data folder's git remote | GitHub URL of this repository, used to link findings to the generated files on GitHub |

When deployed without a `.git` folder, set `CATALOGUE_REPOSITORY_URL` (for
example `https://github.com/talentconsulting/talentsuite-atlas`), or the GitHub
links show as plain text. On Render, the server falls back to Render's
`RENDER_GIT_REPO_SLUG`.

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

Docker Compose reads `.env` automatically. If you run `npm start` instead, export
the same variables in your shell first. Leaving `AUTH_PASSWORD` unset (or
deleting `.env`) runs the viewer without authentication.

## Security reports

These are produced by scheduled GitHub Actions jobs in `talentsuite-atlas-backend`,
which open pull requests here. Each runs weekly on Monday and can also be run
manually.

- **Dependabot alerts**: `<repo>/dependency-alerts/dependabot-alerts.json` for
  every manifest repository, from the **Check Dependabot Alerts** job. It needs
  the `DEPENDABOT_ALERTS_TOKEN` secret in `talentsuite-atlas-backend`.
- **API security audit**: `<repo>/api-security-audit/report.json`, from the
  **API Security Audit** job, which lints every generated OpenAPI spec against the
  OWASP API Security Top 10. It reads and writes here with
  `SERVICE_CATALOGUE_PR_TOKEN`.

## DfE overlay

[`dfe-overlay/`](dfe-overlay/README.md) is specific to DfE. Calls through
`das-apim-endpoints` (APIM) are rewritten into the inner APIs behind them, so the
landscape shows what each service actually relies on. The scanned dependency
files are not changed. The weekly **Resolve APIM routing (DfE overlay)** workflow
in this repository regenerates the overlay and opens a pull request.
