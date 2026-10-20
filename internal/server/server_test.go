package server

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"remote-desk/internal/activity"
	"remote-desk/internal/auth"
	"remote-desk/internal/awake"
	"remote-desk/internal/config"
	"remote-desk/internal/tailnet"
)

type fakeNet struct{ url string }

func (n fakeNet) Status(context.Context) tailnet.Status {
	return tailnet.Status{State: "Running", HTTPS: true, MagicDNS: true, Serving: true, DNSName: "rd-test.example.ts.net"}
}
func (n fakeNet) SiteURL(context.Context) string { return n.url }

type identFunc func(r string) auth.Peer

func (f identFunc) WhoIs(_ context.Context, addr string) (auth.Peer, error) { return f(addr), nil }

const phoneNode = "node-phone"

func newApp(t *testing.T) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	share := filepath.Join(dir, "share")
	for name, body := range map[string]string{
		"photo.jpg":       "0123456789",
		"page.html":       "<script>alert(1)</script>",
		".env":            "TOKEN=x",
		"Docs/notes.txt":  "hello notes",
		"Docs/résumé.pdf": "%PDF-1.4",
	} {
		p := filepath.Join(share, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cfgDir := filepath.Join(dir, "config")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Hostname: "rd-test", Roots: []config.Root{{Name: "Share", Path: share}}, AdminPort: 1, AdminKey: "admin-key-123"}
	am, err := auth.New(cfgDir)
	if err != nil {
		t.Fatal(err)
	}
	a := NewApp(cfg)
	a.Auth = am
	a.Log = activity.Open(cfgDir)
	a.Awake = &awake.Keeper{}
	a.ConfigDir = cfgDir
	a.Laptop = "Test Laptop"
	a.Net = fakeNet{url: "https://rd-test.example.ts.net/"}
	a.Init()
	return a, share
}

// phoneServer serves the phone handler; the device is chosen per client by
// the X-Test-Node header (the real app uses Tailscale WhoIs).
func phoneServer(t *testing.T, a *App) *httptest.Server {
	t.Helper()
	var current string
	a.Ident = identFunc(func(string) auth.Peer {
		return auth.Peer{NodeID: current, Name: current, OS: "iOS", SameUser: current != "stranger"}
	})
	h := a.PhoneHandler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current = r.Header.Get("X-Test-Node")
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

type client struct {
	t    *testing.T
	base string
	node string
	hc   *http.Client
}

func newClient(t *testing.T, srv *httptest.Server, node string) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: srv.URL, node: node, hc: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (c *client) do(method, path string, body any, hdr ...string) (*http.Response, map[string]any) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	req.Header.Set("X-Test-Node", c.node)
	if method == http.MethodPost {
		req.Header.Set("Origin", c.base)
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		if hdr[i] == "Host" {
			req.Host = hdr[i+1] // Go ignores a Host header; it sends req.Host
		} else if hdr[i+1] == "" {
			req.Header.Del(hdr[i])
		} else {
			req.Header.Set(hdr[i], hdr[i+1])
		}
	}
	res, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	res.Body = io.NopCloser(strings.NewReader(string(raw)))
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return res, m
}

