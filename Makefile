.PHONY: build app install windows test dev clean

build:
	go build -trimpath -o bin/remote-desk .

# bin/Remote Desk.app (macOS)
app:
	sh scripts/macos-app.sh

# Build the app and copy it to ~/Applications. Nothing runs at login.
install:
	sh scripts/macos-app.sh --install

windows:
	GOOS=windows GOARCH=amd64 go build -trimpath -o bin/remote-desk.exe .

test:
	gofmt -l . | (! grep .) || (echo "run gofmt -w ." && exit 1)
	go vet ./...
	go test ./...
	GOOS=windows GOARCH=amd64 go vet ./...
	GOOS=windows GOARCH=amd64 go build -o /dev/null .

# Dev mode against a test folder: make dev ROOT=/path/to/test/folder
dev:
	go run . --dev $(if $(ROOT),--root "$(ROOT)")

clean:
	rm -rf bin
