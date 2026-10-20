// Package config stores the agent's settings in the user's config folder
// (~/Library/Application Support/RemoteDesk on macOS, %AppData%\RemoteDesk on
// Windows). Everything is written 0600 with atomic replaces.
package config

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const DefaultAdminPort = 47800

// Root is a folder shared with the phone.
type Root struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type Config struct {
	// Hostname is the laptop's Tailscale machine name. It is random so the
	// public certificate logs don't carry anyone's name.
	Hostname  string `json:"hostname"`
	Roots     []Root `json:"roots"`
	AdminPort int    `json:"adminPort"`
	KeepAwake bool   `json:"keepAwake"`
	// AdminKey gates the local admin page.
	AdminKey string `json:"adminKey"`
}

// Dir returns the agent's config folder, creating it (0700) if needed.
func Dir(dev bool) (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "RemoteDesk")
	if dev {
		dir = filepath.Join(dir, "dev")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// Load reads config.json from dir, creating defaults on first run.
func Load(dir string) (*Config, error) {
	path := filepath.Join(dir, "config.json")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		c, err := defaults()
		if err != nil {
			return nil, err
		}
		return c, Save(dir, c)
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	changed := false
	if c.Hostname == "" {
		c.Hostname = "rd-" + RandomID(4)
		changed = true
	}
	if c.AdminKey == "" {
		c.AdminKey = RandomID(32)
		changed = true
	}
	if c.AdminPort == 0 {
		c.AdminPort = DefaultAdminPort
		changed = true
	}
	if changed {
		return &c, Save(dir, &c)
	}
	return &c, nil
}

func Save(dir string, c *Config) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(filepath.Join(dir, "config.json"), b)
}

func defaults() (*Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	roots := []Root{{Name: "Home", Path: home}}
	if runtime.GOOS == "darwin" {
		icloud := filepath.Join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")
		if fi, err := os.Stat(icloud); err == nil && fi.IsDir() {
			roots = append(roots, Root{Name: "iCloud Drive", Path: icloud})
		}
	}
	return &Config{
		Hostname:  "rd-" + RandomID(4),
		Roots:     roots,
		AdminPort: DefaultAdminPort,
		KeepAwake: true,
		AdminKey:  RandomID(32),
	}, nil
}

// RandomID returns n random lowercase base32 characters.
func RandomID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	s := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
	return s[:n]
}

// WriteFileAtomic writes data to a temp file next to path and renames it
// into place, so a crash never leaves a half-written file.
func WriteFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
