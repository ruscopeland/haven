# Haven cloud service Dockerfile
# Build stage: compile Go binary
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o server ./cmd/server/

# Runtime stage: minimal image
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/server .

# Release files storage
RUN mkdir -p /app/releases

EXPOSE 8080
CMD ["./server"]
