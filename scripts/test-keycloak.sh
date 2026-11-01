#!/usr/bin/env bash
# Starts a throwaway Keycloak (development mode, nothing persisted) with the realm that api/test/api-keycloak.test.mjs expects, then prints
# the variable to export. Remove it with: docker rm -f wp-test-keycloak
#
#   scripts/test-keycloak.sh
#   WP_TEST_KEYCLOAK_URL=http://127.0.0.1:18400/realms/wirepulse-test npm test --prefix api
#
# Test fixtures only: the passwords below are for a container that is gone when you remove it and listens on loopback.
set -euo pipefail

NAME=${KEYCLOAK_CONTAINER:-wp-test-keycloak}
PORT=${KEYCLOAK_PORT:-18400}
IMAGE=${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.0}
REALM=wirepulse-test
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

kcadm() { docker exec "$NAME" /opt/keycloak/bin/kcadm.sh "$@"; }
kcadm config credentials --server "$SERVER" --realm master --user admin --password admin-password >/dev/null

kcadm create realms -s realm="$REALM" -s enabled=true -s sslRequired=none >/dev/null

# The console clients carry an audience mapper, so their access tokens are meant for the API. The other client does not: a token it
# obtains for the same person must be refused. All three are public clients that may use the authorization code flow with PKCE from the
# console's address (browser sign-in, e2e/sso.spec.ts); wirepulse-console-short issues access tokens that last 65 seconds, which is what
# makes the console's silent renewal observable in a test.
E2E_ORIGIN=${WP_E2E_ORIGIN:-http://127.0.0.1:5173}   # where the console is served during the browser tests
for client in wirepulse-console wirepulse-console-short other-app; do
  kcadm create clients -r "$REALM" -s clientId="$client" -s publicClient=true -s directAccessGrantsEnabled=true \
    -s "redirectUris=[\"$E2E_ORIGIN/*\"]" -s "webOrigins=[\"$E2E_ORIGIN\"]" -s 'attributes."pkce.code.challenge.method"=S256' >/dev/null
done
kcadm update "clients/$(kcadm get clients -r "$REALM" -q clientId=wirepulse-console-short --fields id --format csv --noquotes | tr -d '\r')" -r "$REALM" -s 'attributes."access.token.lifespan"=65' >/dev/null
for client in wirepulse-console wirepulse-console-short; do
  client_id=$(kcadm get clients -r "$REALM" -q clientId="$client" --fields id --format csv --noquotes | tr -d '\r')
  kcadm create "clients/$client_id/protocol-mappers/models" -r "$REALM" -s name=api-audience -s protocol=openid-connect \
    -s protocolMapper=oidc-audience-mapper -s 'config."included.custom.audience"=wirepulse-api' \
    -s 'config."access.token.claim"=true' -s 'config."id.token.claim"=false' >/dev/null
done

# username  email  verified
for row in "pat pat@example.com true" "kim kim@example.com true" "lee lee@example.com false"; do
  read -r username email verified <<<"$row"
  kcadm create users -r "$REALM" -s username="$username" -s email="$email" -s emailVerified="$verified" \
    -s firstName="${username^}" -s lastName=Tester -s enabled=true >/dev/null
  kcadm set-password -r "$REALM" --username "$username" --new-password "$username-password" >/dev/null
done

echo "export WP_TEST_KEYCLOAK_URL=$SERVER/realms/$REALM"
