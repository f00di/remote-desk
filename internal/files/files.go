// Package files decides what the phone may see and reads it. Every path the
// phone sends goes through FS.Resolve; nothing here writes to disk.
package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"remote-desk/internal/config"
)

var (
	ErrNotFound = errors.New("not found")
	ErrDenied   = errors.New("not shared")
	ErrBadPath  = errors.New("bad path")
)

// MaxEntries caps one folder listing.
const MaxEntries = 5000

type root struct {
	name     string
	path     string // as configured
	resolved string // symlinks resolved; "" if missing
}

// FS is the read-only view of the shared folders.
type FS struct {
	roots []root
	// deny is never served, whatever the roots are.
	deny []string
	// hide is skipped when it sits strictly inside a shared root, but a root
	// may itself be inside one (iCloud Drive lives in ~/Library).
	hide []string
}

type RootInfo struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
}

type Entry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"` // unix milliseconds
	Kind  string `json:"kind"`
}

// New builds the view. configDir (the agent's own data) is always denied.
func New(roots []config.Root, configDir string) *FS {
	home, _ := os.UserHomeDir()
	deny, hide := osRules(home)
	f := &FS{}
	for _, p := range append(deny, configDir) {
		f.deny = append(f.deny, resolveOrClean(p))
	}
	for _, p := range hide {
		f.hide = append(f.hide, resolveOrClean(p))
	}
	for _, r := range roots {
		rr := root{name: r.Name, path: r.Path}
		if res, err := filepath.EvalSymlinks(r.Path); err == nil {
			if fi, err := os.Stat(res); err == nil && fi.IsDir() {
				rr.resolved = res
			}
		}
		f.roots = append(f.roots, rr)
	}
	return f
}

func resolveOrClean(p string) string {
	if res, err := filepath.EvalSymlinks(p); err == nil {
		return res
	}
	return filepath.Clean(p)
}

func (f *FS) Roots() []RootInfo {
	out := make([]RootInfo, len(f.roots))
	for i, r := range f.roots {
		out[i] = RootInfo{ID: i, Name: r.name, Available: r.resolved != ""}
	}
	return out
}

func (f *FS) root(id int) (root, error) {
	if id < 0 || id >= len(f.roots) || f.roots[id].resolved == "" {
		return root{}, ErrNotFound
	}
	return f.roots[id], nil
}

// Resolve turns a root id and a slash-separated path relative to it into an
// absolute path the phone is allowed to read.
func (f *FS) Resolve(rootID int, rel string) (string, error) {
	r, err := f.root(rootID)
	if err != nil {
		return "", err
	}
	rel = strings.Trim(rel, "/")
	if strings.ContainsRune(rel, 0) {
		return "", ErrBadPath
	}
	if rel == "" {
		if !f.allowed(r, r.resolved) {
			return "", ErrDenied // e.g. someone shared the agent's own folder
		}
		return r.resolved, nil
	}
	if runtime.GOOS == "windows" && strings.ContainsAny(rel, `\:`) {
		return "", ErrBadPath
	}
	native := filepath.FromSlash(rel)
	if !filepath.IsLocal(native) {
		return "", ErrBadPath
	}
	joined := filepath.Join(r.resolved, native)
	if !f.allowed(r, joined) {
		return "", ErrDenied
	}
	real, err := filepath.EvalSymlinks(joined)
	if errors.Is(err, fs.ErrNotExist) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", ErrDenied
	}
	if !f.allowed(r, real) {
		return "", ErrDenied
	}
	return real, nil
}

// allowed reports whether abs is inside root r and passes every rule.
func (f *FS) allowed(r root, abs string) bool {
	rel, ok := relInside(r.resolved, abs)
	if !ok {
		return false
	}
	if rel != "." {
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			if strings.HasPrefix(part, ".") {
				return false
			}
		}
	}
	for _, d := range f.deny {
		if within(abs, d) {
			return false
		}
	}
	for _, h := range f.hide {
		// Only hide folders that sit strictly inside the root.
		if within(abs, h) && !within(r.resolved, h) {
			return false
		}
	}
	return true
}

