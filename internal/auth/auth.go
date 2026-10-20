// Package auth holds the one paired phone and decides who gets in.
//
// Pairing: the laptop opens a short window with a one-time code. A device on
// the same Tailscale account sends the code, a PIN and the public half of a
// key it made; the owner approves on the laptop. Login: the paired device
// signs a one-time challenge with that key and sends the PIN. Every check is
// also tied to the device's Tailscale node ID.
package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"

	"remote-desk/internal/config"
)

// Peer is the Tailscale device behind a request.
type Peer struct {
	NodeID string // stable node ID
	Name   string // Tailscale machine name
	OS     string
	User   string // Tailscale login
	// SameUser: the device belongs to the same Tailscale account as the laptop.
	SameUser bool
}

const (
	CodeTTL      = 5 * time.Minute
	CodeTries    = 5
	RequestTTL   = 5 * time.Minute
	ChallengeTTL = 60 * time.Second
	MaxFailures  = 5
	SessionIdle  = 15 * time.Minute
	SessionMax   = 8 * time.Hour
	// A PIN-protected folder (iCloud Drive) stays open this long after its
	// last use, and at most ProtectedMax, then the PIN is asked again.
	ProtectedIdle   = 2 * time.Minute
	ProtectedMax    = 10 * time.Minute
	maxOutstanding  = 20
	PINLength       = 6
	LoginPrefix     = "remote-desk-login:"
	codeAlphabet    = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	codeLength      = 8
	stateFileName   = "pairing.json"
	maxLabelLength  = 40
	requestIDLength = 16
)

var (
	ErrAlreadyPaired = errors.New("this laptop is already paired with a phone")
	ErrNoWindow      = errors.New("pairing isn't open on the laptop")
	ErrBadCode       = errors.New("wrong pairing code")
	ErrNotSameUser   = errors.New("this device isn't on the same Tailscale account as the laptop")
	ErrBadPIN        = errors.New("the PIN must be 6 digits")
	ErrBadKey        = errors.New("bad device key")
	ErrNotPaired     = errors.New("this device isn't the paired phone")
	ErrLocked        = errors.New("locked after too many wrong tries; unlock it on the laptop")
	ErrBadChallenge  = errors.New("challenge expired; try again")
	ErrWrongLogin    = errors.New("wrong PIN")
	ErrNoRequest     = errors.New("no such pairing request")
)

// Device is the paired phone, saved in pairing.json.
type Device struct {
	NodeID    string    `json:"nodeId"`
	NodeName  string    `json:"nodeName"`
	OS        string    `json:"os"`
	Label     string    `json:"label"`
	PublicKey []byte    `json:"publicKey"` // SPKI DER
	PINSalt   []byte    `json:"pinSalt"`
	PINHash   []byte    `json:"pinHash"`
	PairedAt  time.Time `json:"pairedAt"`
	LastSeen  time.Time `json:"lastSeen,omitzero"`
	Failures  int       `json:"failures"`
	Locked    bool      `json:"locked"`
	pub       *ecdsa.PublicKey
}

// Request is a pairing request waiting for the owner's approval.
type Request struct {
	ID       string    `json:"id"`
	NodeID   string    `json:"nodeId"`
	NodeName string    `json:"nodeName"`
	OS       string    `json:"os"`
	User     string    `json:"user"`
	Label    string    `json:"label"`
	Created  time.Time `json:"created"`
	Status   string    `json:"status"` // pending, approved, denied, expired
	device   *Device
}

type window struct {
	code    string
	expires time.Time
	tries   int
}

type session struct {
	nodeID  string
	created time.Time
	seen    time.Time
	// Protected folders: opened at, last used at (zero = closed).
	protFrom time.Time
	protSeen time.Time
}

type Manager struct {
	mu       sync.Mutex
	dir      string
	now      func() time.Time
	device   *Device
	window   *window
	requests map[string]*Request
	nonces   map[string]time.Time
	sessions map[string]*session
}

// New loads the paired device (if any) from dir.
func New(dir string) (*Manager, error) {
	m := &Manager{
		dir:      dir,
		now:      time.Now,
		requests: map[string]*Request{},
		nonces:   map[string]time.Time{},
		sessions: map[string]*session{},
	}
	b, err := os.ReadFile(filepath.Join(dir, stateFileName))
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	var d Device
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	pub, err := parseKey(d.PublicKey)
	if err != nil {
		return nil, err
	}
	d.pub = pub
	m.device = &d
	return m, nil
}

