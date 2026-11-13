package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const castTestUSN = "uuid:7f3a2b1c-0000-1111-2222-334455667788::urn:schemas-upnp-org:service:AVTransport:1"

const castTestDescription = `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>客厅电视</friendlyName>
    <UDN>uuid:7f3a2b1c-0000-1111-2222-334455667788</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <SCPDURL>/rc/desc.xml</SCPDURL>
        <controlURL>/rc/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <SCPDURL>/avt/AVTransport.xml</SCPDURL>
        <controlURL>/avt/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

// castFakeRenderer is a minimal DLNA MediaRenderer AVTransport endpoint.
type castFakeRenderer struct {
	mu      sync.Mutex
	actions []string
	bodies  []string
}

func (f *castFakeRenderer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	action := strings.Trim(r.Header.Get("SOAPAction"), `"`)
	if i := strings.LastIndex(action, "#"); i >= 0 {
		action = action[i+1:]
	}
	f.mu.Lock()
	f.actions = append(f.actions, action)
	f.bodies = append(f.bodies, string(body))
	f.mu.Unlock()
	w.Header().Set("Content-Type", `text/xml; charset="utf-8"`)
	if action == "GetPositionInfo" {
		fmt.Fprint(w, `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><RelTime>00:00:05</RelTime><TrackDuration>00:01:00</TrackDuration><TrackNumber>1</TrackNumber></u:GetPositionInfoResponse></s:Body></s:Envelope>`)
		return
	}
	fmt.Fprint(w, `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"></u:Response></s:Body></s:Envelope>`)
}

func (f *castFakeRenderer) count(action string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, got := range f.actions {
		if got == action {
			n++
		}
	}
	return n
}

func (f *castFakeRenderer) lastBody(action string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.actions) - 1; i >= 0; i-- {
		if f.actions[i] == action {
			return f.bodies[i]
		}
	}
	return ""
}

// isolateCastSvc resets the package-level cast service for one test and
// restores every field (plus the swappable LAN IP probe) on cleanup.
func isolateCastSvc(t *testing.T) {
	t.Helper()
	oldIP := castLANIPv4
	castLANIPv4 = func() (string, error) { return "127.0.0.1", nil }
	castSvc.mu.Lock()
	oldDevices, oldAt, oldSession, oldPort, oldSrv := castSvc.devices, castSvc.devicesAt, castSvc.session, castSvc.lanPort, castSvc.lanSrv
	castSvc.devices = nil
	castSvc.devicesAt = time.Time{}
	castSvc.session = nil
	castSvc.lanPort = 0
	castSvc.lanSrv = nil
	castSvc.mu.Unlock()
	t.Cleanup(func() {
		castLANIPv4 = oldIP
		castSvc.mu.Lock()
		liveSrv := castSvc.lanSrv
		castSvc.devices, castSvc.devicesAt, castSvc.session, castSvc.lanPort, castSvc.lanSrv = oldDevices, oldAt, oldSession, oldPort, oldSrv
		castSvc.mu.Unlock()
		if liveSrv != nil && liveSrv != oldSrv {
			_ = liveSrv.Close()
		}
	})
}

func castCacheDevice(controlURL string) {
	castSvc.mu.Lock()
	castSvc.devices = []castDevice{{USN: castTestUSN, Name: "Test TV", Host: "192.168.1.50:8080", ControlURL: controlURL}}
	castSvc.devicesAt = time.Now()
	castSvc.mu.Unlock()
}

func castDecode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return out
}

func castDecodeData(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	out := castDecode(t, rec)
	if out["ok"] != true {
		t.Fatalf("ok = %v, body = %s", out["ok"], rec.Body.String())
	}
	data, ok := out["data"].(map[string]any)
	if !ok {
		t.Fatalf("missing data object: %s", rec.Body.String())
	}
	return data
}

