//go:build !darwin && !windows

package files

import "io/fs"

// osRules: other systems only get the dotfile rule and the config dir.
func osRules(home string) (deny, hide []string) {
	return nil, []string{"/proc", "/sys", "/dev", "/etc", "/root"}
}

func hiddenByOS(fs.FileInfo) bool { return false }
