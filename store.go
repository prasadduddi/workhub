package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type Entry struct {
	ID            string            `json:"id"`
	Project       string            `json:"project"`
	Name          string            `json:"name"`
	Host          string            `json:"host,omitempty"`
	Port          int               `json:"port,omitempty"`
	Protocol      string            `json:"protocol,omitempty"`
	URL           string            `json:"url,omitempty"`
	Username      string            `json:"username,omitempty"`
	Password      string            `json:"password,omitempty"`
	PrevPasswords []string          `json:"prev_passwords,omitempty"`
	KeyFile       string            `json:"key_file,omitempty"`
	Env           string            `json:"env,omitempty"`
	Tags          []string          `json:"tags,omitempty"`
	Extra         map[string]string `json:"extra,omitempty"`
	Notes         string            `json:"notes,omitempty"`
	Favorite      bool              `json:"favorite,omitempty"`
	ClipIDs       []string          `json:"clip_ids,omitempty"`
	Created       time.Time         `json:"created"`
	Updated       time.Time         `json:"updated"`
	LastUsed      time.Time         `json:"last_used,omitzero"`
	LastDir       string            `json:"last_dir,omitempty"`     // last remote folder (terminal or Files)
	OpenCount     int               `json:"open_count,omitempty"`   // opened / connected
	SearchCount   int               `json:"search_count,omitempty"` // used after searching for it
	Folder        string            `json:"folder,omitempty"`       // browser bookmark folder, e.g. "Edge › Favorites bar › Infra"
	Source        string            `json:"source,omitempty"`       // "edge"/"chrome" when it came from browser bookmarks
	Hidden        bool              `json:"hidden,omitempty"`       // removed by the user but kept so it isn't imported again
	Unsorted      bool              `json:"unsorted,omitempty"`     // captured, not yet looked at (the Unsorted inbox)
	Status        string            `json:"status,omitempty"`       // last connection/link check: "ok" or "fail"
	StatusAt      time.Time         `json:"status_at,omitzero"`
	LastOK        time.Time         `json:"last_ok,omitzero"` // when it last connected / checked fine (kept when a later try fails)
	StatusMsg     string            `json:"status_msg,omitempty"`
	Captures      []Capture         `json:"captures,omitempty"` // when and where the details came from, oldest first
}

// Capture records one time the details were captured: Source is "clipboard",
// "paste", "outlook", "chrome", "edge", "screenshot", "manual", "note"…;
// Detail adds e.g. the bookmark folder.
type Capture struct {
	At     time.Time `json:"at"`
	Source string    `json:"source"`
	Detail string    `json:"detail,omitempty"`
}

const maxCaptures = 20

func (e *Entry) addCapture(source, detail string, at time.Time) {
	if n := len(e.Captures); n > 0 {
		last := e.Captures[n-1]
		if last.Source == source && last.Detail == detail && at.Sub(last.At) < time.Minute {
			return // the same copy seen twice
		}
	}
	e.Captures = append(e.Captures, Capture{At: at, Source: source, Detail: detail})
	if len(e.Captures) > maxCaptures {
		e.Captures = e.Captures[len(e.Captures)-maxCaptures:]
	}
}

type Clip struct {
	ID       string    `json:"id"`
	Text     string    `json:"text"`
	Source   string    `json:"source"`
	From     string    `json:"from,omitempty"` // the app/window it was copied from
	Project  string    `json:"project"`
	Created  time.Time `json:"created"`
	EntryIDs []string  `json:"entry_ids,omitempty"`
}

type Note struct {
	ID      string    `json:"id"`
	Title   string    `json:"title"`
	Body    string    `json:"body"`
	Updated time.Time `json:"updated"`
}

type RecentFile struct {
	Path   string    `json:"path"`
	Opened time.Time `json:"opened"`
}

type Settings struct {
	Workspace     string          `json:"workspace"`
	Watch         bool            `json:"watch"`
	CaptureAll    bool            `json:"capture_all"`
	Project       string          `json:"project"`
	OpenTabs      []string        `json:"open_tabs"`
	NoBrowserSync bool            `json:"no_browser_sync"`
	Repos         []string        `json:"repos"`
	Groups        []Group         `json:"groups"`
	BlockedSites  []string        `json:"blocked_sites"`
	LinkBrowser   string          `json:"link_browser"` // desktop version: chrome (default), edge or default
	Mail          MailSettings    `json:"mail"`
	NameRules     []NameRule      `json:"name_rules,omitempty"` // e.g. -BAT- → Batch (this workspace only)
	Saved         []SavedQuery    `json:"saved_searches,omitempty"`
	ActiveThread  string          `json:"active_thread,omitempty"`   // the task thread captures are added to: "" = General, "off" = none
	SessionLog    bool            `json:"session_log,omitempty"`     // save the text of SSH sessions (sessionlog.go)
	BackupCopy    string          `json:"backup_copy,omitempty"`     // second folder for backups, e.g. in OneDrive
	NoShots       bool            `json:"no_shots,omitempty"`        // don't capture copied screenshots
	Monitor       MonitorSettings `json:"monitor"`                   // server monitoring (monitor.go)
	NoUpdateFetch bool            `json:"no_update_fetch,omitempty"` // don't download new versions in the background
	LastSession   *SessionSnap    `json:"last_session,omitempty"`    // reopened after a restart or update
	NoReopen      bool            `json:"no_reopen,omitempty"`       // don't offer to reopen the last session
}