func TestCastValidateMediaPath(t *testing.T) {
	cases := []struct {
		media string
		valid bool
	}{
		{"/minireel-proxy/media/abc123.mp4", true},
		{"/minireel-proxy/media/token-1_2.mp4", true},
		{"/minireel-proxy/media/", false},
		{"/minireel-proxy/media/../secret", false},
		{"/minireel-proxy/media/a/../../b.mp4", false},
		{"/minireel-proxy/media/evil\r\nX: 1", false},
		{"/other/path/x.mp4", false},
		{"http://evil/minireel-proxy/media/x.mp4", false},
		{"/minireel-proxy/mediaX/abc", false},
		{"", false},
	}
	for _, tc := range cases {
		err := castValidateMediaPath(tc.media)
		if tc.valid && err != nil {
			t.Errorf("castValidateMediaPath(%q) = %v, want nil", tc.media, err)
		}
		if !tc.valid && err == nil {
			t.Errorf("castValidateMediaPath(%q) = nil, want error", tc.media)
		}
	}
}

func TestCastIsPrivateLAN(t *testing.T) {
	cases := map[string]bool{
		"192.168.1.5":  true,
		"10.0.0.2":     true,
		"10.255.1.1":   true,
		"172.16.0.1":   true,
		"172.31.9.9":   true,
		"172.15.0.1":   false,
		"172.32.0.1":   false,
		"8.8.8.8":      false,
		"169.254.1.1":  false,
		"not-an-ip":    false,
	}
	for ip, want := range cases {
		if got := castIsPrivateLAN(ip); got != want {
			t.Errorf("castIsPrivateLAN(%q) = %v, want %v", ip, got, want)
		}
	}
}

func TestCastBuildDIDL(t *testing.T) {
	didl := castBuildDIDL(`标题<&>"`, "http://192.168.1.5:9/媒体?a=1&b=2")
	for _, want := range []string{
		`<dc:title>标题&lt;&amp;&gt;&#34;</dc:title>`,
		`protocolInfo="http-get:*:video/mp4:*"`,
		`<res protocolInfo="http-get:*:video/mp4:*">http://192.168.1.5:9/媒体?a=1&amp;b=2</res>`,
		`urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/`,
	} {
		if !strings.Contains(didl, want) {
			t.Errorf("DIDL missing %q: %s", want, didl)
		}
	}
	if fallback := castBuildDIDL("   ", "http://x/y.mp4"); !strings.Contains(fallback, "<dc:title>hongguo-tv</dc:title>") {
		t.Errorf("empty title should fall back: %s", fallback)
	}
}

func TestCastBuildSOAPBodies(t *testing.T) {
	setURI := castBuildSetURIBody("http://192.168.1.5:9/a&b.mp4", `<DIDL-Lite><dc:title>t</dc:title></DIDL-Lite>`)
	if !strings.Contains(setURI, `<CurrentURI>http://192.168.1.5:9/a&amp;b.mp4</CurrentURI>`) {
		t.Errorf("CurrentURI not escaped: %s", setURI)
	}
	if !strings.Contains(setURI, `<CurrentURIMetaData>&lt;DIDL-Lite&gt;`) {
		t.Errorf("metadata must be escaped once more: %s", setURI)
	}
	if !strings.Contains(setURI, `xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"`) || !strings.Contains(setURI, "<InstanceID>0</InstanceID>") {
		t.Errorf("SetAVTransportURI body malformed: %s", setURI)
	}
	play := castBuildPlayBody()
	if !strings.Contains(play, "<u:Play") || !strings.Contains(play, "<Speed>1</Speed>") || !strings.Contains(play, "<InstanceID>0</InstanceID>") {
		t.Errorf("Play body malformed: %s", play)
	}
	stop := castBuildStopBody()
	if !strings.Contains(stop, "<u:Stop") || !strings.Contains(stop, "<InstanceID>0</InstanceID>") {
		t.Errorf("Stop body malformed: %s", stop)
	}
	get := castBuildGetPositionBody()
	if !strings.Contains(get, "<u:GetPositionInfo") {
		t.Errorf("GetPositionInfo body malformed: %s", get)
	}
	env := castBuildEnvelope("Play", play)
	if !strings.HasPrefix(env, `<?xml version="1.0" encoding="utf-8"?>`) || !strings.Contains(env, `xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"`) || !strings.Contains(env, `<s:Body>`) || !strings.HasSuffix(env, `</s:Envelope>`) {
		t.Errorf("envelope malformed: %s", env)
	}
}

