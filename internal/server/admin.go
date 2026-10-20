package server

import (
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"remote-desk/internal/awake"
	"remote-desk/internal/config"
	"remote-desk/internal/files"
	"remote-desk/web"
)

const adminCookie = "rd_admin"

// adminMux is the admin page and its API, without any access checks.
func (a *App) adminMux() *http.ServeMux {
	mux := http.NewServeMux()
	static := web.Admin()
	mux.HandleFunc("GET /{$}", serveStatic(static, "index.html"))
	mux.HandleFunc("GET /admin.js", serveStatic(static, "admin.js"))
	mux.HandleFunc("GET /admin.css", serveStatic(static, "admin.css"))
	serveShared(mux)
	mux.HandleFunc("GET /icon-180.png", serveIcon(180))
	mux.HandleFunc("GET /api/status", a.adminStatus)
	mux.HandleFunc("POST /api/pair/start", a.adminPairStart)
	mux.HandleFunc("POST /api/pair/cancel", func(w http.ResponseWriter, r *http.Request) {
		a.Auth.CancelPairing()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/pair/approve", a.adminApprove)
	mux.HandleFunc("POST /api/pair/deny", a.adminDeny)
	mux.HandleFunc("POST /api/unpair", a.adminUnpair)
	mux.HandleFunc("POST /api/unlock", a.adminUnlock)
	mux.HandleFunc("POST /api/roots", a.adminRoots)
	mux.HandleFunc("POST /api/keepawake", a.adminKeepAwake)
	mux.HandleFunc("POST /api/quit", func(w http.ResponseWriter, r *http.Request) {
		if a.Quit == nil {
			writeErr(w, http.StatusNotFound, "quit isn't available")
			return
		}
		a.Log.Add("Remote Desk quit from the admin page", "")
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); a.Quit() }()
	})
	return mux
}

const adminCSP = "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; " +
	"connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func adminHeaders(h http.Header) {
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", adminCSP)
}

// DesktopHandler serves the admin page inside the desktop window. Wails
// answers the window's requests in-process (a custom URL scheme, no network
// listener), so nothing else can reach this handler and it needs no key.
func (a *App) DesktopHandler() http.Handler {
	mux := a.adminMux()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminHeaders(w.Header())
		mux.ServeHTTP(w, r)
	})
}