// SessionSnap is what was open: SSH terminals and SQL tabs (connection ids),
// the thread and the page.
type SessionSnap struct {
	SSH    []string  `json:"ssh,omitempty"`
	SQL    []string  `json:"sql,omitempty"`
	Thread string    `json:"thread,omitempty"`
	View   string    `json:"view,omitempty"`
	At     time.Time `json:"at,omitzero"`
}

// SavedQuery is a search kept in the sidebar, e.g. "PROD Batch" = env:prod app:batch.
type SavedQuery struct {
	Name  string `json:"name"`
	Query string `json:"query"`
}

// NameRule names servers and links whose host name contains Match.
type NameRule struct {
	Match string `json:"match"`
	Label string `json:"label"`
}

// Group gathers everything matching its patterns (see static/groups.js).
type Group struct {
	Name     string   `json:"name"`
	Patterns []string `json:"patterns"`
	Color    string   `json:"color,omitempty"`
}

type State struct {
	Entries      []*Entry     `json:"entries"`
	Clips        []*Clip      `json:"clips"`
	Notes        []*Note      `json:"notes"`
	Recent       []RecentFile `json:"recent"`
	LocalDir     string       `json:"local_dir,omitempty"`         // last folder in This PC
	MailFrom     time.Time    `json:"mail_since,omitzero"`         // newest mail already checked
	MailIDs      []string     `json:"mail_seen,omitempty"`         // EntryIDs already captured
	Ignored      []string     `json:"ignored_bookmarks,omitempty"` // browser bookmark URLs deleted in WorkHub
	Props        []*PropNode  `json:"props,omitempty"`             // Properties page tree
	WorkItems    []*WorkItem  `json:"work_items,omitempty"`        // Notepad++ work item pages
	Jira         JiraConfig   `json:"jira"`
	JiraIssues   []*JiraIssue `json:"jira_issues,omitempty"`
	Events       []*Event     `json:"events,omitempty"` // Calendar
	Snippets     []*Snippet   `json:"sql_snippets,omitempty"`
	HTTPReqs     []*HTTPReq   `json:"http_requests,omitempty"` // 🌐 API page
	HTTPEnvs     []*HTTPEnv   `json:"http_envs,omitempty"`
	HTTPHistory  []HTTPHist   `json:"http_history,omitempty"`
	HTTPLocalEnv bool         `json:"http_local_env,omitempty"` // the default "localhost" environment was made (once)
	Settings     Settings     `json:"settings"`
}

const (
	maxClips  = 2000
	maxRecent = 30
	fileMagic = "WHUB1"
)

// Store keeps everything in memory and writes it to one encrypted file
// (AES-GCM). On Windows the key itself is protected with DPAPI, so the data
// file is unreadable for other Windows users or if copied to another PC.
type Store struct {
	mu      sync.RWMutex
	path    string
	key     []byte
	st      State
	version int64
	dirty   bool
}

func OpenStore(dir string) (*Store, error) { return OpenStoreKey(dir, nil) }

// OpenStoreKey opens the data with a key unlocked by the master password;
// with key nil it uses key.bin (and refuses if a master password is set).
func OpenStoreKey(dir string, key []byte) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "workhub.dat")}
	_, statErr := os.Stat(s.path)
	dataExists := statErr == nil

	keyPath := filepath.Join(dir, "key.bin")
	raw, err := os.ReadFile(keyPath)
	switch {
	case key != nil:
		s.key = key
	case hasMaster(dir):
		return nil, errMasterNeeded
	case err == nil:
		s.key, err = unprotectKey(raw)
		if err != nil {
			return nil, fmt.Errorf("cannot unlock key.bin (was the data folder created by another Windows user or PC?): %w", err)
		}
	case errors.Is(err, os.ErrNotExist) && !dataExists:
		s.key = make([]byte, 32)
		if _, err := rand.Read(s.key); err != nil {
			return nil, err
		}
		prot, err := protectKey(s.key)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(keyPath, prot, 0o600); err != nil {
			return nil, err
		}
	case errors.Is(err, os.ErrNotExist):
		return nil, fmt.Errorf("%s exists but key.bin is missing; refusing to start so nothing is overwritten", s.path)
	default:
		return nil, err
	}

	s.st.Settings = Settings{Watch: true, Project: "General"}
	if dataExists {
		blob, err := os.ReadFile(s.path)
		if err != nil {
			return nil, err
		}
		plain, err := s.decrypt(blob)
		if err != nil {
			return nil, fmt.Errorf("cannot decrypt %s: %w", s.path, err)
		}
		if err := json.Unmarshal(plain, &s.st); err != nil {
			return nil, fmt.Errorf("corrupt data file %s: %w", s.path, err)
		}
		s.applyNameRules() // automatic names follow the current rules and labels
		s.migrateThreads()
		s.tidyClips() // work item documents become thread posts
	}
	go s.saver()
	return s, nil
}