func TestCastParseDeviceDescription(t *testing.T) {
	name, control, err := castParseDeviceDescription([]byte(castTestDescription), "http://192.168.1.50:8080/rootDesc.xml")
	if err != nil {
		t.Fatalf("parse description: %v", err)
	}
	if name != "客厅电视" {
		t.Errorf("friendlyName = %q", name)
	}
	if control != "http://192.168.1.50:8080/avt/control" {
		t.Errorf("relative controlURL not resolved: %q", control)
	}

	// SCPDURL containing AVTransport also identifies the service.
	scpdMatch := strings.Replace(castTestDescription, "<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>", "<serviceType>urn:schemas-upnp-org:service:CustomTransport:1</serviceType>", 1)
	if _, control, err = castParseDeviceDescription([]byte(scpdMatch), "http://192.168.1.50:8080/rootDesc.xml"); err != nil || control != "http://192.168.1.50:8080/avt/control" {
		t.Errorf("SCPDURL match failed: control=%q err=%v", control, err)
	}

	// Absolute controlURLs are kept as-is.
	absolute := strings.Replace(castTestDescription, "<controlURL>/avt/control</controlURL>", "<controlURL>http://10.0.0.9:1234/ctrl</controlURL>", 1)
	if _, control, err = castParseDeviceDescription([]byte(absolute), "http://192.168.1.50:8080/rootDesc.xml"); err != nil || control != "http://10.0.0.9:1234/ctrl" {
		t.Errorf("absolute controlURL rewritten: control=%q err=%v", control, err)
	}

	// Missing friendlyName is tolerated (caller substitutes the host).
	noName := strings.Replace(castTestDescription, "<friendlyName>客厅电视</friendlyName>", "", 1)
	if name, _, err = castParseDeviceDescription([]byte(noName), "http://192.168.1.50:8080/rootDesc.xml"); err != nil || name != "" {
		t.Errorf("missing friendlyName: name=%q err=%v", name, err)
	}

	// No AVTransport service at all.
	noAVT := strings.ReplaceAll(castTestDescription, "AVTransport", "SomethingElse")
	if _, _, err = castParseDeviceDescription([]byte(noAVT), "http://192.168.1.50:8080/rootDesc.xml"); err == nil {
		t.Error("device without AVTransport must error")
	}

	// Malformed XML must error, never panic.
	if _, _, err = castParseDeviceDescription([]byte("<root><device><friendlyName>broken"), "http://192.168.1.50:8080/x.xml"); err == nil {
		t.Error("malformed XML must error")
	}
	if _, _, err = castParseDeviceDescription(nil, "http://192.168.1.50:8080/x.xml"); err == nil {
		t.Error("empty body must error")
	}
}

func TestCastResolveControlURLErrors(t *testing.T) {
	if _, err := castResolveControlURL("not-a-url", "/control"); err == nil {
		t.Error("invalid LOCATION must error")
	}
	if _, err := castResolveControlURL("http://1.2.3.4:80/desc", "http://%zz"); err == nil {
		t.Error("invalid controlURL must error")
	}
	if got, err := castResolveControlURL("http://1.2.3.4:80/desc", "control"); err != nil || got != "http://1.2.3.4:80/control" {
		t.Errorf("relative-without-slash resolution: got %q err %v", got, err)
	}
}