func (m *Manager) save() error {
	path := filepath.Join(m.dir, stateFileName)
	if m.device == nil {
		err := os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	b, err := json.MarshalIndent(m.device, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(path, b)
}

// ---- Pairing (laptop side) ----

// StartPairing opens the pairing window and returns the code to show.
func (m *Manager) StartPairing() (code string, expires time.Time, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.device != nil {
		return "", time.Time{}, ErrAlreadyPaired
	}
	m.expireRequests()
	for _, r := range m.requests {
		if r.Status == "pending" {
			r.Status = "expired"
		}
	}
	code = randomCode()
	m.window = &window{code: code, expires: m.now().Add(CodeTTL)}
	return code, m.window.expires, nil
}

func (m *Manager) CancelPairing() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.window = nil
	for _, r := range m.requests {
		if r.Status == "pending" {
			r.Status = "expired"
		}
	}
}

// Approve pairs the device from request id.
func (m *Manager) Approve(id string) (*Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expireRequests()
	r, ok := m.requests[id]
	if !ok || r.Status != "pending" {
		return nil, ErrNoRequest
	}
	if m.device != nil {
		return nil, ErrAlreadyPaired
	}
	r.device.PairedAt = m.now()
	m.device = r.device
	if err := m.save(); err != nil {
		m.device = nil
		return nil, err
	}
	r.Status = "approved"
	m.window = nil
	for _, other := range m.requests {
		if other.Status == "pending" {
			other.Status = "expired"
		}
	}
	return m.device, nil
}

func (m *Manager) Deny(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.requests[id]
	if !ok || r.Status != "pending" {
		return ErrNoRequest
	}
	r.Status = "denied"
	return nil
}

// Unpair forgets the phone and ends its sessions.
func (m *Manager) Unpair() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.device = nil
	m.sessions = map[string]*session{}
	m.nonces = map[string]time.Time{}
	return m.save()
}

// Unlock clears the wrong-try counter.
func (m *Manager) Unlock() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.device == nil {
		return nil
	}
	m.device.Failures = 0
	m.device.Locked = false
	return m.save()
}

// ---- Pairing (phone side) ----

// SubmitPairing records a pairing request from peer. The code is used up by
// the first correct submission; wrong codes count against the window.
func (m *Manager) SubmitPairing(p Peer, code, label, pin string, publicKey []byte) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.device != nil {
		return "", ErrAlreadyPaired
	}
	w := m.window
	if w == nil || w.code == "" || m.now().After(w.expires) {
		m.window = nil
		return "", ErrNoWindow
	}
	if !p.SameUser || p.NodeID == "" {
		return "", ErrNotSameUser
	}
	if subtle.ConstantTimeCompare([]byte(normalizeCode(code)), []byte(w.code)) != 1 {
		w.tries++
		if w.tries >= CodeTries {
			m.window = nil
		}
		return "", ErrBadCode
	}
	if !validPIN(pin) {
		return "", ErrBadPIN
	}
	pub, err := parseKey(publicKey)
	if err != nil {
		return "", ErrBadKey
	}
	label = strings.TrimSpace(label)
	if label == "" {
		label = "iPhone"
	}
	if len([]rune(label)) > maxLabelLength {
		label = string([]rune(label)[:maxLabelLength])
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	w.code = "" // single use: nobody else can submit with it
	id := config.RandomID(requestIDLength)
	m.requests[id] = &Request{
		ID: id, NodeID: p.NodeID, NodeName: p.Name, OS: p.OS, User: p.User,
		Label: label, Created: m.now(), Status: "pending",
		device: &Device{
			NodeID: p.NodeID, NodeName: p.Name, OS: p.OS, Label: label,
			PublicKey: publicKey, PINSalt: salt, PINHash: hashPIN(pin, salt), pub: pub,
		},
	}
	return id, nil
}

// RequestStatus tells the requesting device how its request is going.
func (m *Manager) RequestStatus(p Peer, id string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expireRequests()
	r, ok := m.requests[id]
	if !ok || r.NodeID != p.NodeID {
		return "", ErrNoRequest
	}
	return r.Status, nil
}