func (s *Store) encrypt(plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append([]byte(fileMagic), nonce...)
	return gcm.Seal(out, nonce, plain, nil), nil
}

func (s *Store) decrypt(blob []byte) ([]byte, error) { return decryptWith(s.key, blob) }

func decryptWith(key, blob []byte) ([]byte, error) {
	if !strings.HasPrefix(string(blob), fileMagic) {
		return nil, errors.New("not a WorkHub data file")
	}
	blob = blob[len(fileMagic):]
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(blob) < gcm.NonceSize() {
		return nil, errors.New("file too short")
	}
	return gcm.Open(nil, blob[:gcm.NonceSize()], blob[gcm.NonceSize():], nil)
}

// changed must be called with s.mu held for writing.
func (s *Store) changed() {
	s.version++
	s.dirty = true
}

func (s *Store) Version() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.version
}

func (s *Store) saver() {
	for range time.Tick(time.Second) {
		s.Flush()
	}
}

func (s *Store) Flush() {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return
	}
	plain, err := json.Marshal(&s.st)
	s.dirty = false
	s.mu.Unlock()
	if err == nil {
		err = s.writeFile(plain)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "save failed:", err)
		s.mu.Lock()
		s.dirty = true
		s.mu.Unlock()
	}
}

func (s *Store) writeFile(plain []byte) error {
	blob, err := s.encrypt(plain)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return err
	}
	if _, err := os.Stat(s.path); err == nil {
		_ = copyFile(s.path, s.path+".bak")
	}
	return os.Rename(tmp, s.path)
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o600)
}

// ---- entries ----

// EntryView is an entry as sent to the browser.
type EntryView struct {
	Entry
	HasPassword bool `json:"has_password"`
}

func view(e *Entry) EntryView {
	return EntryView{Entry: *e, HasPassword: e.Password != ""}
}

func (s *Store) Entries() []EntryView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]EntryView, 0, len(s.st.Entries))
	for _, e := range s.st.Entries {
		out = append(out, view(e))
	}
	return out
}

func (s *Store) Entry(id string) (Entry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, e := range s.st.Entries {
		if e.ID == id {
			return *e, true
		}
	}
	return Entry{}, false
}

// EntryInput is what the edit form sends. Nil Password means "unchanged".
type EntryInput struct {
	ID       string            `json:"id"`
	Project  string            `json:"project"`
	Name     string            `json:"name"`
	Host     string            `json:"host"`
	Port     int               `json:"port"`
	Protocol string            `json:"protocol"`
	URL      string            `json:"url"`
	Username string            `json:"username"`
	Password *string           `json:"password"`
	KeyFile  string            `json:"key_file"`
	Env      string            `json:"env"`
	Tags     []string          `json:"tags"`
	Extra    map[string]string `json:"extra"`
	Notes    string            `json:"notes"`
	Favorite bool              `json:"favorite"`
}

func (s *Store) SaveEntry(in EntryInput) (EntryView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	var e *Entry
	if in.ID != "" {
		for _, x := range s.st.Entries {
			if x.ID == in.ID {
				e = x
			}
		}
		if e == nil {
			return EntryView{}, errors.New("entry not found")
		}
	} else {
		e = &Entry{ID: randomHex(8), Created: now}
		e.addCapture("manual", "", now)
		s.st.Entries = append(s.st.Entries, e)
	}
	e.Project = orDefault(strings.TrimSpace(in.Project), "General")
	e.Host = strings.TrimSpace(in.Host)
	e.Port = in.Port
	e.Protocol = strings.ToLower(strings.TrimSpace(in.Protocol))
	e.URL = strings.TrimSpace(in.URL)
	e.Username = strings.TrimSpace(in.Username)
	if in.Password != nil && *in.Password != e.Password {
		if e.Password != "" {
			e.PrevPasswords = append(e.PrevPasswords, e.Password)
		}
		e.Password = *in.Password
	}
	e.KeyFile = strings.TrimSpace(in.KeyFile)
	e.Env = strings.ToUpper(strings.TrimSpace(in.Env))
	if e.Env == "" {
		e.Env = inferEnv(e.Host + " " + e.URL + " " + in.Name)
	}
	e.Tags = in.Tags
	e.Extra = in.Extra
	e.Notes = in.Notes
	e.Favorite = in.Favorite
	e.Unsorted = false // saved by the user: sorted
	e.Name = strings.TrimSpace(in.Name)
	if e.Name == "" {
		e.Name = defaultName(e)
	}
	e.Updated = now
	s.changed()
	return view(e), nil
}

