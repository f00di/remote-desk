package files

import (
	"bufio"
	"context"
	"os/exec"
)

// indexSearch asks Spotlight for names containing word under dir. ok is
// false if Spotlight can't be used, so the caller walks instead.
func indexSearch(ctx context.Context, dir, word string) (paths []string, ok bool) {
	cmd := exec.CommandContext(ctx, "/usr/bin/mdfind", "-onlyin", dir, "-name", word)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false
	}
	if err := cmd.Start(); err != nil {
		return nil, false
	}
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() && len(paths) < 3000 {
		paths = append(paths, sc.Text())
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return paths, true
}
