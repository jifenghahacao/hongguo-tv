package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// The home feed shown history belongs to the device. WebView localStorage dies
// with the ephemeral http://127.0.0.1:<random-port> origin, so the recommend
// filter_ids list must live here to survive app restarts.
const feedHistoryLimit = 150
const feedHistoryPushLimit = 60

type feedHistoryStore struct {
	mu    sync.Mutex
	path  string
	items []string
}

func newFeedHistoryStore(dir string) (*feedHistoryStore, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &feedHistoryStore{path: filepath.Join(dir, "feed-history.json"), items: []string{}}
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var saved struct {
		Items []string `json:"items"`
	}
	if err := json.NewDecoder(io.LimitReader(f, 65536)).Decode(&saved); err != nil {
		return s, nil
	}
	s.items = mergeFeedIDs(nil, saved.Items, feedHistoryLimit)
	return s, nil
}

// mergeFeedIDs prepends ids (most recent first), drops duplicates and
// anything that is not a numeric series id, then caps at limit.
func mergeFeedIDs(current, ids []string, limit int) []string {
	seen := map[string]bool{}
	next := []string{}
	for _, value := range append(append([]string{}, ids...), current...) {
		if !validID(value) || seen[value] {
			continue
		}
		seen[value] = true
		next = append(next, value)
		if len(next) >= limit {
			break
		}
	}
	return next
}

func (s *feedHistoryStore) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.items...)
}

func (s *feedHistoryStore) push(ids []string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := mergeFeedIDs(s.items, ids, feedHistoryLimit)
	if err := atomicPrivateJSON(s.path, struct {
		Items []string `json:"items"`
	}{next}); err != nil {
		return nil, err
	}
	s.items = next
	return append([]string{}, next...), nil
}

func (s *feedHistoryStore) clear() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := atomicPrivateJSON(s.path, struct {
		Items []string `json:"items"`
	}{[]string{}}); err != nil {
		return nil, err
	}
	s.items = []string{}
	return []string{}, nil
}

func (s *server) feedHistory(w http.ResponseWriter, r *http.Request) {
	if s.feedHistoryStore == nil {
		writeError(w, 503, "推荐历史暂不可用")
		return
	}
	var items []string
	var err error
	switch r.Method {
	case http.MethodGet:
		items = s.feedHistoryStore.snapshot()
	case http.MethodPost:
		var request struct {
			IDs []string `json:"ids"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || len(request.IDs) > feedHistoryPushLimit {
			writeError(w, 400, "推荐历史格式不正确")
			return
		}
		items, err = s.feedHistoryStore.push(request.IDs)
	case http.MethodDelete:
		items, err = s.feedHistoryStore.clear()
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err != nil {
		writeError(w, 500, "保存推荐历史失败，请重试")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "data": map[string]any{"items": items, "limit": feedHistoryLimit}})
}
