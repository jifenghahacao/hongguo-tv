package main

// DLNA screen casting for the TV core.
//
// The main listener stays bound to 127.0.0.1 (see runtime.go); casting needs
// a second, deliberately LAN-exposed http.Server that only re-serves the
// /minireel-proxy/media/ prefix so a MediaRenderer on the same network can
// pull the same Range-enabled stream the WebView plays locally.
//
// Discovery is SSDP M-SEARCH for MediaRenderer devices; control is plain
// SOAP 1.1 against each device's AVTransport controlURL. Everything here is
// standard library only so the file also compiles into the Android
// libhongguotv.so via gomobile c-shared.

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// castMediaPrefix is the only path the LAN media server exposes.
	castMediaPrefix = "/minireel-proxy/media/"
	// castDeviceType is the SSDP search target for DLNA renderers.
	castDeviceType = "urn:schemas-upnp-org:device:MediaRenderer:1"
	// castAVTransportNS is the AVTransport service urn used for SOAP control.
	castAVTransportNS = "urn:schemas-upnp-org:service:AVTransport:1"
	castSSDPAddr      = "239.255.255.250:1900"
	castSearchWindow  = 3500 * time.Millisecond
	castCacheTTL      = 5 * time.Minute
	castSOAPTimeout   = 5 * time.Second
	castDescTimeout   = 3 * time.Second
	// castPosTTL throttles GetPositionInfo SOAP calls behind /cast/status.
	castPosTTL = 2 * time.Second
	// castMaxBody caps every device response we parse.
	castMaxBody = 512 << 10
)

// castDevice is one discovered DLNA MediaRenderer.
type castDevice struct {
	USN        string `json:"usn"`
	Name       string `json:"name"`
	Host       string `json:"host"`
	ControlURL string `json:"-"`
}

// castSession is the active cast target plus the last polled position.
type castSession struct {
	USN        string
	Name       string
	URL        string
	ControlURL string
	Pos        string
	Duration   string
	PosAt      time.Time
	// Played flips true once the renderer reports PLAYING/PAUSED. Until then
	// a STOPPED transport state is just buffering after Play, not an ended
	// track, and /cast/status must keep reporting casting=true.
	Played bool
}

// castService owns the LAN server, the device cache and the session. All
// shared fields are guarded by mu; searchMu serialises SSDP discovery so a
// refresh storm does not fire parallel multicast searches.
type castService struct {
	mu            sync.Mutex
	lanSrv        *http.Server
	lanPort       int
	lanIPOverride string
	devices       []castDevice
	devicesAt     time.Time
	session       *castSession
	searchMu      sync.Mutex
	httpc         *http.Client
}

// setLANIP records the IPv4 handed down by the host app. Android SELinux
// blocks Go's net.Interfaces(), so the WebView bridge passes the Wi-Fi
// address through the ?lan_ip= query parameter instead.
func (c *castService) setLANIP(ip string) {
	if net.ParseIP(ip).To4() == nil {
		return
	}
	c.mu.Lock()
	c.lanIPOverride = ip
	c.mu.Unlock()
}

var castSvc = &castService{httpc: &http.Client{Timeout: castDescTimeout}}

// castLANIPv4 is swappable so tests do not depend on the host network.
var castLANIPv4 = defaultCastLANIPv4

// ensureLAN starts the LAN media server on a random port the first time it
// is needed. The server re-serves handleMiniReelMedia verbatim, so Range
// requests from the renderer keep working without duplicating any logic.
func (c *castService) ensureLAN() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lanPort != 0 {
		return nil
	}
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		return fmt.Errorf("start LAN media server: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc(castMediaPrefix, handleMiniReelMedia)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	c.lanSrv = srv
	c.lanPort = listener.Addr().(*net.TCPAddr).Port
	go func() {
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("cast: LAN media server: %v", err)
		}
	}()
	log.Printf("cast: LAN media server listening on 0.0.0.0:%d", c.lanPort)
	return nil
}

