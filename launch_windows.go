package main

const appLaunchEnv = "REMOTE_DESK_APP_LAUNCH"

// launchFromApp: Windows has no app bundle yet; the .exe runs the agent in
// its own console window.
func launchFromApp() error { return run(false, false, "") }
