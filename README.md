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

## Dependabot alert report

The `dependabot-report` workflow (`.github/workflows/dependabot-report.yml`)
runs weekly (and on manual dispatch), scans every active, non-archived
repository in the `SkillsFundingAgency` organisation for open Dependabot
security alerts via `.github/scripts/generate-dependabot-report.mjs`, and
opens a pull request against this repo updating `dependabot-alerts.json` with
the results (per-repo alerts, severity breakdown, and org-wide totals).

**Setup:** the workflow needs an `ORG_DEPENDABOT_TOKEN` repository secret — a
token (fine-grained PAT with `Dependabot alerts: Read-only` across the org, or
a classic PAT with `repo` + `security_events` scope) belonging to an account
with Dependabot alert read access across the organisation. The default
`GITHUB_TOKEN` only covers this repository and can't read alerts elsewhere in
the org.
