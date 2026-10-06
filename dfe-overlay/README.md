# DfE overlay: APIM routing

This folder is specific to DfE and isn't part of the generic catalogue agents.

In DfE, `das-apim-endpoints` (APIM) isn't a real dependency. It's how a service reaches other services' APIs. The service-dependency scan correctly records calls such as `das-commitments → Approvals Outer API`, which tells you nothing about what commitments actually relies on. This overlay rewrites those calls into the inner APIs behind them:

```
das-commitments ──► Approvals Outer API                (scanned)
das-commitments ──► Courses API, Reservations API, …   (resolved, "via APIM (Approvals)")
```

## How it works

1. **`extract-apim-routes.mjs`** reads a `das-apim-endpoints` checkout. Each area (`src/Approvals`, `src/Reservations`, …) calls inner APIs through clients typed by their configuration class, for example `ICoursesApiClient<CoursesApiConfiguration>`. The script records the classes each area uses in `das-apim-endpoints/apim-routes/apim-routes.json`. It reads the APIM source itself, not the agent scan, which stops after about 30 of APIM's areas.
2. **`apim-routing.json`** is the mapping you edit by hand:
   - `gateway.areas`: which calls go into which APIM area, matched by configuration key segment or by dependency name. Add `repo` when a key is too generic to match on its own (for example `OuterApiConfiguration`).
   - `innerApis`: configuration class → display name and repository. Classes not listed here still appear, named from the class, as systems outside the catalogue. `names` and `configurationKeys` also pin *direct* calls to the right repository (for example commitments → "Reservations" is `das-reservations-api`, not `das-reservations`).
   - `additionalCalls`: calls the scan missed (for example `das-reservations → ReservationsOuterApi`).
3. **`resolve-dependencies.mjs`** writes `<repo>/service-dependencies/resolved-dependencies.json` next to each scanned file. The scanned file is never changed. The visualiser serves the resolved file when it exists, draws routed edges labelled `via APIM (<area>)`, and hides the APIM node in the landscape.

## Run it locally

```bash
node dfe-overlay/extract-apim-routes.mjs ../path/to/das-apim-endpoints   # when APIM has changed
node dfe-overlay/resolve-dependencies.mjs                                # after editing the overlay or a rescan
node --test dfe-overlay/test/*.test.mjs
```

The `Resolve APIM routing (DfE overlay)` workflow does the same in CI and opens a PR. It runs when a scan or the overlay changes, and every Monday. It needs **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** turned on.

## Precision

Routing is resolved at **area level**: a caller is linked to every inner API its APIM area calls, so this overstates. For example, `das-commitments` appears to use every API that the Approvals area uses. Making it route-level would mean matching the operations each caller makes (kept in `via.operations`) to APIM controllers, then to handlers, then to inner API clients.
