#!/bin/sh
# Runs the browser smoke test against a fresh demo (made-up data only).
# Set up once with tools/uitest/setup.sh.
set -e
cd "$(dirname "$0")/../.."
PY=tools/uitest/.venv/bin/python
[ -x "$PY" ] || { echo "Run tools/uitest/setup.sh once first"; exit 2; }
# a fresh demo, without opening a browser window
NOOPEN=$(mktemp -d); printf '#!/bin/sh\nexit 0\n' > "$NOOPEN/open"; chmod +x "$NOOPEN/open"
PATH="$NOOPEN:$PATH" tools/demolab/run-demo.sh reset >/dev/null
PATH="$NOOPEN:$PATH" tools/demolab/run-demo.sh >/dev/null
URL=$(grep -o 'http://[^ ]*' dist/sim/workhub.log | head -1)
echo "UI smoke test on $URL"
status=0
"$PY" -I tools/uitest/smoke.py "$URL" "$PWD/dist/sim" || status=$?
tools/demolab/run-demo.sh stop >/dev/null
exit $status