func body(res *http.Response) string {
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

// pairAndLogin runs the whole phone flow and returns the logged-in client.
func pairAndLogin(t *testing.T, a *App, srv *httptest.Server) (*client, *ecdsa.PrivateKey) {
	t.Helper()
	c := newClient(t, srv, phoneNode)
	code, _, err := a.Auth.StartPairing()
	if err != nil {
		t.Fatal(err)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	spki, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	res, m := c.do("POST", "/api/pair", map[string]string{"code": code, "label": "iPhone", "pin": "246810", "publicKey": base64.StdEncoding.EncodeToString(spki)})
	if res.StatusCode != 200 {
		t.Fatalf("pair: %d %v", res.StatusCode, m)
	}
	if _, err := a.Auth.Approve(m["id"].(string)); err != nil {
		t.Fatal(err)
	}
	login(t, c, key, "246810", 200)
	return c, key
}

func login(t *testing.T, c *client, key *ecdsa.PrivateKey, pin string, want int) map[string]any {
	t.Helper()
	res, m := c.do("POST", "/api/challenge", nil)
	if res.StatusCode != 200 {
		if want == res.StatusCode {
			return m
		}
		t.Fatalf("challenge: %d %v", res.StatusCode, m)
	}
	nonce := m["nonce"].(string)
	h := sha256.Sum256([]byte(auth.LoginPrefix + nonce))
	r, s, _ := ecdsa.Sign(rand.Reader, key, h[:])
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	res, m = c.do("POST", "/api/login", map[string]string{"nonce": nonce, "signature": base64.StdEncoding.EncodeToString(sig), "pin": pin})
	if res.StatusCode != want {
		t.Fatalf("login: %d %v, want %d", res.StatusCode, m, want)
	}
	return m
}

func TestPhoneFlow(t *testing.T) {
	a, _ := newApp(t)
	srv := phoneServer(t, a)

	// Before pairing nothing but hello/pair works.
	anon := newClient(t, srv, phoneNode)
	if res, _ := anon.do("GET", "/api/list?root=0&path=", nil); res.StatusCode != 401 {
		t.Errorf("list before login = %d", res.StatusCode)
	}
	if res, m := anon.do("GET", "/api/hello", nil); res.StatusCode != 200 || m["paired"] != false {
		t.Errorf("hello = %d %v", res.StatusCode, m)
	}

	c, key := pairAndLogin(t, a, srv)

	res, m := c.do("GET", "/api/list?root=0&path=", nil)
	if res.StatusCode != 200 {
		t.Fatalf("list = %d %v", res.StatusCode, m)
	}
	var names []string
	for _, e := range m["entries"].([]any) {
		names = append(names, e.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "Docs,page.html,photo.jpg" {
		t.Errorf("entries = %v", names)
	}

	// Safe types show inline; everything else downloads as a plain file.
	res, _ = c.do("GET", "/api/file?root=0&path=photo.jpg", nil)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/jpeg" || !strings.HasPrefix(res.Header.Get("Content-Disposition"), "inline") {
		t.Errorf("photo: %d %q %q", res.StatusCode, res.Header.Get("Content-Type"), res.Header.Get("Content-Disposition"))
	}
	if res.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("photo headers: %v", res.Header)
	}
	res, _ = c.do("GET", "/api/file?root=0&path=page.html", nil)
	if res.Header.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment") {
		t.Errorf("html must download, got %q %q", res.Header.Get("Content-Type"), res.Header.Get("Content-Disposition"))
	}
	res, _ = c.do("GET", "/api/file?root=0&path=Docs/r%C3%A9sum%C3%A9.pdf", nil)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/pdf" || !strings.Contains(res.Header.Get("Content-Disposition"), "filename*=UTF-8''r%C3%A9sum%C3%A9.pdf") {
		t.Errorf("pdf: %d %q %q", res.StatusCode, res.Header.Get("Content-Type"), res.Header.Get("Content-Disposition"))
	}
	res, _ = c.do("GET", "/api/file?root=0&path=photo.jpg&dl=1", nil)
	if res.Header.Get("Content-Type") != "application/octet-stream" {
		t.Errorf("dl=1 should force a download")
	}
	// Range requests (video seeking).
	res, _ = c.do("GET", "/api/file?root=0&path=photo.jpg", nil, "Range", "bytes=2-4")
	if res.StatusCode != 206 || body(res) != "234" {
		t.Errorf("range: %d", res.StatusCode)
	}
	// Hidden and outside paths.
	for _, p := range []string{".env", "../config/pairing.json", "Docs/../../config/pairing.json"} {
		if res, _ := c.do("GET", "/api/file?root=0&path="+p, nil); res.StatusCode != 403 && res.StatusCode != 400 {
			t.Errorf("%s = %d", p, res.StatusCode)
		}
	}
	res, m = c.do("GET", "/api/search?q=notes", nil)
	if res.StatusCode != 200 || len(m["results"].([]any)) != 1 {
		t.Errorf("search = %d %v", res.StatusCode, m)
	}

	// Wrong PIN, then lock after the limit.
	m = login(t, c, key, "000000", 401)
	if m["triesLeft"].(float64) != auth.MaxFailures-1 {
		t.Errorf("triesLeft = %v", m["triesLeft"])
	}

	// Logout ends the session.
	c.do("POST", "/api/logout", nil)
	if res, _ := c.do("GET", "/api/session", nil); res.StatusCode != 401 {
		t.Errorf("session after logout = %d", res.StatusCode)
	}
}

func TestOtherDevicesAndStolenCookies(t *testing.T) {
	a, _ := newApp(t)
	srv := phoneServer(t, a)
	c, _ := pairAndLogin(t, a, srv)

	// Same cookie jar, but the request comes from another Tailscale device.
	c.node = "node-ipad"
	if res, _ := c.do("GET", "/api/list?root=0&path=", nil); res.StatusCode != 401 {
		t.Errorf("stolen cookie from another device = %d", res.StatusCode)
	}
	if res, _ := c.do("POST", "/api/challenge", nil); res.StatusCode != 403 {
		t.Errorf("challenge from another device = %d", res.StatusCode)
	}
	if _, m := c.do("GET", "/api/hello", nil); m["paired"] != true || m["thisDevice"] != false {
		t.Errorf("hello from another device = %v", m)
	}
	// A second device can't pair while one is paired.
	_, spki := func() (*ecdsa.PrivateKey, []byte) {
		k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		b, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
		return k, b
	}()
	if res, _ := c.do("POST", "/api/pair", map[string]string{"code": "ABCDEFGH", "label": "x", "pin": "123456", "publicKey": base64.StdEncoding.EncodeToString(spki)}); res.StatusCode != 403 {
		t.Errorf("second pairing = %d", res.StatusCode)
	}
}

