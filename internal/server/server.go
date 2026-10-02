// Package server wires the Fiber app. Multiplayer (WebSocket, lobbies) plugs in here later.
package server

import (
	"os"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/compress"
	"github.com/gofiber/fiber/v3/middleware/logger"
	"github.com/gofiber/fiber/v3/middleware/recover"
	"github.com/gofiber/fiber/v3/middleware/static"

	"airhockey/web"
)

func New() (*fiber.App, error) {
	app := fiber.New(fiber.Config{AppName: "airhockey"})

	app.Use(recover.New())
	app.Use(logger.New())
	app.Use(compress.New())

	api := app.Group("/api")
	api.Get("/health", func(c fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})
	// TODO(multiplayer): app.Get("/ws", ...) and room/lobby routes.

	// WEB_DIR serves the frontend from disk (no rebuild needed); default is the embedded build.
	if dir := os.Getenv("WEB_DIR"); dir != "" {
		app.Use("/", static.New(dir, static.Config{CacheDuration: -1}))
		return app, nil
	}
	dist, err := web.Dist()
	if err != nil {
		return nil, err
	}
	app.Use("/", static.New("", static.Config{FS: dist}))

	return app, nil
}
