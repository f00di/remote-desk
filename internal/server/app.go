// Package server is the agent's HTTP side: the phone site and API (served
// on the tailnet) and the admin page (served on 127.0.0.1 only).
package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"

	"remote-desk/internal/activity"
	"remote-desk/internal/auth"
	"remote-desk/internal/awake"
	"remote-desk/internal/config"
	"remote-desk/internal/files"
	"remote-desk/internal/tailnet"
)

// Identifier tells which Tailscale device a connection comes from.
type Identifier interface {
	WhoIs(ctx context.Context, remoteAddr string) (auth.Peer, error)
}

// Network reports the laptop's Tailscale state for the admin page.
type Network interface {
	Status(ctx context.Context) tailnet.Status
	SiteURL(ctx context.Context) string
}

type App struct {
	Auth      *auth.Manager
	Log       *activity.Log
	Awake     *awake.Keeper
	Ident     Identifier
	Net       Network
	ConfigDir string
	Laptop    string // friendly computer name shown on the phone
	// Secure: the phone site is on HTTPS (cookies Secure, HSTS). False only
	// in dev mode on http://127.0.0.1.
	Secure bool
	Dev    bool
	// Quit stops the agent (the admin page's Quit button). Nil hides it.
	Quit func()

	cfgMu sync.Mutex
	cfg   *config.Config
	fs    atomic.Pointer[files.FS]
}

func NewApp(cfg *config.Config) *App {
	a := &App{cfg: cfg}
	return a
}

// Init builds the file view from the config. Call after ConfigDir is set.
func (a *App) Init() {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	a.fs.Store(files.New(a.cfg.Roots, a.ConfigDir))
}

func (a *App) files() *files.FS { return a.fs.Load() }

func (a *App) config() config.Config {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	c := *a.cfg
	c.Roots = append([]config.Root(nil), a.cfg.Roots...)
	return c
}

// updateConfig applies fn to the config, saves it and rebuilds the file view.
func (a *App) updateConfig(fn func(*config.Config)) error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	next := *a.cfg
	next.Roots = append([]config.Root(nil), a.cfg.Roots...)
	fn(&next)
	if err := config.Save(a.ConfigDir, &next); err != nil {
		return err
	}
	*a.cfg = next
	a.fs.Store(files.New(a.cfg.Roots, a.ConfigDir))
	return nil
}

// ---- helpers shared by both handlers ----

const maxBody = 64 << 10

func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errors.New("bad request body")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
