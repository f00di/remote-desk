// Remote Desk: reach the files on this laptop from your iPhone, anywhere,
// read-only, over your own Tailscale network. See README.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"remote-desk/internal/auth"
	"remote-desk/internal/config"
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
	headless := fl.Bool("headless", false, "no window: show the admin page in the browser instead")
	fl.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: remote-desk [run|open] [flags]\n\n  run   start the agent (default)\n  open  open the admin page of the running agent\n\n")
		fl.PrintDefaults()
	}
	_ = fl.Parse(args)

	switch cmd {
	case "run":
		if hasWindow && !*headless {
			if err := runDesktop(*dev, *root); err != nil {
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

// run is the headless agent (dev mode, or a build without the window): the
// admin page opens in the browser and Ctrl+C stops it.
func run(dev, noOpen bool, devRoot string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ag, err := startAgent(ctx, dev, devRoot)
	if errors.Is(err, errAlreadyRunning) {
		fmt.Println("Remote Desk is already running; opening its admin page.")
		if !noOpen {
			openBrowser(adminURL(ag.cfg))
		}
		return nil
	}
	if err != nil {
		return err
	}
	defer ag.Close()
	ag.app.Quit = stop
	ag.logger.Printf("Remote Desk is running. Admin page: http://127.0.0.1:%d (run `remote-desk open` to reopen it)", ag.cfg.AdminPort)
	if !noOpen {
		openBrowser(adminURL(ag.cfg))
	}
	<-ctx.Done()
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
