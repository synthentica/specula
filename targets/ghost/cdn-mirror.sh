#!/bin/sh
# Stand-in for cdn.jsdelivr.net where it is unreachable: downloads Ghost's Portal from the npm
# registry (the package jsDelivr serves) into <dir>/portal for the "cdn-mirror" compose profile.
#   ./cdn-mirror.sh <dir> [version, default 2.51]
set -e
dir=${1:?usage: ./cdn-mirror.sh <dir> [version]}
tmp=$(mktemp -d)
npm pack "@tryghost/portal@~${2:-2.51}" --pack-destination "$tmp" >/dev/null 2>&1
mkdir -p "$dir/portal"
tar xzf "$tmp"/*.tgz -C "$dir/portal" --strip-components=1 package/umd package/package.json
rm -rf "$tmp"
echo "Portal $(node -p "require('$dir/portal/package.json').version") in $dir/portal/umd"
