package kvmhid

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

// upgrader is used to upgrade HTTP connections to WebSocket connections
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// hidACKReply is the JSON structure sent back to the client when a command
// with a "rid" field has been processed.
type hidACKReply struct {
	Rid    string `json:"rid"`
	Status string `json:"status"` // "ok" or "error"
}

// HIDWebSocketHandler handles incoming WebSocket connections for HID commands
func (c *Controller) HIDWebSocketHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Failed to upgrade to websocket:", err)
		return
	}
	defer conn.Close()

	// Synchronize websocket writes (consumer ACKs vs. any future server pushes)
	var wsMu sync.Mutex

	// Bounded command queue:
	// When full, the oldest command is dropped so new events are not
	// blocked behind stale ones (e.g. when the remote machine reboots
	// and serial sends start timing out).
	const maxQueueSize = 10
	cmdQueue := make(chan *HIDCommand, maxQueueSize)
	done := make(chan struct{})

	// Consumer goroutine: sends commands to the HID serial device
	go func() {
		defer close(done)
		for cmd := range cmdQueue {
			_, err := c.ConstructAndSendCmd(cmd)

			// If the client requested an ACK (rid is set), send a reply
			if cmd.Rid != "" {
				status := "ok"
				if err != nil {
					status = "error"
				}
				ack := hidACKReply{Rid: cmd.Rid, Status: status}
				wsMu.Lock()
				writeErr := conn.WriteJSON(ack)
				wsMu.Unlock()
				if writeErr != nil {
					log.Println("Error writing ACK:", writeErr)
				}
			} else if err != nil {
				log.Println("Error sending HID command:", err)
			}
		}
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if !strings.Contains(err.Error(), "close") {
				log.Println("Error reading message:", err)
			}
			break
		}

		var hidCmd HIDCommand
		if err := json.Unmarshal(message, &hidCmd); err != nil {
			log.Println("Error parsing message:", err)
			continue
		}

		// Record activity for mouse jiggler idle detection
		c.RecordActivity()

		// Commands with rid must not be dropped — they expect an ACK.
		// Send them directly to the queue (blocking if full).
		if hidCmd.Rid != "" {
			cmdQueue <- &hidCmd
			continue
		}

		// Fire-and-forget: try to enqueue; if full, drop the oldest event first
		select {
		case cmdQueue <- &hidCmd:
		default:
			// Queue full — discard the oldest pending command
			<-cmdQueue
			cmdQueue <- &hidCmd
		}
	}

	// WebSocket closed — drain queue and wait for consumer to finish
	close(cmdQueue)
	<-done
}
