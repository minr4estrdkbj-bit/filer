package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web/*
var webFS embed.FS

const (
	DefaultPort      = 8082
	HeartbeatTimeout = 5 * time.Second
)

type FileItem struct {
	Name          string `json:"name"`
	Path          string `json:"path"`
	IsDir         bool   `json:"isDir"`
	IsSymlink     bool   `json:"isSymlink"`
	SymlinkTarget string `json:"symlinkTarget,omitempty"`
	Size          int64  `json:"size"`
	SizeHuman     string `json:"sizeHuman"`
	ModTime       string `json:"modTime"`
	Mode          string `json:"mode"`
	Ext           string `json:"ext"`
}

type LsResponse struct {
	Current string     `json:"current"`
	Parent  string     `json:"parent"`
	Items   []FileItem `json:"items"`
	Error   string     `json:"error,omitempty"`
}

var (
	isPersistentServer bool
	lastHeartbeat      time.Time
	connectedOnce      bool
	stateMu            sync.Mutex
	shutdownChan       = make(chan string, 1)
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "service":
			handleServiceCommand(os.Args[2:])
			return
		case "server":
			handleServerCommand(os.Args[2:])
			return
		}
	}

	fsFlags := flag.NewFlagSet("filer", flag.ExitOnError)
	portFlag := fsFlags.Int("port", DefaultPort, "ポート番号")
	fsFlags.IntVar(portFlag, "p", DefaultPort, "ポート番号 (短縮)")
	appFlag := fsFlags.Bool("app", false, "独立したアプリウィンドウで起動する")
	foregroundFlag := fsFlags.Bool("foreground", false, "フォアグラウンドで実行する")
	fsFlags.BoolVar(foregroundFlag, "f", false, "フォアグラウンドで実行する (短縮)")
	noBrowserFlag := fsFlags.Bool("no-browser", false, "ブラウザを自動起動しない")

	fsFlags.Usage = func() {
		fmt.Fprintf(os.Stderr, "使用法: filer [オプション] [ディレクトリパス]\n\n")
		fmt.Fprintf(os.Stderr, "引数:\n")
		fmt.Fprintf(os.Stderr, "  [ディレクトリパス]  開くフォルダ (省略時はカレントディレクトリ)\n\n")
		fmt.Fprintf(os.Stderr, "サブコマンド:\n")
		fmt.Fprintf(os.Stderr, "  server            常駐バックグラウンドサーバーを起動\n")
		fmt.Fprintf(os.Stderr, "  service install   ログイン時自動起動の常駐サービスを登録・起動\n")
		fmt.Fprintf(os.Stderr, "  service status    常駐サービスの稼働状態を確認\n")
		fmt.Fprintf(os.Stderr, "  service uninstall 常駐サービスを解除・停止\n\n")
		fmt.Fprintf(os.Stderr, "オプション:\n")
		fsFlags.PrintDefaults()
	}

	_ = fsFlags.Parse(os.Args[1:])
	ensureGUIEnv()

	targetDir := "."
	if fsFlags.NArg() > 0 {
		targetDir = fsFlags.Arg(0)
	}

	absDir, err := filepath.Abs(targetDir)
	if err != nil {
		log.Fatalf("パスの解決に失敗しました: %v", err)
	}

	// 1. すでにポート 8082 (または指定ポート) でサーバーが動いているか確認
	if isServerRunning(*portFlag) {
		targetURL := fmt.Sprintf("http://localhost:%d/?cwd=%s", *portFlag, url.QueryEscape(absDir))
		if !*noBrowserFlag {
			openBrowser(targetURL, *appFlag)
		} else {
			fmt.Printf("URL: %s\n", targetURL)
		}
		return
	}

	// 2. バックグラウンド起動処理
	isBg := os.Getenv("_FILER_BACKGROUND_SERVER") == "1"
	if !*foregroundFlag && !isBg {
		launchBackgroundProcess(absDir, *portFlag, *appFlag, *noBrowserFlag)
		return
	}

	// 3. サーバー実行 (オンデマンド)
	runOnDemandServer(absDir, *portFlag, *appFlag, *noBrowserFlag, *foregroundFlag)
}

func isServerRunning(port int) bool {
	client := http.Client{Timeout: 300 * time.Millisecond}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/ping", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func launchBackgroundProcess(targetDir string, port int, appMode bool, noBrowser bool) {
	execPath, err := os.Executable()
	if err != nil {
		log.Fatalf("実行ファイルのパス取得に失敗しました: %v", err)
	}

	args := []string{
		fmt.Sprintf("-port=%d", port),
	}
	if appMode {
		args = append(args, "-app")
	}
	if noBrowser {
		args = append(args, "-no-browser")
	}
	args = append(args, targetDir)

	cmd := exec.Command(execPath, args...)
	cmd.Env = append(os.Environ(), "_FILER_BACKGROUND_SERVER=1")
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		log.Fatalf("バックグラウンド起動に失敗しました: %v", err)
	}

	// サーバーの立ち上がりを少し待つ
	for i := 0; i < 20; i++ {
		time.Sleep(50 * time.Millisecond)
		if isServerRunning(port) {
			break
		}
	}

	targetURL := fmt.Sprintf("http://localhost:%d/?cwd=%s", port, url.QueryEscape(targetDir))
	if !noBrowser {
		openBrowser(targetURL, appMode)
	} else {
		fmt.Printf("URL: %s\n", targetURL)
	}
}

func runOnDemandServer(initialDir string, port int, appMode bool, noBrowser bool, foreground bool) {
	isPersistentServer = false
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("ポートのバインドに失敗しました (%s): %v", addr, err)
	}

	mux := createMux()

	server := &http.Server{
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	targetURL := fmt.Sprintf("http://localhost:%d/?cwd=%s", port, url.QueryEscape(initialDir))

	if foreground {
		fmt.Println("==================================================")
		fmt.Println("🚀 Filer - ファイルマネージャー (フォアグラウンド)")
		fmt.Printf("📁 フォルダ: %s\n", initialDir)
		fmt.Printf("🌐 URL:     %s\n", targetURL)
		fmt.Println("💡 ブラウザを閉じるか Ctrl+C で終了します")
		fmt.Println("==================================================")
		if !noBrowser {
			openBrowser(targetURL, appMode)
		}
	}

	// 終了監視 (ブラウザ離脱/タブ全閉じ)
	go func() {
		time.Sleep(2 * time.Second)
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			stateMu.Lock()
			if connectedOnce && time.Since(lastHeartbeat) > HeartbeatTimeout {
				stateMu.Unlock()
				triggerShutdown("ブラウザが閉じられたため終了しました。")
				return
			}
			stateMu.Unlock()
		}
	}()

	// シグナルハンドラ
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		select {
		case sig := <-sigChan:
			if foreground {
				fmt.Printf("\nシグナルを受信しました (%v)。終了します...\n", sig)
			}
		case reason := <-shutdownChan:
			if foreground {
				fmt.Println(reason)
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = listener.Close()
		os.Exit(0)
	}()

	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("Server error: %v", err)
	}
}

func handleServerCommand(args []string) {
	fsFlags := flag.NewFlagSet("server", flag.ExitOnError)
	portFlag := fsFlags.Int("port", DefaultPort, "ポート番号")
	foregroundFlag := fsFlags.Bool("foreground", false, "フォアグラウンドで実行")
	fsFlags.BoolVar(foregroundFlag, "f", false, "フォアグラウンドで実行 (短縮)")

	_ = fsFlags.Parse(args)

	isBg := os.Getenv("_FILER_BACKGROUND_SERVER") == "1"
	if !*foregroundFlag && !isBg {
		execPath, err := os.Executable()
		if err != nil {
			log.Fatalf("実行ファイルのパス取得に失敗しました: %v", err)
		}

		cmd := exec.Command(execPath, "server", "-f", fmt.Sprintf("-port=%d", *portFlag))
		cmd.Env = append(os.Environ(), "_FILER_BACKGROUND_SERVER=1")
		cmd.Stdin = nil
		cmd.Stdout = nil
		cmd.Stderr = nil
		if err := cmd.Start(); err != nil {
			log.Fatalf("常駐サーバーの起動に失敗しました: %v", err)
		}

		fmt.Println("==================================================")
		fmt.Println("✅ Filer 常駐サーバーをバックグラウンドで起動しました")
		fmt.Printf("🌐 URL: http://localhost:%d/\n", *portFlag)
		fmt.Println("==================================================")
		return
	}

	runPersistentServer(*portFlag, *foregroundFlag)
}

func runPersistentServer(port int, foreground bool) {
	isPersistentServer = true
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("ポートのバインドに失敗しました (%s): %v", addr, err)
	}

	mux := createMux()

	server := &http.Server{
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = listener.Close()
		os.Exit(0)
	}()

	if foreground {
		fmt.Println("==================================================")
		fmt.Println("         Filer 常駐サーバーが起動しました         ")
		fmt.Println("==================================================")
		fmt.Printf("Listening: http://%s/\n", addr)
		fmt.Println("ブラウザでお気に入り登録しておけば、いつでも開けます。")
		fmt.Println("停止するには Ctrl+C を押してください。")
		fmt.Println("==================================================")
	}

	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("Server error: %v", err)
	}
}

func handleServiceCommand(args []string) {
	action := "status"
	if len(args) > 0 {
		action = args[0]
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("ホームディレクトリの取得に失敗しました: %v", err)
	}
	servicePath := filepath.Join(homeDir, ".config", "systemd", "user", "filer.service")

	switch action {
	case "install":
		execPath, err := exec.LookPath("filer")
		if err != nil {
			execPath, err = os.Executable()
			if err != nil {
				log.Fatalf("filer コマンドのパス取得に失敗しました: %v", err)
			}
		}

		_ = os.MkdirAll(filepath.Dir(servicePath), 0755)

		serviceContent := fmt.Sprintf(`[Unit]
Description=Filer Persistent File Manager Server
After=network.target

[Service]
Type=simple
ExecStart=%s server -f
Restart=on-failure
RestartSec=3
PassEnvironment=DISPLAY XAUTHORITY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS

[Install]
WantedBy=default.target
`, execPath)

		if err := os.WriteFile(servicePath, []byte(serviceContent), 0644); err != nil {
			log.Fatalf("サービスファイルの書き込みに失敗しました: %v", err)
		}

		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
		if err := exec.Command("systemctl", "--user", "enable", "--now", "filer.service").Run(); err != nil {
			log.Fatalf("サービスの有効化・起動に失敗しました: %v", err)
		}

		fmt.Println("==================================================")
		fmt.Println("✅ Filer 常駐サービスを登録・起動しました！")
		fmt.Println("🌐 URL: http://localhost:8082/")
		fmt.Println("💡 ブラウザでお気に入りに登録しておけば、")
		fmt.Println("   いつでもワンクリックでファイル一覧を開けます。")
		fmt.Println("")
		fmt.Println("管理コマンド:")
		fmt.Println("  ステータス確認  : filer service status")
		fmt.Println("  サービス一時停止: systemctl --user stop filer")
		fmt.Println("  アンインストール: filer service uninstall")
		fmt.Println("==================================================")

	case "uninstall":
		_ = exec.Command("systemctl", "--user", "disable", "--now", "filer.service").Run()
		_ = os.Remove(servicePath)
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
		fmt.Println("✅ Filer 常駐サービスを停止・削除しました。")

	case "status":
		cmd := exec.Command("systemctl", "--user", "status", "filer.service")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		_ = cmd.Run()

	default:
		fmt.Println("使用方法: filer service [install|uninstall|status]")
	}
}

func triggerShutdown(reason string) {
	if isPersistentServer {
		return
	}
	select {
	case shutdownChan <- reason:
	default:
	}
}

func createMux() *http.ServeMux {
	mux := http.NewServeMux()

	// API
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("pong"))
	})

	mux.HandleFunc("/api/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		stateMu.Lock()
		connectedOnce = true
		lastHeartbeat = time.Now()
		stateMu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("/api/close", func(w http.ResponseWriter, r *http.Request) {
		triggerShutdown("ブラウザが閉じられたため終了しました。")
		w.WriteHeader(http.StatusOK)
	})

	mux.HandleFunc("/api/ls", handleLs)
	mux.HandleFunc("/api/create", handleCreate)
	mux.HandleFunc("/api/rename", handleRename)
	mux.HandleFunc("/api/delete", handleDelete)
	mux.HandleFunc("/api/paste", handlePaste)
	mux.HandleFunc("/api/duplicate", handleDuplicate)

	// 静的アセット配信
	webSubFS, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("埋め込みアセットの読み込みに失敗しました: %v", err)
	}

	fileServer := http.FileServer(http.FS(webSubFS))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			data, err := webSubFS.Open("index.html")
			if err == nil {
				defer data.Close()
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				http.ServeContent(w, r, "index.html", time.Time{}, data.(interface {
					Read([]byte) (int, error)
					Seek(int64, int) (int64, error)
				}))
				return
			}
		}
		fileServer.ServeHTTP(w, r)
	})

	return mux
}

func handleLs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	stateMu.Lock()
	connectedOnce = true
	lastHeartbeat = time.Now()
	stateMu.Unlock()

	targetDir := r.URL.Query().Get("cwd")
	if targetDir == "" {
		homeDir, _ := os.UserHomeDir()
		targetDir = homeDir
	}

	absDir, err := filepath.Abs(targetDir)
	if err != nil {
		http.Error(w, fmt.Sprintf("パスの解決に失敗しました: %v", err), http.StatusBadRequest)
		return
	}

	entries, err := os.ReadDir(absDir)
	if err != nil {
		http.Error(w, fmt.Sprintf("ディレクトリの読み込みに失敗しました: %v", err), http.StatusInternalServerError)
		return
	}

	parent := filepath.Dir(absDir)

	items := make([]FileItem, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		itemPath := filepath.Join(absDir, name)

		isSymlink := (e.Type() & os.ModeSymlink) != 0
		var symlinkTarget string
		if isSymlink {
			if target, err := os.Readlink(itemPath); err == nil {
				symlinkTarget = target
			}
		}

		info, err := e.Info()
		var size int64
		var modTime time.Time
		var mode string

		if err == nil {
			size = info.Size()
			modTime = info.ModTime()
			mode = info.Mode().String()
		} else {
			mode = "----------"
		}

		ext := strings.TrimPrefix(filepath.Ext(name), ".")

		items = append(items, FileItem{
			Name:          name,
			Path:          itemPath,
			IsDir:         e.IsDir(),
			IsSymlink:     isSymlink,
			SymlinkTarget: symlinkTarget,
			Size:          size,
			SizeHuman:     formatSize(size),
			ModTime:       modTime.Format("2006-01-02 15:04:05"),
			Mode:          mode,
			Ext:           ext,
		})
	}

	resp := LsResponse{
		Current: absDir,
		Parent:  parent,
		Items:   items,
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(resp)
}

func formatSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

func ensureGUIEnv() {
	if runtime.GOOS != "linux" {
		return
	}
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		out, err := exec.Command("systemctl", "--user", "show-environment").Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "DISPLAY=") && os.Getenv("DISPLAY") == "" {
					os.Setenv("DISPLAY", strings.TrimPrefix(line, "DISPLAY="))
				}
				if strings.HasPrefix(line, "XAUTHORITY=") && os.Getenv("XAUTHORITY") == "" {
					os.Setenv("XAUTHORITY", strings.TrimPrefix(line, "XAUTHORITY="))
				}
				if strings.HasPrefix(line, "WAYLAND_DISPLAY=") && os.Getenv("WAYLAND_DISPLAY") == "" {
					os.Setenv("WAYLAND_DISPLAY", strings.TrimPrefix(line, "WAYLAND_DISPLAY="))
				}
				if strings.HasPrefix(line, "DBUS_SESSION_BUS_ADDRESS=") && os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
					os.Setenv("DBUS_SESSION_BUS_ADDRESS", strings.TrimPrefix(line, "DBUS_SESSION_BUS_ADDRESS="))
				}
			}
		}

		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			if _, err := os.Stat("/tmp/.X11-unix/X0"); err == nil {
				os.Setenv("DISPLAY", ":0")
			}
		}
		if os.Getenv("XAUTHORITY") == "" {
			home, _ := os.UserHomeDir()
			xauth := filepath.Join(home, ".Xauthority")
			if _, err := os.Stat(xauth); err == nil {
				os.Setenv("XAUTHORITY", xauth)
			}
		}
	}
}

func openBrowser(url string, appMode bool) {
	ensureGUIEnv()
	if appMode && openAppWindow(url) {
		return
	}
	openDefaultBrowser(url)
}

func openAppWindow(url string) bool {
	ensureGUIEnv()
	switch runtime.GOOS {
	case "linux":
		candidates := []string{
			"google-chrome",
			"google-chrome-stable",
			"chromium",
			"chromium-browser",
			"brave-browser",
			"microsoft-edge",
			"msedge",
		}
		for _, name := range candidates {
			if path, err := exec.LookPath(name); err == nil {
				cmd := exec.Command(path, fmt.Sprintf("--app=%s", url))
				if err := cmd.Start(); err == nil {
					return true
				}
			}
		}
	case "darwin":
		candidates := []string{
			"Google Chrome",
			"Chromium",
			"Brave Browser",
			"Microsoft Edge",
		}
		for _, name := range candidates {
			cmd := exec.Command("open", "-na", name, "--args", fmt.Sprintf("--app=%s", url))
			if err := cmd.Start(); err == nil {
				return true
			}
		}
	case "windows":
		candidates := []string{"chrome.exe", "msedge.exe"}
		for _, name := range candidates {
			if path, err := exec.LookPath(name); err == nil {
				cmd := exec.Command(path, fmt.Sprintf("--app=%s", url))
				if err := cmd.Start(); err == nil {
					return true
				}
			}
		}
	}
	return false
}

func openDefaultBrowser(url string) {
	ensureGUIEnv()
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "linux":
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return
		}
		cmd = exec.Command("xdg-open", url)
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return
	}

	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	_ = cmd.Start()
}

type CreateRequest struct {
	Cwd   string `json:"cwd"`
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
}

type RenameRequest struct {
	OldPath string `json:"oldPath"`
	NewName string `json:"newName"`
}

type DeleteRequest struct {
	Path string `json:"path"`
}

type PasteRequest struct {
	Action  string `json:"action"` // "copy" or "move"
	SrcPath string `json:"srcPath"`
	DestDir string `json:"destDir"`
}

type DuplicateRequest struct {
	Path string `json:"path"`
}

func touchActivity() {
	stateMu.Lock()
	connectedOnce = true
	lastHeartbeat = time.Now()
	stateMu.Unlock()
}

func handleCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	touchActivity()

	var req CreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("不正なリクエストです: %v", err), http.StatusBadRequest)
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		http.Error(w, "名前を入力してください", http.StatusBadRequest)
		return
	}

	isDir := req.IsDir
	if strings.HasSuffix(name, "/") {
		isDir = true
		name = strings.TrimSuffix(name, "/")
	}

	cwd, err := filepath.Abs(req.Cwd)
	if err != nil {
		http.Error(w, fmt.Sprintf("無効なディレクトリです: %v", err), http.StatusBadRequest)
		return
	}

	targetPath := filepath.Join(cwd, name)
	if _, err := os.Lstat(targetPath); err == nil {
		http.Error(w, "同名のファイルまたはフォルダが既に存在します", http.StatusConflict)
		return
	}

	if isDir {
		if err := os.MkdirAll(targetPath, 0755); err != nil {
			http.Error(w, fmt.Sprintf("フォルダの作成に失敗しました: %v", err), http.StatusInternalServerError)
			return
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			http.Error(w, fmt.Sprintf("親フォルダの作成に失敗しました: %v", err), http.StatusInternalServerError)
			return
		}
		f, err := os.OpenFile(targetPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err != nil {
			http.Error(w, fmt.Sprintf("ファイルの作成に失敗しました: %v", err), http.StatusInternalServerError)
			return
		}
		_ = f.Close()
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"path":    targetPath,
		"isDir":   isDir,
	})
}

func handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	touchActivity()

	var req RenameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("不正なリクエストです: %v", err), http.StatusBadRequest)
		return
	}

	newName := strings.TrimSpace(req.NewName)
	if newName == "" {
		http.Error(w, "新しい名前を入力してください", http.StatusBadRequest)
		return
	}

	oldPath, err := filepath.Abs(req.OldPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("無効なパスです: %v", err), http.StatusBadRequest)
		return
	}

	if _, err := os.Lstat(oldPath); err != nil {
		http.Error(w, "変更元の項目が見つかりません", http.StatusNotFound)
		return
	}

	dir := filepath.Dir(oldPath)
	newPath := filepath.Join(dir, newName)

	if oldPath == newPath {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "path": newPath})
		return
	}

	if _, err := os.Lstat(newPath); err == nil {
		http.Error(w, "同名の項目が既に存在します", http.StatusConflict)
		return
	}

	if err := os.Rename(oldPath, newPath); err != nil {
		http.Error(w, fmt.Sprintf("名前の変更に失敗しました: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "path": newPath})
}

func handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	touchActivity()

	var req DeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("不正なリクエストです: %v", err), http.StatusBadRequest)
		return
	}

	absPath, err := filepath.Abs(req.Path)
	if err != nil {
		http.Error(w, fmt.Sprintf("無効なパスです: %v", err), http.StatusBadRequest)
		return
	}

	homeDir, _ := os.UserHomeDir()
	if absPath == "/" || absPath == homeDir {
		http.Error(w, "ルートディレクトリやホームディレクトリの削除は許可されていません", http.StatusForbidden)
		return
	}

	if _, err := os.Lstat(absPath); err != nil {
		http.Error(w, "対象が見つかりません", http.StatusNotFound)
		return
	}

	trashed := false
	if gioPath, err := exec.LookPath("gio"); err == nil {
		cmd := exec.Command(gioPath, "trash", absPath)
		if err := cmd.Run(); err == nil {
			trashed = true
		}
	}

	if !trashed {
		if err := os.RemoveAll(absPath); err != nil {
			http.Error(w, fmt.Sprintf("削除に失敗しました: %v", err), http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"trashed": trashed,
	})
}

func handlePaste(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	touchActivity()

	var req PasteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("不正なリクエストです: %v", err), http.StatusBadRequest)
		return
	}

	srcPath, err := filepath.Abs(req.SrcPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("無効な転送元パスです: %v", err), http.StatusBadRequest)
		return
	}

	destDir, err := filepath.Abs(req.DestDir)
	if err != nil {
		http.Error(w, fmt.Sprintf("無効な転送先フォルダです: %v", err), http.StatusBadRequest)
		return
	}

	destInfo, err := os.Stat(destDir)
	if err != nil || !destInfo.IsDir() {
		http.Error(w, "転送先がディレクトリではありません", http.StatusBadRequest)
		return
	}

	rel, err := filepath.Rel(srcPath, destDir)
	if err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
		http.Error(w, "フォルダを自身の中にコピー・移動することはできません", http.StatusBadRequest)
		return
	}

	baseName := filepath.Base(srcPath)
	var destPath string

	if req.Action == "move" {
		destPath = filepath.Join(destDir, baseName)
		if destPath == srcPath {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "destPath": destPath})
			return
		}
		if _, err := os.Lstat(destPath); err == nil {
			destPath = getUniquePath(destDir, baseName)
		}
		if err := os.Rename(srcPath, destPath); err != nil {
			if err := copyEntry(srcPath, destPath); err != nil {
				http.Error(w, fmt.Sprintf("移動に失敗しました: %v", err), http.StatusInternalServerError)
				return
			}
			_ = os.RemoveAll(srcPath)
		}
	} else {
		// copy
		destPath = getUniquePath(destDir, baseName)
		if err := copyEntry(srcPath, destPath); err != nil {
			http.Error(w, fmt.Sprintf("コピーに失敗しました: %v", err), http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success":  true,
		"destPath": destPath,
	})
}

func handleDuplicate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	touchActivity()

	var req DuplicateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("不正なリクエストです: %v", err), http.StatusBadRequest)
		return
	}

	srcPath, err := filepath.Abs(req.Path)
	if err != nil {
		http.Error(w, fmt.Sprintf("無効なパスです: %v", err), http.StatusBadRequest)
		return
	}

	if _, err := os.Lstat(srcPath); err != nil {
		http.Error(w, "対象が見つかりません", http.StatusNotFound)
		return
	}

	dir := filepath.Dir(srcPath)
	name := filepath.Base(srcPath)
	destPath := getDuplicatePath(dir, name)

	if err := copyEntry(srcPath, destPath); err != nil {
		http.Error(w, fmt.Sprintf("複製に失敗しました: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success":  true,
		"destPath": destPath,
	})
}

func getUniquePath(dir, name string) string {
	target := filepath.Join(dir, name)
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		return target
	}

	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)

	for i := 1; ; i++ {
		newName := fmt.Sprintf("%s (%d)%s", base, i, ext)
		newPath := filepath.Join(dir, newName)
		if _, err := os.Lstat(newPath); os.IsNotExist(err) {
			return newPath
		}
	}
}

func getDuplicatePath(dir, name string) string {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	copyName := fmt.Sprintf("%s (copy)%s", base, ext)
	target := filepath.Join(dir, copyName)
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		return target
	}
	for i := 2; ; i++ {
		newName := fmt.Sprintf("%s (copy %d)%s", base, i, ext)
		newPath := filepath.Join(dir, newName)
		if _, err := os.Lstat(newPath); os.IsNotExist(err) {
			return newPath
		}
	}
}

func copyEntry(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}

	if info.Mode()&os.ModeSymlink != 0 {
		link, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(link, dst)
	}

	if info.IsDir() {
		return copyDir(src, dst, info.Mode())
	}

	return copyFile(src, dst, info.Mode())
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

func copyDir(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(dst, mode); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		s := filepath.Join(src, entry.Name())
		d := filepath.Join(dst, entry.Name())
		if err := copyEntry(s, d); err != nil {
			return err
		}
	}
	return nil
}
