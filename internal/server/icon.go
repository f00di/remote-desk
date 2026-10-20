package server

import (
	"bytes"
	"embed"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"net/http"
	"sync"
)

// The app icon, a folder with a prompt in it: full-bleed squares for the
// phone's Home Screen (iOS rounds the corners itself) and the macOS
// version, a rounded square with margins, for the Mac app.
//
//go:embed appicon/*.png
var appIcons embed.FS

// serveIcon serves the Home Screen icon at size px (180, 192 or 512).
func serveIcon(size int) http.HandlerFunc {
	b, err := appIcons.ReadFile(fmt.Sprintf("appicon/ios-%d.png", size))
	if err != nil {
		panic(err)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(b)
	}
}

var (
	iconMu    sync.Mutex
	iconCache = map[int][]byte{}
)

// IconPNG is the macOS app icon as a PNG of size×size px. size must divide
// 1024 (16, 32, … 1024); each pixel averages a block of the original.
func IconPNG(size int) []byte {
	iconMu.Lock()
	defer iconMu.Unlock()
	if b, ok := iconCache[size]; ok {
		return b
	}
	b, err := appIcons.ReadFile("appicon/macos-1024.png")
	if err != nil {
		panic(err)
	}
	if size != 1024 {
		b = shrink(b, size)
	}
	iconCache[size] = b
	return b
}

func shrink(b []byte, size int) []byte {
	src, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		panic(err)
	}
	full := image.NewRGBA(src.Bounds()) // premultiplied, so edges average cleanly
	draw.Draw(full, full.Bounds(), src, src.Bounds().Min, draw.Src)
	f := full.Bounds().Dx() / size
	out := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var sum [4]int
			for dy := 0; dy < f; dy++ {
				row := full.Pix[(y*f+dy)*full.Stride+x*f*4:]
				for dx := 0; dx < f*4; dx++ {
					sum[dx%4] += int(row[dx])
				}
			}
			o := out.PixOffset(x, y)
			for c := 0; c < 4; c++ {
				out.Pix[o+c] = uint8((sum[c] + f*f/2) / (f * f))
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, out)
	return buf.Bytes()
}
