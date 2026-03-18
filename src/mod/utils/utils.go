package utils

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// Response related
func SendTextResponse(w http.ResponseWriter, msg string) {
	w.Write([]byte(msg))
}

// Send JSON response, with an extra json header
func SendJSONResponse(w http.ResponseWriter, json string) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(json))
}

func SendErrorResponse(w http.ResponseWriter, errMsg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("{\"error\":\"" + errMsg + "\"}"))
}

func SendOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("\"OK\""))
}

// Get GET parameter
func GetPara(r *http.Request, key string) (string, error) {
	// Get first value from the URL query
	value := r.URL.Query().Get(key)
	if len(value) == 0 {
		return "", errors.New("invalid " + key + " given")
	}
	return value, nil
}

// Get GET paramter as boolean, accept 1 or true
func GetBool(r *http.Request, key string) (bool, error) {
	x, err := GetPara(r, key)
	if err != nil {
		return false, err
	}

	// Convert to lowercase and trim spaces just once to compare
	switch strings.ToLower(strings.TrimSpace(x)) {
	case "1", "true", "on":
		return true, nil
	case "0", "false", "off":
		return false, nil
	}

	return false, errors.New("invalid boolean given")
}

// Get POST parameter
func PostPara(r *http.Request, key string) (string, error) {
	// Try to parse the form
	if err := r.ParseForm(); err != nil {
		return "", err
	}
	// Get first value from the form
	x := r.Form.Get(key)
	if len(x) == 0 {
		return "", errors.New("invalid " + key + " given")
	}
	return x, nil
}

// Get POST paramter as boolean, accept 1 or true
func PostBool(r *http.Request, key string) (bool, error) {
	x, err := PostPara(r, key)
	if err != nil {
		return false, err
	}

	// Convert to lowercase and trim spaces just once to compare
	switch strings.ToLower(strings.TrimSpace(x)) {
	case "1", "true", "on":
		return true, nil
	case "0", "false", "off":
		return false, nil
	}

	return false, errors.New("invalid boolean given")
}

// Get POST paramter as int
func PostInt(r *http.Request, key string) (int, error) {
	x, err := PostPara(r, key)
	if err != nil {
		return 0, err
	}

	x = strings.TrimSpace(x)
	rx, err := strconv.Atoi(x)
	if err != nil {
		return 0, err
	}

	return rx, nil
}
