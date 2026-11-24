#!/bin/sh
# One-time set-up of the browser smoke test on the build machine (not needed
# on the Windows laptops): a Python venv with Playwright and its Chromium.
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip -q install playwright==1.56.0 # pinned: the same browser every run
.venv/bin/python -m playwright install chromium
echo "Smoke test ready: tools/uitest/run.sh (or ./build.sh check)"
