package main

// Start-up gate, shown before any data is opened:
//   - the team access password, asked once per PC when the build has one
//     (access.go, set with "go run ./tools/accesshash"). The code is public,
//     so this only keeps casual users out of a downloaded copy.
//   - the master password, on the first start of each new version, when one
//     is set (see master.go).
// Once both are given the real app takes over on the same address.

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const accessIter = 300_000

// accessProof is what a correct access password turns into; only its hash
// (accessCheck) is in the program, and the proof itself is saved on this PC.
func accessProof(pw string) []byte {
	salt, _ := hex.DecodeString(accessSalt)
	k, _ := pbkdf2.Key(sha256.New, pw, salt, accessIter, 32)
	return k
}

func accessMatches(proof []byte) bool {
	return subtle.ConstantTimeCompare([]byte(sha256Hex(proof)), []byte(accessCheck)) == 1
}

func (a *App) accessFile() string { return filepath.Join(filepath.Dir(a.lockFile()), "access.ok") }

func (a *App) accessOK() bool {
	if accessCheck == "" {
		return true
	}
	b, err := os.ReadFile(a.accessFile())
	if err != nil {
		return false
	}
	proof, err := hex.DecodeString(strings.TrimSpace(string(b)))
	return err == nil && accessMatches(proof)
}

// switchHandler lets the gate page hand over to the app without a restart.
type switchHandler struct {
	mu sync.RWMutex
	h  http.Handler
}

func (s *switchHandler) set(h http.Handler) { s.mu.Lock(); s.h = h; s.mu.Unlock() }
func (s *switchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	h := s.h
	s.mu.RUnlock()
	h.ServeHTTP(w, r)
}

type gate struct {
	mu    sync.Mutex
	fails int
	until time.Time
}

// gateRoutes: open is called with the unlocked data key (nil = key.bin).
func (a *App) gateRoutes(open func(key []byte) error) http.Handler {
	g := &gate{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, gatePage)
	})
	mux.HandleFunc("GET /api/gate", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"access": !a.accessOK(), "master": hasMaster(a.dataDir), "version": version})
	})
	mux.HandleFunc("POST /api/gate", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Access, Password, NewPassword string }
		if err := readJSON(r, &in); err != nil {
			writeErr(w, 400, err)
			return
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		if wait := time.Until(g.until); wait > 0 {
			writeErr(w, 429, fmt.Errorf("too many wrong tries — wait %d seconds", int(wait.Seconds())+1))
			return
		}
		fail := func(field string, err error) {
			g.fails++
			time.Sleep(time.Second)
			if g.fails >= 5 {
				g.until = time.Now().Add(time.Duration(30*(g.fails-4)) * time.Second)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(403)
			fmt.Fprintf(w, `{"error":%q,"field":%q}`, err.Error(), field)
		}
		if !a.accessOK() {
			proof := accessProof(in.Access)
			if !accessMatches(proof) {
				fail("access", errors.New("wrong access password"))
				return
			}
			_ = os.MkdirAll(filepath.Dir(a.accessFile()), 0o700)
			if err := os.WriteFile(a.accessFile(), []byte(hex.EncodeToString(proof)), 0o600); err != nil {
				writeErr(w, 500, err)
				return
			}
		}
		var key []byte
		rec := ""
		if hasMaster(a.dataDir) {
			k, usedRecovery, err := unlockMaster(a.dataDir, in.Password)
			if err != nil {
				fail("password", err)
				return
			}
			if usedRecovery { // the recovery code works once: choose a new password
				if in.NewPassword == "" {
					writeJSON(w, map[string]any{"need_new": true})
					return
				}
				if err := checkMasterPassword(in.NewPassword); err != nil {
					writeErr(w, 400, err)
					return
				}
				if rec, err = writeMaster(a.dataDir, k, in.NewPassword); err != nil {
					writeErr(w, 500, err)
					return
				}
			}
			key = k
			_ = writeKeyCache(a.dataDir, k) // not asked again until the next version
		}
		g.fails = 0
		if err := open(key); err != nil {
			writeErr(w, 500, err)
			return
		}
		out := map[string]any{"ok": true}
		if rec != "" {
			for k, v := range a.mailRecovery(a.resetEmail(), rec) {
				out[k] = v
			}
		}
		writeJSON(w, out)
	})
	return a.guard(mux)
}

