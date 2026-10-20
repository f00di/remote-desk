package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"remote-desk/internal/config"
)

type fixture struct {
	root, outside, agent string
	fs                   *FS
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func setup(t *testing.T) fixture {
	t.Helper()
	base := t.TempDir()
	f := fixture{
		root:    filepath.Join(base, "share"),
		outside: filepath.Join(base, "secret"),
	}
	f.agent = filepath.Join(f.root, "agentdata")
	write(t, filepath.Join(f.root, "Docs", "report.pdf"), "%PDF")
	write(t, filepath.Join(f.root, "Docs", "notes.txt"), "hello")
	write(t, filepath.Join(f.root, ".ssh", "id_rsa"), "key")
	write(t, filepath.Join(f.root, ".env"), "TOKEN=x")
	write(t, filepath.Join(f.root, "photo.JPG"), "jpg")
	write(t, filepath.Join(f.root, "page.html"), "<script>")
	write(t, filepath.Join(f.root, "node_modules", "notes-pkg.txt"), "x")
	write(t, filepath.Join(f.root, "Private", "a.txt"), "x")
	write(t, filepath.Join(f.agent, "pairing.json"), "{}")
	write(t, filepath.Join(f.outside, "secret.txt"), "secret")
	if err := os.Symlink(f.outside, filepath.Join(f.root, "escape")); err != nil {
		t.Skip("symlinks not available:", err)
	}
	if err := os.Symlink(filepath.Join(f.root, "Docs"), filepath.Join(f.root, "inside-link")); err != nil {
		t.Fatal(err)
	}
	f.fs = New([]config.Root{{Name: "Share", Path: f.root}}, f.agent)
	return f
}

func TestResolve(t *testing.T) {
	f := setup(t)
	ok := []string{"", "Docs", "Docs/report.pdf", "/Docs/notes.txt", "inside-link/notes.txt", "photo.JPG"}
	for _, p := range ok {
		if _, err := f.fs.Resolve(0, p); err != nil {
			t.Errorf("Resolve(%q) = %v, want ok", p, err)
		}
	}
	bad := map[string]error{
		"../secret/secret.txt":   ErrBadPath,
		"Docs/../../secret":      ErrBadPath,
		"Docs/../..":             ErrBadPath,
		"a\x00b":                 ErrBadPath,
		".ssh/id_rsa":            ErrDenied,
		".env":                   ErrDenied,
		"Docs/.hidden":           ErrDenied,
		"escape/secret.txt":      ErrDenied,
		"escape":                 ErrDenied,
		"agentdata/pairing.json": ErrDenied,
		"missing.txt":            ErrNotFound,
	}
	for p, want := range bad {
		if _, err := f.fs.Resolve(0, p); !errors.Is(err, want) {
			t.Errorf("Resolve(%q) = %v, want %v", p, err, want)
		}
	}
	if _, err := f.fs.Resolve(1, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown root: %v", err)
	}
	if _, err := f.fs.Resolve(-1, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("negative root: %v", err)
	}
}

func TestResolveIgnoresCase(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("case-sensitive file system")
	}
	f := setup(t)
	if _, err := os.Stat(filepath.Join(f.root, "AGENTDATA")); err != nil {
		t.Skip("this volume is case-sensitive")
	}
	if _, err := f.fs.Resolve(0, "AGENTDATA/pairing.json"); !errors.Is(err, ErrDenied) {
		t.Errorf("upper-case path to the agent's data = %v, want ErrDenied", err)
	}
}

func TestHideOnlyInsideRoot(t *testing.T) {
	f := setup(t)
	private := filepath.Join(f.fs.roots[0].resolved, "Private")
	f.fs.hide = append(f.fs.hide, private)
	if _, err := f.fs.Resolve(0, "Private/a.txt"); !errors.Is(err, ErrDenied) {
		t.Errorf("hidden folder inside root = %v, want ErrDenied", err)
	}
	// Sharing the hidden folder itself (like iCloud Drive inside ~/Library) works.
	inner := New([]config.Root{{Name: "P", Path: filepath.Join(f.root, "Private")}}, f.agent)
	inner.hide = append(inner.hide, private)
	if _, err := inner.Resolve(0, "a.txt"); err != nil {
		t.Errorf("root inside a hidden folder = %v, want ok", err)
	}
}

func TestList(t *testing.T) {
	f := setup(t)
	entries, err := f.fs.List(0, "")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name)
	}
	want := []string{"Docs", "inside-link", "node_modules", "Private", "page.html", "photo.JPG"}
	if len(names) != len(want) {
		t.Fatalf("List = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("List = %v, want %v", names, want)
		}
	}
	if !entries[0].Dir || entries[0].Kind != "folder" {
		t.Errorf("first entry should be a folder: %+v", entries[0])
	}
	if _, err := f.fs.List(0, "escape"); !errors.Is(err, ErrDenied) {
		t.Errorf("listing a symlink that leaves the root = %v", err)
	}
}

func TestOpen(t *testing.T) {
	f := setup(t)
	file, fi, err := f.fs.Open(0, "page.html")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	if fi.Size() != int64(len("<script>")) {
		t.Errorf("size = %d", fi.Size())
	}
	if _, _, err := f.fs.Open(0, "Docs"); !errors.Is(err, ErrDenied) {
		t.Errorf("opening a folder = %v, want ErrDenied", err)
	}
	if _, _, err := f.fs.Open(0, ".env"); !errors.Is(err, ErrDenied) {
		t.Errorf("opening .env = %v, want ErrDenied", err)
	}
}

func TestKinds(t *testing.T) {
	cases := map[string][2]string{
		"photo.JPG":  {"image", "image/jpeg"},
		"clip.mov":   {"video", "video/quicktime"},
		"report.pdf": {"pdf", "application/pdf"},
		"notes.txt":  {"text", "text/plain; charset=utf-8"},
		"page.html":  {"other", ""},
		"logo.svg":   {"other", ""},
		"cv.docx":    {"other", ""},
		"noext":      {"other", ""},
	}
	for name, want := range cases {
		if k, ct := Kind(name), InlineType(name); k != want[0] || ct != want[1] {
			t.Errorf("%s: kind %q type %q, want %q %q", name, k, ct, want[0], want[1])
		}
	}
}

func TestSearch(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	res := f.fs.Search(ctx, "NOTES", 50)
	if len(res) != 1 || res[0].Path != "Docs/notes.txt" || res[0].RootName != "Share" {
		t.Fatalf("Search(notes) = %+v, want only Docs/notes.txt", res)
	}
	for _, q := range []string{"id_rsa", "secret", ".env", "pairing"} {
		if res := f.fs.Search(ctx, q, 50); len(res) != 0 {
			t.Errorf("Search(%q) found %+v, want nothing", q, res)
		}
	}
	if res := f.fs.Search(ctx, "report pdf", 50); len(res) != 1 {
		t.Errorf("multi-word search = %+v", res)
	}
	if res := f.fs.Search(ctx, "   ", 50); res != nil {
		t.Errorf("blank search = %+v", res)
	}
}
