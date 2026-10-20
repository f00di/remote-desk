package files

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// FullDiskAccess reports whether macOS lets this app read protected
// folders. It lists ~/Library/Safari (names only, nothing is read or
// served), which only Full Disk Access unlocks and which never triggers a
// permission prompt. nil means it can't tell.
func FullDiskAccess() *bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	f, err := os.Open(filepath.Join(home, "Library", "Safari"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	ok := err == nil
	if ok {
		_, err = f.ReadDir(1)
		f.Close()
		ok = err == nil || errors.Is(err, io.EOF)
	}
	return &ok
}