// List returns the visible entries of a folder: folders first, then by name.
func (f *FS) List(rootID int, rel string) ([]Entry, error) {
	r, err := f.root(rootID)
	if err != nil {
		return nil, err
	}
	dir, err := f.Resolve(rootID, rel)
	if err != nil {
		return nil, err
	}
	des, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return nil, fs.ErrPermission
		}
		return nil, ErrNotFound
	}
	out := make([]Entry, 0, len(des))
	for _, de := range des {
		if len(out) >= MaxEntries {
			break
		}
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		child := filepath.Join(dir, name)
		if !f.allowed(r, child) {
			continue
		}
		var fi fs.FileInfo
		if de.Type()&fs.ModeSymlink != 0 {
			real, err := filepath.EvalSymlinks(child)
			if err != nil || !f.allowed(r, real) {
				continue
			}
			fi, err = os.Stat(real)
			if err != nil {
				continue
			}
		} else {
			fi, err = de.Info()
			if err != nil {
				continue
			}
		}
		if hiddenByOS(fi) || !(fi.IsDir() || fi.Mode().IsRegular()) {
			continue
		}
		out = append(out, entryOf(name, fi))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// Open opens a regular file for reading.
func (f *FS) Open(rootID int, rel string) (*os.File, fs.FileInfo, error) {
	abs, err := f.Resolve(rootID, rel)
	if err != nil {
		return nil, nil, err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	if !fi.Mode().IsRegular() || hiddenByOS(fi) {
		return nil, nil, ErrDenied
	}
	file, err := os.Open(abs)
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return nil, nil, fs.ErrPermission
		}
		return nil, nil, ErrNotFound
	}
	return file, fi, nil
}

func entryOf(name string, fi fs.FileInfo) Entry {
	e := Entry{Name: name, Dir: fi.IsDir(), MTime: fi.ModTime().UnixMilli()}
	if e.Dir {
		e.Kind = "folder"
	} else {
		e.Size = fi.Size()
		e.Kind = Kind(name)
	}
	return e
}

// relInside returns abs relative to base (keeping abs's spelling) if abs is
// base or inside it.
func relInside(base, abs string) (string, bool) {
	if !within(abs, base) {
		return "", false
	}
	// within may have matched ignoring case; slicing is only safe when the
	// prefix has the same byte length, which is every real-world case.
	if len(abs) < len(base) || !strings.EqualFold(abs[:len(base)], base) {
		r, err := filepath.Rel(base, abs)
		if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			return "", false
		}
		return r, true
	}
	rest := strings.TrimPrefix(abs[len(base):], string(filepath.Separator))
	if rest == "" {
		return ".", true
	}
	return rest, true
}

// within reports whether p is base or inside it. macOS and Windows file
// systems ignore case by default, so the comparison does too.
func within(p, base string) bool {
	if caseInsensitive {
		p, base = strings.ToLower(p), strings.ToLower(base)
	}
	if p == base {
		return true
	}
	if !strings.HasSuffix(base, string(filepath.Separator)) {
		base += string(filepath.Separator)
	}
	return strings.HasPrefix(p, base)
}

var caseInsensitive = runtime.GOOS == "darwin" || runtime.GOOS == "windows"

var kinds = map[string]string{
	"jpg": "image", "jpeg": "image", "png": "image", "gif": "image", "webp": "image",
	"heic": "image", "heif": "image", "avif": "image", "bmp": "image", "tif": "image", "tiff": "image",
	"mp4": "video", "m4v": "video", "mov": "video",
	"mp3": "audio", "m4a": "audio", "aac": "audio", "wav": "audio",
	"pdf": "pdf",
	"txt": "text", "md": "text", "csv": "text", "log": "text", "json": "text",
}

// Kind is the preview type for a file name: image, video, audio, pdf, text
// or other (download only).
func Kind(name string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if k, ok := kinds[ext]; ok {
		return k
	}
	return "other"
}

var mimes = map[string]string{
	"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
	"webp": "image/webp", "heic": "image/heic", "heif": "image/heif", "avif": "image/avif",
	"bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
	"mp4": "video/mp4", "m4v": "video/x-m4v", "mov": "video/quicktime",
	"mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav",
	"pdf": "application/pdf",
}

// InlineType is the Content-Type to show a file inside the app, or "" if it
// must only be downloaded.
func InlineType(name string) string {
	switch Kind(name) {
	case "text":
		return "text/plain; charset=utf-8"
	case "other":
		return ""
	}
	return mimes[strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))]
}