// Bulk changes several entries at once (chat "delete all youtube links").
// Removing hides, so it can be undone and browser bookmarks aren't re-imported.
func (s *Store) Bulk(ids []string, op, value string) (int, error) {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n, now := 0, time.Now()
	for _, e := range s.st.Entries {
		if !want[e.ID] {
			continue
		}
		switch op {
		case "hide":
			e.Hidden = true
		case "unhide":
			e.Hidden = false
		case "pin":
			e.Favorite = true
		case "unpin":
			e.Favorite = false
		case "project":
			e.Project = orDefault(strings.TrimSpace(value), "General")
		case "env":
			e.Env = strings.ToUpper(strings.TrimSpace(value))
		case "type": // e.g. a pasted host that is really an Oracle database
			e.Protocol = strings.ToLower(strings.TrimSpace(value))
		case "password": // a changed password, set on every login of that user
			if value == e.Password {
				continue
			}
			if e.Password != "" && !slices.Contains(e.PrevPasswords, e.Password) {
				e.PrevPasswords = append(e.PrevPasswords, e.Password)
			}
			e.Password, e.Status, e.StatusMsg = value, "", "" // not tried with the new one yet
		default:
			return 0, fmt.Errorf("unknown bulk action %q", op)
		}
		e.Updated = now
		n++
	}
	if n > 0 {
		s.changed()
	}
	return n, nil
}

// SetHidden hides or restores an entry. Hidden entries stay in the data so
// browser bookmarks the user removed are known and never imported again.
func (s *Store) SetHidden(id string, hidden bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.ID == id && e.Hidden != hidden {
			e.Hidden = hidden
			e.Updated = time.Now()
			s.changed()
		}
	}
}

func (s *Store) DeleteEntry(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, e := range s.st.Entries {
		if e.ID == id {
			if e.Source != "" && e.URL != "" { // from Edge/Chrome: hide instead, so it isn't imported again
				e.Hidden = true
				e.Updated = time.Now()
				s.changed()
				return
			}
			s.st.Entries = append(s.st.Entries[:i], s.st.Entries[i+1:]...)
			s.changed()
			return
		}
	}
}

func (s *Store) Touch(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.ID == id {
			e.OpenCount++ // every connection counts as a use
			e.LastUsed = time.Now()
			s.changed()
		}
	}
}

// Searched records that the entry was used from search results.
func (s *Store) Searched(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.ID == id {
			e.SearchCount++
			s.changed()
		}
	}
}

// SetStatus records whether the last connection or link check worked.
func (s *Store) SetStatus(id string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.ID == id {
			e.Status, e.StatusMsg, e.StatusAt = "ok", "", time.Now()
			if err == nil {
				e.LastOK = e.StatusAt
			} else {
				e.Status, e.StatusMsg = "fail", err.Error()
			}
			s.changed()
		}
	}
}

func (s *Store) SetExtra(id, key, val string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.ID == id {
			if e.Extra == nil {
				e.Extra = map[string]string{}
			}
			if val == "" {
				delete(e.Extra, key)
			} else {
				e.Extra[key] = val
			}
			s.changed()
		}
	}
}

// Opened records that the user opened the entry's URL.
func (s *Store) Opened(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.ID == id {
			e.OpenCount++
			e.LastUsed = time.Now()
			s.changed()
		}
	}
}

// SyncBookmarks imports the browsers' bookmarks: new ones are added and
// renamed or moved ones updated. It never removes anything (the browser is
// only read), skips links already in WorkHub (see normURL) and links the user
// deleted in WorkHub.
func (s *Store) SyncBookmarks(list []Bookmark) (added, removed int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	norm := normURL
	byURL := map[string]*Entry{}
	// Merge duplicate browser copies already stored (keep the first).
	kept0 := s.st.Entries[:0]
	for _, e := range s.st.Entries {
		if e.URL != "" {
			k := norm(e.URL)
			if prev := byURL[k]; prev != nil && e.Source != "" && e.Password == "" && e.Username == "" && e.Notes == "" {
				prev.OpenCount += e.OpenCount
				prev.SearchCount += e.SearchCount
				continue
			}
			if byURL[k] == nil {
				byURL[k] = e
			}
		}
		kept0 = append(kept0, e)
	}
	s.st.Entries = kept0
	seen := map[string]bool{}
	ignored := map[string]bool{}
	for _, u := range s.st.Ignored {
		ignored[normURL(u)] = true
	}
	now, changed := time.Now(), false
	own := s.st.Settings.BlockedSites
	for _, e := range s.st.Entries {
		if e.URL != "" && !e.Hidden && blockedURL(e.URL, own) {
			e.Hidden = true // blocked site imported earlier: hide it for good
			changed = true
		}
	}
	for _, b := range list {
		k := norm(b.URL)
		if ignored[k] || blockedURL(b.URL, own) {
			continue
		}
		if seen[k] {
			continue // same link in two folders: keep the first
		}
		seen[k] = true
		name := strings.TrimSpace(b.Name)
		if e := byURL[k]; e != nil {
			if e.Folder != b.Folder || (e.Source != "" && name != "" && e.Name != name) {
				e.Folder = b.Folder
				if e.Source != "" && name != "" {
					e.Name = name
				}
				changed = true
			}
			continue
		}
		f, ok := fromURL(b.URL)
		if !ok {
			continue
		}
		e := &Entry{ID: randomHex(8), Project: "Bookmarks", Name: orDefault(name, f.Host), Host: f.Host, Port: f.Port,
			Protocol: f.Protocol, URL: f.URL, Folder: b.Folder, Source: b.Source, Created: now, Updated: now}
		e.addCapture(orDefault(b.Source, "bookmark"), b.Folder, now)
		e.Env = inferEnv(e.Host + " " + e.URL + " " + e.Name)
		s.st.Entries = append(s.st.Entries, e)
		byURL[k] = e
		added++
		changed = true
	}
	if changed {
		s.applyNameRules()
		s.changed()
	}
	return added, removed
}

