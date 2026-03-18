//go:build !linux
// +build !linux

package main

import (
	"log"
	"net/http"
)

func initializeIpKVMApis(mux *http.ServeMux) {
	log.Fatal("IP-KVM mode is only supported on Linux")
}
