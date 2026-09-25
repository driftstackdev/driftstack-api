//! The desktop's native SOCKS5 check — what the Test button on a SOCKS5 proxy
//! runs from this Mac (`proxy_test` in lib.rs). Native because the WebView cannot
//! open the raw sockets it needs.
//!
//! Its own module so the REAL function is what the loopback fixtures below test
//! (every audit before this one compiled a verbatim copy of it instead).
//!
//! Two stages, and only the first one can speak about the proxy's health:
//!   1. TCP → greeting → login → CONNECT to 1.1.1.1:443 — reachable, auth_ok,
//!      can_route, latency.
//!   2. On its OWN connection, and only after a CONNECT that succeeded: UDP
//!      ASSOCIATE, then ONE datagram through the relay it grants (a DNS query
//!      with a random id to 1.1.1.1:53), waiting for the answer with the same id.
//!      This yields `udp_relay`. ⛔ Nothing that goes wrong in stage 2 changes
//!      stage 1's verdict (proxy-accuracy audit G4): a proxy that allows one
//!      connection at a time, or rejects a second login, WORKS — our second
//!      connection failing is our reading failing, `not_run`.

use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::PROXY_PROBE_TIMEOUT;

/// What the UDP stage found (proxy-accuracy audit G1). Four states, because a
/// grant is not a relay: a proxy can answer "yes" to UDP ASSOCIATE and then drop
/// every datagram.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UdpRelay {
    /// A datagram went through the relay and its answer came back.
    Relays,
    /// The proxy granted UDP ASSOCIATE, but no answer came back in time. NOT a
    /// verdict: the check is one DNS query on port 53, and an exit that blocks
    /// only that port reads the same. Shown as "not verified", never ✓ or ⤵.
    Silent,
    /// The proxy answered UDP ASSOCIATE with a refusal — the one measured NO.
    Refused,
    /// The UDP stage did not run or could not finish (the proxy did not route,
    /// or our second connection or login failed). Not measured.
    NotRun,
}

/// Structured result of a SOCKS5 proxy probe. Serialized straight to
/// the React side, so field names are the camel/snake the GUI reads.
#[derive(serde::Serialize, Debug)]
pub(crate) struct ProxyTestResult {
    /// TCP connect + SOCKS5 greeting handshake succeeded.
    pub(crate) reachable: bool,
    /// Username/password auth (RFC 1929) was accepted, or no auth was
    /// required. `false` only when credentials were offered + rejected.
    pub(crate) auth_ok: bool,
    /// The RAW grant: the proxy answered `UDP ASSOCIATE` with success. ⛔ Not a
    /// claim that UDP works — a proxy can grant and drop every datagram. What
    /// UDP does is `udp_relay`; this is kept so the grant stays visible.
    pub(crate) udp_associate: bool,
    /// Whether a datagram actually went through the relay (see `UdpRelay`).
    pub(crate) udp_relay: UdpRelay,
    /// A real SOCKS5 CONNECT (CMD 0x01) to a public destination succeeded.
    ///
    /// This is the verdict that actually answers "can this proxy carry my
    /// traffic". Everything above it is preamble: a proxy can accept TCP,
    /// complete the greeting and accept credentials and STILL refuse every
    /// CONNECT. That is not a corner case — five NodeMaven endpoints did
    /// exactly that on 2026-08-18, answering 0x02 "not allowed by ruleset"
    /// to every request while this probe reported "Connected · auth ok" and
    /// customers launched profiles that could not reach anything.
    pub(crate) can_route: bool,
    /// Raw SOCKS5 reply byte from the CONNECT attempt (RFC 1928 §6), kept so
    /// the UI can say WHY rather than just "failed". 0x00 success, 0x02 not
    /// allowed by ruleset, 0x03 network unreachable, 0x04 host unreachable,
    /// 0x05 connection refused, 0x06 TTL expired. 0xFF = no reply read.
    pub(crate) connect_reply: u8,
    /// Milliseconds from the TCP connect to the CONNECT reply. ⛔ The UDP stage
    /// is not in it: its wait for a datagram that may never come would read as
    /// a slow proxy.
    pub(crate) latency_ms: u64,
    /// Human-readable summary the GUI shows verbatim under the button.
    pub(crate) message: String,
}

/// The waits the probe applies. Injected so the loopback tests run in seconds.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ProbeTimeouts {
    /// Each TCP connect, read and write.
    pub(crate) io: Duration,
    /// How long the UDP stage waits for the DNS answer through the relay.
    pub(crate) udp_answer: Duration,
}

impl ProbeTimeouts {
    pub(crate) const PRODUCTION: ProbeTimeouts = ProbeTimeouts {
        io: PROXY_PROBE_TIMEOUT,
        udp_answer: Duration::from_secs(3),
    };
}