func (s *Store) SetLastDir(id, dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.ID == id && e.LastDir != dir {
			e.LastDir = dir
			s.changed()
		}
	}
}

func (s *Store) MailSince() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st.MailFrom
}

func (s *Store) SetMailSince(t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.After(s.st.MailFrom) {
		s.st.MailFrom = t
		s.dirty = true
	}
}

func (s *Store) MailSeen(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, x := range s.st.MailIDs {
		if x == id {
			return true
		}
	}
	return false
}

func (s *Store) MarkMailSeen(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.st.MailIDs = append(s.st.MailIDs, id)
	if len(s.st.MailIDs) > 5000 {
		s.st.MailIDs = s.st.MailIDs[len(s.st.MailIDs)-5000:]
	}
	s.dirty = true
}

func (s *Store) LocalDir() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st.LocalDir
}

func (s *Store) SetLocalDir(dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st.LocalDir != dir {
		s.st.LocalDir = dir
		s.dirty = true // no version bump: the UI doesn't need to refresh for this
	}
}

// SetCredentials stores credentials typed at connect time.
func (s *Store) SetCredentials(id, user, pass string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.ID == id {
			if user != "" {
				e.Username = user
			}
			if pass != "" && pass != e.Password {
				if e.Password != "" {
					e.PrevPasswords = append(e.PrevPasswords, e.Password)
				}
				e.Password = pass
			}
			e.Updated = time.Now()
			s.changed()
		}
	}
}

func (s *Store) RenameProject(from, to string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rename := func(p string) string {
		if p == from {
			return to
		}
		if strings.HasPrefix(p, from+"/") {
			return to + p[len(from):]
		}
		return p
	}
	for _, e := range s.st.Entries {
		e.Project = rename(e.Project)
	}
	s.st.Settings.Project = rename(s.st.Settings.Project)
	s.changed()
}

// ---- capture ----

func entryKey(host string, port int, user, url string) string {
	return strings.ToLower(host) + "|" + fmt.Sprint(port) + "|" + strings.ToLower(user) + "|" + strings.TrimRight(strings.ToLower(url), "/")
}

// Ingest parses text, stores the clip and merges findings into entries.
// Clipboard captures without findings are dropped unless CaptureAll is on.
// tidyClips (at start): removes WorkHub's own sign-in links that older
// versions captured (and the token in any text), and merges captures of the
// same text into the first one.
func (s *Store) tidyClips() {
	keep := s.st.Entries[:0]
	for _, e := range s.st.Entries {
		if !selfAddr.MatchString(e.URL) {
			keep = append(keep, e)
		}
	}
	for i := len(keep); i < len(s.st.Entries); i++ {
		s.st.Entries[i] = nil
	}
	s.st.Entries = keep
	norm := func(t string) string { return strings.Join(strings.Fields(t), " ") }
	first := map[string]*Clip{}
	moved := map[string]string{} // removed clip id → kept clip id
	clips := s.st.Clips[:0]
	for _, c := range s.st.Clips {
		if selfLink.MatchString(c.Text) {
			c.Text = selfLink.ReplaceAllString(c.Text, "${1}•••")
			if strings.TrimSpace(strings.ReplaceAll(c.Text, "•••", "")) == "" || selfLinkOnly(c.Text) {
				moved[c.ID] = ""
				continue
			}
		}
		k := norm(c.Text)
		if f := first[k]; f != nil {
			for _, id := range c.EntryIDs {
				f.EntryIDs = appendUnique(f.EntryIDs, id)
			}
			moved[c.ID] = f.ID
			continue
		}
		first[k] = c
		clips = append(clips, c)
	}
	for i := len(clips); i < len(s.st.Clips); i++ {
		s.st.Clips[i] = nil
	}
	s.st.Clips = clips
	if len(moved) == 0 {
		return
	}
	for _, e := range s.st.Entries {
		var ids []string
		for _, id := range e.ClipIDs {
			if to, ok := moved[id]; !ok {
				ids = append(ids, id)
			} else if to != "" {
				ids = appendUnique(ids, to)
			}
		}
		e.ClipIDs = ids
	}
	for _, w := range s.st.WorkItems {
		for _, p := range w.Posts {
			if to, ok := moved[p.Ref]; ok && p.Kind == "capture" {
				p.Ref = to
			}
		}
	}
	s.changed()
}

// selfLinkOnly: the text is just WorkHub's own (token-less) sign-in link.
func selfLinkOnly(t string) bool {
	return regexp.MustCompile(`(?i)^\s*https?://(?:127\.0\.0\.1|localhost):\d+/?\S*t=•••\S*\s*$`).MatchString(t)
}

// seenClip: the same text (ignoring spacing) is among the recent captures.
func (s *Store) seenClip(text string) bool {
	norm := func(t string) string { return strings.Join(strings.Fields(t), " ") }
	t := norm(text)
	for i := len(s.st.Clips) - 1; i >= 0 && i >= len(s.st.Clips)-500; i-- {
		if norm(s.st.Clips[i].Text) == t {
			return true
		}
	}
	return false
}

