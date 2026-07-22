// Command haven is the Haven desktop application entry point.
// It runs the local API server and serves the React frontend through a Wails webview.
package main

import (
	"context"
	"embed"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ruscopeland/haven-desktop/internal/api"
	"github.com/ruscopeland/haven-desktop/internal/credentials"
	"github.com/ruscopeland/haven-desktop/internal/db"
	"github.com/ruscopeland/haven-desktop/internal/market"
	"github.com/ruscopeland/haven-desktop/internal/trading"
)

// BuildHash is set at build time via -ldflags "-X main.BuildHash=$(git rev-parse HEAD)".
// It is sent to the cloud service during subscription verification for integrity checking.
var BuildHash = "dev"

//go:embed all:frontend/dist
var embeddedAssets embed.FS

func init() {
	var err error
	assets, err = fs.Sub(embeddedAssets, "frontend/dist")
	if err != nil {
		panic("frontend/dist not found in embedded files: " + err.Error())
	}
}

var assets fs.FS

type engineManager struct {
	engine *trading.Engine
}

func (em *engineManager) UpdateChainLive(rpcURL string, chainID int64, privateKeyHex string) error {
	chain, err := trading.NewChain(rpcURL, chainID, privateKeyHex)
	if err != nil {
		return err
	}
	em.engine.UpdateChain(trading.ModeLive, chain)
	return nil
}

func (em *engineManager) UpdateChainDry() {
	em.engine.UpdateChain(trading.ModeDry, nil)
}

func main() {
	// Determine data directory
	dataDir := dataDirectory()
	dbPath := filepath.Join(dataDir, "haven.db")

	// Set up logging
	logDir := filepath.Join(dataDir, "logs")
	os.MkdirAll(logDir, 0755)
	logFile, err := os.OpenFile(filepath.Join(logDir, "haven.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		log.Fatalf("failed to open log file: %v", err)
	}
	defer logFile.Close()

	multiWriter := io.MultiWriter(os.Stdout, logFile)
	logger := slog.New(slog.NewTextHandler(multiWriter, &slog.HandlerOptions{Level: slog.LevelInfo}))

	logger.Info("opening database", "path", dbPath)

	store, err := db.Open(dbPath)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer store.Close()

	// Initialize Engine
	var engine *trading.Engine
	key, err := credentials.Retrieve(credentials.WalletKey)
	if err == nil && key != "" {
		chain, err := trading.NewChain("https://bsc-dataseed.binance.org/", 56, strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(key), "0x"), "0X"))
		if err == nil {
			engine = trading.NewEngine(store, logger, trading.ModeLive, chain)
		} else {
			logger.Error("failed to init live chain, defaulting to dry mode", "error", err)
			engine = trading.NewEngine(store, logger, trading.ModeDry, nil)
		}
	} else {
		engine = trading.NewEngine(store, logger, trading.ModeDry, nil)
	}
	go engine.Start(context.Background(), 10) // 10 second polling

	// Start market data service (non-blocking — fetches in background)
	marketSvc := market.NewService(store, logger)
	go marketSvc.Start(context.Background(), 60)

	// Start local API server on a goroutine
	em := &engineManager{engine: engine}
	apiSrv := api.NewServer(store, logger, marketSvc, em, BuildHash)
	go func() {
		port := os.Getenv("HAVEN_PORT")
		if port == "" {
			port = "8000"
		}
		logger.Info("local API server starting", "port", port)
		httpSrv := &http.Server{Addr: ":" + port, Handler: apiSrv.Handler()}
		if err := httpSrv.ListenAndServe(); err != http.ErrServerClosed {
			logger.Error("api server error", "error", err)
		}
	}()

	// Launch signal handler for graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		os.Exit(0)
	}()

	// Create Wails application
	app := application.New(application.Options{
		Name:        "Haven",
		Description: "Crypto Research & Strategy Workspace",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// Create main window
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Haven",
		Width:     1400,
		Height:    900,
		MinWidth:  1024,
		MinHeight: 680,
		BackgroundColour: application.NewRGB(13, 17, 23),
	})

	if err := app.Run(); err != nil {
		log.Fatalf("application error: %v", err)
	}
}

func dataDirectory() string {
	if dir := os.Getenv("HAVEN_DATA_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("cannot determine home directory: %v", err)
	}
	return filepath.Join(home, ".haven")
}