// lanBase returns the absolute base URL renderers must fetch media from.
func (c *castService) lanBase() (string, error) {
	if err := c.ensureLAN(); err != nil {
		return "", err
	}
	c.mu.Lock()
	ip := c.lanIPOverride
	port := c.lanPort
	c.mu.Unlock()
	if ip == "" {
		var err error
		ip, err = castLANIPv4()
		if err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("http://%s:%d/", ip, port), nil
}

// defaultCastLANIPv4 enumerates interfaces and returns the first non-loopback
// IPv4, preferring the private ranges a home LAN actually uses.
func defaultCastLANIPv4() (string, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return "", fmt.Errorf("list network interfaces: %w", err)
	}
	fallback := ""
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ip := castAddrIP(addr)
			if ip == nil {
				continue
			}
			s := ip.String()
			if castIsPrivateLAN(s) {
				return s, nil
			}
			if fallback == "" {
				fallback = s
			}
		}
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", errors.New("no LAN IPv4 address available for casting")
}

func castAddrIP(addr net.Addr) net.IP {
	switch v := addr.(type) {
	case *net.IPNet:
		return castLANIPv4Candidate(v.IP)
	case *net.IPAddr:
		return castLANIPv4Candidate(v.IP)
	}
	return nil
}

func castLANIPv4Candidate(ip net.IP) net.IP {
	if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return nil
	}
	return ip.To4()
}

// castIsPrivateLAN reports 192.168.0.0/16, 10.0.0.0/8 and 172.16.0.0/12.
func castIsPrivateLAN(ip string) bool {
	if strings.HasPrefix(ip, "192.168.") || strings.HasPrefix(ip, "10.") {
		return true
	}
	if strings.HasPrefix(ip, "172.") {
		parts := strings.Split(ip, ".")
		if len(parts) >= 2 {
			if second, err := strconv.Atoi(parts[1]); err == nil && second >= 16 && second <= 31 {
				return true
			}
		}
	}
	return false
}

type castSSDPEntry struct {
	usn      string
	location string
}

// castSSDPSTs are the search targets we probe. Renderers must answer their
// device type, but some firmwares only reply to the generic rootdevice or
// ssdp:all targets, so we probe all three and keep entries whose ST/USN/NT
// names a MediaRenderer before spending a description fetch on them.
var castSSDPSTs = []string{castDeviceType, "upnp:rootdevice", "ssdp:all"}

// castSSDPSocket opens the discovery socket. It prefers binding UDP :1900
// (SO_REUSEADDR on Linux so other cast apps keep working) and joining the
// SSDP multicast group, which is what lets us see both unicast search replies
// and spontaneous NOTIFY broadcasts; several TV firmwares answer only via the
// group. If the bind fails we fall back to an ephemeral unconnected socket,
// which still receives unicast replies.
func castSSDPSocket() (net.PacketConn, error) {
	conn, err := castSSDPListenPacket()
	if err == nil {
		castSSDPJoinGroup(conn)
		return conn, nil
	}
	log.Printf("cast: ssdp bind :1900 failed (%v); using ephemeral socket", err)
	return net.ListenPacket("udp4", ":0")
}

// castSSDPSearch multicasts the M-SEARCH rounds and collects responses for
// the search window, de-duplicating by LOCATION.
func castSSDPSearch() []castSSDPEntry {
	conn, err := castSSDPSocket()
	if err != nil {
		log.Printf("cast: ssdp socket: %v", err)
		return nil
	}
	defer conn.Close()
	group := &net.UDPAddr{IP: net.IPv4(239, 255, 255, 250), Port: 1900}
	send := func() {
		for _, st := range castSSDPSTs {
			request := "M-SEARCH * HTTP/1.1\r\n" +
				"HOST: 239.255.255.250:1900\r\n" +
				"MAN: \"ssdp:discover\"\r\n" +
				"MX: 2\r\n" +
				"ST: " + st + "\r\n" +
				"\r\n"
			if _, werr := conn.WriteTo([]byte(request), group); werr != nil {
				log.Printf("cast: ssdp send %s: %v", st, werr)
			}
		}
	}
	send()
	seen := make(map[string]bool)
	entries := make([]castSSDPEntry, 0)
	buf := make([]byte, 4096)
	start := time.Now()
	deadline := start.Add(castSearchWindow)
	resent := false
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		if !resent && time.Since(start) >= castSearchWindow/2 {
			resent = true
			send()
		}
		if remaining > 300*time.Millisecond {
			remaining = 300 * time.Millisecond
		}
		if err := conn.SetReadDeadline(time.Now().Add(remaining)); err != nil {
			break
		}
		n, _, err := conn.ReadFrom(buf)
		if n > 0 {
			location, usn, target := castParseSSDPResponse(string(buf[:n]))
			if location != "" && castSSDPNamesRenderer(usn, target) && !seen[location] {
				seen[location] = true
				if usn == "" {
					usn = location
				}
				entries = append(entries, castSSDPEntry{usn: usn, location: location})
			}
		}
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			log.Printf("cast: ssdp read: %v", err)
			break
		}
	}
	return entries
}

