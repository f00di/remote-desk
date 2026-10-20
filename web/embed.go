// Package web holds the phone site and the admin page. Plain files, no
// build step.
package web

import (
	"embed"
	"io/fs"
)

//go:embed phone admin
var files embed.FS

func Phone() fs.FS { return sub("phone") }
func Admin() fs.FS { return sub("admin") }

func sub(dir string) fs.FS {
	f, err := fs.Sub(files, dir)
	if err != nil {
		panic(err)
	}
	return f
}
