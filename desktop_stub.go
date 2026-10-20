//go:build !desktop

package main

import "errors"

// hasWindow: this build has no window (tests, dev mode, `make build`).
const hasWindow = false

func runDesktop(bool, string) error { return errors.New("built without the desktop window") }
