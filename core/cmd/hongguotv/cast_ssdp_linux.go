//go:build linux

package main

import (
	"context"
	"log"
	"net"
	"syscall"
)

// castSSDPListenPacket binds UDP :1900 with SO_REUSEADDR so SSDP can be
// shared with other casting apps on the same device.
func castSSDPListenPacket() (net.PacketConn, error) {
	lc := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		var opErr error
		if err := c.Control(func(fd uintptr) {
			opErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
		}); err != nil {
			return err
		}
		return opErr
	}}
	return lc.ListenPacket(context.Background(), "udp4", "0.0.0.0:1900")
}

// castSSDPJoinGroup adds the socket to the SSDP multicast group on the
// default multicast interface (the phone's Wi-Fi), so group-addressed search
// replies and NOTIFY broadcasts reach us. The stdlib dropped
// UDPConn.JoinGroup, so membership goes through the raw socket option.
func castSSDPJoinGroup(conn net.PacketConn) {
	udp, ok := conn.(*net.UDPConn)
	if !ok {
		return
	}
	raw, err := udp.SyscallConn()
	if err != nil {
		log.Printf("cast: ssdp raw conn: %v", err)
		return
	}
	var opErr error
	err = raw.Control(func(fd uintptr) {
		mreq := syscall.IPMreq{Multiaddr: [4]byte{239, 255, 255, 250}}
		opErr = syscall.SetsockoptIPMreq(int(fd), syscall.IPPROTO_IP, syscall.IP_ADD_MEMBERSHIP, &mreq)
	})
	if err != nil {
		log.Printf("cast: ssdp membership control: %v", err)
		return
	}
	if opErr != nil {
		log.Printf("cast: ssdp add membership: %v", opErr)
	}
}
