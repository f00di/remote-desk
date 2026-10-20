package server

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"remote-desk/internal/auth"
	"remote-desk/internal/files"
	"remote-desk/web"
)

const sessionCookie = "rd_s"

type peerKey struct{}

func peerOf(r *http.Request) auth.Peer {
	p, _ := r.Context().Value(peerKey{}).(auth.Peer)
	return p
}

// PhoneHandler serves the phone site and API.
func (a *App) PhoneHandler() http.Handler {
	mux := http.NewServeMux()
	static := web.Phone()
	for _, name := range []string{"app.js", "app.css", "sw.js", "manifest.webmanifest"} {
		mux.HandleFunc("GET /"+name, serveStatic(static, name))
	}
	mux.HandleFunc("GET /{$}", serveStatic(static, "index.html"))
	mux.HandleFunc("GET /icon-180.png", serveIcon(180))
	mux.HandleFunc("GET /icon-512.png", serveIcon(512))

	mux.HandleFunc("GET /api/hello", a.hello)
	mux.HandleFunc("POST /api/pair", a.pair)
	mux.HandleFunc("GET /api/pair/status", a.pairStatus)
	mux.HandleFunc("POST /api/challenge", a.challenge)
	mux.HandleFunc("POST /api/login", a.login)
	mux.HandleFunc("POST /api/logout", a.logout)
	mux.HandleFunc("GET /api/session", a.needSession(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/roots", a.needSession(a.roots))
	mux.HandleFunc("GET /api/list", a.needSession(a.list))
	mux.HandleFunc("GET /api/search", a.needSession(a.search))
	mux.HandleFunc("GET /api/file", a.needSession(a.file))
	return a.phoneMiddleware(mux)
}

// phoneMiddleware identifies the device, sets security headers and blocks
// cross-site POSTs.
func (a *App) phoneMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if a.Secure {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if !strings.HasPrefix(r.URL.Path, "/api/file") {
			h.Set("X-Frame-Options", "DENY")
			h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; "+
				"frame-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; "+
				"manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		}
		if r.Method == http.MethodPost && !a.sameOrigin(r) {
			writeErr(w, http.StatusForbidden, "cross-site request refused")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			p, err := a.Ident.WhoIs(ctx, r.RemoteAddr)
			cancel()
			if err != nil {
				writeErr(w, http.StatusForbidden, "unknown device")
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), peerKey{}, p))
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	scheme := "http://"
	if a.Secure {
		scheme = "https://"
	}
	return o != "" && o == scheme+r.Host
}

func (a *App) hello(w http.ResponseWriter, r *http.Request) {
	st := a.Auth.PeerState(peerOf(r))
	writeJSON(w, http.StatusOK, map[string]any{
		"laptop":      a.Laptop,
		"paired":      st.Paired,
		"thisDevice":  st.ThisDevice,
		"locked":      st.Locked,
		"triesLeft":   st.TriesLeft,
		"pairingOpen": st.PairingOpen,
		"dev":         a.Dev,
	})
}

func (a *App) pair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code      string `json:"code"`
		Label     string `json:"label"`
		PIN       string `json:"pin"`
		PublicKey string `json:"publicKey"` // base64 SPKI
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	key, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil {
		writeErr(w, http.StatusBadRequest, auth.ErrBadKey.Error())
		return
	}
	p := peerOf(r)
	id, err := a.Auth.SubmitPairing(p, req.Code, req.Label, req.PIN, key)
	if err != nil {
		a.Log.Add("Pairing attempt refused", fmt.Sprintf("%s (%s): %v", p.Name, p.OS, err))
		writeErr(w, statusFor(err), err.Error())
		return
	}
	a.Log.Add("Pairing requested", fmt.Sprintf("%s (%s)", p.Name, p.OS))
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (a *App) pairStatus(w http.ResponseWriter, r *http.Request) {
	st, err := a.Auth.RequestStatus(peerOf(r), r.URL.Query().Get("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": st})
}

func (a *App) challenge(w http.ResponseWriter, r *http.Request) {
	n, err := a.Auth.Challenge(peerOf(r))
	if err != nil {
		writeErr(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"nonce": n})
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nonce     string `json:"nonce"`
		Signature string `json:"signature"` // base64 raw r||s
		PIN       string `json:"pin"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	sig, _ := base64.StdEncoding.DecodeString(req.Signature)
	p := peerOf(r)
	tok, err := a.Auth.Login(p, req.Nonce, sig, req.PIN)
	if err != nil {
		if errors.Is(err, auth.ErrWrongLogin) || errors.Is(err, auth.ErrLocked) {
			a.Log.Add("Wrong PIN", p.Name)
		}
		st := a.Auth.PeerState(p)
		writeJSON(w, statusFor(err), map[string]any{"error": err.Error(), "locked": st.Locked, "triesLeft": st.TriesLeft})
		return
	}
	a.Log.Add("Phone unlocked", p.Name)
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: tok, Path: "/", HttpOnly: true, Secure: a.Secure,
		SameSite: http.SameSiteStrictMode, MaxAge: int(auth.SessionMax / time.Second),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.Auth.Logout(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: a.Secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) needSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil || !a.Auth.Session(peerOf(r), c.Value) {
			writeErr(w, http.StatusUnauthorized, "locked")
			return
		}
		next(w, r)
	}
}

func (a *App) roots(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"roots": a.files().Roots(), "laptop": a.Laptop})
}

func (a *App) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	root, err := strconv.Atoi(q.Get("root"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad root")
		return
	}
	entries, err := a.files().List(root, q.Get("path"))
	if err != nil {
		writeErr(w, fileStatus(err), fileMessage(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "truncated": len(entries) >= files.MaxEntries})
}

func (a *App) search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return
	}
	if len(q) > 200 {
		q = q[:200]
	}
	res := a.files().Search(r.Context(), q, 100)
	if res == nil {
		res = []files.Result{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": res})
}

func (a *App) file(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	root, err := strconv.Atoi(q.Get("root"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad root")
		return
	}
	rel := q.Get("path")
	f, fi, err := a.files().Open(root, rel)
	if err != nil {
		writeErr(w, fileStatus(err), fileMessage(err))
		return
	}
	defer f.Close()
	name := path.Base(strings.ReplaceAll(rel, "\\", "/"))
	inline := files.InlineType(name)
	download := q.Get("dl") == "1" || inline == ""

	h := w.Header()
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Frame-Options", "SAMEORIGIN")
	if files.Kind(name) == "pdf" && !download {
		h.Set("Content-Security-Policy", "frame-ancestors 'self'")
	} else {
		h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'")
	}
	if download {
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Disposition", disposition("attachment", name))
	} else {
		h.Set("Content-Type", inline)
		h.Set("Content-Disposition", disposition("inline", name))
	}
	// One log line per file per minute, not one per video range request or
	// per preview + share-sheet fetch.
	if rg := r.Header.Get("Range"); rg == "" || strings.HasPrefix(rg, "bytes=0-") {
		verb := "Viewed"
		if download {
			verb = "Downloaded"
		}
		a.Log.AddFile(verb, a.rootName(root)+"/"+strings.TrimPrefix(rel, "/"))
	}
	http.ServeContent(w, r, name, fi.ModTime(), f)
}

func (a *App) rootName(id int) string {
	for _, r := range a.files().Roots() {
		if r.ID == id {
			return r.Name
		}
	}
	return "?"
}

func disposition(kind, name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	if v := mime.FormatMediaType(kind, map[string]string{"filename": name}); v != "" && ascii == name {
		return v
	}
	return fmt.Sprintf(`%s; filename="%s"; filename*=UTF-8''%s`, kind, ascii, url.PathEscape(name))
}

func statusFor(err error) int {
	switch {
	case errors.Is(err, auth.ErrNotPaired), errors.Is(err, auth.ErrNotSameUser), errors.Is(err, auth.ErrAlreadyPaired):
		return http.StatusForbidden
	case errors.Is(err, auth.ErrLocked):
		return http.StatusLocked
	case errors.Is(err, auth.ErrWrongLogin), errors.Is(err, auth.ErrBadCode):
		return http.StatusUnauthorized
	case errors.Is(err, auth.ErrNoWindow), errors.Is(err, auth.ErrBadChallenge):
		return http.StatusConflict
	default:
		return http.StatusBadRequest
	}
}

func fileStatus(err error) int {
	switch {
	case errors.Is(err, files.ErrDenied), errors.Is(err, fs.ErrPermission):
		return http.StatusForbidden
	case errors.Is(err, files.ErrBadPath):
		return http.StatusBadRequest
	default:
		return http.StatusNotFound
	}
}

func fileMessage(err error) string {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return "The laptop's system blocked this folder. Give Remote Desk Full Disk Access on the laptop."
	case errors.Is(err, files.ErrDenied):
		return "This isn't shared."
	case errors.Is(err, files.ErrBadPath):
		return "Bad path."
	default:
		return "Not found. It may have been moved or deleted."
	}
}

func serveStatic(fsys fs.FS, name string) http.HandlerFunc {
	ctype := mime.TypeByExtension(path.Ext(name))
	switch path.Ext(name) {
	case ".webmanifest":
		ctype = "application/manifest+json"
	case ".html":
		ctype = "text/html; charset=utf-8"
	}
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := fs.ReadFile(fsys, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(b)
	}
}
