#!/bin/sh
# Renders the home-screen icons (img/icon-*.png, img/apple-touch-icon.png) from img/emblem.svg
# with Google Chrome (macOS). Run after replacing the logo, then: sh scripts/bump-version.sh
cd "$(dirname "$0")/.." || exit 1
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SVG="$(pwd)/img/emblem.svg"
TMP=$(mktemp -d)
render() { # size, logo % of the icon, background, output
  printf '<!doctype html><body style="margin:0;width:%spx;height:%spx;background:%s;display:grid;place-items:center;overflow:hidden"><img src="file://%s" style="width:%s%%;height:%s%%">' \
    "$1" "$1" "$3" "$SVG" "$2" "$2" > "$TMP/p.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$1,$1" --screenshot="$4" "file://$TMP/p.html" >/dev/null 2>&1
}
render 192 100 transparent img/icon-192.png
render 512 100 transparent img/icon-512.png
# "maskable": Android crops these to circles/squircles, so the logo stays inside the central safe zone
render 192 72 '#050505' img/icon-maskable-192.png
render 512 72 '#050505' img/icon-maskable-512.png
render 180 84 '#050505' img/apple-touch-icon.png
rm -rf "$TMP"
ls -l img/*.png
