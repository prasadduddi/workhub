package main

// Microsoft Teams, the full connection (⚙ Settings → Teams): through Microsoft
// Graph, with an app your IT registers in Entra ID (a public client with
// delegated Chat.ReadWrite, User.Read, User.ReadBasic.All, offline_access).
// Sign-in is Microsoft's device code flow — you see a code, open the Microsoft
// page and sign in there; WorkHub never sees your password. The refresh token
// stays here (never sent to the page). With it: forward a thread message to a
// person or group chat (pictures included) and bring chat messages into a
// thread (pictures too). Without it, the page uses Teams links and the clipboard.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type TeamsConfig struct {
	Tenant   string `json:"tenant,omitempty"`
	ClientID string `json:"client_id,omitempty"`
	Refresh  string `json:"refresh,omitempty"` // never sent to the page
	User     string `json:"user,omitempty"`    // who signed in (display name / mail)
	UserID   string `json:"user_id,omitempty"`
}

var (
	teamsLogin = "https://login.microsoftonline.com"
	teamsGraph = "https://graph.microsoft.com/v1.0"
	teamsHTTP  = &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
)

const teamsScope = "Chat.ReadWrite User.Read User.ReadBasic.All offline_access"

func (s *Store) TeamsConfig() TeamsConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st.Teams
}

func (s *Store) setTeams(f func(*TeamsConfig)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(&s.st.Teams)
	s.changed()
}

// teamsAuth: the access token (kept until it nearly expires) and the device-code sign-in in progress.
type teamsAuth struct {
	mu       sync.Mutex
	access   string
	until    time.Time
	pending  string // "", "waiting", "done" or an error
	userCode string
	verify   string
}

var teamsState = &teamsAuth{}

func teamsPost(endpoint string, form url.Values, out any) error {
	resp, err := teamsHTTP.PostForm(endpoint, form)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("Microsoft answered %s", resp.Status)
	}
	return nil
}

type tokenReply struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	Expires int    `json:"expires_in"`
	Error   string `json:"error"`
	Desc    string `json:"error_description"`
}

// token: a fresh access token from the saved refresh token.
func (a *App) teamsToken() (string, error) {
	teamsState.mu.Lock()
	if teamsState.access != "" && time.Now().Before(teamsState.until) {
		t := teamsState.access
		teamsState.mu.Unlock()
		return t, nil
	}
	teamsState.mu.Unlock()
	c := a.store.TeamsConfig()
	if c.Refresh == "" {
		return "", errors.New("not signed in to Teams — ⚙ Settings → Teams")
	}
	var t tokenReply
	if err := teamsPost(teamsLogin+"/"+url.PathEscape(c.Tenant)+"/oauth2/v2.0/token", url.Values{
		"client_id": {c.ClientID}, "grant_type": {"refresh_token"}, "refresh_token": {c.Refresh}, "scope": {teamsScope},
	}, &t); err != nil {
		return "", err
	}
	if t.Access == "" {
		return "", fmt.Errorf("Teams sign-in has expired — sign in again (%s)", orDefault(t.Desc, t.Error))
	}
	if t.Refresh != "" && t.Refresh != c.Refresh {
		a.store.setTeams(func(x *TeamsConfig) { x.Refresh = t.Refresh })
	}
	teamsState.mu.Lock()
	teamsState.access, teamsState.until = t.Access, time.Now().Add(time.Duration(max(t.Expires-120, 60))*time.Second)
	teamsState.mu.Unlock()
	return t.Access, nil
}

