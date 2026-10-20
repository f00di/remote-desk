package files

import (
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// osRules returns folders that are never served (deny) and folders skipped
// when they sit inside a shared folder (hide). Dotfiles are always skipped.
func osRules(home string) (deny, hide []string) {
	roaming := filepath.Join(home, "AppData", "Roaming")
	local := filepath.Join(home, "AppData", "Local")
	deny = []string{
		filepath.Join(roaming, "Microsoft", "Protect"),
		filepath.Join(roaming, "Microsoft", "Credentials"),
		filepath.Join(roaming, "Microsoft", "Vault"),
		filepath.Join(local, "Microsoft", "Credentials"),
		filepath.Join(local, "Microsoft", "Vault"),
		filepath.Join(local, "Google", "Chrome", "User Data"),
		filepath.Join(local, "Microsoft", "Edge", "User Data"),
		filepath.Join(local, "BraveSoftware"),
		filepath.Join(roaming, "Mozilla", "Firefox"),
		filepath.Join(local, "1Password"),
	}
	hide = []string{filepath.Join(home, "AppData")}
	for _, env := range []string{"SystemRoot", "ProgramData", "ProgramFiles", "ProgramFiles(x86)"} {
		if p := os.Getenv(env); p != "" {
			hide = append(hide, p)
		}
	}
	if sd := os.Getenv("SystemDrive"); sd != "" {
		hide = append(hide, filepath.Join(sd+`\`, "$Recycle.Bin"), filepath.Join(sd+`\`, "System Volume Information"))
	}
	return deny, hide
}

// hiddenByOS skips files Windows marks hidden or system (NTUSER.DAT,
// desktop.ini and friends).
func hiddenByOS(fi fs.FileInfo) bool {
	if d, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		return d.FileAttributes&(syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_SYSTEM) != 0
	}
	return false
}
