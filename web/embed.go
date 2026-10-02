// Package web embeds the built frontend (web/dist).
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist returns the built frontend rooted at dist/.
func Dist() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}