func TestCastFetchDeviceViaHTTP(t *testing.T) {
	var served int32
	desc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/desc.xml" {
			served++
			w.Header().Set("Content-Type", "text/xml")
			fmt.Fprint(w, castTestDescription)
			return
		}
		http.NotFound(w, r)
	}))
	defer desc.Close()
	svc := &castService{httpc: &http.Client{Timeout: 2 * time.Second}}
	device, err := svc.fetchDevice(castSSDPEntry{usn: castTestUSN, location: desc.URL + "/desc.xml"})
	if err != nil {
		t.Fatalf("fetchDevice: %v", err)
	}
	if served != 1 {
		t.Fatalf("description fetched %d times", served)
	}
	if device.Name != "客厅电视" || device.USN != castTestUSN {
		t.Errorf("device = %+v", device)
	}
	if device.ControlURL != desc.URL+"/avt/control" {
		t.Errorf("controlURL = %q, want %q", device.ControlURL, desc.URL+"/avt/control")
	}
	if device.Host == "" || !strings.HasPrefix(device.Host, "127.0.0.1:") {
		t.Errorf("host = %q", device.Host)
	}
	// 404 LOCATION must fail cleanly.
	if _, err := svc.fetchDevice(castSSDPEntry{usn: "u", location: desc.URL + "/missing.xml"}); err == nil {
		t.Error("404 description must error")
	}
}

