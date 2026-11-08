#!/usr/bin/env bash
# Deploy a committed version to a host over ssh, as root. One-time host setup
# (the unit, /etc/bst/env, the bst user) is not done here.
# Usage: deploy/deploy.sh <ssh-target> [git-ref]
# Set NODE_DIR to the directory holding node and npm on the host (default /usr/bin).
set -euo pipefail

usage="usage: deploy/deploy.sh <ssh-target> [git-ref]"
if [ $# -lt 1 ] || [ $# -gt 2 ] || [ -z "$1" ]; then
  echo "$usage" >&2
  exit 2
fi
target=$1
ref=${2-HEAD}
if [[ $target == -* || $ref == -* ]]; then
  echo "$usage" >&2
  echo "the target and the ref must not begin with '-'" >&2
  exit 2
fi
node_dir=${NODE_DIR:-/usr/bin}

# Run git at the top of this repository, from any current directory. A
# git archive taken in a subdirectory would ship only that subdirectory.
cd "$(dirname "${BASH_SOURCE[0]}")"
cd "$(git rev-parse --show-toplevel)"

# These two checks run before the host is contacted.
if [ "$ref" = HEAD ] && ! { git diff --quiet && git diff --cached --quiet; }; then
  echo "refusing to deploy HEAD: tracked files have uncommitted changes" >&2
  exit 1
fi
if ! sha=$(git rev-parse --verify --quiet "$ref^{commit}"); then
  echo "not a commit: $ref" >&2
  exit 1
fi
echo "$sha"
release=/opt/bst/releases/$sha

# Ship committed files only. The remote command checks for root, and that the
# release is not already live, before it writes.
git archive "$sha" | ssh "$target" "[ \"\$(id -u)\" = 0 ] || { echo 'the ssh login must be root' >&2; exit 1; }; a=\$(readlink -f /opt/bst/app); [ -z \"\$a\" ] || [ \"\$a\" != \"\$(readlink -f $release)\" ] || { echo '$sha is already live; use systemctl restart bst' >&2; exit 1; }; umask 022; mkdir -p $release && tar -x -C $release"

# Install, switch, check health and prune on the host. The body is one brace group,
# so bash reads all of it before running and no command can consume the script
# from stdin. Only the sha and the quoted NODE_DIR reach the remote command line.
ssh "$target" bash -s -- "$sha" "$(printf %q "$node_dir")" <<'REMOTE'
{
set -euo pipefail
umask 022
sha=$1
node_dir=$2
release=/opt/bst/releases/$sha
link=/opt/bst/app

if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "$link exists and is not a symlink" >&2
  exit 1
fi

cd "$release"
PATH="$node_dir:$PATH" npm ci --omit=dev --ignore-scripts
chown -R root:root "$release"
chmod -R go-w "$release"
touch "$release"

previous=$(readlink "$link" || true)
ln -sfn "$release" "$link"
# A failed restart is judged by the health check below, which rolls back.
systemctl restart bst || true

sleep 10
if ! systemctl is-active --quiet bst; then
  journalctl -u bst -n 30 --no-pager || true
  if [ -n "$previous" ]; then
    ln -sfn "$previous" "$link"
    if systemctl restart bst; then
      echo "bst did not start; rolled back to $previous" >&2
    else
      echo "bst did not start; pointed the link back at $previous, but restarting bst failed" >&2
    fi
  else
    echo "bst did not start; there is no release to roll back to" >&2
  fi
  exit 1
fi

# Healthy: keep the newest 3 releases, never the one the link points at.
shopt -s nullglob
candidates=()
for dir in /opt/bst/releases/*; do
  if [[ ${dir##*/} =~ ^[0-9a-f]{40}$ && -d $dir && ! -L $dir ]]; then
    candidates+=("$dir")
  fi
done
if [ "${#candidates[@]}" -gt 3 ]; then
  current=$(readlink -f "$link")
  mapfile -t newest_first < <(ls -1dt "${candidates[@]}")
  for dir in "${newest_first[@]:3}"; do
    if [ "$(readlink -f "$dir")" != "$current" ]; then
      rm -rf -- "$dir"
    fi
  done
fi
}
REMOTE
