//go:build !darwin

package files

// FullDiskAccess: only macOS has it.
func FullDiskAccess() *bool { return nil }
