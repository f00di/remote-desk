//go:build !darwin

package files

import "context"

// indexSearch: no OS index wired up yet (Windows Search is a later step), so
// the caller walks the folders.
func indexSearch(ctx context.Context, dir, word string) ([]string, bool) { return nil, false }
