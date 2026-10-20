// Package tailnet runs the agent as its own device on the owner's Tailscale
// network (tsnet), so the laptop needs no Tailscale app and listens nowhere
// else.
package tailnet

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tsnet"

	"remote-desk/internal/auth"
)

type Tailnet struct {
	srv *tsnet.Server
	lc  *local.Client

	mu      sync.Mutex
	listErr string // last error from the HTTPS listener (e.g. HTTPS not enabled)
	serving bool
}

// Start brings the node up in the background. Until the owner logs in, the
// status carries the login URL.
func Start(dir, hostname string, userLog *log.Logger) (*Tailnet, error) {
	srv := &tsnet.Server{
		Dir:      dir,
		Hostname: hostname,
		UserLogf: func(format string, args ...any) {
			// The only user-facing message is the login URL, which the admin
			// page shows too.
			userLog.Printf("tailscale: "+format, args...)
		},
	}
	if err := srv.Start(); err != nil {
		return nil, err
	}
	lc, err := srv.LocalClient()
	if err != nil {
		srv.Close()
		return nil, err
	}
	return &Tailnet{srv: srv, lc: lc}, nil
}

func (t *Tailnet) Close() error { return t.srv.Close() }

// Status is what the admin page shows about Tailscale.
type Status struct {
	State    string `json:"state"` // NeedsLogin, Starting, Running, ...
	AuthURL  string `json:"authURL,omitempty"`
	DNSName  string `json:"dnsName,omitempty"`
	MagicDNS bool   `json:"magicDNS"`
	HTTPS    bool   `json:"https"`
	Serving  bool   `json:"serving"`
	User     string `json:"user,omitempty"`
	Error    string `json:"error,omitempty"`
}

func (t *Tailnet) Status(ctx context.Context) Status {
	st, err := t.lc.StatusWithoutPeers(ctx)
	if err != nil {
		return Status{State: "Unknown", Error: err.Error()}
	}
	s := Status{State: st.BackendState, AuthURL: st.AuthURL, HTTPS: len(st.CertDomains) > 0}
	if st.CurrentTailnet != nil {
		s.MagicDNS = st.CurrentTailnet.MagicDNSEnabled
	}
	if st.Self != nil {
		s.DNSName = strings.TrimSuffix(st.Self.DNSName, ".")
		if u, ok := st.User[st.Self.UserID]; ok {
			s.User = u.LoginName
		}
	}
	t.mu.Lock()
	s.Serving = t.serving
	if !t.serving && st.BackendState == "Running" {
		s.Error = t.listErr
	}
	t.mu.Unlock()
	return s
}

// SiteURL is the phone site's address once HTTPS is ready.
func (t *Tailnet) SiteURL(ctx context.Context) string {
	s := t.Status(ctx)
	if s.DNSName == "" || !s.HTTPS {
		return ""
	}
	return "https://" + s.DNSName + "/"
}

// Serve serves h over HTTPS on the tailnet (port 443) and redirects port 80
// to it. It waits for login and retries until HTTPS is turned on for the
// tailnet.
func (t *Tailnet) Serve(ctx context.Context, h http.Handler) {
	go t.redirectHTTP(ctx)
	for ctx.Err() == nil {
		ln, err := t.srv.ListenTLS("tcp", ":443")
		if err != nil {
			t.setErr(err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(10 * time.Second):
			}
			continue
		}
		t.mu.Lock()
		t.serving, t.listErr = true, ""
		t.mu.Unlock()
		hs := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
		go func() { <-ctx.Done(); hs.Close() }()
		err = hs.Serve(ln)
		t.mu.Lock()
		t.serving = false
		t.mu.Unlock()
		if ctx.Err() != nil || errors.Is(err, http.ErrServerClosed) {
			return
		}
		t.setErr(err)
		time.Sleep(2 * time.Second)
	}
}

func (t *Tailnet) redirectHTTP(ctx context.Context) {
	ln, err := t.srv.Listen("tcp", ":80")
	if err != nil {
		return
	}
	hs := &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host, _, err := net.SplitHostPort(r.Host)
			if err != nil {
				host = r.Host
			}
			http.Redirect(w, r, "https://"+host+"/", http.StatusMovedPermanently)
		}),
	}
	go func() { <-ctx.Done(); hs.Close() }()
	_ = hs.Serve(ln)
}

func (t *Tailnet) setErr(err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.listErr = err.Error()
}

// WhoIs identifies the Tailscale device behind a connection.
func (t *Tailnet) WhoIs(ctx context.Context, remoteAddr string) (auth.Peer, error) {
	who, err := t.lc.WhoIs(ctx, remoteAddr)
	if err != nil {
		return auth.Peer{}, err
	}
	if who.Node == nil {
		return auth.Peer{}, fmt.Errorf("unknown device")
	}
	p := auth.Peer{NodeID: string(who.Node.StableID), Name: who.Node.ComputedName}
	if p.Name == "" {
		p.Name = strings.Split(who.Node.Name, ".")[0]
	}
	if who.Node.Hostinfo.Valid() {
		p.OS = who.Node.Hostinfo.OS()
	}
	if who.UserProfile != nil {
		p.User = who.UserProfile.LoginName
	}
	st, err := t.lc.StatusWithoutPeers(ctx)
	if err == nil && st.Self != nil && !who.Node.IsTagged() {
		p.SameUser = who.Node.User == st.Self.UserID
	}
	return p, nil
}
