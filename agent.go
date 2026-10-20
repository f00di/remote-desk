package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"remote-desk/internal/activity"
	"remote-desk/internal/auth"
	"remote-desk/internal/awake"
	"remote-desk/internal/config"
	"remote-desk/internal/server"
	"remote-desk/internal/tailnet"
)

// errAlreadyRunning: another copy of Remote Desk holds the admin port.
var errAlreadyRunning = errors.New("Remote Desk is already running")

// agent is everything Remote Desk runs, whatever shows it: the desktop
// window, a browser tab, or nothing.
type agent struct {
	app     *server.App
	cfg     *config.Config
	logger  *log.Logger
	closers []func()
}

// startAgent loads the config and starts Tailscale (or dev mode), the phone
// site and the local admin server. ctx ends the Tailscale listener.
func startAgent(ctx context.Context, dev bool, devRoot string) (*agent, error) {
	dir, err := config.Dir(dev)
	if err != nil {
		return nil, err
	}
	cfg, err := config.Load(dir)
	if err != nil {
		return nil, err
	}
	if devRoot != "" {
		if !dev {
			return nil, errors.New("--root only works with --dev; change shared folders on the admin page")
		}
		abs, err := filepath.Abs(devRoot)
		if err != nil {
			return nil, err
		}
		cfg.Roots = []config.Root{{Name: filepath.Base(abs), Path: abs}}
	}

	adminLn, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(cfg.AdminPort))
	if err != nil {
		return &agent{cfg: cfg}, errAlreadyRunning
	}

	ag := &agent{cfg: cfg}
	ok := false
	defer func() {
		if !ok {
			ag.Close()
		}
	}()
	ag.closers = append(ag.closers, func() { adminLn.Close() })

	logFile, err := os.OpenFile(filepath.Join(dir, "agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	ag.closers = append(ag.closers, func() { logFile.Close() })
	ag.logger = log.New(io.MultiWriter(os.Stderr, logFile), "", log.LstdFlags)

	am, err := auth.New(dir)
	if err != nil {
		return nil, fmt.Errorf("reading pairing: %w", err)
	}
	keeper := &awake.Keeper{}
	app := server.NewApp(cfg)
	app.Auth = am
	app.Log = activity.Open(dir)
	app.Awake = keeper
	app.ConfigDir = dir
	app.Laptop = laptopName()
	app.Dev = dev
	app.Init()
	ag.app = app

	if dev {
		app.Ident = devIdent{}
		app.Net = devNet{}
		phoneLn, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(devPhonePort))
		if err != nil {
			return nil, err
		}
		ps := &http.Server{Handler: app.PhoneHandler(), ReadHeaderTimeout: 10 * time.Second}
		go ps.Serve(phoneLn)
		ag.closers = append(ag.closers, func() { ps.Close() })
		ag.logger.Printf("DEV MODE: phone site on http://127.0.0.1:%d (no Tailscale, fake device)", devPhonePort)
	} else {
		tsDir := filepath.Join(dir, "tailscale")
		if err := os.MkdirAll(tsDir, 0o700); err != nil {
			return nil, err
		}
		tn, err := tailnet.Start(tsDir, cfg.Hostname, ag.logger)
		if err != nil {
			return nil, fmt.Errorf("starting Tailscale: %w", err)
		}
		ag.closers = append(ag.closers, func() { tn.Close() })
		app.Ident = tn
		app.Net = tn
		app.Secure = true
		go tn.Serve(ctx, app.PhoneHandler())
		if cfg.KeepAwake {
			keeper.Set(true)
		}
		ag.closers = append(ag.closers, func() { keeper.Set(false) })
	}

	as := &http.Server{Handler: app.AdminHandler(cfg.AdminPort), ReadHeaderTimeout: 10 * time.Second}
	go as.Serve(adminLn)
	ag.closers = append(ag.closers, func() { as.Close() })
	ok = true
	return ag, nil
}

// Close stops everything startAgent started, newest first.
func (a *agent) Close() {
	for i := len(a.closers) - 1; i >= 0; i-- {
		a.closers[i]()
	}
	a.closers = nil
	if a.logger != nil {
		a.logger.Printf("stopped")
	}
}
