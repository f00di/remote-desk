//go:build desktop

package main

import (
	"context"
	"errors"
	goruntime "runtime"
	"sync/atomic"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"remote-desk/internal/server"
)

// hasWindow: this build shows Remote Desk in its own window (build tags
// "desktop,production"; see scripts/macos-app.sh).
const hasWindow = true

// runDesktop runs the agent with its admin page in a native window.
// Closing the window keeps Remote Desk running, so the phone can still
// reach this computer: macOS hides the app (the Dock icon brings it back),
// Windows minimises it. Quit (menu, Cmd+Q or the button on the page) stops it.
func runDesktop(dev bool, devRoot string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ag, err := startAgent(ctx, dev, devRoot)
	if errors.Is(err, errAlreadyRunning) {
		// Started from a terminal while the app runs: show the running one.
		openBrowser(adminURL(ag.cfg))
		return nil
	}
	if err != nil {
		return err
	}
	defer ag.Close()

	var wctx context.Context
	var quitting atomic.Bool
	ag.app.Desktop = true
	ag.app.Quit = func() {
		quitting.Store(true)
		runtime.Quit(wctx)
	}

	var appMenu *menu.Menu
	if goruntime.GOOS == "darwin" {
		appMenu = menu.NewMenuFromItems(menu.AppMenu(), menu.EditMenu(), menu.WindowMenu())
	}

	err = wails.Run(&options.App{
		Title:             "Remote Desk",
		Width:             1280,
		Height:            800,
		MinWidth:          560,
		MinHeight:         560,
		BackgroundColour:  &options.RGBA{R: 0x1f, G: 0x1f, B: 0x1f, A: 0xff}, // Dark Modern, until the page loads
		AssetServer:       &assetserver.Options{Handler: ag.app.DesktopHandler()},
		Menu:              appMenu,
		HideWindowOnClose: goruntime.GOOS == "darwin",
		OnStartup:         func(c context.Context) { wctx = c },
		OnBeforeClose: func(c context.Context) bool {
			if goruntime.GOOS == "windows" && !quitting.Load() {
				runtime.WindowMinimise(c)
				return true
			}
			return false
		},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "com.remotedesk.agent",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) {
				runtime.WindowUnminimise(wctx)
				runtime.Show(wctx)
			},
		},
		Mac: &mac.Options{
			// The page draws its own title bar under the traffic lights
			// (and marks it draggable with --wails-draggable).
			TitleBar: mac.TitleBarHidden(),
			About: &mac.AboutInfo{
				Title:   "Remote Desk",
				Message: "Your files on your iPhone, from anywhere. Read-only, one phone, over your own Tailscale network.",
				Icon:    server.IconPNG(256),
			},
		},
	})
	return err
}
