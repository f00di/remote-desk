// mkicon writes the app icon as a macOS .iconset folder (for iconutil).
// Usage: go run ./cmd/mkicon <dir>.iconset
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"remote-desk/internal/server"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: mkicon <dir>.iconset")
		os.Exit(2)
	}
	dir := os.Args[1]
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	for _, s := range []int{16, 32, 128, 256, 512} {
		write(filepath.Join(dir, fmt.Sprintf("icon_%dx%d.png", s, s)), s)
		write(filepath.Join(dir, fmt.Sprintf("icon_%dx%d@2x.png", s, s)), 2*s)
	}
}

func write(path string, size int) {
	if err := os.WriteFile(path, server.IconPNG(size), 0o644); err != nil {
		panic(err)
	}
}