// castSSDPNamesRenderer reports whether one datagram identifies a DLNA
// renderer via its USN device type or its ST/NT search target.
func castSSDPNamesRenderer(usn, target string) bool {
	return strings.Contains(usn, "MediaRenderer") || strings.Contains(target, "MediaRenderer")
}

// castParseSSDPResponse extracts LOCATION/USN plus the search target (ST for
// search replies, NT for NOTIFY broadcasts) from one SSDP datagram. Anything
// that is neither an HTTP/1.x reply nor a NOTIFY request yields empties.
func castParseSSDPResponse(message string) (location, usn, target string) {
	lines := strings.Split(strings.ReplaceAll(message, "\n", "\r\n"), "\r\n")
	if len(lines) == 0 {
		return "", "", ""
	}
	first := strings.ToUpper(lines[0])
	if !strings.HasPrefix(first, "HTTP/1.") && !strings.HasPrefix(first, "NOTIFY ") {
		return "", "", ""
	}
	for _, line := range lines[1:] {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.ToUpper(strings.TrimSpace(key)) {
		case "LOCATION":
			location = strings.TrimSpace(value)
		case "USN":
			usn = strings.TrimSpace(value)
		case "ST", "NT":
			target = strings.TrimSpace(value)
		}
	}
	return location, usn, target
}

// discoverDevices returns the cached device list, re-running SSDP discovery
// when the TTL expired or refresh is requested. Unreachable or malformed
// devices are skipped so one bad renderer never blocks discovery.
func (c *castService) discoverDevices(refresh bool) []castDevice {
	c.mu.Lock()
	if devices, ok := c.cachedDevices(refresh); ok {
		c.mu.Unlock()
		return devices
	}
	c.mu.Unlock()
	c.searchMu.Lock()
	defer c.searchMu.Unlock()
	c.mu.Lock()
	if devices, ok := c.cachedDevices(refresh); ok {
		c.mu.Unlock()
		return devices
	}
	c.mu.Unlock()
	devices := make([]castDevice, 0)
	for _, entry := range castSSDPSearch() {
		device, err := c.fetchDevice(entry)
		if err != nil {
			log.Printf("cast: describe %s: %v", entry.location, err)
			continue
		}
		devices = append(devices, device)
	}
	c.mu.Lock()
	c.devices = devices
	c.devicesAt = time.Now()
	c.mu.Unlock()
	return devices
}

// cachedDevices must be called with c.mu held.
func (c *castService) cachedDevices(refresh bool) ([]castDevice, bool) {
	if refresh || c.devices == nil || time.Since(c.devicesAt) >= castCacheTTL {
		return nil, false
	}
	return c.devices, true
}

func (c *castService) findDevice(usn string) *castDevice {
	devices := c.discoverDevices(false)
	for i := range devices {
		if devices[i].USN == usn {
			device := devices[i]
			return &device
		}
	}
	return nil
}