func TestCastSOAPCallHeadersAndFault(t *testing.T) {
	var gotCT, gotAction string
	var gotBody []byte
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCT = r.Header.Get("Content-Type")
		gotAction = r.Header.Get("SOAPAction")
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", `text/xml; charset="utf-8"`)
		fmt.Fprint(w, `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>`)
	}))
	defer ok.Close()
	if _, err := castSOAPCall(context.Background(), ok.URL, "Play", castBuildPlayBody()); err != nil {
		t.Fatalf("castSOAPCall: %v", err)
	}
	if gotCT != `text/xml; charset="utf-8"` {
		t.Errorf("Content-Type = %q", gotCT)
	}
	if gotAction != `"urn:schemas-upnp-org:service:AVTransport:1#Play"` {
		t.Errorf("SOAPAction = %q", gotAction)
	}
	if !strings.Contains(string(gotBody), "<u:Play") {
		t.Errorf("request body = %s", gotBody)
	}

	fault := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", `text/xml; charset="utf-8"`)
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Invalid action</faultstring></s:Fault></s:Body></s:Envelope>`)
	}))
	defer fault.Close()
	if _, err := castSOAPCall(context.Background(), fault.URL, "Stop", castBuildStopBody()); err == nil || !strings.Contains(err.Error(), "Invalid action") {
		t.Errorf("SOAP fault not surfaced: %v", err)
	}
	if _, err := castSOAPCall(context.Background(), "  ", "Play", castBuildPlayBody()); err == nil {
		t.Error("empty controlURL must error")
	}
}

func TestCastParsePositionInfo(t *testing.T) {
	valid := []byte(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><RelTime>00:12:34</RelTime><TrackDuration>00:45:00</TrackDuration></u:GetPositionInfoResponse></s:Body></s:Envelope>`)
	pos, err := castParsePositionInfo(valid)
	if err != nil || pos.RelTime != "00:12:34" || pos.Duration != "00:45:00" {
		t.Errorf("valid response: pos=%+v err=%v", pos, err)
	}
	// Missing fields must not error or panic.
	missing := []byte(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>`)
	if pos, err = castParsePositionInfo(missing); err != nil || pos.RelTime != "" || pos.Duration != "" {
		t.Errorf("missing fields: pos=%+v err=%v", pos, err)
	}
	if _, err = castParsePositionInfo([]byte("<s:Envelope><<<broken")); err == nil {
		t.Error("malformed SOAP response must error")
	}
}

func TestCastParseSSDPResponse(t *testing.T) {
	message := "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: " + castTestUSN + "\r\nEXT:\r\nLOCATION: http://192.168.1.20:49152/desc.xml\r\n\r\n"
	location, usn, target := castParseSSDPResponse(message)
	if location != "http://192.168.1.20:49152/desc.xml" || usn != castTestUSN || target != castDeviceType {
		t.Errorf("parsed location=%q usn=%q target=%q", location, usn, target)
	}
	// Header names are case-insensitive; missing USN is tolerated.
	lower := "HTTP/1.0 200 OK\r\nlocation: http://10.0.0.5:8080/d\r\n"
	if location, usn, target = castParseSSDPResponse(lower); location != "http://10.0.0.5:8080/d" || usn != "" || target != "" {
		t.Errorf("lowercase headers: location=%q usn=%q target=%q", location, usn, target)
	}
	// NOTIFY broadcasts are parsed too; the NT header carries the target.
	notify := "NOTIFY * HTTP/1.1\r\nNT: " + castDeviceType + "\r\nNTS: ssdp:alive\r\nUSN: " + castTestUSN + "\r\nLOCATION: http://x/y\r\n"
	if location, usn, target = castParseSSDPResponse(notify); location != "http://x/y" || usn != castTestUSN || target != castDeviceType {
		t.Errorf("notify: location=%q usn=%q target=%q", location, usn, target)
	}
	// M-SEARCH requests and other traffic must yield empties.
	if location, usn, target = castParseSSDPResponse("M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n"); location != "" || usn != "" || target != "" {
		t.Errorf("non-response datagram must be ignored: %q %q %q", location, usn, target)
	}
	if location, _, _ = castParseSSDPResponse(""); location != "" {
		t.Errorf("empty datagram: %q", location)
	}
}

func TestCastDevicesEndpointServesCachedList(t *testing.T) {
	isolateCastSvc(t)
	castCacheDevice("http://192.168.1.50:8080/avt/control")
	s := &server{}
	rec := httptest.NewRecorder()
	s.castDevices(rec, httptest.NewRequest(http.MethodGet, "/api/v1/cast/devices", nil))
	data := castDecodeData(t, rec)
	base, _ := data["lan_base"].(string)
	if !strings.HasPrefix(base, "http://127.0.0.1:") || !strings.HasSuffix(base, "/") {
		t.Errorf("lan_base = %q", base)
	}
	raw, _ := json.Marshal(data["devices"])
	var devices []map[string]any
	if err := json.Unmarshal(raw, &devices); err != nil {
		t.Fatalf("devices shape: %v", err)
	}
	if len(devices) != 1 || devices[0]["usn"] != castTestUSN || devices[0]["name"] != "Test TV" || devices[0]["host"] != "192.168.1.50:8080" {
		t.Errorf("devices = %s", raw)
	}
	if strings.Contains(string(raw), "avt/control") {
		t.Errorf("controlURL leaked into JSON: %s", raw)
	}
	rec = httptest.NewRecorder()
	s.castDevices(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cast/devices", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST devices = %d", rec.Code)
	}
}

func TestCastStartStatusStopFlow(t *testing.T) {
	isolateCastSvc(t)
	fake := &castFakeRenderer{}
	deviceServer := httptest.NewServer(fake)
	defer deviceServer.Close()
	castCacheDevice(deviceServer.URL + "/control")
	s := &server{}

	// Reject traversal media paths before touching the device.
	rec := httptest.NewRecorder()
	s.castStart(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cast/start",
		strings.NewReader(`{"usn":"`+castTestUSN+`","media":"/minireel-proxy/media/../x.mp4","title":"t"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad media status = %d body = %s", rec.Code, rec.Body.String())
	}
	if fake.count("SetAVTransportURI") != 0 {
		t.Fatal("device contacted despite invalid media")
	}

	// Unknown usn must 404 without re-running SSDP (cache is fresh).
	rec = httptest.NewRecorder()
	s.castStart(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cast/start",
		strings.NewReader(`{"usn":"uuid:unknown","media":"/minireel-proxy/media/x.mp4","title":"t"}`)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown usn status = %d body = %s", rec.Code, rec.Body.String())
	}

	// Discover the LAN base first, then start a real cast.
	rec = httptest.NewRecorder()
	s.castDevices(rec, httptest.NewRequest(http.MethodGet, "/api/v1/cast/devices", nil))
	base, _ := castDecodeData(t, rec)["lan_base"].(string)

	rec = httptest.NewRecorder()
	s.castStart(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cast/start",
		strings.NewReader(`{"usn":"`+castTestUSN+`","media":"/minireel-proxy/media/token9.mp4","title":"我的<视频>&标题"}`)))
	data := castDecodeData(t, rec)
	wantURL := strings.TrimSuffix(base, "/") + "/minireel-proxy/media/token9.mp4"
	if data["url"] != wantURL || data["name"] != "Test TV" {
		t.Fatalf("start data = %v, want url %q", data, wantURL)
	}
	if fake.count("SetAVTransportURI") != 1 || fake.count("Play") != 1 {
		t.Fatalf("actions = %v", fake.actions)
	}
	setBody := fake.lastBody("SetAVTransportURI")
	if !strings.Contains(setBody, "<CurrentURI>"+strings.ReplaceAll(wantURL, "&", "&amp;")+"</CurrentURI>") {
		t.Errorf("CurrentURI missing in %s", setBody)
	}
	// DIDL 整体作为文本再转义一次：< 变 &lt;，DIDL 内的 &lt; 变 &amp;lt;。
	if !strings.Contains(setBody, "我的&amp;lt;视频&amp;gt;&amp;amp;标题") {
		t.Errorf("double-escaped DIDL title missing in %s", setBody)
	}
	if !strings.Contains(setBody, `protocolInfo=&#34;http-get:*:video/mp4:*&#34;`) {
		t.Errorf("protocolInfo missing in %s", setBody)
	}

	// Status polls position once, then throttles for 2s.
	rec = httptest.NewRecorder()
	s.castStatus(rec, httptest.NewRequest(http.MethodGet, "/api/v1/cast/status", nil))
	data = castDecodeData(t, rec)
	if data["casting"] != true || data["pos"] != "00:00:05" || data["duration"] != "00:01:00" || data["url"] != wantURL {
		t.Fatalf("status data = %v", data)
	}
	if fake.count("GetPositionInfo") != 1 {
		t.Fatalf("first status should poll once, got %d", fake.count("GetPositionInfo"))
	}
	rec = httptest.NewRecorder()
	s.castStatus(rec, httptest.NewRequest(http.MethodGet, "/api/v1/cast/status", nil))
	if castDecodeData(t, rec)["pos"] != "00:00:05" || fake.count("GetPositionInfo") != 1 {
		t.Fatalf("second status must reuse cached position within 2s (count=%d)", fake.count("GetPositionInfo"))
	}

	// Stop clears the session.
	rec = httptest.NewRecorder()
	s.castStop(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cast/stop", strings.NewReader(`{}`)))
	if castDecodeData(t, rec)["stopped"] != true {
		t.Fatalf("stop body = %s", rec.Body.String())
	}
	if fake.count("Stop") != 1 {
		t.Fatalf("device actions = %v", fake.actions)
	}
	rec = httptest.NewRecorder()
	s.castStatus(rec, httptest.NewRequest(http.MethodGet, "/api/v1/cast/status", nil))
	data = castDecodeData(t, rec)
	if data["casting"] != false || data["pos"] != "" || data["url"] != "" {
		t.Fatalf("status after stop = %v", data)
	}

	// Stop with an explicit usn works without a session (device cache hit).
	rec = httptest.NewRecorder()
	s.castStop(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cast/stop", strings.NewReader(`{"usn":"`+castTestUSN+`"}`)))
	if rec.Code != http.StatusOK || fake.count("Stop") != 2 {
		t.Fatalf("stop by usn: code=%d actions=%v", rec.Code, fake.actions)
	}
}

func TestCastStopWithoutSession(t *testing.T) {
	isolateCastSvc(t)
	s := &server{}
	rec := httptest.NewRecorder()
	s.castStop(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cast/stop", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty stop code = %d body = %s", rec.Code, rec.Body.String())
	}
	if out := castDecode(t, rec); out["ok"] != false {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCastStartPropagatesSOAPFailure(t *testing.T) {
	isolateCastSvc(t)
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer broken.Close()
	castCacheDevice(broken.URL + "/control")
	s := &server{}
	rec := httptest.NewRecorder()
	s.castStart(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cast/start",
		strings.NewReader(`{"usn":"`+castTestUSN+`","media":"/minireel-proxy/media/x.mp4","title":"t"}`)))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("SOAP failure code = %d body = %s", rec.Code, rec.Body.String())
	}
	castSvc.mu.Lock()
	session := castSvc.session
	castSvc.mu.Unlock()
	if session != nil {
		t.Fatal("failed start must not record a session")
	}
}
