package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"errors"
	"strings"
	"testing"
	"time"
)

var phone = Peer{NodeID: "node-phone", Name: "iphone", OS: "iOS", User: "me@example.com", SameUser: true}

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

func newManager(t *testing.T) (*Manager, *clock, string) {
	t.Helper()
	dir := t.TempDir()
	m, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := &clock{t: time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)}
	m.now = c.now
	return m, c, dir
}

func newKey(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return k, spki
}

// sign makes the raw r||s signature WebCrypto produces.
func sign(t *testing.T, k *ecdsa.PrivateKey, nonce string) []byte {
	t.Helper()
	h := sha256.Sum256([]byte(LoginPrefix + nonce))
	r, s, err := ecdsa.Sign(rand.Reader, k, h[:])
	if err != nil {
		t.Fatal(err)
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return out
}

func pair(t *testing.T, m *Manager) *ecdsa.PrivateKey {
	t.Helper()
	code, _, err := m.StartPairing()
	if err != nil {
		t.Fatal(err)
	}
	k, spki := newKey(t)
	// Typed by hand: lower case, with the dash.
	typed := strings.ToLower(code[:4] + "-" + code[4:])
	id, err := m.SubmitPairing(phone, typed, "My iPhone", "123456", spki)
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := m.RequestStatus(phone, id); st != "pending" {
		t.Fatalf("status = %q, want pending", st)
	}
	if _, err := m.Approve(id); err != nil {
		t.Fatal(err)
	}
	if st, _ := m.RequestStatus(phone, id); st != "approved" {
		t.Fatalf("status = %q, want approved", st)
	}
	return k
}

func login(t *testing.T, m *Manager, k *ecdsa.PrivateKey, pin string) (string, error) {
	t.Helper()
	n, err := m.Challenge(phone)
	if err != nil {
		return "", err
	}
	return m.Login(phone, n, sign(t, k, n), pin)
}

func TestPairAndLogin(t *testing.T) {
	m, _, dir := newManager(t)
	k := pair(t, m)
	tok, err := login(t, m, k, "123456")
	if err != nil {
		t.Fatal(err)
	}
	if !m.Session(phone, tok) {
		t.Error("session should be valid")
	}
	other := Peer{NodeID: "node-ipad", SameUser: true}
	if m.Session(other, tok) {
		t.Error("a stolen session cookie must not work from another device")
	}

	// The pairing survives a restart.
	m2, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := login(t, m2, k, "123456"); err != nil {
		t.Errorf("login after reload: %v", err)
	}
	if st := m2.PeerState(phone); !st.Paired || !st.ThisDevice {
		t.Errorf("PeerState = %+v", st)
	}
	if st := m2.PeerState(other); !st.Paired || st.ThisDevice {
		t.Errorf("PeerState(other) = %+v", st)
	}
}

func TestOnlyOnePhone(t *testing.T) {
	m, _, _ := newManager(t)
	pair(t, m)
	if _, _, err := m.StartPairing(); !errors.Is(err, ErrAlreadyPaired) {
		t.Errorf("StartPairing while paired = %v", err)
	}
	_, spki := newKey(t)
	if _, err := m.SubmitPairing(Peer{NodeID: "node-2", SameUser: true}, "ABCDEFGH", "x", "123456", spki); !errors.Is(err, ErrAlreadyPaired) {
		t.Errorf("SubmitPairing while paired = %v", err)
	}
}

func TestPairingWindow(t *testing.T) {
	m, c, _ := newManager(t)
	_, spki := newKey(t)

	if _, err := m.SubmitPairing(phone, "ABCDEFGH", "x", "123456", spki); !errors.Is(err, ErrNoWindow) {
		t.Errorf("no window: %v", err)
	}

	// Wrong codes close the window after CodeTries.
	code, _, _ := m.StartPairing()
	for i := 0; i < CodeTries; i++ {
		if _, err := m.SubmitPairing(phone, "WRONGCOD", "x", "123456", spki); !errors.Is(err, ErrBadCode) {
			t.Fatalf("try %d: %v", i, err)
		}
	}
	if _, err := m.SubmitPairing(phone, code, "x", "123456", spki); !errors.Is(err, ErrNoWindow) {
		t.Errorf("after too many wrong codes: %v", err)
	}

	// Codes expire.
	code, _, _ = m.StartPairing()
	c.add(CodeTTL + time.Second)
	if _, err := m.SubmitPairing(phone, code, "x", "123456", spki); !errors.Is(err, ErrNoWindow) {
		t.Errorf("expired code: %v", err)
	}

	// Other accounts, bad PINs and bad keys are refused.
	code, _, _ = m.StartPairing()
	if _, err := m.SubmitPairing(Peer{NodeID: "n", SameUser: false}, code, "x", "123456", spki); !errors.Is(err, ErrNotSameUser) {
		t.Errorf("other account: %v", err)
	}
	if _, err := m.SubmitPairing(phone, code, "x", "12345a", spki); !errors.Is(err, ErrBadPIN) {
		t.Errorf("bad PIN: %v", err)
	}
	if _, err := m.SubmitPairing(phone, code, "x", "123456", []byte("junk")); !errors.Is(err, ErrBadKey) {
		t.Errorf("bad key: %v", err)
	}

	// A code works once.
	id, err := m.SubmitPairing(phone, code, "x", "123456", spki)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SubmitPairing(Peer{NodeID: "n2", SameUser: true}, code, "x", "123456", spki); !errors.Is(err, ErrNoWindow) {
		t.Errorf("reused code: %v", err)
	}
	// Only the requesting device can see its request.
	if _, err := m.RequestStatus(Peer{NodeID: "n2"}, id); !errors.Is(err, ErrNoRequest) {
		t.Errorf("status from another device: %v", err)
	}
	// Denied requests can't be approved.
	if err := m.Deny(id); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Approve(id); !errors.Is(err, ErrNoRequest) {
		t.Errorf("approve after deny: %v", err)
	}
	// Pending requests expire.
	code, _, _ = m.StartPairing()
	id, _ = m.SubmitPairing(phone, code, "x", "123456", spki)
	c.add(RequestTTL + time.Second)
	if _, err := m.Approve(id); !errors.Is(err, ErrNoRequest) {
		t.Errorf("approve after expiry: %v", err)
	}
}

func TestLoginRules(t *testing.T) {
	m, c, _ := newManager(t)
	k := pair(t, m)

	if _, err := m.Challenge(Peer{NodeID: "node-ipad", SameUser: true}); !errors.Is(err, ErrNotPaired) {
		t.Errorf("challenge for another device: %v", err)
	}

	// Nonces are single use and expire.
	n, _ := m.Challenge(phone)
	if _, err := m.Login(phone, n, sign(t, k, n), "123456"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Login(phone, n, sign(t, k, n), "123456"); !errors.Is(err, ErrBadChallenge) {
		t.Errorf("reused nonce: %v", err)
	}
	n, _ = m.Challenge(phone)
	c.add(ChallengeTTL + time.Second)
	if _, err := m.Login(phone, n, sign(t, k, n), "123456"); !errors.Is(err, ErrBadChallenge) {
		t.Errorf("expired nonce: %v", err)
	}

	// A signature from any other key fails, even with the right PIN.
	other, _ := newKey(t)
	n, _ = m.Challenge(phone)
	if _, err := m.Login(phone, n, sign(t, other, n), "123456"); !errors.Is(err, ErrWrongLogin) {
		t.Errorf("wrong key: %v", err)
	}
	// A signature over a different nonce fails.
	n, _ = m.Challenge(phone)
	if _, err := m.Login(phone, n, sign(t, k, "something-else"), "123456"); !errors.Is(err, ErrWrongLogin) {
		t.Errorf("wrong message: %v", err)
	}

	// Wrong PINs lock it (2 failures already counted above).
	var err error
	for i := 0; i < MaxFailures-2; i++ {
		_, err = login(t, m, k, "000000")
	}
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("after %d failures: %v", MaxFailures, err)
	}
	if _, err := m.Challenge(phone); !errors.Is(err, ErrLocked) {
		t.Errorf("challenge while locked: %v", err)
	}
	if _, err := login(t, m, k, "123456"); !errors.Is(err, ErrLocked) {
		t.Errorf("right PIN while locked: %v", err)
	}
	if err := m.Unlock(); err != nil {
		t.Fatal(err)
	}
	tok, err := login(t, m, k, "123456")
	if err != nil {
		t.Fatalf("after unlock: %v", err)
	}

	// Sessions end after being idle.
	c.add(SessionIdle + time.Second)
	if m.Session(phone, tok) {
		t.Error("idle session should have ended")
	}
	// And after the hard limit, even when used.
	tok, _ = login(t, m, k, "123456")
	start := c.t
	for i := 0; i < int(SessionMax/(SessionIdle-time.Minute))+2; i++ {
		c.add(SessionIdle - time.Minute)
		if !m.Session(phone, tok) {
			if c.t.Sub(start) <= SessionMax {
				t.Fatal("session ended too early")
			}
			return
		}
	}
	t.Error("session outlived SessionMax")
}

func TestUnpair(t *testing.T) {
	m, _, dir := newManager(t)
	k := pair(t, m)
	tok, _ := login(t, m, k, "123456")
	if err := m.Unpair(); err != nil {
		t.Fatal(err)
	}
	if m.Session(phone, tok) {
		t.Error("session survived unpair")
	}
	m2, _ := New(dir)
	if m2.PeerState(phone).Paired {
		t.Error("pairing survived unpair on disk")
	}
	if _, _, err := m.StartPairing(); err != nil {
		t.Errorf("pairing again: %v", err)
	}
}
