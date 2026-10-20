package awake

import (
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

const supported = true

const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	setThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")
	getSystemPowerStatus    = kernel32.NewProc("GetSystemPowerStatus")
)

type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

func onAC() bool {
	var s systemPowerStatus
	r, _, _ := getSystemPowerStatus.Call(uintptr(unsafe.Pointer(&s)))
	return r != 0 && s.ACLineStatus == 1
}

// start asks Windows not to sleep while on AC power. The request belongs to
// one OS thread, so a locked goroutine holds it and rechecks the power
// source every 30 seconds.
func start() func() {
	done := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer setThreadExecutionState.Call(esContinuous)
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			if onAC() {
				setThreadExecutionState.Call(esContinuous | esSystemRequired)
			} else {
				setThreadExecutionState.Call(esContinuous)
			}
			select {
			case <-done:
				return
			case <-t.C:
			}
		}
	}()
	return func() { close(done) }
}
