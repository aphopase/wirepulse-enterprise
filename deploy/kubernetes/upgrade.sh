#!/usr/bin/env bash
# Upgrade WirePulse on Kubernetes without downtime: run the schema migration with the NEW image while the old replicas keep serving,
# then roll the Deployment one replica at a time. If the migration fails the Deployment is not touched. If the rollout does not become
# ready it is rolled back (safe, because migrations must be additive, see "Zero-downtime upgrades" in DEPLOYMENT.md).
#
#   deploy/kubernetes/upgrade.sh registry.example.com/wirepulse-api:0.2.0
#   NAMESPACE=wirepulse MIGRATE_TIMEOUT=15m ROLLOUT_TIMEOUT=10m deploy/kubernetes/upgrade.sh IMAGE
set -euo pipefail
IMAGE=${1:?usage: upgrade.sh IMAGE}
NAMESPACE=${NAMESPACE:-wirepulse}
DEPLOYMENT=${DEPLOYMENT:-wirepulse-api}
MIGRATE_TIMEOUT=${MIGRATE_TIMEOUT:-15m}
ROLLOUT_TIMEOUT=${ROLLOUT_TIMEOUT:-10m}
KUBECTL=${KUBECTL:-kubectl}
HERE=$(cd "$(dirname "$0")" && pwd)
k() { $KUBECTL -n "$NAMESPACE" "$@"; }
seconds() { case "$1" in *h) echo $(( ${1%h} * 3600 ));; *m) echo $(( ${1%m} * 60 ));; *s) echo "${1%s}";; *) echo "$1";; esac; }

echo "== migrating with $IMAGE"
k delete job wirepulse-migrate --ignore-not-found --wait=true >/dev/null
sed "s#image: wirepulse-api#image: $IMAGE#" "$HERE/base/migrate-job.yaml" | k apply -f - >/dev/null
# Wait for either outcome; "kubectl wait" alone would sit out the whole timeout when the Job has already failed.
deadline=$(( $(date +%s) + $(seconds "$MIGRATE_TIMEOUT") ))
while :; do
  status=$(k get job wirepulse-migrate -o jsonpath='{.status.succeeded}/{.status.failed}')
  case "$status" in 1/*) break;; esac
  if k get job wirepulse-migrate -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' | grep -q True; then
    echo "migration FAILED; the Deployment was not changed" >&2; k logs job/wirepulse-migrate --tail=40 >&2 || true; exit 1
  fi
  [ "$(date +%s)" -lt "$deadline" ] || { echo "migration timed out; the Deployment was not changed" >&2; exit 1; }
  sleep 2
done
k logs job/wirepulse-migrate --tail=5

echo "== rolling $DEPLOYMENT to $IMAGE"
k set image "deployment/$DEPLOYMENT" "api=$IMAGE" >/dev/null
k annotate "deployment/$DEPLOYMENT" "kubernetes.io/change-cause=upgrade to $IMAGE" --overwrite >/dev/null
if ! k rollout status "deployment/$DEPLOYMENT" --timeout="$ROLLOUT_TIMEOUT"; then
  echo "rollout did not become ready; rolling back" >&2
  k rollout undo "deployment/$DEPLOYMENT" >/dev/null; k rollout status "deployment/$DEPLOYMENT" --timeout="$ROLLOUT_TIMEOUT" >&2 || true
  exit 1
fi
echo "== upgraded"
