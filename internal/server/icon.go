package server

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"sync"
)

var (
	iconMu    sync.Mutex
	iconCache = map[int][]byte{}
)

// serveIcon draws the Home Screen icon (a white folder on teal) at size px.
// iOS rounds the corners itself.
func serveIcon(size int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(IconPNG(size))
	}
}

// IconPNG is the app icon as a PNG of size×size px.
func IconPNG(size int) []byte {
	iconMu.Lock()
	defer iconMu.Unlock()
	if b, ok := iconCache[size]; ok {
		return b
	}
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	bg := color.RGBA{0x14, 0x5c, 0x52, 0xff}
	fg := color.RGBA{0xf6, 0xf3, 0xec, 0xff}
	draw.Draw(img, img.Bounds(), &image.Uniform{bg}, image.Point{}, draw.Src)
	u := func(f float64) int { return int(f * float64(size)) }
	// Folder tab, then body.
	draw.Draw(img, image.Rect(u(0.22), u(0.30), u(0.46), u(0.40)), &image.Uniform{fg}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(u(0.22), u(0.36), u(0.78), u(0.72)), &image.Uniform{fg}, image.Point{}, draw.Src)
	// A down arrow cut into the body: "get it from the laptop".
	cx := u(0.50)
	draw.Draw(img, image.Rect(cx-u(0.025), u(0.44), cx+u(0.025), u(0.58)), &image.Uniform{bg}, image.Point{}, draw.Src)
	for i := 0; i <= u(0.08); i++ {
		y := u(0.56) + i
		draw.Draw(img, image.Rect(cx-u(0.09)+i, y, cx+u(0.09)-i, y+1), &image.Uniform{bg}, image.Point{}, draw.Src)
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	iconCache[size] = buf.Bytes()
	return iconCache[size]
}
