#!/bin/bash
# Starts a WorkHub demo on this computer with made-up data for a fictional
# customer, two pretend servers (SSH/SFTP) and a pretend Jira.
#   tools/demolab/run-demo.sh          start (first run seeds the data)
#   tools/demolab/run-demo.sh stop     stop everything
#   tools/demolab/run-demo.sh reset    stop and delete the demo data
set -e
cd "$(dirname "$0")/../.."
SIM="$PWD/dist/sim"
PORT=47950
export PATH="$HOME/sdk/go/bin:$PATH"

stop() {
  for f in "$SIM"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
  return 0
}
case "$1" in
  stop) stop; echo "Demo stopped."; exit 0 ;;
  reset) stop; rm -rf "$SIM"; echo "Demo data deleted."; exit 0 ;;
esac
stop
mkdir -p "$SIM"
go build -o "$SIM/workhub" . && go build -o "$SIM/demolab" ./tools/demolab
fresh=0; [ -d "$SIM/data" ] || fresh=1
[ $fresh = 1 ] && python3 tools/demolab/seed.py home "$SIM"

"$SIM/demolab" -dir "$SIM/lab" > "$SIM/demolab.log" 2>&1 & echo $! > "$SIM/demolab.pid"
python3 tools/demolab/fake_jira.py 47990 > "$SIM/jira.log" 2>&1 & echo $! > "$SIM/jira.pid"
HOME="$SIM/home" "$SIM/workhub" -data "$SIM/data" -port $PORT -no-browser > "$SIM/workhub.log" 2>&1 & echo $! > "$SIM/workhub.pid"
for i in $(seq 1 100); do grep -q "Open:" "$SIM/workhub.log" 2>/dev/null && break; sleep 0.1; done
URL=$(grep -o 'http://[^ ]*' "$SIM/workhub.log" | head -1)
[ $fresh = 1 ] && python3 tools/demolab/seed.py api "$SIM" $PORT
echo "Demo running: $URL"
echo "  Live servers: 127.0.0.1:2222 deploy/Demo#2026 · 127.0.0.1:2223 batch/Batch#2026"
open "$URL" 2>/dev/null || true