func TestCrossSitePostRefused(t *testing.T) {
	a, _ := newApp(t)
	srv := phoneServer(t, a)
	c := newClient(t, srv, phoneNode)
	for _, origin := range []string{"", "https://evil.example", "null"} {
		if res, _ := c.do("POST", "/api/challenge", nil, "Origin", origin); res.StatusCode != 403 {
			t.Errorf("Origin %q = %d", origin, res.StatusCode)
		}
	}
}

func TestPhonePageHeaders(t *testing.T) {
	a, _ := newApp(t)
	srv := phoneServer(t, a)
	c := newClient(t, srv, phoneNode)
	res, _ := c.do("GET", "/", nil)
	if res.StatusCode != 200 || !strings.Contains(body(res), "app.js") {
		t.Fatalf("index = %d", res.StatusCode)
	}
	csp := res.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self'") || res.Header.Get("X-Frame-Options") != "DENY" {
		t.Errorf("index headers: %v", res.Header)
	}
	for _, p := range []string{"/icon-180.png", "/icon-192.png", "/icon-512.png"} {
		if res, _ := c.do("GET", p, nil); res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/png" {
			t.Errorf("%s = %d", p, res.StatusCode)
		}
	}
	checkShared(t, c)
}

// checkShared: both sites serve the design tokens, themes, icons and favicon.
func checkShared(t *testing.T, c *client) {
	t.Helper()
	for p, ctype := range map[string]string{
		"/tokens.css": "text/css", "/theme.js": "text/javascript", "/icons.js": "text/javascript", "/favicon.svg": "image/svg+xml",
	} {
		res, _ := c.do("GET", p, nil)
		if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), ctype) {
			t.Errorf("%s = %d %q", p, res.StatusCode, res.Header.Get("Content-Type"))
		}
	}
}

func TestIconPNG(t *testing.T) {
	for _, size := range []int{16, 32, 64, 128, 256, 512, 1024} {
		img, err := png.Decode(bytes.NewReader(IconPNG(size)))
		if err != nil {
			t.Fatalf("%d: %v", size, err)
		}
		if b := img.Bounds(); b.Dx() != size || b.Dy() != size {
			t.Errorf("%d: got %v", size, b)
		}
	}
}

func adminServer(t *testing.T, a *App) (*httptest.Server, int) {
	t.Helper()
	srv := httptest.NewUnstartedServer(nil)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	srv.Config.Handler = a.AdminHandler(port)
	srv.Start()
	t.Cleanup(srv.Close)
	return srv, port
}

func TestAdminAccess(t *testing.T) {
	a, _ := newApp(t)
	srv, port := adminServer(t, a)
	c := newClient(t, srv, "")

	if res, _ := c.do("GET", "/api/status", nil); res.StatusCode != 403 {
		t.Errorf("status without key = %d", res.StatusCode)
	}
	if res, _ := c.do("GET", "/?k=wrong", nil); res.StatusCode != 403 {
		t.Errorf("wrong key = %d", res.StatusCode)
	}
	if res, _ := c.do("GET", "/?k=admin-key-123", nil); res.StatusCode != 303 {
		t.Fatalf("right key = %d", res.StatusCode)
	}
	res, m := c.do("GET", "/api/status", nil)
	if res.StatusCode != 200 || m["laptop"] != "Test Laptop" || m["siteQR"] == nil {
		t.Fatalf("status = %d %v", res.StatusCode, m)
	}
	// DNS rebinding: another host name pointing at 127.0.0.1.
	if res, _ := c.do("GET", "/api/status", nil, "Host", "evil.example:"+strconv.Itoa(port)); res.StatusCode != http.StatusMisdirectedRequest {
		t.Errorf("foreign Host = %d", res.StatusCode)
	}
	// POSTs need our own Origin.
	if res, _ := c.do("POST", "/api/pair/start", nil, "Origin", "https://evil.example"); res.StatusCode != 403 {
		t.Errorf("foreign Origin = %d", res.StatusCode)
	}
	if res, m := c.do("POST", "/api/pair/start", nil); res.StatusCode != 200 || len(m["code"].(string)) != 9 {
		t.Errorf("pair/start = %d %v", res.StatusCode, m)
	}
	// Shared folders must be real folders.
	if res, _ := c.do("POST", "/api/roots", map[string]any{"roots": []map[string]string{{"name": "x", "path": "relative/path"}}}); res.StatusCode != 400 {
		t.Errorf("relative root = %d", res.StatusCode)
	}
	if res, _ := c.do("POST", "/api/roots", map[string]any{"roots": []map[string]string{{"name": "", "path": a.ConfigDir}}}); res.StatusCode != 200 {
		t.Errorf("valid root = %d", res.StatusCode)
	}
	if got := a.config().Roots; len(got) != 1 || got[0].Name != filepath.Base(a.ConfigDir) {
		t.Errorf("roots = %+v", got)
	}
	// Sharing the agent's own folder still never serves its data.
	if _, err := a.files().List(0, ""); err == nil {
		t.Error("the agent's own data must never be served")
	}
}