/// Build the SOCKS5 greeting (RFC 1928 §3): version 5, the method
/// count, then the offered methods. We always offer `0x00` (no auth)
/// and additionally `0x02` (username/password) when credentials are
/// present, letting the server pick.
pub(crate) fn socks5_greeting(use_auth: bool) -> Vec<u8> {
    let methods: &[u8] = if use_auth { &[0x00, 0x02] } else { &[0x00] };
    let mut greeting = vec![0x05u8, methods.len() as u8];
    greeting.extend_from_slice(methods);
    greeting
}

/// Build the RFC 1929 username/password sub-negotiation packet:
/// version `0x01`, ULEN, username, PLEN, password.
pub(crate) fn socks5_userpass(user: &str, pass: &str) -> Vec<u8> {
    let mut auth = vec![0x01u8, user.len() as u8];
    auth.extend_from_slice(user.as_bytes());
    auth.push(pass.len() as u8);
    auth.extend_from_slice(pass.as_bytes());
    auth
}

/// Probe a SOCKS5 proxy with the production waits.
pub(crate) fn run_socks5_probe(
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<ProxyTestResult, String> {
    run_socks5_probe_with(host, port, username, password, ProbeTimeouts::PRODUCTION)
}

/// Why a CONNECT reply could not be read — two different facts.
enum NoConnectReply {
    /// Nothing arrived within the wait: the proxy may be slow. Not a verdict.
    TimedOut,
    /// The proxy closed or reset the stream instead of answering.
    Closed,
}

fn read_timed_out(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

/// Read and discard the bound address that follows a reply head (VER REP RSV
/// ATYP), returning it when it is an IP address.
fn read_bound_addr(stream: &mut TcpStream, atyp: u8) -> std::io::Result<Option<SocketAddr>> {
    match atyp {
        0x01 => {
            let mut b = [0u8; 6];
            stream.read_exact(&mut b)?;
            let ip = Ipv4Addr::new(b[0], b[1], b[2], b[3]);
            Ok(Some(SocketAddr::new(
                IpAddr::V4(ip),
                u16::from_be_bytes([b[4], b[5]]),
            )))
        }
        0x04 => {
            let mut b = [0u8; 18];
            stream.read_exact(&mut b)?;
            let mut o = [0u8; 16];
            o.copy_from_slice(&b[..16]);
            Ok(Some(SocketAddr::new(
                IpAddr::V6(Ipv6Addr::from(o)),
                u16::from_be_bytes([b[16], b[17]]),
            )))
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len)?;
            let mut b = vec![0u8; len[0] as usize + 2];
            stream.read_exact(&mut b)?;
            let name = String::from_utf8_lossy(&b[..len[0] as usize]).to_string();
            let port = u16::from_be_bytes([b[len[0] as usize], b[len[0] as usize + 1]]);
            Ok((name.as_str(), port)
                .to_socket_addrs()
                .ok()
                .and_then(|mut a| a.next()))
        }
        _ => Ok(None),
    }
}

/// Probe a SOCKS5 proxy: TCP connect → greeting → optional RFC 1929 auth →
/// CONNECT (the verdict), then, on its own connection, the UDP relay check.
pub(crate) fn run_socks5_probe_with(
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
    t: ProbeTimeouts,
) -> Result<ProxyTestResult, String> {
    let start = Instant::now();
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS resolution failed: {e}"))?
        .next()
        .ok_or_else(|| "Host resolved to no addresses.".to_string())?;
    let mut stream =
        TcpStream::connect_timeout(&addr, t.io).map_err(|e| format!("TCP connect failed: {e}"))?;
    stream.set_read_timeout(Some(t.io)).ok();
    stream.set_write_timeout(Some(t.io)).ok();

    let use_auth = username.is_some();
    stream
        .write_all(&socks5_greeting(use_auth))
        .map_err(|e| format!("write greeting: {e}"))?;

    let mut sel = [0u8; 2];
    stream
        .read_exact(&mut sel)
        .map_err(|e| format!("read method selection: {e}"))?;
    if sel[0] != 0x05 {
        return Err(format!("Not a SOCKS5 server (version byte {:#x}).", sel[0]));
    }

    let not_routed = |auth_ok: bool, message: String| ProxyTestResult {
        reachable: true,
        auth_ok,
        udp_associate: false,
        udp_relay: UdpRelay::NotRun,
        can_route: false,
        connect_reply: 0xFF,
        latency_ms: start.elapsed().as_millis() as u64,
        message,
    };
    match sel[1] {
        0x00 => {} // no auth required
        0x02 => {
            let user = username.unwrap_or("");
            let pass = password.unwrap_or("");
            if user.len() > 255 || pass.len() > 255 {
                return Err("Username/password exceed the 255-byte SOCKS5 limit.".into());
            }
            stream
                .write_all(&socks5_userpass(user, pass))
                .map_err(|e| format!("write auth: {e}"))?;
            let mut auth_reply = [0u8; 2];
            stream
                .read_exact(&mut auth_reply)
                .map_err(|e| format!("read auth reply: {e}"))?;
            if auth_reply[1] != 0x00 {
                return Ok(not_routed(
                    false,
                    "Connected, but the proxy rejected the username/password.".into(),
                ));
            }
        }
        0xFF => {
            return Ok(not_routed(
                false,
                if use_auth {
                    "Server rejected all offered authentication methods.".into()
                } else {
                    "Server requires authentication — add a username + password.".into()
                },
            ));
        }
        other => {
            return Err(format!(
                "Server selected unsupported auth method {other:#x}."
            ))
        }
    }

    // CONNECT (RFC 1928 §4, CMD 0x01) to a real public destination.
    //
    // This is the check that was missing, and its absence is why the Test
    // button could not be trusted: auth success was being reported as
    // "Connected", but authenticating and ROUTING are separate permissions on
    // every commercial proxy. A residential endpoint whose plan has lapsed, or
    // whose ruleset forbids a destination, authenticates perfectly and then
    // refuses every CONNECT.
    //
    // Destination is 1.1.1.1:443 as a DOTTED IPv4 (ATYP 0x01), deliberately:
    // a hostname (ATYP 0x03) would make the proxy resolve DNS, so a DNS fault
    // would be indistinguishable from a routing refusal. Port 443 because a
    // proxy that allows only 80 is not usable for this product anyway.
    let connect_req = [0x05u8, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x01, 0xBB];
    stream
        .write_all(&connect_req)
        .map_err(|e| format!("write CONNECT: {e}"))?;
    let mut connect_head = [0u8; 4]; // VER REP RSV ATYP
    let connect_answer = match stream.read_exact(&mut connect_head) {
        Ok(()) => Ok(connect_head[1]),
        Err(e) if read_timed_out(&e) => Err(NoConnectReply::TimedOut),
        Err(_) => Err(NoConnectReply::Closed),
    };
    let connect_reply = *connect_answer.as_ref().unwrap_or(&0xFF);
    let can_route = connect_reply == 0x00;
    if connect_answer.is_ok() {
        // Drain the bound address, best-effort: nothing else is read from here.
        let _ = read_bound_addr(&mut stream, connect_head[3]);
    }
    // The pill's number: TCP connect to CONNECT reply. Taken before the UDP stage.
    let latency_ms = start.elapsed().as_millis() as u64;
    // ⛔ G4 (c)(d) — this stream is finished. It is a tunnel to 1.1.1.1:443 after
    // a success, dead after a refusal, and in an unknown state after a stall: no
    // other request is ever written to it. Closing it also frees the slot of a
    // proxy that allows one connection at a time before the UDP stage asks.
    drop(stream);

    // ⛔ G4 — the UDP stage runs only when the proxy ROUTES, on its own
    // connection, and nothing that happens in it changes the verdict above.
    let udp = if can_route {
        udp_stage(addr, username, password, t)
    } else {
        UdpStage {
            granted: false,
            relay: UdpRelay::NotRun,
        }
    };

    // The headline is whether traffic can actually LEAVE. UDP is a qualifier on
    // a working proxy, never a substitute for one — reporting it as the verdict
    // is what let an endpoint that refuses every CONNECT read as healthy. And a
    // GRANT is not a relay: only a datagram that came back says UDP works.
    let udp_note = match udp.relay {
        UdpRelay::Relays => " UDP relays through it.",
        UdpRelay::Silent => {
            " UDP not verified: the proxy accepts UDP requests, but nothing came back through it."
        }
        UdpRelay::Refused => " The proxy refuses UDP.",
        UdpRelay::NotRun => " UDP was not checked this time.",
    };
    let message = match connect_answer {
        Ok(0x00) => format!("Working — CONNECT succeeded.{udp_note}"),
        // ⛔ G4 (c) — a stall is not a refusal: nothing here says the proxy
        // will not carry traffic, only that it did not answer in time.
        Err(NoConnectReply::TimedOut) => format!(
            "Logged in, but the proxy did not answer a connection request within {} s. It may be slow or overloaded — test again.",
            t.io.as_secs().max(1)
        ),
        Err(NoConnectReply::Closed) => "Authenticates, but cannot route: the proxy closed the connection instead of answering. Credentials are fine — this proxy will not carry traffic, so a profile launched through it cannot reach anything.".to_string(),
        Ok(rep) => {
            // Name the refusal in the proxy's own words. "Failed" sends someone to
            // re-check a password that was already accepted; "your plan does not
            // allow this destination" sends them to their provider.
            let why = match rep {
                0x02 => "the proxy refused it: not allowed by its ruleset (usually an expired plan, or a destination/port your provider blocks)",
                0x03 => "the proxy reported the network as unreachable",
                0x04 => "the proxy reported the host as unreachable",
                0x05 => "the proxy's upstream refused the connection",
                0x06 => "the connection expired (TTL) inside the proxy",
                0x07 => "the proxy does not support CONNECT",
                0x08 => "the proxy rejected the address type",
                _ => "the proxy returned an unrecognised SOCKS5 error",
            };
            format!(
                "Authenticates, but cannot route: {why}. Credentials are fine — this proxy will not carry traffic, so a profile launched through it cannot reach anything."
            )
        }
    };
    Ok(ProxyTestResult {
        reachable: true,
        auth_ok: true,
        udp_associate: udp.granted,
        udp_relay: udp.relay,
        can_route,
        connect_reply,
        latency_ms,
        message,
    })
}

struct UdpStage {
    granted: bool,
    relay: UdpRelay,
}

/// The UDP stage. Every failure of OUR side — the second connection, its login,
/// a garbled reply — is `NotRun`; only the proxy's own refusal REP is `Refused`.
fn udp_stage(
    addr: SocketAddr,
    username: Option<&str>,
    password: Option<&str>,
    t: ProbeTimeouts,
) -> UdpStage {
    udp_stage_inner(addr, username, password, t).unwrap_or(UdpStage {
        granted: false,
        relay: UdpRelay::NotRun,
    })
}

fn udp_stage_inner(
    addr: SocketAddr,
    username: Option<&str>,
    password: Option<&str>,
    t: ProbeTimeouts,
) -> Result<UdpStage, std::io::Error> {
    let other = |m: &str| std::io::Error::new(ErrorKind::Other, m.to_string());
    let mut control = TcpStream::connect_timeout(&addr, t.io)?;
    control.set_read_timeout(Some(t.io)).ok();
    control.set_write_timeout(Some(t.io)).ok();
    let use_auth = username.is_some();
    control.write_all(&socks5_greeting(use_auth))?;
    let mut sel = [0u8; 2];
    control.read_exact(&mut sel)?;
    if sel[0] != 0x05 {
        return Err(other("not socks5"));
    }
    match sel[1] {
        0x00 => {}
        0x02 => {
            // ⛔ G4 (b) — the SAME login as the first connection: a username with
            // no password logs in as (user, ""), exactly as stage 1 did.
            control.write_all(&socks5_userpass(
                username.unwrap_or(""),
                password.unwrap_or(""),
            ))?;
            let mut status = [0u8; 2];
            control.read_exact(&mut status)?;
            if status[1] != 0x00 {
                return Err(other("second login rejected"));
            }
        }
        _ => return Err(other("no acceptable method")),
    }
    // UDP ASSOCIATE (RFC 1928 §4, CMD 0x03), DST 0.0.0.0:0: "I will send from an
    // address I do not know yet".
    control.write_all(&[0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0])?;
    let mut head = [0u8; 4];
    control.read_exact(&mut head)?;
    if head[0] != 0x05 {
        return Err(other("garbled associate reply"));
    }
    if head[1] != 0x00 {
        return Ok(UdpStage {
            granted: false,
            relay: UdpRelay::Refused,
        });
    }
    let bound = read_bound_addr(&mut control, head[3])?;
    let relay = match bound {
        // A relay at 0.0.0.0 / :: means "the address you reached me on".
        Some(b) if b.ip().is_unspecified() => SocketAddr::new(addr.ip(), b.port()),
        Some(b) => b,
        None => return Err(other("unreadable relay address")),
    };
    if relay.port() == 0 {
        // Granted, with nowhere to send a datagram.
        return Ok(UdpStage {
            granted: true,
            relay: UdpRelay::Silent,
        });
    }
    let local = control.local_addr()?.ip();
    let bind_ip = if local.is_ipv4() == relay.is_ipv4() {
        local
    } else if relay.is_ipv4() {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V6(Ipv6Addr::UNSPECIFIED)
    };
    let socket = UdpSocket::bind(SocketAddr::new(bind_ip, 0))?;
    let txid = random_txid();
    socket.send_to(&dns_query_through_relay(txid), relay)?;
    let deadline = Instant::now() + t.udp_answer;
    let mut buf = [0u8; 1500];
    let mut answered = false;
    while !answered {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        socket.set_read_timeout(Some(left)).ok();
        match socket.recv_from(&mut buf) {
            Ok((n, _)) => answered = is_answer_to(&buf[..n], txid),
            Err(e) if read_timed_out(&e) => break,
            Err(_) => break,
        }
    }
    // The association lives exactly as long as the control stream; it is held
    // open until here on purpose.
    drop(control);
    Ok(UdpStage {
        granted: true,
        relay: if answered {
            UdpRelay::Relays
        } else {
            UdpRelay::Silent
        },
    })
}

/// A transaction id nobody else can predict, so a matching answer can only be
/// the answer to this query.
fn random_txid() -> [u8; 2] {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    let v = h.finish();
    [(v >> 8) as u8, v as u8]
}

/// One SOCKS5 UDP request (RFC 1928 §7: RSV RSV FRAG ATYP DST.ADDR DST.PORT)
/// carrying a DNS query (A one.one.one.one) to 1.1.1.1:53.
fn dns_query_through_relay(txid: [u8; 2]) -> Vec<u8> {
    let mut p = vec![0x00, 0x00, 0x00, 0x01, 1, 1, 1, 1, 0x00, 53];
    p.extend_from_slice(&txid);
    p.extend_from_slice(&[0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    for label in ["one", "one", "one", "one"] {
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.extend_from_slice(&[0x00, 0x00, 0x01, 0x00, 0x01]);
    p
}

/// Whether a datagram from the relay is the DNS answer to our query: a SOCKS5
/// UDP header (unfragmented), then a DNS RESPONSE carrying our transaction id.
fn is_answer_to(datagram: &[u8], txid: [u8; 2]) -> bool {
    if datagram.len() < 4 || datagram[2] != 0x00 {
        return false;
    }
    let header = match datagram[3] {
        0x01 => 10,
        0x04 => 22,
        0x03 if datagram.len() > 4 => 4 + 1 + datagram[4] as usize + 2,
        _ => return false,
    };
    let dns = match datagram.get(header..) {
        Some(d) if d.len() >= 12 => d,
        _ => return false,
    };
    dns[0..2] == txid && dns[2] & 0x80 != 0
}

/// The §5 matrix, native layer (proxy-accuracy audit §5.2, L1): fake SOCKS5
/// proxies on 127.0.0.1 that LOG what really happened — TCP accepted or turned
/// away, each login, each CONNECT and what came through the tunnel after it, each
/// UDP ASSOCIATE, each datagram in and out — and assertions that tie every verdict
/// the probe returns to that log. The fakes never dial out: a CONNECT is answered
/// without connecting, and the UDP port answers a DNS query itself.
#[cfg(test)]
mod loopback_fixture_tests {
    use super::*;
    use std::net::{TcpListener, UdpSocket};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    /// What the fake proxy really saw.
    #[derive(Default, Debug, Clone)]
    struct Log {
        tcp_accepted: u32,
        /// Connections a one-at-a-time proxy closed at once because another was open.
        tcp_turned_away: u32,
        logins: Vec<(Vec<u8>, Vec<u8>)>,
        connects: u32,
        connect_refused: u32,
        /// Bytes that arrived on a CONNECT's stream AFTER its reply was sent — the
        /// tunnel on a success, the dead stream on a refusal. The probe never sends
        /// any: an ASSOCIATE written there is the defect G4 (c) and (d) name.
        bytes_after_connect_reply: usize,
        associates: u32,
        associate_refused: u32,
        datagrams_in: u32,
        datagrams_out: u32,
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Udp {
        /// Answers the DNS query itself, as a working relay's resolver would.
        Answer,
        /// Swallows every datagram.
        Drop,
    }

    #[derive(Clone, Copy)]
    enum Associate {
        Grant { bnd_zero: bool, udp: Udp },
        Refuse(u8),
    }

    #[derive(Clone, Copy)]
    struct Fake {
        /// The login the proxy requires; None = no authentication.
        auth: Option<(&'static str, &'static str)>,
        connect_rep: u8,
        connect_delay: Duration,
        associate: Associate,
        /// Only one connection at a time; another is closed while one is open
        /// (and for a short while after it closes, as a real one's accounting lags).
        one_connection: bool,
    }

    impl Default for Fake {
        fn default() -> Self {
            Fake {
                auth: None,
                connect_rep: 0x00,
                connect_delay: Duration::ZERO,
                associate: Associate::Grant {
                    bnd_zero: false,
                    udp: Udp::Answer,
                },
                one_connection: false,
            }
        }
    }

    struct Running {
        port: u16,
        log: Arc<Mutex<Log>>,
        active: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
    }

    impl Running {
        /// The log once every connection the fake accepted has been handled.
        fn settled_log(&self) -> Log {
            let deadline = Instant::now() + Duration::from_secs(20);
            while self.active.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            self.log.lock().unwrap().clone()
        }
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Wake the accept loop so it sees the flag.
            let _ = TcpStream::connect(("127.0.0.1", self.port));
        }
    }

    fn read_n(c: &mut TcpStream, n: usize) -> std::io::Result<Vec<u8>> {
        let mut b = vec![0u8; n];
        c.read_exact(&mut b)?;
        Ok(b)
    }

    /// Everything that arrives before the peer closes (or a quiet second passes).
    fn drain(c: &mut TcpStream) -> usize {
        c.set_read_timeout(Some(Duration::from_millis(1000))).ok();
        let mut total = 0;
        let mut buf = [0u8; 512];
        while let Ok(n) = c.read(&mut buf) {
            if n == 0 {
                break;
            }
            total += n;
        }
        total
    }

    fn handle(mut c: TcpStream, f: Fake, udp_port: u16, log: &Mutex<Log>) -> std::io::Result<()> {
        c.set_read_timeout(Some(Duration::from_secs(15))).ok();
        let head = read_n(&mut c, 2)?;
        read_n(&mut c, head[1] as usize)?;
        match f.auth {
            None => c.write_all(&[0x05, 0x00])?,
            Some((user, pass)) => {
                c.write_all(&[0x05, 0x02])?;
                let vu = read_n(&mut c, 2)?;
                let u = read_n(&mut c, vu[1] as usize)?;
                let pl = read_n(&mut c, 1)?;
                let p = read_n(&mut c, pl[0] as usize)?;
                let ok = vu[0] == 0x01 && u == user.as_bytes() && p == pass.as_bytes();
                log.lock().unwrap().logins.push((u, p));
                c.write_all(&[0x01, if ok { 0x00 } else { 0x01 }])?;
                if !ok {
                    return Ok(());
                }
            }
        }
        let req = read_n(&mut c, 4)?;
        match req[3] {
            0x01 => drop(read_n(&mut c, 6)?),
            0x04 => drop(read_n(&mut c, 18)?),
            _ => {
                let len = read_n(&mut c, 1)?;
                read_n(&mut c, len[0] as usize + 2)?;
            }
        }
        match req[1] {
            0x01 => {
                log.lock().unwrap().connects += 1;
                thread::sleep(f.connect_delay);
                if f.connect_rep != 0x00 {
                    log.lock().unwrap().connect_refused += 1;
                }
                let _ = c.write_all(&[0x05, f.connect_rep, 0x00, 0x01, 127, 0, 0, 1, 0x11, 0x5c]);
                let n = drain(&mut c);
                log.lock().unwrap().bytes_after_connect_reply += n;
            }
            0x03 => {
                log.lock().unwrap().associates += 1;
                match f.associate {
                    Associate::Refuse(rep) => {
                        log.lock().unwrap().associate_refused += 1;
                        c.write_all(&[0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])?;
                    }
                    Associate::Grant { bnd_zero, .. } => {
                        let ip = if bnd_zero {
                            [0, 0, 0, 0]
                        } else {
                            [127, 0, 0, 1]
                        };
                        let p = udp_port.to_be_bytes();
                        c.write_all(&[
                            0x05, 0x00, 0x00, 0x01, ip[0], ip[1], ip[2], ip[3], p[0], p[1],
                        ])?;
                        // The association lives as long as this control stream.
                        drain(&mut c);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn start(f: Fake) -> Running {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
        let udp_port = udp.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Log::default()));
        let active = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let busy = Arc::new(Mutex::new(false));
        {
            let log = log.clone();
            let stop = stop.clone();
            let udp_mode = match f.associate {
                Associate::Grant { udp, .. } => udp,
                Associate::Refuse(_) => Udp::Drop,
            };
            udp.set_read_timeout(Some(Duration::from_millis(100))).ok();
            thread::spawn(move || {
                let mut buf = [0u8; 1500];
                while !stop.load(Ordering::SeqCst) {
                    let Ok((n, src)) = udp.recv_from(&mut buf) else {
                        continue;
                    };
                    log.lock().unwrap().datagrams_in += 1;
                    // RSV RSV FRAG ATYP(1) + IPv4 + port, then the DNS query.
                    if udp_mode == Udp::Answer && n > 10 + 12 && buf[3] == 0x01 {
                        let (hdr, q) = (&buf[..10], &buf[10..n]);
                        let mut answer = hdr.to_vec();
                        answer.extend_from_slice(&q[..2]); // the query's own txid
                        answer.extend_from_slice(&[0x81, 0x80]); // a response, no error
                        answer.extend_from_slice(&q[4..6]);
                        answer.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
                        answer.extend_from_slice(&q[12..]);
                        if udp.send_to(&answer, src).is_ok() {
                            log.lock().unwrap().datagrams_out += 1;
                        }
                    }
                }
            });
        }
        {
            let log = log.clone();
            let active = active.clone();
            let stop = stop.clone();
            thread::spawn(move || {
                for conn in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(c) = conn else { continue };
                    if f.one_connection {
                        let mut b = busy.lock().unwrap();
                        if *b {
                            log.lock().unwrap().tcp_turned_away += 1;
                            drop(c);
                            continue;
                        }
                        *b = true;
                    }
                    log.lock().unwrap().tcp_accepted += 1;
                    active.fetch_add(1, Ordering::SeqCst);
                    let log = log.clone();
                    let active = active.clone();
                    let busy = busy.clone();
                    thread::spawn(move || {
                        let _ = handle(c, f, udp_port, &log);
                        if f.one_connection {
                            thread::sleep(Duration::from_millis(300));
                            *busy.lock().unwrap() = false;
                        }
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            });
        }
        Running {
            port,
            log,
            active,
            stop,
        }
    }

    // ── the adapter: the only lines that name the probe's API ────────────────
    /// Short waits, so a stall or a silent relay costs a fraction of a second.
    const TEST_WAITS: ProbeTimeouts = ProbeTimeouts {
        io: Duration::from_millis(1500),
        udp_answer: Duration::from_millis(600),
    };
    fn probe(port: u16, user: Option<&str>, pass: Option<&str>) -> ProxyTestResult {
        run_socks5_probe_with("127.0.0.1", port, user, pass, TEST_WAITS)
            .expect("the probe returned Err")
    }
    fn relays(r: &ProxyTestResult) -> bool {
        r.udp_relay == UdpRelay::Relays
    }
    /// How long a CONNECT must stall to exceed the probe's own wait.
    const PROBE_IO: Duration = TEST_WAITS.io;

    #[test]
    fn a_relay_all_proxy_reads_relays_and_a_datagram_went_both_ways() {
        let fake = start(Fake::default());
        let r = probe(fake.port, None, None);
        let log = fake.settled_log();
        assert!(r.reachable && r.auth_ok && r.can_route, "{r:?}");
        assert!(relays(&r), "{r:?}");
        assert!(r.udp_associate, "the raw grant stays visible: {r:?}");
        // ✓ requires the positive event in the log: a datagram in AND one back.
        assert!(log.datagrams_in >= 1 && log.datagrams_out >= 1, "{log:?}");
        assert!(r.message.contains("UDP relays"), "{r:?}");
    }

    #[test]
    fn g1_a_proxy_that_grants_udp_and_drops_every_datagram_never_reads_relays() {
        let fake = start(Fake {
            associate: Associate::Grant {
                bnd_zero: false,
                udp: Udp::Drop,
            },
            ..Fake::default()
        });
        let r = probe(fake.port, None, None);
        let log = fake.settled_log();
        assert!(r.reachable && r.can_route, "{r:?}");
        assert_eq!(log.associates, 1, "{log:?}");
        assert_eq!(log.datagrams_out, 0, "{log:?}");
        assert!(
            !relays(&r),
            "0 datagrams came back, yet the probe says UDP relays: {r:?}"
        );
        // "Granted but silent": the grant is kept as the raw fact, the relay is
        // NOT a verdict either way (never ✓, never the ⤵ of a refusal).
        assert_eq!(r.udp_relay, UdpRelay::Silent, "{r:?}");
        assert!(r.udp_associate, "{r:?}");
        assert_eq!(
            log.datagrams_in, 1,
            "one query was sent through the relay: {log:?}"
        );
        assert!(
            !r.message.contains("QUIC"),
            "a grant never implies QUIC: {r:?}"
        );
        // The wait for an answer that never came is not in the latency.
        assert!(
            r.latency_ms < TEST_WAITS.udp_answer.as_millis() as u64,
            "{r:?}"
        );
    }

    #[test]
    fn g1_a_grant_whose_bnd_is_0_0_0_0_is_checked_at_the_proxys_own_address_and_relays() {
        let fake = start(Fake {
            associate: Associate::Grant {
                bnd_zero: true,
                udp: Udp::Answer,
            },
            ..Fake::default()
        });
        let r = probe(fake.port, None, None);
        let log = fake.settled_log();
        assert!(relays(&r), "{r:?}");
        assert!(log.datagrams_in >= 1 && log.datagrams_out >= 1, "{log:?}");
    }

    #[test]
    fn g1_a_proxy_that_refuses_udp_with_0x07_or_0x02_reads_refused_and_no_datagram_is_sent() {
        for rep in [0x07u8, 0x02] {
            let fake = start(Fake {
                associate: Associate::Refuse(rep),
                ..Fake::default()
            });
            let r = probe(fake.port, None, None);
            let log = fake.settled_log();
            assert!(r.reachable && r.can_route, "{r:?}");
            assert!(!relays(&r), "{r:?}");
            // The one measured NO: the proxy's own refusal REP.
            assert_eq!(r.udp_relay, UdpRelay::Refused, "{r:?}");
            assert!(!r.udp_associate, "{r:?}");
            assert_eq!(log.associate_refused, 1, "{log:?}");
            assert_eq!(log.datagrams_in, 0, "{log:?}");
        }
    }

    #[test]
    fn g4a_a_proxy_that_allows_one_connection_at_a_time_is_reachable_and_routes() {
        let fake = start(Fake {
            one_connection: true,
            ..Fake::default()
        });
        let r = probe(fake.port, None, None);
        let log = fake.settled_log();
        // The proxy WORKS: its CONNECT succeeded. Its refusal of a second
        // connection is a limit of the proxy's plan, never "unreachable".
        assert_eq!(log.connects, 1, "{log:?}");
        assert!(r.reachable && r.auth_ok && r.can_route, "{r:?}");
        // …and the UDP stage, whose second connection the proxy turned away, is
        // OUR reading failing: not measured, never "no UDP".
        assert!(log.tcp_turned_away >= 1, "{log:?}");
        assert_eq!(r.udp_relay, UdpRelay::NotRun, "{r:?}");
    }

    #[test]
    fn g4b_a_username_with_no_password_logs_in_as_user_and_empty_on_both_connections() {
        let fake = start(Fake {
            auth: Some(("u", "")),
            ..Fake::default()
        });
        let r = probe(fake.port, Some("u"), None);
        let log = fake.settled_log();
        assert!(!log.logins.is_empty(), "{log:?}");
        for (u, p) in &log.logins {
            assert_eq!(
                (u.as_slice(), p.as_slice()),
                (&b"u"[..], &b""[..]),
                "{log:?}"
            );
        }
        assert_eq!(log.logins.len(), 2, "each connection logs in: {log:?}");
        assert!(r.reachable && r.auth_ok && r.can_route, "{r:?}");
        assert!(relays(&r), "{r:?} {log:?}");
    }

    #[test]
    fn g4c_a_connect_slower_than_the_wait_is_not_called_unroutable_and_nothing_is_written_into_the_tunnel(
    ) {
        let fake = start(Fake {
            connect_delay: PROBE_IO + Duration::from_millis(700),
            ..Fake::default()
        });
        let r = probe(fake.port, None, None);
        let log = fake.settled_log();
        assert!(r.reachable && r.auth_ok, "{r:?}");
        assert!(!r.can_route, "{r:?}");
        assert!(
            !r.message.contains("will not carry traffic"),
            "a stall is not a verdict: {r:?}"
        );
        assert!(r.message.contains("did not answer"), "{r:?}");
        assert_eq!(log.bytes_after_connect_reply, 0, "{log:?}");
        assert_eq!(log.associates, 0, "{log:?}");
        assert_eq!(r.udp_relay, UdpRelay::NotRun, "{r:?}");
    }

    #[test]
    fn g4d_after_a_refused_connect_no_udp_request_is_sent_on_the_refused_stream() {
        let fake = start(Fake {
            connect_rep: 0x02,
            ..Fake::default()
        });
        let r = probe(fake.port, None, None);
        let log = fake.settled_log();
        assert!(r.reachable && r.auth_ok && !r.can_route, "{r:?}");
        assert_eq!(r.connect_reply, 0x02);
        assert_eq!(log.connect_refused, 1, "{log:?}");
        assert_eq!(
            log.bytes_after_connect_reply, 0,
            "the probe wrote to a stream the proxy had refused: {log:?}"
        );
        // UDP is never asked of a proxy that does not route, on any stream.
        assert_eq!(log.associates, 0, "{log:?}");
        assert_eq!(r.udp_relay, UdpRelay::NotRun, "{r:?}");
        assert!(!relays(&r), "{r:?}");
    }

    #[test]
    fn the_login_is_repeated_on_the_udp_connection_and_a_wrong_password_never_reaches_it() {
        // CONTROL for g4b with a password: both connections log in with it.
        let fake = start(Fake {
            auth: Some(("u", "p")),
            ..Fake::default()
        });
        let r = probe(fake.port, Some("u"), Some("p"));
        let log = fake.settled_log();
        assert_eq!(log.logins.len(), 2, "{log:?}");
        assert_eq!(r.udp_relay, UdpRelay::Relays, "{r:?}");
        // A wrong password is the first stage's verdict, and UDP is not asked.
        let fake = start(Fake {
            auth: Some(("u", "p")),
            ..Fake::default()
        });
        let r = probe(fake.port, Some("u"), Some("wrong"));
        let log = fake.settled_log();
        assert!(r.reachable && !r.auth_ok && !r.can_route, "{r:?}");
        assert_eq!(r.udp_relay, UdpRelay::NotRun, "{r:?}");
        assert_eq!(log.associates, 0, "{log:?}");
    }

    #[test]
    fn the_udp_relay_states_cross_the_wire_under_the_names_the_gui_reads() {
        for (state, wire) in [
            (UdpRelay::Relays, "\"relays\""),
            (UdpRelay::Silent, "\"silent\""),
            (UdpRelay::Refused, "\"refused\""),
            (UdpRelay::NotRun, "\"not_run\""),
        ] {
            assert_eq!(serde_json::to_string(&state).unwrap(), wire);
        }
    }

    #[test]
    fn only_a_dns_response_carrying_our_id_counts_as_an_answer() {
        let q = dns_query_through_relay([0xAB, 0xCD]);
        let mut answer = q.clone();
        answer[12] |= 0x80; // the QR bit: a response
        assert!(is_answer_to(&answer, [0xAB, 0xCD]));
        // Our own query reflected back is not an answer.
        assert!(!is_answer_to(&q, [0xAB, 0xCD]));
        // Another id is not ours.
        assert!(!is_answer_to(&answer, [0xAB, 0xCE]));
        // A fragment is not an answer.
        let mut frag = answer.clone();
        frag[2] = 1;
        assert!(!is_answer_to(&frag, [0xAB, 0xCD]));
        // Truncated.
        assert!(!is_answer_to(&answer[..14], [0xAB, 0xCD]));
    }
}