func (m *Manager) expireRequests() {
	now := m.now()
	for id, r := range m.requests {
		if r.Status == "pending" && now.Sub(r.Created) > RequestTTL {
			r.Status = "expired"
		}
		if now.Sub(r.Created) > 2*RequestTTL {
			delete(m.requests, id)
		}
	}
}

// ---- Login ----

// Challenge returns a one-time value for the paired device to sign.
func (m *Manager) Challenge(p Peer) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.checkDevice(p); err != nil {
		return "", err
	}
	now := m.now()
	for n, exp := range m.nonces {
		if now.After(exp) {
			delete(m.nonces, n)
		}
	}
	if len(m.nonces) >= maxOutstanding {
		return "", ErrBadChallenge
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	n := base64.RawURLEncoding.EncodeToString(b)
	m.nonces[n] = now.Add(ChallengeTTL)
	return n, nil
}

// Login checks the signed challenge and PIN and returns a session token.
// sig is the raw r||s ECDSA signature WebCrypto produces.
func (m *Manager) Login(p Peer, nonce string, sig []byte, pin string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.proveLocked(p, nonce, sig, pin); err != nil {
		return "", err
	}
	tok := config.RandomID(43)
	m.sessions[tok] = &session{nodeID: p.NodeID, created: m.now(), seen: m.now()}
	return tok, nil
}

// proveLocked checks a signed challenge and the PIN for the paired device,
// counting failures towards the lockout. m.mu must be held.
func (m *Manager) proveLocked(p Peer, nonce string, sig []byte, pin string) error {
	if err := m.checkDevice(p); err != nil {
		return err
	}
	exp, ok := m.nonces[nonce]
	delete(m.nonces, nonce)
	if !ok || m.now().After(exp) {
		return ErrBadChallenge
	}
	d := m.device
	sigOK := verify(d.pub, []byte(LoginPrefix+nonce), sig)
	pinOK := validPIN(pin) && subtle.ConstantTimeCompare(hashPIN(pin, d.PINSalt), d.PINHash) == 1
	if !sigOK || !pinOK {
		d.Failures++
		if d.Failures >= MaxFailures {
			d.Locked = true
		}
		_ = m.save()
		if d.Locked {
			return ErrLocked
		}
		return ErrWrongLogin
	}
	d.Failures = 0
	d.LastSeen = m.now()
	_ = m.save()
	return nil
}

// OpenProtected unlocks the PIN-protected folders for session tok, after a
// fresh signed challenge and the PIN, like a login.
func (m *Manager) OpenProtected(p Peer, tok, nonce string, sig []byte, pin string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.liveLocked(p, tok)
	if s == nil {
		return ErrNotPaired
	}
	if err := m.proveLocked(p, nonce, sig, pin); err != nil {
		return err
	}
	s.protFrom, s.protSeen = m.now(), m.now()
	return nil
}

// ProtectedOpen reports whether session tok has the protected folders open,
// and keeps them open a little longer if so.
func (m *Manager) ProtectedOpen(p Peer, tok string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.liveLocked(p, tok)
	if s == nil || s.protFrom.IsZero() {
		return false
	}
	now := m.now()
	if now.Sub(s.protSeen) > ProtectedIdle || now.Sub(s.protFrom) > ProtectedMax {
		s.protFrom, s.protSeen = time.Time{}, time.Time{}
		return false
	}
	s.protSeen = now
	return true
}

// CloseProtected closes the protected folders for session tok (the phone
// left them), so the next visit asks for the PIN again.
func (m *Manager) CloseProtected(tok string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[tok]; ok {
		s.protFrom, s.protSeen = time.Time{}, time.Time{}
	}
}

// Session reports whether tok is a live session for the paired device p.
func (m *Manager) Session(p Peer, tok string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.liveLocked(p, tok)
	if s == nil {
		return false
	}
	s.seen = m.now()
	m.device.LastSeen = s.seen
	return true
}

// liveLocked returns tok's session if it is live and belongs to the paired
// device p, dropping it if it has expired. m.mu must be held.
func (m *Manager) liveLocked(p Peer, tok string) *session {
	if tok == "" || m.checkDevice(p) != nil {
		return nil
	}
	s, ok := m.sessions[tok]
	if !ok {
		return nil
	}
	now := m.now()
	if s.nodeID != p.NodeID || now.Sub(s.seen) > SessionIdle || now.Sub(s.created) > SessionMax {
		delete(m.sessions, tok)
		return nil
	}
	return s
}

