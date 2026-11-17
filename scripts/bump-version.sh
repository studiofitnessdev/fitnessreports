#!/bin/sh
# Stamps css/js links in index.html with a hash of their contents (?v=...),
# so phones never mix a new index.html with old cached files (GitHub Pages caches each file for 10 min).
# Also stamps the service worker's cache name (sw.js).
# Run before committing: sh scripts/bump-version.sh
cd "$(dirname "$0")/.." || exit 1
for f in css/style.css js/printer.js js/receipt.js js/config.js js/app.js; do
  v=$(shasum "$f" | cut -c1-8)
  sed -i.bak -E "s#(\"$f)(\?v=[0-9a-f]+)?\"#\1?v=$v\"#" index.html
done
rm -f index.html.bak
# The service worker's cache name follows the page and images, so a deploy drops the old cache.
v=$(cat index.html img/* | shasum | cut -c1-8)
sed -i.bak -E "s#sf-[0-9a-f]{8}#sf-$v#" sw.js && rm -f sw.js.bak
grep -n "const VERSION" sw.js
grep -n -E 'style.css|printer.js|receipt.js|config.js|app.js' index.html
