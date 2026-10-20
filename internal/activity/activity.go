// Package activity records what the phone did (logins, pairing, files
// opened) so the owner can see it on the laptop. Names and paths only, never
// contents, PINs or keys.
package activity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	keep    = 200
	maxFile = 5 << 20
)

type Entry struct {
	Time   time.Time `json:"time"`
	Event  string    `json:"event"`
	Detail string    `json:"detail,omitempty"`
}

type Log struct {
	mu      sync.Mutex
	path    string
	entries []Entry
}

// Open loads the most recent entries from dir/activity.log.
func Open(dir string) *Log {
	l := &Log{path: filepath.Join(dir, "activity.log")}
	if b, err := os.ReadFile(l.path); err == nil {
		for _, line := range splitLines(b) {
			var e Entry
			if json.Unmarshal(line, &e) == nil {
				l.entries = append(l.entries, e)
			}
		}
		if len(l.entries) > keep {
			l.entries = l.entries[len(l.entries)-keep:]
		}
	}
	return l
}

func (l *Log) Add(event, detail string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := Entry{Time: time.Now(), Event: event, Detail: detail}
	l.entries = append(l.entries, e)
	if len(l.entries) > keep {
		l.entries = l.entries[len(l.entries)-keep:]
	}
	if fi, err := os.Stat(l.path); err == nil && fi.Size() > maxFile {
		_ = os.Remove(l.path)
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	b, _ := json.Marshal(e)
	_, _ = f.Write(append(b, '\n'))
}

// Recent returns up to n entries, newest first.
func (l *Log) Recent(n int) []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Entry, 0, n)
	for i := len(l.entries) - 1; i >= 0 && len(out) < n; i-- {
		out = append(out, l.entries[i])
	}
	return out
}

func splitLines(b []byte) [][]byte {
	var out [][]byte
	start := 0
	for i, c := range b {
		if c == '\n' {
			if i > start {
				out = append(out, b[start:i])
			}
			start = i + 1
		}
	}
	if start < len(b) {
		out = append(out, b[start:])
	}
	return out
}
