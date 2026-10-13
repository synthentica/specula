#!/bin/sh
# Downloads Wiki.js's English locale package into <dir> for an offline install (Wiki.js "sideload"
# feature), so the UI has its strings without reaching graph.requarks.io.
#   ./sideload.sh <dir>
set -e
dir=${1:?usage: ./sideload.sh <dir>}
mkdir -p "$dir"
base=https://raw.githubusercontent.com/Requarks/wiki-localization/master
curl -fsSL "$base/locales.json" -o "$dir/locales.json"
curl -fsSL "$base/en.json" -o "$dir/en.json"
echo "locales.json and en.json in $dir"