func (m *Manager) Logout(tok string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, tok)
}

func (m *Manager) checkDevice(p Peer) error {
	if m.device == nil || p.NodeID == "" || subtle.ConstantTimeCompare([]byte(p.NodeID), []byte(m.device.NodeID)) != 1 {
		return ErrNotPaired
	}
	if m.device.Locked {
		return ErrLocked
	}
	return nil
}

// ---- Status ----

// PeerState is what a device on the tailnet may learn about pairing.
type PeerState struct {
	Paired      bool `json:"paired"`
	ThisDevice  bool `json:"thisDevice"`
	Locked      bool `json:"locked"`
	PairingOpen bool `json:"pairingOpen"`
	TriesLeft   int  `json:"triesLeft,omitempty"`
}

func (m *Manager) PeerState(p Peer) PeerState {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := PeerState{Paired: m.device != nil}
	if m.device != nil && p.NodeID != "" && p.NodeID == m.device.NodeID {
		s.ThisDevice = true
		s.Locked = m.device.Locked
		s.TriesLeft = MaxFailures - m.device.Failures
	}
	s.PairingOpen = m.device == nil && m.window != nil && m.window.code != "" && m.now().Before(m.window.expires)
	return s
}

// AdminState is everything the laptop's admin page shows.
type AdminState struct {
	Device  *DeviceInfo  `json:"device"`
	Pairing *PairingInfo `json:"pairing"`
}

type DeviceInfo struct {
	Label    string    `json:"label"`
	NodeName string    `json:"nodeName"`
	OS       string    `json:"os"`
	PairedAt time.Time `json:"pairedAt"`
	LastSeen time.Time `json:"lastSeen,omitzero"`
	Locked   bool      `json:"locked"`
	Failures int       `json:"failures"`
}

type PairingInfo struct {
	Code     string     `json:"code,omitempty"`
	Expires  time.Time  `json:"expires,omitzero"`
	Requests []*Request `json:"requests"`
}

func (m *Manager) AdminState() AdminState {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expireRequests()
	var s AdminState
	if d := m.device; d != nil {
		s.Device = &DeviceInfo{Label: d.Label, NodeName: d.NodeName, OS: d.OS, PairedAt: d.PairedAt, LastSeen: d.LastSeen, Locked: d.Locked, Failures: d.Failures}
	}
	var pending []*Request
	for _, r := range m.requests {
		if r.Status == "pending" {
			cp := *r
			cp.device = nil
			pending = append(pending, &cp)
		}
	}
	w := m.window
	if w != nil && m.now().After(w.expires) && len(pending) == 0 {
		m.window, w = nil, nil
	}
	if w != nil || len(pending) > 0 {
		s.Pairing = &PairingInfo{Requests: pending}
		if w != nil && w.code != "" && m.now().Before(w.expires) {
			s.Pairing.Code = w.code[:4] + "-" + w.code[4:]
			s.Pairing.Expires = w.expires
		}
	}
	return s
}

// ---- helpers ----

func randomCode() string {
	b := make([]byte, codeLength)
	max := big.NewInt(int64(len(codeAlphabet)))
	for i := range b {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		b[i] = codeAlphabet[n.Int64()]
	}
	return string(b)
}

func normalizeCode(s string) string {
	s = strings.ToUpper(s)
	return strings.Map(func(r rune) rune {
		if r == '-' || r == ' ' {
			return -1
		}
		return r
	}, s)
}

func validPIN(pin string) bool {
	if len(pin) != PINLength {
		return false
	}
	for _, c := range pin {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func hashPIN(pin string, salt []byte) []byte {
	return argon2.IDKey([]byte(pin), salt, 2, 64*1024, 2, 32)
}

func parseKey(spki []byte) (*ecdsa.PublicKey, error) {
	k, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		return nil, err
	}
	pub, ok := k.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, ErrBadKey
	}
	return pub, nil
}

// verify checks a WebCrypto ECDSA P-256/SHA-256 signature (raw r||s).
func verify(pub *ecdsa.PublicKey, msg, sig []byte) bool {
	if pub == nil || len(sig) != 64 {
		return false
	}
	h := sha256.Sum256(msg)
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(pub, h[:], r, s)
}