// graph calls Microsoft Graph; path starts with "/".
func (a *App) graph(method, path string, body, out any) error {
	tok, err := a.teamsToken()
	if err != nil {
		return err
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	u := path
	if !strings.HasPrefix(u, "http") {
		u = teamsGraph + path
	}
	req, _ := http.NewRequest(method, u, rd)
	req.Header.Set("Authorization", "Bearer "+tok)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := teamsHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		return fmt.Errorf("Teams: %s", orDefault(e.Error.Message, resp.Status))
	}
	if raw, ok := out.(*[]byte); ok {
		*raw = b
		return nil
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

// ---- sign in (device code) ----

func (a *App) handleTeamsStatus(w http.ResponseWriter, r *http.Request) {
	c := a.store.TeamsConfig()
	teamsState.mu.Lock()
	p, code, verify := teamsState.pending, teamsState.userCode, teamsState.verify
	teamsState.mu.Unlock()
	writeJSON(w, map[string]any{"tenant": c.Tenant, "client_id": c.ClientID, "configured": c.Tenant != "" && c.ClientID != "",
		"signed_in": c.Refresh != "", "user": c.User, "pending": p, "user_code": code, "verify": verify})
}

func (a *App) handleTeamsConfig(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Tenant   string `json:"tenant"`
		ClientID string `json:"client_id"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	a.store.setTeams(func(c *TeamsConfig) {
		if strings.TrimSpace(in.Tenant) != c.Tenant || strings.TrimSpace(in.ClientID) != c.ClientID {
			*c = TeamsConfig{Tenant: strings.TrimSpace(in.Tenant), ClientID: strings.TrimSpace(in.ClientID)} // another app: sign in again
		}
	})
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleTeamsSignIn(w http.ResponseWriter, r *http.Request) {
	c := a.store.TeamsConfig()
	if c.Tenant == "" || c.ClientID == "" {
		writeErr(w, 400, errors.New("enter the Tenant ID and Client ID from IT first"))
		return
	}
	var d struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
		Verify     string `json:"verification_uri"`
		Interval   int    `json:"interval"`
		Expires    int    `json:"expires_in"`
		Error      string `json:"error"`
		Desc       string `json:"error_description"`
	}
	if err := teamsPost(teamsLogin+"/"+url.PathEscape(c.Tenant)+"/oauth2/v2.0/devicecode", url.Values{"client_id": {c.ClientID}, "scope": {teamsScope}}, &d); err != nil {
		writeErr(w, 502, err)
		return
	}
	if d.DeviceCode == "" {
		writeErr(w, 400, fmt.Errorf("Microsoft refused: %s", orDefault(d.Desc, d.Error)))
		return
	}
	teamsState.mu.Lock()
	teamsState.pending, teamsState.userCode, teamsState.verify = "waiting", d.UserCode, d.Verify
	teamsState.mu.Unlock()
	go a.teamsWaitSignIn(c, d.DeviceCode, max(d.Interval, 1), max(d.Expires, 60))
	writeJSON(w, map[string]string{"user_code": d.UserCode, "verify": d.Verify})
}

func (a *App) teamsWaitSignIn(c TeamsConfig, device string, interval, expires int) {
	end := time.Now().Add(time.Duration(expires) * time.Second)
	set := func(p string) {
		teamsState.mu.Lock()
		teamsState.pending = p
		teamsState.mu.Unlock()
	}
	for time.Now().Before(end) {
		time.Sleep(time.Duration(interval) * time.Second)
		var t tokenReply
		if err := teamsPost(teamsLogin+"/"+url.PathEscape(c.Tenant)+"/oauth2/v2.0/token", url.Values{
			"client_id": {c.ClientID}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {device},
		}, &t); err != nil {
			continue
		}
		switch {
		case t.Refresh != "":
			a.store.setTeams(func(x *TeamsConfig) { x.Refresh = t.Refresh })
			teamsState.mu.Lock()
			teamsState.access, teamsState.until = t.Access, time.Now().Add(time.Duration(max(t.Expires-120, 60))*time.Second)
			teamsState.mu.Unlock()
			var me struct {
				ID, DisplayName, Mail, UserPrincipalName string
			}
			if a.graph("GET", "/me", nil, &me) == nil {
				a.store.setTeams(func(x *TeamsConfig) { x.User, x.UserID = orDefault(me.DisplayName, me.UserPrincipalName), me.ID })
			}
			set("done")
			return
		case t.Error == "authorization_pending", t.Error == "slow_down":
			continue
		default:
			set("error: " + orDefault(t.Desc, t.Error))
			return
		}
	}
	set("error: the code expired — press Sign in again")
}

func (a *App) handleTeamsSignOut(w http.ResponseWriter, r *http.Request) {
	a.store.setTeams(func(c *TeamsConfig) { c.Refresh, c.User, c.UserID = "", "", "" })
	teamsState.mu.Lock()
	teamsState.access, teamsState.pending = "", ""
	teamsState.mu.Unlock()
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- send a thread message ----

var reLocalImg = regexp.MustCompile(`<img[^>]*src="(?:https?://[^/"]+)?/api/props/files/([0-9a-f]+)[^"]*"[^>]*>`)

// teamsBody: a thread message as Teams HTML, its pictures as hosted contents.
func (a *App) teamsBody(p Post) (string, []map[string]string) {
	body := p.HTML
	if body == "" {
		body = "<pre>" + html.EscapeString(p.Text) + "</pre>"
	}
	var hosted []map[string]string
	body = reLocalImg.ReplaceAllStringFunc(body, func(tag string) string {
		id := reLocalImg.FindStringSubmatch(tag)[1]
		at, data, err := a.store.ReadAttachment(id)
		if err != nil || !at.Image {
			return ""
		}
		n := fmt.Sprint(len(hosted) + 1)
		hosted = append(hosted, map[string]string{"@microsoft.graph.temporaryId": n, "contentBytes": base64.StdEncoding.EncodeToString(data), "contentType": orDefault(at.Mime, "image/png")})
		return fmt.Sprintf(`<img src="../hostedContents/%s/$value" alt="%s">`, n, html.EscapeString(at.Name))
	})
	return body, hosted
}

func (a *App) handleTeamsSend(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Thread string   `json:"thread"`
		Post   string   `json:"post"`
		To     []string `json:"to"`
	}
	if err := readJSON(r, &in); err != nil || len(in.To) == 0 {
		writeErr(w, 400, errors.New("who should get it?"))
		return
	}
	wi, ok := a.store.GetWorkItem(in.Thread)
	var post *Post
	for _, p := range wi.Posts {
		if p.ID == in.Post {
			post = p
		}
	}
	if !ok || post == nil {
		writeErr(w, 404, errors.New("message not found"))
		return
	}
	c := a.store.TeamsConfig()
	me := orDefault(c.UserID, "me")
	member := func(who string) map[string]any {
		return map[string]any{"@odata.type": "#microsoft.graph.aadUserConversationMember", "roles": []string{"owner"},
			"user@odata.bind": teamsGraph + "/users('" + strings.ReplaceAll(strings.TrimSpace(who), "'", "''") + "')"}
	}
	members := []any{member(me)}
	for _, t := range in.To {
		members = append(members, member(t))
	}
	kind := "oneOnOne"
	if len(in.To) > 1 {
		kind = "group"
	}
	var chat struct{ ID string }
	if err := a.graph("POST", "/chats", map[string]any{"chatType": kind, "members": members}, &chat); err != nil {
		writeErr(w, 502, err)
		return
	}
	body, hosted := a.teamsBody(*post)
	msg := map[string]any{"body": map[string]string{"contentType": "html", "content": body}}
	if len(hosted) > 0 {
		msg["hostedContents"] = hosted
	}
	if err := a.graph("POST", "/chats/"+url.PathEscape(chat.ID)+"/messages", msg, nil); err != nil {
		writeErr(w, 502, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "chat": chat.ID, "pictures": len(hosted)})
}

// ---- bring chat messages in ----

type teamsMsg struct {
	ID      string    `json:"id"`
	From    string    `json:"from"`
	At      time.Time `json:"at"`
	HTML    string    `json:"html"`
	Preview string    `json:"preview"`
}

func (a *App) handleTeamsChats(w http.ResponseWriter, r *http.Request) {
	var res struct {
		Value []struct {
			ID      string `json:"id"`
			Topic   string `json:"topic"`
			Kind    string `json:"chatType"`
			Members []struct {
				DisplayName string `json:"displayName"`
				UserID      string `json:"userId"`
			} `json:"members"`
			Updated time.Time `json:"lastUpdatedDateTime"`
		} `json:"value"`
	}
	if err := a.graph("GET", "/me/chats?$expand=members&$top=30", nil, &res); err != nil {
		writeErr(w, 502, err)
		return
	}
	me := a.store.TeamsConfig().UserID
	out := []map[string]any{}
	for _, c := range res.Value {
		name := c.Topic
		if name == "" {
			var who []string
			for _, m := range c.Members {
				if m.UserID != me && m.DisplayName != "" {
					who = append(who, m.DisplayName)
				}
			}
			name = strings.Join(who, ", ")
		}
		out = append(out, map[string]any{"id": c.ID, "name": orDefault(name, "Chat"), "kind": c.Kind, "updated": c.Updated})
	}
	writeJSON(w, out)
}

func (a *App) teamsMessages(chat string) ([]teamsMsg, error) {
	var res struct {
		Value []struct {
			ID   string    `json:"id"`
			Type string    `json:"messageType"`
			At   time.Time `json:"createdDateTime"`
			From *struct {
				User *struct {
					DisplayName string `json:"displayName"`
				} `json:"user"`
			} `json:"from"`
			Body struct {
				Type    string `json:"contentType"`
				Content string `json:"content"`
			} `json:"body"`
		} `json:"value"`
	}
	if err := a.graph("GET", "/chats/"+url.PathEscape(chat)+"/messages?$top=40", nil, &res); err != nil {
		return nil, err
	}
	out := []teamsMsg{}
	for _, m := range res.Value {
		if m.Type != "" && m.Type != "message" {
			continue // system messages (someone joined…)
		}
		h := m.Body.Content
		if m.Body.Type != "html" {
			h = "<p>" + strings.ReplaceAll(html.EscapeString(h), "\n", "<br>") + "</p>"
		}
		from := "Someone"
		if m.From != nil && m.From.User != nil {
			from = m.From.User.DisplayName
		}
		preview := strings.Join(strings.Fields(html.UnescapeString(tagRe.ReplaceAllString(h, " "))), " ")
		if len([]rune(preview)) > 160 {
			preview = string([]rune(preview)[:160]) + "…"
		}
		out = append(out, teamsMsg{ID: m.ID, From: from, At: m.At, HTML: h, Preview: preview})
	}
	return out, nil
}

func (a *App) handleTeamsMessages(w http.ResponseWriter, r *http.Request) {
	ms, err := a.teamsMessages(r.URL.Query().Get("chat"))
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	writeJSON(w, ms)
}

var reHostedImg = regexp.MustCompile(`<img[^>]*src="(https://graph\.microsoft\.com/[^"]+/hostedContents/[^"]+)"[^>]*>`)

func (a *App) handleTeamsImport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Thread string   `json:"thread"`
		Chat   string   `json:"chat"`
		Name   string   `json:"name"`
		IDs    []string `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil || len(in.IDs) == 0 {
		writeErr(w, 400, errors.New("pick the messages to add"))
		return
	}
	ms, err := a.teamsMessages(in.Chat)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	want := map[string]bool{}
	for _, id := range in.IDs {
		want[id] = true
	}
	added := 0
	for i := len(ms) - 1; i >= 0; i-- { // oldest first
		m := ms[i]
		if !want[m.ID] {
			continue
		}
		body := reHostedImg.ReplaceAllStringFunc(m.HTML, func(tag string) string { // pictures: kept in WorkHub's file store
			src := strings.ReplaceAll(reHostedImg.FindStringSubmatch(tag)[1], "&amp;", "&")
			var b []byte
			if a.graph("GET", strings.TrimPrefix(src, teamsGraph), nil, &b) != nil || len(b) == 0 {
				return "[picture]"
			}
			at, err := a.store.storeAttachment("teams-picture.png", b)
			if err != nil {
				return "[picture]"
			}
			_ = a.store.AddWorkFile(in.Thread, at)
			return fmt.Sprintf(`<img src="/api/props/files/%s" alt="picture from Teams">`, at.ID)
		})
		head := fmt.Sprintf("<p><b>%s</b> <i>%s · Teams%s</i></p>", html.EscapeString(m.From), m.At.Local().Format("Mon 2 Jan 15:04"), map[bool]string{true: " — " + html.EscapeString(in.Name), false: ""}[in.Name != ""])
		if _, err := a.store.AddPost(in.Thread, Post{Kind: "note", HTML: head + body, From: "Teams"}); err == nil {
			added++
		}
	}
	_, _ = a.store.writeWorkDocx(in.Thread)
	writeJSON(w, map[string]int{"added": added})
}