// AdminHandler serves the admin page in a browser on 127.0.0.1 (headless
// mode, or `remote-desk open`). port is the port it listens on, used for
// Host and Origin checks; the admin key cookie is required.
func (a *App) AdminHandler(port int) http.Handler {
	mux := a.adminMux()
	hosts := map[string]bool{
		"127.0.0.1:" + strconv.Itoa(port): true,
		"localhost:" + strconv.Itoa(port): true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		adminHeaders(h)
		// A web page elsewhere could point its own domain at 127.0.0.1
		// (DNS rebinding); only answer to our own host names.
		if !hosts[r.Host] {
			http.Error(w, "wrong host", http.StatusMisdirectedRequest)
			return
		}
		if r.Method == http.MethodPost && !hosts[strings.TrimPrefix(r.Header.Get("Origin"), "http://")] {
			writeErr(w, http.StatusForbidden, "cross-site request refused")
			return
		}
		// ?k=<admin key> (from `remote-desk open`) sets the cookie once.
		if k := r.URL.Query().Get("k"); k != "" && r.Method == http.MethodGet && r.URL.Path == "/" {
			if a.adminKeyOK(k) {
				http.SetCookie(w, &http.Cookie{Name: adminCookie, Value: k, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 400 * 24 * 3600})
				http.Redirect(w, r, "/", http.StatusSeeOther)
				return
			}
		}
		c, err := r.Cookie(adminCookie)
		if err != nil || !a.adminKeyOK(c.Value) {
			if r.URL.Path == "/" {
				h.Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusForbidden)
				fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Remote Desk</title><body style="font:16px system-ui;margin:40px">`+
					`<h1>Remote Desk</h1><p>Open this page with <code>remote-desk open</code> on this computer.</p>`)
				return
			}
			writeErr(w, http.StatusForbidden, "admin key needed")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *App) adminKeyOK(k string) bool {
	key := a.config().AdminKey
	return key != "" && subtle.ConstantTimeCompare([]byte(k), []byte(key)) == 1
}

var qrCache sync.Map // url → data URL

func qrDataURL(u string) string {
	if v, ok := qrCache.Load(u); ok {
		return v.(string)
	}
	png, err := qrcode.Encode(u, qrcode.Medium, 320)
	if err != nil {
		return ""
	}
	d := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	qrCache.Store(u, d)
	return d
}

type rootStatus struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Available bool   `json:"available"`
	Protected bool   `json:"protected"` // as applied (iCloud is always on)
	Asked     bool   `json:"asked"`     // as set by the owner
}

func (a *App) adminStatus(w http.ResponseWriter, r *http.Request) {
	cfg := a.config()
	site := a.Net.SiteURL(r.Context())
	var roots []rootStatus
	avail := a.files().Roots()
	for i, rt := range cfg.Roots {
		rs := rootStatus{Name: rt.Name, Path: rt.Path, Asked: rt.Protected}
		if i < len(avail) {
			rs.Available, rs.Protected = avail[i].Available, avail[i].Protected
		}
		roots = append(roots, rs)
	}
	resp := map[string]any{
		"laptop":    a.Laptop,
		"dev":       a.Dev,
		"tailscale": a.Net.Status(r.Context()),
		"siteURL":   site,
		"auth":      a.Auth.AdminState(),
		"roots":     roots,
		"keepAwake": map[string]bool{"enabled": a.Awake.Enabled(), "supported": awake.Supported()},
		"activity":  a.Log.Recent(60),
		"canQuit":   a.Quit != nil,
		"desktop":   a.Desktop,
		// macOS Full Disk Access: true, false, or null (not macOS / can't tell).
		"fullDiskAccess": files.FullDiskAccess(),
	}
	if site != "" {
		resp["siteQR"] = qrDataURL(site)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *App) adminPairStart(w http.ResponseWriter, r *http.Request) {
	code, exp, err := a.Auth.StartPairing()
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code[:4] + "-" + code[4:], "expires": exp})
}

func (a *App) adminApprove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	d, err := a.Auth.Approve(req.ID)
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	a.Log.Add("Phone paired", fmt.Sprintf("%s (%s, %s)", d.Label, d.NodeName, d.OS))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) adminDeny(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.Auth.Deny(req.ID); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	a.Log.Add("Pairing denied", "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) adminUnpair(w http.ResponseWriter, r *http.Request) {
	if err := a.Auth.Unpair(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.Log.Add("Phone unpaired", "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) adminUnlock(w http.ResponseWriter, r *http.Request) {
	if err := a.Auth.Unlock(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.Log.Add("Phone unlocked from the laptop", "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) adminRoots(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Roots []config.Root `json:"roots"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Roots) > 20 {
		writeErr(w, http.StatusBadRequest, "at most 20 shared folders")
		return
	}
	var clean []config.Root
	for _, rt := range req.Roots {
		p := strings.TrimSpace(rt.Path)
		if strings.HasPrefix(p, "~") {
			if home, err := os.UserHomeDir(); err == nil {
				p = filepath.Join(home, strings.TrimPrefix(p, "~"))
			}
		}
		if !filepath.IsAbs(p) {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("%q isn't a full folder path", rt.Path))
			return
		}
		fi, err := os.Stat(p)
		if err != nil || !fi.IsDir() {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("%q isn't a folder on this computer", rt.Path))
			return
		}
		name := strings.TrimSpace(rt.Name)
		if name == "" {
			name = filepath.Base(p)
		}
		clean = append(clean, config.Root{Name: name, Path: filepath.Clean(p), Protected: rt.Protected})
	}
	if err := a.updateConfig(func(c *config.Config) { c.Roots = clean }); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.Log.Add("Shared folders changed", fmt.Sprintf("%d folder(s)", len(clean)))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) adminKeepAwake(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.updateConfig(func(c *config.Config) { c.KeepAwake = req.Enabled }); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.Awake.Set(req.Enabled)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
