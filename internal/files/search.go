package files

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Result is one search hit. Path is relative to the root, slash-separated.
type Result struct {
	Root     int    `json:"root"`
	RootName string `json:"rootName"`
	Path     string `json:"path"`
	Entry
}

// skipDirs are never walked during a search (huge, never what you want).
var skipDirs = map[string]bool{"node_modules": true, "__pycache__": true}

// Search finds files and folders whose name contains every word of q,
// newest first. It uses the OS index where there is one (Spotlight on
// macOS) and falls back to walking the folders within a time budget.
func (f *FS) Search(ctx context.Context, q string, limit int) []Result {
	words := strings.Fields(strings.ToLower(q))
	if len(words) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	seen := map[string]bool{}
	var out []Result
	add := func(id int, abs string) bool {
		if len(out) >= limit {
			return false
		}
		if seen[abs] {
			return true
		}
		r := f.roots[id]
		if !matches(filepath.Base(abs), words) || !f.allowed(r, abs) {
			return true
		}
		fi, err := os.Stat(abs)
		if err != nil || hiddenByOS(fi) || !(fi.IsDir() || fi.Mode().IsRegular()) {
			return true
		}
		rel, ok := relInside(r.resolved, abs)
		if !ok || rel == "." {
			return true
		}
		seen[abs] = true
		out = append(out, Result{Root: id, RootName: r.name, Path: filepath.ToSlash(rel), Entry: entryOf(filepath.Base(abs), fi)})
		return true
	}

	for id, r := range f.roots {
		if r.resolved == "" {
			continue
		}
		if paths, ok := indexSearch(ctx, r.resolved, words[0]); ok && len(paths) > 0 {
			for _, p := range paths {
				if !add(id, p) {
					break
				}
			}
			continue
		}
		f.walk(ctx, id, words, add)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].MTime > out[j].MTime })
	return out
}

func (f *FS) walk(ctx context.Context, id int, words []string, add func(int, string) bool) {
	r := f.roots[id]
	_ = filepath.WalkDir(r.resolved, func(p string, de fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return fs.SkipAll
		}
		if err != nil {
			if de != nil && de.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if p == r.resolved {
			return nil
		}
		name := de.Name()
		if de.IsDir() && (skipDirs[name] || !f.allowed(r, p)) {
			return fs.SkipDir
		}
		if de.Type()&fs.ModeSymlink != 0 {
			return nil // don't follow links while searching
		}
		if matches(name, words) && !add(id, p) {
			return fs.SkipAll
		}
		return nil
	})
}

func matches(name string, words []string) bool {
	n := strings.ToLower(name)
	for _, w := range words {
		if !strings.Contains(n, w) {
			return false
		}
	}
	return true
}