// selfLink is WorkHub's own sign-in link (http://127.0.0.1:PORT/?t=TOKEN):
// never captured, and its token never stored.
var selfLink = regexp.MustCompile(`(?i)(https?://(?:127\.0\.0\.1|localhost):\d+/?[^\s"'<>]*?[?&]t=)[0-9a-f]{16,}`)

// selfAddr: any link to a local WorkHub sign-in address (token or not).
var selfAddr = regexp.MustCompile(`(?i)^https?://(?:127\.0\.0\.1|localhost):\d+/?[^\s]*[?&]t=`)

func (s *Store) Ingest(text, source, project string) (*Clip, []EntryView) {
	return s.IngestFrom(text, source, "", project)
}

// IngestFrom is Ingest with where the text was copied from (app and window).
func (s *Store) IngestFrom(text, source, from, project string) (*Clip, []EntryView) {
	if selfLink.MatchString(text) {
		if strings.TrimSpace(selfLink.ReplaceAllString(text, "")) == "" || strings.TrimSpace(selfLink.ReplaceAllString(text, "")) == "#tasks" {
			return nil, nil // just WorkHub's own link
		}
		text = selfLink.ReplaceAllString(text, "${1}•••")
	}
	all := Parse(text)
	s.mu.Lock()
	defer s.mu.Unlock()
	var findings []Finding
	for _, f := range all {
		if selfAddr.MatchString(f.URL) {
			continue // WorkHub's own address
		}
		if f.URL == "" || !blockedURL(f.URL, s.st.Settings.BlockedSites) {
			findings = append(findings, f)
		}
	}
	if project == "" {
		project = s.st.Settings.Project
	}
	if len(findings) == 0 && (source == "outlook" || (source == "clipboard" && !s.st.Settings.CaptureAll)) {
		return nil, nil
	}
	if source == "clipboard" && s.seenClip(text) {
		return nil, nil // copied the same text again: already captured
	}
	if source == "outlook-all" {
		source = "outlook"
	}
	now := time.Now()
	clip := &Clip{ID: randomHex(8), Text: text, Source: source, From: from, Project: project, Created: now}

	index := map[string]*Entry{}
	for _, e := range s.st.Entries {
		index[entryKey(e.Host, e.Port, e.Username, e.URL)] = e
	}
	var touched []EntryView
	for _, f := range findings {
		k := entryKey(f.Host, f.Port, f.Username, f.URL)
		e := index[k]
		if e == nil {
			e = &Entry{ID: randomHex(8), Project: project, Created: now, Unsorted: true}
			s.st.Entries = append(s.st.Entries, e)
			index[k] = e
		}
		mergeFinding(e, f)
		e.addCapture(source, "", now)
		e.ClipIDs = appendUnique(e.ClipIDs, clip.ID)
		e.Updated = now
		clip.EntryIDs = append(clip.EntryIDs, e.ID)
		touched = append(touched, view(e))
	}
	s.applyNameRules()
	s.st.Clips = append(s.st.Clips, clip)
	if source == "clipboard" || source == "paste" {
		s.captureToThread(text, clip.ID, from, now)
	}
	if len(s.st.Clips) > maxClips {
		s.st.Clips = s.st.Clips[len(s.st.Clips)-maxClips:]
	}
	s.changed()
	return clip, touched
}

func mergeFinding(e *Entry, f Finding) {
	if e.Host == "" {
		e.Host = f.Host
	}
	if e.Port == 0 {
		e.Port = f.Port
	}
	if e.URL == "" {
		e.URL = f.URL
	}
	if e.Username == "" {
		e.Username = f.Username
	}
	if e.Protocol == "" {
		e.Protocol = f.Protocol
	}
	if f.Password != "" && f.Password != e.Password {
		switch {
		case e.Status == "ok" && e.Password != "":
			// Keep the password that connected; the new one is kept as an alternative.
			if !slices.Contains(e.PrevPasswords, f.Password) {
				e.PrevPasswords = append(e.PrevPasswords, f.Password)
			}
		default:
			if e.Password != "" && !slices.Contains(e.PrevPasswords, e.Password) {
				e.PrevPasswords = append(e.PrevPasswords, e.Password)
			}
			e.Password = f.Password
			if e.Status == "fail" {
				e.Status, e.StatusMsg = "", "" // new details: not tried yet
			}
		}
	}
	for k, v := range f.Extra {
		if e.Extra == nil {
			e.Extra = map[string]string{}
		}
		switch k {
		case "key_file": // from "ssh -i"
			if e.KeyFile == "" {
				e.KeyFile = v
			}
			continue
		case "tunnels": // keep forwards already saved, add new ones
			v = mergeTunnelSpecs(e.Extra[k], v)
		}
		e.Extra[k] = v
	}
	if e.Env == "" {
		e.Env = inferEnv(e.Host + " " + e.URL)
	}
	if e.Name == "" {
		e.Name = defaultName(e)
	}
}

