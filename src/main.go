package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"time"
)

//go:embed www/*
var embeddedFiles embed.FS

const (
	certFile = "cert.pem"
	keyFile  = "key.pem"
)

func main() {
	dev := flag.Bool("dev", true, "Serve files from www/ directory instead of embedded files")
	addr := flag.String("addr", ":8443", "HTTPS server address")
	mode := flag.String("mode", "local", "Server mode: local or ipkvm")
	flag.Parse()

	// Check and generate certs if needed
	if !fileExists(certFile) || !fileExists(keyFile) {
		fmt.Println("Certificates not found, generating self-signed certificate...")
		if err := generateSelfSignedCert(certFile, keyFile); err != nil {
			log.Fatalf("Failed to generate certificate: %v", err)
		}
	}

	var handler http.Handler
	if *dev {
		fmt.Println("Development mode: serving from www/ directory")
		handler = http.FileServer(http.Dir("www"))
	} else {
		fmt.Println("Production mode: serving embedded files")
		subFS, err := fs.Sub(embeddedFiles, "www")
		if err != nil {
			log.Fatalf("Failed to get sub filesystem: %v", err)
		}
		handler = http.FileServer(http.FS(subFS))
	}

	mux := http.NewServeMux()
	mux.Handle("/", handler)

	if *mode == "ipkvm" {
		// Run precheck for IP-KVM mode
		err := run_dependency_precheck()
		if err != nil {
			log.Fatalf("Precheck failed: %v", err)
			log.Fatal("Please ensure all dependencies are installed and available in PATH")
		}

		// Initialize IP-KVM specific APIs
		fmt.Println("Running in IPKVM mode, visit https://localhost:8443/ to access the KVM interface")
		initializeIpKVMApis(mux)
	} else {
		fmt.Println("Running in local mode, visit https://localhost:8443/ to access the DezKVM-Go local viewer")
	}

	server := &http.Server{
		Addr:    *addr,
		Handler: mux,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}

	fmt.Printf("Starting HTTPS server on %s\n", *addr)
	log.Fatal(server.ListenAndServeTLS(certFile, keyFile))
}

// generateSelfSignedCert creates a self-signed certificate and saves it to the specified paths
func generateSelfSignedCert(certPath, keyPath string) error {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}

	serialNumber, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		return err
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"RedesKVM"},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	// Add localhost as SAN
	template.DNSNames = []string{"localhost"}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	certOut, err := os.Create(certPath)
	if err != nil {
		return err
	}
	defer certOut.Close()
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		return err
	}

	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer keyOut.Close()
	privBytes := x509.MarshalPKCS1PrivateKey(priv)
	if err := pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: privBytes}); err != nil {
		return err
	}

	return nil
}

// run_dependency_precheck checks if required dependencies are available in the system
func run_dependency_precheck() error {
	log.Println("Running precheck...")
	// Dependencies of USB capture card
	if _, err := exec.LookPath("v4l2-ctl"); err != nil {
		return fmt.Errorf("v4l2-ctl not found in PATH")
	}
	if _, err := exec.LookPath("arecord"); err != nil {
		return fmt.Errorf("arecord not found in PATH")
	}
	log.Println("v4l2-ctl and arecord found in PATH.")
	return nil
}

// fileExists checks if a file exists and is not a directory
func fileExists(filename string) bool {
	info, err := os.Stat(filename)
	return err == nil && !info.IsDir()
}