func TestDesktopHandler(t *testing.T) {
	a, _ := newApp(t)
	quit := make(chan struct{})
	a.Desktop = true
	a.Quit = func() { close(quit) }
	srv := httptest.NewServer(a.DesktopHandler())
	t.Cleanup(srv.Close)
	c := newClient(t, srv, "")

	// The window needs no admin key: only the app itself can reach this handler.
	res, m := c.do("GET", "/api/status", nil)
	if res.StatusCode != 200 || m["desktop"] != true || m["canQuit"] != true {
		t.Fatalf("status = %d %v", res.StatusCode, m)
	}
	if res.Header.Get("Content-Security-Policy") != adminCSP {
		t.Errorf("CSP = %q", res.Header.Get("Content-Security-Policy"))
	}
	if res, _ := c.do("GET", "/", nil); res.StatusCode != 200 || !strings.Contains(body(res), "admin.js") {
		t.Errorf("index = %d", res.StatusCode)
	}
	checkShared(t, c)
	if res, _ := c.do("POST", "/api/quit", nil); res.StatusCode != 200 {
		t.Fatalf("quit = %d", res.StatusCode)
	}
	select {
	case <-quit:
	case <-time.After(2 * time.Second):
		t.Error("Quit wasn't called")
	}
}

func TestProtectedFolderNeedsPIN(t *testing.T) {
	a, share := newApp(t)
	vault := t.TempDir()
	if err := os.WriteFile(filepath.Join(vault, "notes-vault.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := a.updateConfig(func(c *config.Config) {
		c.Roots = []config.Root{{Name: "Share", Path: share}, {Name: "Vault", Path: vault, Protected: true}}
	}); err != nil {
		t.Fatal(err)
	}
	srv := phoneServer(t, a)
	c, key := pairAndLogin(t, a, srv)

	res, m := c.do("GET", "/api/list?root=1&path=", nil)
	if res.StatusCode != 403 || m["needPIN"] != true {
		t.Fatalf("closed protected root = %d %v", res.StatusCode, m)
	}
	if res, _ := c.do("GET", "/api/file?root=1&path=notes-vault.txt", nil); res.StatusCode != 403 {
		t.Errorf("file in closed protected root = %d", res.StatusCode)
	}
	// Search leaves it out until it's open.
	_, m = c.do("GET", "/api/search?q=notes", nil)
	for _, r := range m["results"].([]any) {
		if r.(map[string]any)["root"].(float64) == 1 {
			t.Errorf("closed protected root in search: %v", r)
		}
	}

	openProtected := func(pin string, want int) {
		t.Helper()
		_, m := c.do("POST", "/api/challenge", nil)
		nonce := m["nonce"].(string)
		h := sha256.Sum256([]byte(auth.LoginPrefix + nonce))
		r, s, _ := ecdsa.Sign(rand.Reader, key, h[:])
		sig := make([]byte, 64)
		r.FillBytes(sig[:32])
		s.FillBytes(sig[32:])
		res, body := c.do("POST", "/api/protected/open", map[string]string{"nonce": nonce, "signature": base64.StdEncoding.EncodeToString(sig), "pin": pin})
		if res.StatusCode != want {
			t.Fatalf("open protected: %d %v, want %d", res.StatusCode, body, want)
		}
	}
	openProtected("000000", 401)
	openProtected("246810", 200)
	if res, _ := c.do("GET", "/api/list?root=1&path=", nil); res.StatusCode != 200 {
		t.Errorf("open protected root = %d", res.StatusCode)
	}
	_, m = c.do("GET", "/api/search?q=notes", nil)
	found := false
	for _, r := range m["results"].([]any) {
		found = found || r.(map[string]any)["root"].(float64) == 1
	}
	if !found {
		t.Error("open protected root should be searchable")
	}
	c.do("POST", "/api/protected/close", nil)
	if res, _ := c.do("GET", "/api/list?root=1&path=", nil); res.StatusCode != 403 {
		t.Errorf("after close = %d", res.StatusCode)
	}
	// A plain root never needs it.
	if res, _ := c.do("GET", "/api/list?root=0&path=", nil); res.StatusCode != 200 {
		t.Errorf("plain root = %d", res.StatusCode)
	}
}
