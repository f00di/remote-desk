// Remote Desk: reach the files on this laptop from your iPhone, anywhere,
// read-only, over your own Tailscale network. See README.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"remote-desk/internal/activity"
	"remote-desk/internal/auth"
	"remote-desk/internal/awake"
	"remote-desk/internal/config"
	"remote-desk/internal/server"
	"remote-desk/internal/tailnet"
)

const devPhonePort = 47801

func main() {
	args := os.Args[1:]
	cmd := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	fl := flag.NewFlagSet("remote-desk", flag.ExitOnError)
	dev := fl.Bool("dev", false, "test mode: no Tailscale, phone site on http://127.0.0.1:47801, separate state")
	noOpen := fl.Bool("no-open", false, "don't open the admin page in the browser")
	root := fl.String("root", "", "dev mode only: share just this folder")
	fl.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: remote-desk [run|open] [flags]\n\n  run   start the agent (default)\n  open  open the admin page of the running agent\n\n")
		fl.PrintDefaults()
	}
	_ = fl.Parse(args)

	switch cmd {
	case "run":
		if os.Getenv(appLaunchEnv) == "1" && !*dev {
			if err := launchFromApp(); err != nil {
				log.Fatal(err)
			}
			return
		}
		if err := run(*dev, *noOpen, *root); err != nil {
			log.Fatal(err)
		}
	case "open":
		dir, err := config.Dir(*dev)
		if err != nil {
			log.Fatal(err)
		}
		cfg, err := config.Load(dir)
		if err != nil {
			log.Fatal(err)
		}
		openBrowser(adminURL(cfg))
	default:
		fl.Usage()
		os.Exit(2)
	}
}

func adminURL(cfg *config.Config) string {
	return fmt.Sprintf("http://127.0.0.1:%d/?k=%s", cfg.AdminPort, cfg.AdminKey)
}

func run(dev, noOpen bool, devRoot string) error {
	dir, err := config.Dir(dev)
	if err != nil {
		return err
	}
	cfg, err := config.Load(dir)
	if err != nil {
		return err
	}
	if devRoot != "" {
		if !dev {
			return errors.New("--root only works with --dev; change shared folders on the admin page")
		}
		abs, err := filepath.Abs(devRoot)
		if err != nil {
			return err
		}
		cfg.Roots = []config.Root{{Name: filepath.Base(abs), Path: abs}}
	}

	adminLn, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(cfg.AdminPort))
	if err != nil {
		// Most likely already running: just show its admin page.
		fmt.Println("Remote Desk is already running; opening its admin page.")
		if !noOpen {
			openBrowser(adminURL(cfg))
		}
		return nil
	}

	logFile, err := os.OpenFile(filepath.Join(dir, "agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	logger := log.New(io.MultiWriter(os.Stderr, logFile), "", log.LstdFlags)

	am, err := auth.New(dir)
	if err != nil {
		return fmt.Errorf("reading pairing: %w", err)
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	app.Quit = stop

	if dev {
		app.Ident = devIdent{}
		app.Net = devNet{}
		app.Secure = false
		phoneLn, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(devPhonePort))
		if err != nil {
			return err
		}
		ps := &http.Server{Handler: app.PhoneHandler(), ReadHeaderTimeout: 10 * time.Second}
		go ps.Serve(phoneLn)
		defer ps.Close()
		logger.Printf("DEV MODE: phone site on http://127.0.0.1:%d (no Tailscale, fake device)", devPhonePort)
	} else {
		tsDir := filepath.Join(dir, "tailscale")
		if err := os.MkdirAll(tsDir, 0o700); err != nil {
			return err
		}
		tn, err := tailnet.Start(tsDir, cfg.Hostname, logger)
		if err != nil {
			return fmt.Errorf("starting Tailscale: %w", err)
		}
		defer tn.Close()
		app.Ident = tn
		app.Net = tn
		app.Secure = true
		go tn.Serve(ctx, app.PhoneHandler())
		if cfg.KeepAwake {
			keeper.Set(true)
		}
		defer keeper.Set(false)
	}

	as := &http.Server{Handler: app.AdminHandler(cfg.AdminPort), ReadHeaderTimeout: 10 * time.Second}
	go as.Serve(adminLn)
	defer as.Close()

	logger.Printf("Remote Desk is running. Admin page: http://127.0.0.1:%d (run `remote-desk open` to reopen it)", cfg.AdminPort)
	if !noOpen {
		openBrowser(adminURL(cfg))
	}
	<-ctx.Done()
	logger.Printf("stopping")
	return nil
}

// laptopName is the friendly computer name shown on the phone.
func laptopName() string {
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("/usr/sbin/scutil", "--get", "ComputerName").Output(); err == nil {
			if n := strings.TrimSpace(string(out)); n != "" {
				return n
			}
		}
	}
	n, _ := os.Hostname()
	return strings.TrimSuffix(n, ".local")
}

func openBrowser(u string) {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", u)
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		c = exec.Command("xdg-open", u)
	}
	if err := c.Start(); err != nil {
		fmt.Println("Open this in your browser:", u)
		return
	}
	go c.Wait()
}

// devIdent pretends every dev-mode request comes from one phone.
type devIdent struct{}

func (devIdent) WhoIs(context.Context, string) (auth.Peer, error) {
	return auth.Peer{NodeID: "dev-device", Name: "dev-browser", OS: "dev", User: "you@dev", SameUser: true}, nil
}

type devNet struct{}

func (devNet) Status(context.Context) tailnet.Status {
	return tailnet.Status{State: "Dev", DNSName: "127.0.0.1:" + strconv.Itoa(devPhonePort), MagicDNS: true, HTTPS: true, Serving: true}
}

func (devNet) SiteURL(context.Context) string {
	return "http://127.0.0.1:" + strconv.Itoa(devPhonePort) + "/"
}
