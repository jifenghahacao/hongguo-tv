//go:build !linux

package main

import "net"

// castSSDPListenPacket is the non-Linux fallback: a plain bind, no socket
// option sharing. Discovery still works for unicast replies.
func castSSDPListenPacket() (net.PacketConn, error) {
	return net.ListenPacket("udp4", "0.0.0.0:1900")
}

func castSSDPJoinGroup(conn net.PacketConn) {}
