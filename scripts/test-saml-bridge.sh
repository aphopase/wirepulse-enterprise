#!/usr/bin/env bash
# Starts a throwaway Keycloak (development mode, nothing persisted) for api/test/api-saml-bridge.test.mjs, then prints the variable to
# export. The test creates its own realms through the admin API and deletes them again. Remove the container with:
#   docker rm -f wp-test-saml-keycloak
#
#   scripts/test-saml-bridge.sh
#   WP_TEST_SAML_KEYCLOAK_URL=http://127.0.0.1:18420 npm test --prefix api
#
# The test needs a browser: `npx playwright install chromium` once, from the repository root.
# Test fixtures only: the admin password below is for a container that is gone when you remove it and listens on loopback.
set -euo pipefail

NAME=${SAML_KEYCLOAK_CONTAINER:-wp-test-saml-keycloak}
PORT=${SAML_KEYCLOAK_PORT:-18420}
IMAGE=${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.0}
SERVER="http://127.0.0.1:$PORT"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --network host \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin-password \
  -e KC_HTTP_PORT="$PORT" -e KC_HTTP_HOST=127.0.0.1 \
  "$IMAGE" start-dev >/dev/null

for _ in $(seq 1 120); do
  curl -fs "$SERVER/realms/master/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 2
done
curl -fs "$SERVER/realms/master/.well-known/openid-configuration" >/dev/null || { docker logs "$NAME" | tail -n 30; echo "Keycloak did not start" >&2; exit 1; }

echo "export WP_TEST_SAML_KEYCLOAK_URL=$SERVER"
