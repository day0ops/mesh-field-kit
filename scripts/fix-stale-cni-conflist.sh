#!/usr/bin/env bash
set -euo pipefail

# fix-stale-cni-conflist.sh
#
# Finds and (optionally) removes CNI conflist files left behind on nodes after
# a CNI addon (e.g. Cilium) was uninstalled without its proper cleanup hook
# running - e.g. a manual `helm uninstall` instead of the addon's own
# cleanup(), which normally sets `cni.uninstall=true` first so the agent can
# remove its own node-level conflist/binaries before it goes away.
#
# Symptom: new pods hang in ContainerCreating with an event like:
#   FailedCreatePodSandBox ... plugin type="cilium-cni" failed (add):
#   unable to connect to Cilium agent ... dial unix /var/run/cilium/cilium.sock:
#   connect: no such file or directory
#
# Cause: the stale conflist (e.g. /etc/cni/net.d/05-cilium.conflist) sorts
# before the cloud provider's own conflist (e.g. 10-aws.conflist), so
# containerd keeps using it as the active CNI config even though the agent
# behind it is gone.
#
# Usage:
#   ./scripts/fix-stale-cni-conflist.sh [--pattern GLOB] [--context CTX] [--apply]
#
# Defaults to a dry run (lists what it finds on each node). Pass --apply to
# actually delete the matched files.
#
# Examples:
#   ./scripts/fix-stale-cni-conflist.sh
#   ./scripts/fix-stale-cni-conflist.sh --pattern '*calico*' --apply
#   ./scripts/fix-stale-cni-conflist.sh --context my-cluster --apply

PATTERN="*cilium*"
CONTEXT=""
APPLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pattern) PATTERN="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^#!\?/ /' | sed '1d'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

KUBECTL=(kubectl)
[[ -n "$CONTEXT" ]] && KUBECTL+=(--context "$CONTEXT")

debug_node() {
  local node="$1"
  local remote_cmd="$2"
  "${KUBECTL[@]}" debug "node/$node" --image=busybox:1.36 --attach=true --quiet=true \
    -- chroot /host sh -c "$remote_cmd" 2>/dev/null
}

cleanup_debug_pods() {
  local node="$1"
  "${KUBECTL[@]}" get pods -n default --no-headers 2>/dev/null \
    | awk -v n="node-debugger-${node}" 'index($1, n) == 1 {print $1}' \
    | xargs -r -n1 "${KUBECTL[@]}" delete pod -n default >/dev/null 2>&1 || true
}

echo "Scanning nodes for CNI conflist files matching '${PATTERN}' in /etc/cni/net.d ..."
echo

NODES=$("${KUBECTL[@]}" get nodes -o jsonpath='{.items[*].metadata.name}')

for node in $NODES; do
  echo "== $node =="

  FOUND=$(debug_node "$node" "cd /etc/cni/net.d 2>/dev/null && ls -1 ${PATTERN} 2>/dev/null || true")

  if [[ -z "$FOUND" ]]; then
    echo "  (none found)"
  else
    echo "$FOUND" | sed 's/^/  found: /'
    if [[ "$APPLY" == true ]]; then
      for f in $FOUND; do
        echo "  deleting /etc/cni/net.d/$f ..."
        debug_node "$node" "rm -fv /etc/cni/net.d/$f"
      done
    else
      echo "  (dry run - pass --apply to delete)"
    fi
  fi

  cleanup_debug_pods "$node"
  echo
done

echo "Done."
if [[ "$APPLY" == false ]]; then
  echo "This was a dry run. Re-run with --apply to actually remove the files above."
fi
