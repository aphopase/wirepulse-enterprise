#!/usr/bin/env bash
# Writes a CycloneDX 1.5 software bill of materials for each package that ships, built from the lockfiles' installed trees (npm sbom):
# sbom/api.cdx.json (the API image), sbom/gateway.cdx.json (the gateway agent) and sbom/console.cdx.json (the browser app, runtime
# dependencies only). Run `npm ci` in each directory first so the tree matches the lockfile; attach the files to a release.
# The container image's operating-system packages are not in these files: `trivy image --format cyclonedx` covers those.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$root/sbom"
for pair in "api:api" "gateway:gateway" ".:console"; do
  dir=${pair%%:*}; name=${pair##*:}
  (cd "$root/$dir" && npm sbom --sbom-format cyclonedx --omit dev --package-lock-only > "$root/sbom/$name.cdx.json")
  node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv[2].padEnd(8), b.specVersion, String(b.components.length).padStart(4), "components")' "$root/sbom/$name.cdx.json" "$name"
done
