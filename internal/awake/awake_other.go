//go:build !darwin && !windows

package awake

const supported = false

func start() func() { return func() {} }
