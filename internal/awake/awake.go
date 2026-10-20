// Package awake keeps the laptop from sleeping while it is plugged in, so
// the phone can still reach it. On battery the laptop sleeps as usual.
package awake

import "sync"

type Keeper struct {
	mu      sync.Mutex
	enabled bool
	stop    func()
}

// Set turns keep-awake on or off.
func (k *Keeper) Set(on bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if on == k.enabled {
		return
	}
	k.enabled = on
	if on {
		k.stop = start()
	} else if k.stop != nil {
		k.stop()
		k.stop = nil
	}
}

func (k *Keeper) Enabled() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.enabled
}

// Supported reports whether this OS has a keep-awake implementation.
func Supported() bool { return supported }