const gatePage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorkHub</title>
<style>
:root{--bg:#f4f5f7;--panel:#fff;--text:#1d2330;--muted:#687385;--border:#dde1e6;--accent:#2f6fde;--bad:#c93535}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--panel:#1c2027;--text:#e3e7ee;--muted:#9aa4b2;--border:#323944;--accent:#5b8ff0;--bad:#ff7b7b}}
body{font:15px/1.5 "Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box}
.box{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:26px 28px;width:min(400px,100%);box-sizing:border-box}
h2{margin:0 0 4px;font-size:20px}.muted{color:var(--muted);font-size:13px}
label{display:block;margin-top:14px;font-size:13px;font-weight:600}
input{display:block;width:100%;box-sizing:border-box;margin-top:4px;font:inherit;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{margin-top:18px;width:100%;font:inherit;font-weight:600;padding:10px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6}#msg{color:var(--bad);margin-top:10px;font-size:13px;min-height:1em}
code{display:block;font-size:20px;letter-spacing:.08em;text-align:center;padding:12px;margin:12px 0;background:var(--bg);border:1px dashed var(--border);border-radius:8px}
a{color:var(--accent)}[hidden]{display:none!important}
</style></head><body><form class="box" id="f" autocomplete="off">
<h2>🔒 WorkHub</h2><div class="muted" id="sub">Checking…</div>
<label id="accL" hidden>Team access password<input id="acc" type="password" autocomplete="off"></label>
<div class="muted" id="accHelp" hidden>Ask the person who gave you WorkHub. You only need it once on this PC.</div>
<label id="pwL" hidden>Master password<input id="pw" type="password" autocomplete="current-password"></label>
<div class="muted" id="pwHelp" hidden>Forgot it? Type your recovery code instead.</div>
<label id="newL" hidden>New master password (at least 8 characters)<input id="np" type="password" autocomplete="new-password"></label>
<label id="new2L" hidden>Type it again<input id="np2" type="password" autocomplete="new-password"></label>
<button id="go">Unlock</button><div id="msg"></div></form>
<script>
const $ = id => document.getElementById(id), show = (id, on) => { $(id).hidden = !on; };
let st = {}, needNew = false;
async function call(m, body) {
  const r = await fetch('/api/gate', { method: m, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({ error: 'WorkHub stopped — start it again' }));
  if (!r.ok) { const e = new Error(d.error); e.field = d.field; throw e; }
  return d;
}
function form() {
  show('accL', st.access); show('accHelp', st.access);
  show('pwL', st.master && !needNew); show('pwHelp', st.master && !needNew);
  show('newL', needNew); show('new2L', needNew);
  $('sub').textContent = needNew ? 'Recovery code accepted. Choose a new master password.' : st.access && st.master ? 'This copy of WorkHub needs the team access password, then your master password.' : st.master ? 'This is a new version of WorkHub — type your master password to open your data.' : 'This copy of WorkHub needs the team access password.';
  (st.access ? $('acc') : needNew ? $('np') : $('pw')).focus();
}
call('GET').then(d => { st = d; form(); }).catch(e => { $('msg').textContent = e.message; });
$('f').onsubmit = async ev => {
  ev.preventDefault(); $('msg').textContent = '';
  if (needNew && $('np').value !== $('np2').value) { $('msg').textContent = 'The two new passwords are different'; return; }
  $('go').disabled = true; $('go').textContent = 'Checking…';
  try {
    const d = await call('POST', { access: $('acc').value, password: $('pw').value, newpassword: $('np').value });
    if (d.need_new) { needNew = true; st.access = false; form(); return; }
    if (d.recovery) {
      $('f').innerHTML = d.sent_to
        ? '<h2>✅ New master password set</h2><p class="muted">Your new recovery code has been emailed to <b></b>. Your old code no longer works.</p><details><summary class="muted">Show the code</summary><code></code></details><button type="button" id="cont">Open WorkHub</button>'
        : '<h2>✅ New master password set</h2><p class="muted">Your new recovery code (it couldn\'t be emailed) — write it down; it is shown only now, and your old one no longer works.</p><code></code><button type="button" id="cont">I have saved it — open WorkHub</button>';
      if (d.sent_to) $('f').querySelector('b').textContent = d.sent_to;
      $('f').querySelector('code').textContent = d.recovery;
      $('cont').onclick = () => location.replace('/');
      return;
    }
    location.replace('/');
  } catch (e) {
    $('msg').textContent = e.message;
    const el = e.field === 'access' ? $('acc') : e.field === 'password' ? $('pw') : null;
    if (el) { el.select(); el.focus(); }
    if (e.field === 'access') st.access = true;
    if (e.field === 'password' && st.access) { st.access = false; show('accL', false); show('accHelp', false); }
  } finally { $('go').disabled = false; $('go').textContent = 'Unlock'; }
};
</script></body></html>`

func sha256Hex(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
