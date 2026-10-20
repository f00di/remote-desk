//go:build !windows

package main

import (
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"remote-desk/internal/config"
)

// appLaunchEnv: Info.plist sets this when Remote Desk.app is opened.
const appLaunchEnv = "REMOTE_DESK_APP_LAUNCH"

// launchFromApp runs when the app icon is opened. A Mac app that keeps
// running ignores a second open, so this process starts the agent in the
// background and exits; opening the app again then lands here, finds the
// agent running and shows its admin page.
func launchFromApp() error {
	dir, err := config.Dir(false)
	if err != nil {
		return err
	}
	cfg, err := config.Load(dir)
	if err != nil {
		return err
	}
	if c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(cfg.AdminPort), time.Second); err == nil {
		c.Close()
		openBrowser(adminURL(cfg))
		time.Sleep(500 * time.Millisecond) // let `open` start before we exit
		return nil
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, "run")
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, appLaunchEnv+"=") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start() // the agent logs to agent.log and opens the admin page itself
}
