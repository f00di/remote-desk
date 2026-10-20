package files

import (
	"io/fs"
	"path/filepath"
)

// osRules returns folders that are never served (deny) and folders skipped
// when they sit inside a shared folder (hide). Dotfiles are always skipped.
func osRules(home string) (deny, hide []string) {
	lib := filepath.Join(home, "Library")
	as := filepath.Join(lib, "Application Support")
	deny = []string{
		filepath.Join(lib, "Keychains"),
		"/Library/Keychains",
		filepath.Join(lib, "Cookies"),
		filepath.Join(lib, "Safari"),
		filepath.Join(as, "Google", "Chrome"),
		filepath.Join(as, "Firefox"),
		filepath.Join(as, "Microsoft Edge"),
		filepath.Join(as, "BraveSoftware"),
		filepath.Join(as, "Arc"),
		filepath.Join(as, "1Password"),
		filepath.Join(lib, "Group Containers", "2BUA8C4S2C.com.1password"),
		filepath.Join(as, "com.apple.TCC"),
	}
	hide = []string{
		lib,
		"/Library", "/System", "/private", "/usr", "/bin", "/sbin", "/dev", "/cores", "/opt",
	}
	return deny, hide
}

func hiddenByOS(fs.FileInfo) bool { return false }
