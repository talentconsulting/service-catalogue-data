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
