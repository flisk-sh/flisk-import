// This release deliberately imports one source: the repository's selected Compose file.
// The standalone detectors in `./dockerfile.ts`, `./package-json.ts`, and `./procfile.ts`
// are staged for later releases and tested directly, so they are not imported here or
// selected by `buildPlan` (`selectDetectors(["compose"])`).
import "./compose.js";