// FindEntry returns the id of the entry a finding would merge into: same
// host/port/user/url, or failing that the same host and user.
func (s *Store) FindEntry(f Finding) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	k := entryKey(f.Host, f.Port, f.Username, f.URL)
	for _, e := range s.st.Entries {
		if entryKey(e.Host, e.Port, e.Username, e.URL) == k {
			return e.ID
		}
	}
	for _, e := range s.st.Entries {
		if f.Host != "" && strings.EqualFold(e.Host, f.Host) && (f.Username == "" || strings.EqualFold(e.Username, f.Username)) {
			return e.ID
		}
	}
	return ""
}

// IsKnownValue reports whether text is exactly a stored value, i.e. the user
// just copied something out of WorkHub itself.
func (s *Store) IsKnownValue(text string) bool {
	t := strings.TrimSpace(text)
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, e := range s.st.Entries {
		if t == e.Password || t == e.Username || t == e.Host || t == e.URL {
			return true
		}
	}
	return false
}

// Clips returns the newest clips first.
func (s *Store) Clips(limit int) []Clip {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Clip{}
	for i := len(s.st.Clips) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, *s.st.Clips[i])
	}
	return out
}

func (s *Store) DeleteClip(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.st.Clips {
		if c.ID == id {
			s.st.Clips = append(s.st.Clips[:i], s.st.Clips[i+1:]...)
			s.changed()
			return
		}
	}
}

// ---- notes, recent files, settings ----

func (s *Store) Notes() []Note {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Note, 0, len(s.st.Notes))
	for _, n := range s.st.Notes {
		out = append(out, *n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	return out
}

func (s *Store) SaveNote(n Note) Note {
	s.mu.Lock()
	defer s.mu.Unlock()
	n.Updated = time.Now()
	if n.ID != "" {
		for _, x := range s.st.Notes {
			if x.ID == n.ID {
				*x = n
				s.changed()
				return n
			}
		}
	}
	if n.ID == "" {
		n.ID = randomHex(8)
	}
	s.st.Notes = append(s.st.Notes, &n)
	s.changed()
	return n
}

func (s *Store) DeleteNote(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, n := range s.st.Notes {
		if n.ID == id {
			s.st.Notes = append(s.st.Notes[:i], s.st.Notes[i+1:]...)
			s.changed()
			return
		}
	}
}

func (s *Store) AddRecent(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := []RecentFile{{Path: path, Opened: time.Now()}}
	for _, r := range s.st.Recent {
		if !strings.EqualFold(r.Path, path) {
			list = append(list, r)
		}
	}
	if len(list) > maxRecent {
		list = list[:maxRecent]
	}
	s.st.Recent = list
	s.changed()
}

func (s *Store) Recent() []RecentFile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]RecentFile{}, s.st.Recent...)
}

func (s *Store) Settings() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st.Settings
}

func (s *Store) SetSettings(st Settings) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.st.Entries {
		if e.URL != "" && !e.Hidden && blockedURL(e.URL, st.BlockedSites) {
			e.Hidden = true
		}
	}
	if st.Project == "" {
		st.Project = "General"
	}
	s.st.Settings = st
	s.applyNameRules()
	s.changed()
}

// ruleLabel: the label of the first naming rule whose text is in the
// entry's host name (or its URL's host), ignoring case.
func ruleLabel(rules []NameRule, e *Entry) string {
	hosts := strings.ToLower(e.Host)
	if u, err := url.Parse(e.URL); err == nil && u.Hostname() != "" {
		hosts += " " + strings.ToLower(u.Hostname())
	}
	for _, r := range rules {
		if m := strings.ToLower(strings.TrimSpace(r.Match)); m != "" && strings.TrimSpace(r.Label) != "" && strings.Contains(hosts, m) {
			return strings.TrimSpace(r.Label)
		}
	}
	return ""
}

// applyNameRules renames entries that still have an automatic name (the
// host, or "<label> – <host>" from an earlier rule); names typed by the user
// are left alone. Caller holds s.mu.
func (s *Store) applyNameRules() {
	for _, e := range s.st.Entries {
		base := defaultName(e)
		old := legacyName(e) // automatic names from before host-user naming
		auto := e.Name == "" || e.Name == base || e.Name == e.Host || strings.HasSuffix(e.Name, " – "+base) || e.Name == old || strings.HasSuffix(e.Name, " – "+old)
		if !auto {
			continue
		}
		name := base
		if l := ruleLabel(s.st.Settings.NameRules, e); l != "" {
			name = l + " – " + base
		}
		if e.Name != name {
			e.Name = name
			e.Updated = time.Now()
		}
	}
}

// ---- helpers ----

var envRe = regexp.MustCompile(`(?i)(?:^|[^a-z])(prod|prd|production|live|uat|qa|sit|tst|test|stg|stage|staging|preprod|dev|develop|sbx|sandbox|dr)(?:[^a-z]|$)`)

func inferEnv(s string) string {
	m := envRe.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	switch strings.ToLower(m[1]) {
	case "prod", "prd", "production", "live":
		return "PROD"
	case "uat":
		return "UAT"
	case "qa", "sit", "tst", "test":
		return "TEST"
	case "stg", "stage", "staging", "preprod":
		return "STAGE"
	case "dr":
		return "DR"
	default:
		return "DEV"
	}
}

