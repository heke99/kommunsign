#!/usr/bin/env bash
set -euo pipefail
npm run verify
mkdir -p release
zip -qr release/kommunsign-source.zip . -x '.git/*' 'node_modules/*' 'dist/*' 'build/*' 'release/*' '.env'
echo "release/kommunsign-source.zip"
