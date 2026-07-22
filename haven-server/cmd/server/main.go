package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ruscopeland/haven-server/internal/assistant"
	"github.com/ruscopeland/haven-server/internal/auth"
	"github.com/ruscopeland/haven-server/internal/release"
	"github.com/ruscopeland/haven-server/internal/subscription"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	// Required configuration
	clerkSecret := requireEnv("CLERK_SECRET_KEY")
	clerkPublishable := os.Getenv("CLERK_PUBLISHABLE_KEY")
	if clerkPublishable == "" {
		clerkPublishable = os.Getenv("CLERK_FRONTEND_API")
	}
	verifier := auth.NewClerkVerifier(clerkSecret, clerkPublishable, logger)
	releaseDir := requireEnv("RELEASE_DIR")
	port := envOrDefault("PORT", "8080")
	deepseekKey := requireEnv("DEEPSEEK_API_KEY")

	// Optional configuration
	releasePublicKey := os.Getenv("RELEASE_PUBLIC_KEY")
	latestBuildHash := os.Getenv("LATEST_BUILD_HASH")


	subSvc := subscription.NewService(verifier, clerkSecret, logger, latestBuildHash)
	assistantSvc := assistant.NewService(deepseekKey, logger)
	assistantSvc.SetVerifier(verifier)
	releaseSvc := release.NewService(releaseDir, logger, releasePublicKey)

	mux := http.NewServeMux()

	// Health
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Subscription verification — the gate
	mux.HandleFunc("POST /v1/subscription/verify", subSvc.HandleVerify)

	// LLM proxy
	mux.HandleFunc("POST /v1/assistant/chat", assistantSvc.HandleChat)

	// Release distribution
	mux.HandleFunc("GET /v1/releases/latest", releaseSvc.HandleLatest)
	mux.HandleFunc("GET /v1/releases/{version}/{platform}", releaseSvc.HandleDownload)

	// Middleware chain
	handler := withCORS(withLogging(logger, mux))

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	logger.Info("haven-cloud starting", "port", port)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

func requireEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required environment variable %s is not set", key)
	}
	return v
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func withLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
