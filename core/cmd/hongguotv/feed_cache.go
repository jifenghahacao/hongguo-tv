package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Cold-start speed. The WebView origin is ephemeral (random core port each
// launch), so localStorage never survives a restart and every launch paid the
// full upstream latency twice: recommendations (~1.4s) before any card could
// render, then play/info (~1.6s) before the first frame. These disk caches in
// the data dir let the UI paint the previous batch immediately and, within a
// short TTL, reuse freshly signed play URLs.

const feedCacheLimit = 512 * 1024
const feedCacheMaxItems = 24

type feedCacheStore struct {
	mu    sync.Mutex
	path  string
	items []json.RawMessage
	ts    int64
}

func newFeedCacheStore(dir string) (*feedCacheStore, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &feedCacheStore{path: filepath.Join(dir, "feed-cache.json")}
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var saved struct {
		Items []json.RawMessage `json:"items"`
		Ts    int64             `json:"ts"`
	}
	if err := json.NewDecoder(io.LimitReader(f, feedCacheLimit)).Decode(&saved); err == nil {
		s.items = saved.Items
		s.ts = saved.Ts
	}
	return s, nil
}

func (s *feedCacheStore) snapshot() ([]json.RawMessage, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items, s.ts
}

func (s *feedCacheStore) replace(items []json.RawMessage) error {
	if len(items) > feedCacheMaxItems {
		items = items[:feedCacheMaxItems]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := atomicPrivateJSON(s.path, struct {
		Items []json.RawMessage `json:"items"`
		Ts    int64             `json:"ts"`
	}{items, time.Now().UnixMilli()}); err != nil {
		return err
	}
	s.items = items
	return nil
}

func (s *server) feedCache(w http.ResponseWriter, r *http.Request) {
	if s.feedCacheStore == nil {
		writeError(w, 503, "缓存暂不可用")
		return
	}
	switch r.Method {
	case http.MethodGet:
		items, ts := s.feedCacheStore.snapshot()
		writeJSON(w, 200, map[string]any{"ok": true, "data": map[string]any{"items": items, "ts": ts}})
	case http.MethodPost:
		var request struct {
			Items []json.RawMessage `json:"items"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, feedCacheLimit)
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.Items == nil {
			writeError(w, 400, "缓存格式不正确")
			return
		}
		if err := s.feedCacheStore.replace(request.Items); err != nil {
			writeError(w, 500, "保存缓存失败")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// Signed play URLs stay valid for far longer than this window; the UI also
// retries with nc=1 (cache bypass) if a reused link ever turns out dead.
const playCacheTTL = 20 * time.Minute
const playCacheMax = 48
const playCacheFileLimit = 1 << 20

type playCacheEntry struct {
	Info json.RawMessage `json:"info"`
	Ts   int64           `json:"ts"`
}

type playCacheStore struct {
	mu   sync.Mutex
	path string
	data map[string]playCacheEntry
}

func newPlayCacheStore(dir string) (*playCacheStore, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &playCacheStore{path: filepath.Join(dir, "play-cache.json"), data: map[string]playCacheEntry{}}
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var saved map[string]playCacheEntry
	if err := json.NewDecoder(io.LimitReader(f, playCacheFileLimit)).Decode(&saved); err == nil && saved != nil {
		s.data = saved
	}
	return s, nil
}

func playCacheKey(q interface{ Get(string) string }) string {
	parts := make([]string, 0, 7)
	for _, name := range []string{"series_id", "vid", "quality", "codec_mode", "content_type", "mode", "fallback"} {
		parts = append(parts, q.Get(name))
	}
	return strings.Join(parts, "|")
}

func (s *playCacheStore) get(key string) (json.RawMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.data[key]
	if !ok || time.Now().UnixMilli()-e.Ts > playCacheTTL.Milliseconds() || len(e.Info) == 0 {
		return nil, false
	}
	return e.Info, true
}

func (s *playCacheStore) put(key string, info json.RawMessage) {
	s.mu.Lock()
	s.data[key] = playCacheEntry{Info: info, Ts: time.Now().UnixMilli()}
	if len(s.data) > playCacheMax {
		// Evict oldest entries first, pruning in bulk down to the cap.
		keys := make([]string, 0, len(s.data))
		for k := range s.data {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return s.data[keys[i]].Ts < s.data[keys[j]].Ts })
		for _, k := range keys[:len(keys)-playCacheMax] {
			delete(s.data, k)
		}
	}
	s.mu.Unlock()
	// Persist immediately: Android force-stop kills the process without
	// running any shutdown hook, so a flush-on-exit cache never survives.
	go s.flush()
}

func (s *playCacheStore) flush() {
	s.mu.Lock()
	data := make(map[string]playCacheEntry, len(s.data))
	for k, v := range s.data {
		data[k] = v
	}
	s.mu.Unlock()
	_ = atomicPrivateJSON(s.path, data)
}
