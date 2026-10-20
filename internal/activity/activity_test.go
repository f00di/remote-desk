package activity

import (
	"testing"
	"time"
)

func TestAddFileOncePerWindow(t *testing.T) {
	dir := t.TempDir()
	l := Open(dir)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return now }

	l.AddFile("Viewed", "Home/a.pdf")
	l.AddFile("Downloaded", "Home/a.pdf") // share-sheet fetch right after the preview
	l.AddFile("Viewed", "Home/b.jpg")
	if got := len(l.Recent(10)); got != 2 {
		t.Fatalf("entries = %d, want 2", got)
	}
	now = now.Add(FileWindow)
	l.AddFile("Downloaded", "Home/a.pdf")
	if got := l.Recent(1)[0]; got.Event != "Downloaded" || got.Detail != "Home/a.pdf" {
		t.Fatalf("after the window: %+v", got)
	}

	// Entries survive a reload from disk.
	if got := len(Open(dir).Recent(10)); got != 3 {
		t.Errorf("reloaded entries = %d, want 3", got)
	}
}