// fetchDevice GETs the LOCATION description document and extracts the
// friendlyName plus the AVTransport controlURL.
func (c *castService) fetchDevice(entry castSSDPEntry) (castDevice, error) {
	ctx, cancel := context.WithTimeout(context.Background(), castDescTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, entry.location, nil)
	if err != nil {
		return castDevice{}, err
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return castDevice{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return castDevice{}, fmt.Errorf("device description returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, castMaxBody))
	if err != nil {
		return castDevice{}, err
	}
	name, controlURL, err := castParseDeviceDescription(body, entry.location)
	if err != nil {
		return castDevice{}, err
	}
	host := entry.location
	if parsed, perr := url.Parse(entry.location); perr == nil && parsed.Host != "" {
		host = parsed.Host
	}
	if name == "" {
		name = host
	}
	return castDevice{USN: entry.usn, Name: name, Host: host, ControlURL: controlURL}, nil
}

type castRootDevice struct {
	XMLName      xml.Name `xml:"root"`
	FriendlyName string   `xml:"device>friendlyName"`
	Services     []struct {
		ServiceType string `xml:"serviceType"`
		SCPDURL     string `xml:"SCPDURL"`
		ControlURL  string `xml:"controlURL"`
	} `xml:"device>serviceList>service"`
}

// castParseDeviceDescription parses friendlyName and the AVTransport
// controlURL (matched via serviceType or SCPDURL). Malformed or incomplete
// documents return errors instead of panicking.
func castParseDeviceDescription(body []byte, location string) (name, controlURL string, err error) {
	var doc castRootDevice
	if err = xml.Unmarshal(body, &doc); err != nil {
		return "", "", fmt.Errorf("parse device description XML: %w", err)
	}
	for _, service := range doc.Services {
		if !strings.Contains(service.ServiceType, "AVTransport") && !strings.Contains(service.SCPDURL, "AVTransport") {
			continue
		}
		control := strings.TrimSpace(service.ControlURL)
		if control == "" {
			continue
		}
		absolute, rerr := castResolveControlURL(location, control)
		if rerr != nil {
			return "", "", rerr
		}
		return strings.TrimSpace(doc.FriendlyName), absolute, nil
	}
	return "", "", errors.New("device has no AVTransport control URL")
}

// castResolveControlURL resolves a relative controlURL against the LOCATION's
// scheme://host:port origin, per the UPnP description contract.
func castResolveControlURL(location, ref string) (string, error) {
	refURL, err := url.Parse(ref)
	if err != nil {
		return "", fmt.Errorf("invalid controlURL %q: %w", ref, err)
	}
	if refURL.IsAbs() {
		return refURL.String(), nil
	}
	base, err := url.Parse(location)
	if err != nil {
		return "", fmt.Errorf("invalid LOCATION %q: %w", location, err)
	}
	if base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("LOCATION %q has no scheme or host", location)
	}
	origin := &url.URL{Scheme: base.Scheme, Host: base.Host}
	return origin.ResolveReference(refURL).String(), nil
}

// castValidateMediaPath accepts only our own tokenised media prefix and
// rejects any traversal so a caller cannot reach other local routes.
func castValidateMediaPath(media string) error {
	if !strings.HasPrefix(media, castMediaPrefix) || len(media) <= len(castMediaPrefix) {
		return fmt.Errorf("media must start with %s", castMediaPrefix)
	}
	if strings.Contains(media, "..") {
		return errors.New("media path is invalid")
	}
	if strings.ContainsAny(media, "\r\n\x00") {
		return errors.New("media path is invalid")
	}
	return nil
}

// castEscapeXMLText escapes text for embedding into generated XML.
func castEscapeXMLText(s string) string {
	var out strings.Builder
	if err := xml.EscapeText(&out, []byte(s)); err != nil {
		return s
	}
	return out.String()
}

// castBuildDIDL renders the DIDL-Lite metadata for a video/mp4 HTTP resource.
func castBuildDIDL(title, mediaURL string) string {
	name := strings.TrimSpace(title)
	if name == "" {
		name = "hongguo-tv"
	}
	return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
		`<item id="0" parentID="-1" restricted="1">` +
		`<dc:title>` + castEscapeXMLText(name) + `</dc:title>` +
		`<upnp:class>object.item.videoItem</upnp:class>` +
		`<res protocolInfo="http-get:*:video/mp4:*">` + castEscapeXMLText(mediaURL) + `</res>` +
		`</item></DIDL-Lite>`
}

func castBuildSetURIBody(uri, metadata string) string {
	return `<u:SetAVTransportURI xmlns:u="` + castAVTransportNS + `">` +
		`<InstanceID>0</InstanceID>` +
		`<CurrentURI>` + castEscapeXMLText(uri) + `</CurrentURI>` +
		`<CurrentURIMetaData>` + castEscapeXMLText(metadata) + `</CurrentURIMetaData>` +
		`</u:SetAVTransportURI>`
}

func castBuildPlayBody() string {
	return `<u:Play xmlns:u="` + castAVTransportNS + `"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>`
}

func castBuildStopBody() string {
	return `<u:Stop xmlns:u="` + castAVTransportNS + `"><InstanceID>0</InstanceID></u:Stop>`
}

func castBuildGetPositionBody() string {
	return `<u:GetPositionInfo xmlns:u="` + castAVTransportNS + `"><InstanceID>0</InstanceID></u:GetPositionInfo>`
}

func castBuildGetTransportBody() string {
	return `<u:GetTransportInfo xmlns:u="` + castAVTransportNS + `"><InstanceID>0</InstanceID></u:GetTransportInfo>`
}

// castParseTransportState reads CurrentTransportState out of a
// GetTransportInfo SOAP response (PLAYING / PAUSED_PLAYBACK / STOPPED /
// NO_MEDIA_PRESENT on most renderers).
func castParseTransportState(body []byte) (string, error) {
	var envelope struct {
		XMLName xml.Name `xml:"Envelope"`
		Body    struct {
			Response struct {
				State string `xml:"CurrentTransportState"`
			} `xml:"GetTransportInfoResponse"`
		} `xml:"Body"`
	}
	if err := xml.Unmarshal(body, &envelope); err != nil {
		return "", err
	}
	return strings.TrimSpace(envelope.Body.Response.State), nil
}

func castBuildEnvelope(action, body string) string {
	return `<?xml version="1.0" encoding="utf-8"?>` +
		`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
		`<s:Body>` + body + `</s:Body></s:Envelope>`
}

// castSOAPCall performs one AVTransport SOAP 1.1 POST with a 5s timeout and
// surfaces both transport failures and SOAP fault envelopes as errors.
func castSOAPCall(ctx context.Context, controlURL, action, body string) ([]byte, error) {
	if strings.TrimSpace(controlURL) == "" {
		return nil, errors.New("empty controlURL")
	}
	if _, err := url.Parse(controlURL); err != nil {
		return nil, fmt.Errorf("invalid controlURL: %w", err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, castSOAPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, controlURL, strings.NewReader(castBuildEnvelope(action, body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", `text/xml; charset="utf-8"`)
	req.Header.Set("SOAPAction", `"`+castAVTransportNS+`#`+action+`"`)
	client := &http.Client{Timeout: castSOAPTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, castMaxBody))
	if fault := castParseSOAPFault(responseBody); fault != "" {
		return nil, fmt.Errorf("SOAP fault: %s", fault)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("device returned HTTP %d", resp.StatusCode)
	}
	return responseBody, nil
}

func castParseSOAPFault(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var envelope struct {
		Body struct {
			Fault struct {
				FaultString string `xml:"faultstring"`
				FaultCode   string `xml:"faultcode"`
			} `xml:"Fault"`
		} `xml:"Body"`
	}
	if err := xml.Unmarshal(body, &envelope); err != nil {
		return ""
	}
	fault := strings.TrimSpace(envelope.Body.Fault.FaultString)
	if fault == "" && envelope.Body.Fault.FaultCode != "" {
		fault = strings.TrimSpace(envelope.Body.Fault.FaultCode)
	}
	return fault
}

type castPosition struct {
	RelTime  string
	Duration string
}

// castParsePositionInfo reads RelTime/TrackDuration (HH:MM:SS) out of a
// GetPositionInfo SOAP response; missing fields stay empty, never panic.
func castParsePositionInfo(body []byte) (castPosition, error) {
	var envelope struct {
		XMLName xml.Name `xml:"Envelope"`
		Body    struct {
			Response struct {
				RelTime       string `xml:"RelTime"`
				TrackDuration string `xml:"TrackDuration"`
			} `xml:"GetPositionInfoResponse"`
		} `xml:"Body"`
	}
	if err := xml.Unmarshal(body, &envelope); err != nil {
		return castPosition{}, err
	}
	return castPosition{
		RelTime:  strings.TrimSpace(envelope.Body.Response.RelTime),
		Duration: strings.TrimSpace(envelope.Body.Response.TrackDuration),
	}, nil
}

// --- HTTP handlers (registered in main.go) ---

func (s *server) castDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	castSvc.setLANIP(r.URL.Query().Get("lan_ip"))
	base, err := castSvc.lanBase()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	devices := castSvc.discoverDevices(r.URL.Query().Get("refresh") == "1")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{
		"lan_base": base,
		"devices":  devices,
	}})
}

func (s *server) castStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	castSvc.setLANIP(r.URL.Query().Get("lan_ip"))
	var body struct {
		USN   string `json:"usn"`
		Media string `json:"media"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "投屏参数无效")
		return
	}
	usn := strings.TrimSpace(body.USN)
	if usn == "" {
		writeError(w, http.StatusBadRequest, "usn 不能为空")
		return
	}
	if err := castValidateMediaPath(body.Media); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	base, err := castSvc.lanBase()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	device := castSvc.findDevice(usn)
	if device == nil {
		writeError(w, http.StatusNotFound, "未找到投屏设备，请先刷新设备列表")
		return
	}
	mediaURL := strings.TrimSuffix(base, "/") + body.Media
	metadata := castBuildDIDL(body.Title, mediaURL)
	ctx := context.Background()
	if _, err := castSOAPCall(ctx, device.ControlURL, "SetAVTransportURI", castBuildSetURIBody(mediaURL, metadata)); err != nil {
		writeError(w, http.StatusBadGateway, "设置投屏地址失败: "+err.Error())
		return
	}
	if _, err := castSOAPCall(ctx, device.ControlURL, "Play", castBuildPlayBody()); err != nil {
		_, _ = castSOAPCall(ctx, device.ControlURL, "Stop", castBuildStopBody())
		writeError(w, http.StatusBadGateway, "启动播放失败: "+err.Error())
		return
	}
	castSvc.mu.Lock()
	castSvc.session = &castSession{USN: device.USN, Name: device.Name, URL: mediaURL, ControlURL: device.ControlURL}
	castSvc.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{
		"url":  mediaURL,
		"name": device.Name,
	}})
}

