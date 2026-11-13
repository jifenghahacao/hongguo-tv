package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// Mobile UI preferences (playback speed, quality, danmaku, auto-next) belong
// to the device. WebView localStorage dies with the ephemeral
// http://127.0.0.1:<random-port> origin, so a cold app restart silently reset
// the user's chosen speed back to 1x. This store keeps the whole blob in the
// data dir so the global speed survives restarts.
const uiSettingsLimit = 8192

type uiSettingsStore struct {
	mu   sync.Mutex
	path string
	data map[string]json.RawMessage
}

func newUISettingsStore(dir string) (*uiSettingsStore, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &uiSettingsStore{path: filepath.Join(dir, "ui-settings.json"), data: map[string]json.RawMessage{}}
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var saved struct {
		Settings map[string]json.RawMessage `json:"settings"`
	}
	if err := json.NewDecoder(io.LimitReader(f, uiSettingsLimit)).Decode(&saved); err == nil && saved.Settings != nil {
		s.data = saved.Settings
	}
	return s, nil
}

func (s *uiSettingsStore) snapshot() map[string]json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]json.RawMessage, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}

func (s *uiSettingsStore) replace(settings map[string]json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := atomicPrivateJSON(s.path, struct {
		Settings map[string]json.RawMessage `json:"settings"`
	}{settings}); err != nil {
		return err
	}
	s.data = settings
	return nil
}

func (s *server) uiSettings(w http.ResponseWriter, r *http.Request) {
	if s.uiSettingsStore == nil {
		writeError(w, 503, "设置暂不可用")
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]any{"ok": true, "data": map[string]any{"settings": s.uiSettingsStore.snapshot()}})
	case http.MethodPost:
		var request struct {
			Settings map[string]json.RawMessage `json:"settings"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, uiSettingsLimit)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || request.Settings == nil {
			writeError(w, 400, "设置格式不正确")
			return
		}
		if err := s.uiSettingsStore.replace(request.Settings); err != nil {
			writeError(w, 500, "保存设置失败，请重试")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "data": map[string]any{"settings": request.Settings}})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
