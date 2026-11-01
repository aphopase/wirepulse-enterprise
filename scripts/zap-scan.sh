#!/usr/bin/env bash
# Automated OWASP ZAP API scan of a running WirePulse API: ZAP imports docs/openapi.yaml, then probes every documented operation
# (injection, path traversal, XXE, SSRF, information leaks, missing headers and so on) and writes report.html, report.json and report.md.
#
#   scripts/zap-scan.sh <base-url> <bearer-token> <workspace-id> [report-dir]
#
# The token decides what is reached: a user or API key reaches /v1, a SCIM token /scim/v2, a gateway token /gateway/v1 (run it once
# for each). The workspace id is substituted into the paths, so scan a workspace that exists.
#
# This is an automated scanner, not a penetration test: it follows the documented API with generated values and, by design, most of
# its requests are refused (about 94% 4xx in our runs), so it exercises authentication and input validation far more than business
# logic. And it is an ACTIVE scan: it creates, changes and deletes data and sends attack payloads. Point it only at an environment you
# own and can throw away, with a token you can revoke (the token is visible in this machine's process list while it runs).
set -euo pipefail

[ $# -ge 3 ] || { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
base=$1; token=$2; workspace=$3; out=${4:-zap-reports}
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$out"; out=$(cd "$out" && pwd)
chmod 777 "$out" # the ZAP container runs as its own user and must be able to write the reports

# The only edit to the spec: give {workspaceId} a real value, so requests get past the "no such workspace" answer.
sed "s|WorkspaceId: { name: workspaceId, in: path, required: true, schema: { type: string, format: uuid } }|WorkspaceId: { name: workspaceId, in: path, required: true, schema: { type: string, format: uuid, example: $workspace }, example: $workspace }|" \
  "$root/docs/openapi.yaml" > "$out/openapi-scan.yaml"
grep -q "example: $workspace" "$out/openapi-scan.yaml" || { echo "could not set the workspace id in the spec" >&2; exit 1; }

# -I: do not fail the run on warnings (read the report); -T: stop after ten minutes.
docker run --rm --network host -v "$out:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable zap-api-scan.py \
  -t /zap/wrk/openapi-scan.yaml -f openapi -O "$base" -T 10 -I -r report.html -J report.json -w report.md \
  -z "-config replacer.full_list(0).description=auth -config replacer.full_list(0).enabled=true -config replacer.full_list(0).matchtype=REQ_HEADER -config replacer.full_list(0).matchstr=Authorization -config replacer.full_list(0).regex=false -config replacer.full_list(0).replacement='Bearer $token'"
echo "reports in $out"