func (s *server) castStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		USN string `json:"usn"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
	usn := strings.TrimSpace(body.USN)
	castSvc.mu.Lock()
	session := castSvc.session
	castSvc.mu.Unlock()
	controlURL := ""
	switch {
	case usn == "" && session == nil:
		writeError(w, http.StatusBadRequest, "当前没有投屏会话")
		return
	case usn == "":
		usn = session.USN
		controlURL = session.ControlURL
	case session != nil && session.USN == usn:
		controlURL = session.ControlURL
	default:
		device := castSvc.findDevice(usn)
		if device == nil {
			writeError(w, http.StatusNotFound, "未找到投屏设备")
			return
		}
		controlURL = device.ControlURL
	}
	if _, err := castSOAPCall(context.Background(), controlURL, "Stop", castBuildStopBody()); err != nil {
		writeError(w, http.StatusBadGateway, "停止投屏失败: "+err.Error())
		return
	}
	castSvc.mu.Lock()
	if castSvc.session != nil && castSvc.session.USN == usn {
		castSvc.session = nil
	}
	castSvc.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"stopped": true}})
}

func (s *server) castStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	castSvc.mu.Lock()
	if castSvc.session == nil {
		castSvc.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{
			"casting": false, "name": "", "url": "", "pos": "", "duration": "",
		}})
		return
	}
	// Reserve the refresh slot before the SOAP calls so even failing polls
	// keep the 2s throttle and cannot hammer the device.
	needPos := time.Since(castSvc.session.PosAt) >= castPosTTL
	if needPos {
		castSvc.session.PosAt = time.Now()
	}
	session := *castSvc.session
	castSvc.mu.Unlock()
	casting := true
	if needPos {
		response, err := castSOAPCall(context.Background(), session.ControlURL, "GetPositionInfo", castBuildGetPositionBody())
		if err == nil {
			position, perr := castParsePositionInfo(response)
			if perr == nil {
				castSvc.mu.Lock()
				if castSvc.session != nil && castSvc.session.USN == session.USN {
					castSvc.session.Pos = position.RelTime
					castSvc.session.Duration = position.Duration
				}
				castSvc.mu.Unlock()
				session.Pos = position.RelTime
				session.Duration = position.Duration
			}
		}
		// Transport state tells us whether the renderer finished the track:
		// once something has actually played, STOPPED / NO_MEDIA means the
		// episode ended (or the user stopped it on the TV) — the caller then
		// decides between chaining the next episode and handing back.
		transportResponse, terr := castSOAPCall(context.Background(), session.ControlURL, "GetTransportInfo", castBuildGetTransportBody())
		if terr == nil {
			if state, perr := castParseTransportState(transportResponse); perr == nil {
				castSvc.mu.Lock()
				if castSvc.session != nil && castSvc.session.USN == session.USN {
					switch state {
					case "PLAYING", "PAUSED_PLAYBACK":
						castSvc.session.Played = true
					}
					session.Played = castSvc.session.Played
				}
				castSvc.mu.Unlock()
				if session.Played && (state == "STOPPED" || state == "NO_MEDIA_PRESENT") {
					casting = false
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{
		"casting":  casting,
		"name":     session.Name,
		"url":      session.URL,
		"pos":      session.Pos,
		"duration": session.Duration,
	}})
}
