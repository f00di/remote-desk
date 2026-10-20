package awake

import (
	"os"
	"os/exec"
	"strconv"
)

const supported = true

// start runs `caffeinate -s` (no system sleep while on AC power) tied to
// this process, so it ends if the agent dies.
func start() func() {
	cmd := exec.Command("/usr/bin/caffeinate", "-s", "-w", strconv.Itoa(os.Getpid()))
	if err := cmd.Start(); err != nil {
		return func() {}
	}
	go cmd.Wait()
	return func() { _ = cmd.Process.Kill() }
}