// defaultName: logins are named host-user (several users on one server stay
// apart), databases host-user / service.
func defaultName(e *Entry) string {
	host := e.Host
	if host != "" && e.Username != "" {
		host += "-" + e.Username
	}
	if db := orDefault(e.Extra["service"], orDefault(e.Extra["sid"], e.Extra["database"])); db != "" && e.Host != "" && dbKind(*e) != "" {
		return host + " / " + db
	}
	if job := jenkinsJob(e.URL); job != "" {
		return "Jenkins – " + job
	}
	switch {
	case e.Host != "":
		return host
	case e.URL != "":
		return e.URL
	case e.Username != "":
		return "Credential: " + e.Username
	}
	return "Untitled"
}

// legacyName is the automatic name older versions gave (host, host / db).
func legacyName(e *Entry) string {
	u := e.Username
	e.Username = ""
	n := defaultName(e)
	e.Username = u
	return n
}

// jenkinsJob reads the job from a Jenkins link:
// /job/Folder/job/pay-api-deploy/123/console → "Folder › pay-api-deploy #123".
func jenkinsJob(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	var segs []string
	for _, p := range strings.Split(u.EscapedPath(), "/") { // %2F stays inside a segment
		if p != "" {
			if d, err := url.PathUnescape(p); err == nil {
				p = d
			}
			segs = append(segs, p)
		}
	}
	var jobs []string
	build := ""
	for i := 0; i < len(segs); i++ {
		if segs[i] == "job" && i+1 < len(segs) {
			i++
			jobs = append(jobs, segs[i])
			if i+1 < len(segs) && isDigits(segs[i+1]) {
				build = segs[i+1]
			}
		}
	}
	if len(jobs) == 0 && len(segs) > 3 && segs[0] == "blue" && segs[1] == "organizations" {
		jobs = strings.Split(segs[3], "/")
		if len(segs) > 6 && segs[4] == "detail" && isDigits(segs[6]) {
			build = segs[6]
		}
	}
	if len(jobs) == 0 {
		return ""
	}
	out := strings.Join(jobs, " › ")
	if build != "" {
		out += " #" + build
	}
	return out
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func appendUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

// ---- importing data folders from older versions ----

// readDataFolder decrypts another WorkHub data folder (same Windows user).
func readDataFolder(dir string) (State, error) {
	var st State
	raw, err := os.ReadFile(filepath.Join(dir, "key.bin"))
	if err != nil {
		return st, err
	}
	key, err := unprotectKey(raw)
	if err != nil {
		return st, fmt.Errorf("key.bin belongs to another Windows user or PC: %w", err)
	}
	blob, err := os.ReadFile(filepath.Join(dir, "workhub.dat"))
	if err != nil {
		return st, err
	}
	plain, err := decryptWith(key, blob)
	if err != nil {
		return st, err
	}
	return st, json.Unmarshal(plain, &st)
}

// Merge adds another state's data; for items present in both, the most
// recently updated copy wins. It returns how many entries and notes were added.
func (s *Store) Merge(o State) (entries, notes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	byID, byKey := map[string]*Entry{}, map[string]*Entry{}
	for _, e := range s.st.Entries {
		byID[e.ID] = e
		byKey[entryKey(e.Host, e.Port, e.Username, e.URL)] = e
	}
	for _, e := range o.Entries {
		cur := byID[e.ID]
		if cur == nil {
			cur = byKey[entryKey(e.Host, e.Port, e.Username, e.URL)]
		}
		switch {
		case cur == nil:
			s.st.Entries = append(s.st.Entries, e)
			byID[e.ID] = e
			entries++
		case e.Updated.After(cur.Updated):
			id := cur.ID
			*cur = *e
			cur.ID = id
		}
	}
	notesByID := map[string]*Note{}
	for _, n := range s.st.Notes {
		notesByID[n.ID] = n
	}
	for _, n := range o.Notes {
		if cur := notesByID[n.ID]; cur == nil {
			s.st.Notes = append(s.st.Notes, n)
			notes++
		} else if n.Updated.After(cur.Updated) {
			*cur = *n
		}
	}
	clipIDs := map[string]bool{}
	for _, c := range s.st.Clips {
		clipIDs[c.ID] = true
	}
	for _, c := range o.Clips {
		if !clipIDs[c.ID] {
			s.st.Clips = append(s.st.Clips, c)
		}
	}
	sort.Slice(s.st.Clips, func(i, j int) bool { return s.st.Clips[i].Created.Before(s.st.Clips[j].Created) })
	if len(s.st.Clips) > maxClips {
		s.st.Clips = s.st.Clips[len(s.st.Clips)-maxClips:]
	}
	for _, r := range o.Recent {
		found := false
		for _, x := range s.st.Recent {
			found = found || strings.EqualFold(x.Path, r.Path)
		}
		if !found && len(s.st.Recent) < maxRecent {
			s.st.Recent = append(s.st.Recent, r)
		}
	}
	if s.st.LocalDir == "" {
		s.st.LocalDir = o.LocalDir
	}
	s.changed()
	return entries, notes
}
