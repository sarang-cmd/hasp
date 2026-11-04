// Talking to the vault from a phone.
//
// The phone holds no vault key and no master password. It holds one pairing secret,
// and that secret is only good for asking a vault on the same network for the
// current codes.
//
// Three things a reader should know:
//
// 1. The address is a LAN address, not loopback. There is no loopback on a phone,
//    so this is the one client where the vault answers on the network, and the
//    vault has to be started with HASP_HOST=0.0.0.0 for this to work at all.
// 2. The channel is plain http. The codes are short lived and the requests are
//    signed, but an observer on the network sees the codes. That is written on the
//    pairing screen rather than buried here.
// 3. Nothing is stored but the address, the device id and the secret, and the
//    secret is only useful while the vault remembers this device.

import { sign } from "./sign.js";
import { codeToSecret } from "./code.js";

const STORE_KEY = "hasp.pair";

let pairing = null;

/**
 * Persistence is injectable so the tests run without Capacitor.
 *
 * The real store is Capacitor Preferences, which is not encrypted. A pairing secret
 * readable off a rooted phone lets someone read short lived codes from a vault that
 * must be on the same network. The alternative is a keychain bridge, which is a
 * platform dependency this app does not have yet. The gap is in the README rather
 * than described here as secure storage.
 */
let store = {
  async get(key) {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  },
  async set(key, value) {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  },
  async remove(key) {
    globalThis.localStorage?.removeItem(key);
  },
};

export function useStore(custom) {
  store = custom;
}

/**
 * Is this an address on a local network?
 *
 * The pairing channel is plain http and the code it carries is a secret, so the
 * address is restricted to the ranges that cannot leave the building: the private
 * IPv4 blocks, a single label hostname, or .local. A public hostname is refused,
 * because pairing with one would send a secret across the internet in clear.
 */
function isLocalHost(host) {
  // A single label, such as "vault" or a machine name on the LAN.
  if (/^[a-z0-9][a-z0-9-]{0,62}$/i.test(host)) return true;
  // mDNS names.
  if (/\.local$/i.test(host)) return true;
  // Private IPv4 ranges: 10/8, 172.16/12, 192.168/16, and link local 169.254/16.
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) return false;
  const [a, b] = [Number(quad[1]), Number(quad[2])];
  if ([a, b, Number(quad[3]), Number(quad[4])].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Validate an address typed by a person.
 *
 * Accepts "192.168.1.20", "vault.local" and "192.168.1.20:3000". Refuses a path,
 * credentials, a scheme other than http, and any host that is not on a local
 * network. `localhost` is refused on purpose: on a phone it means the phone, which
 * is the mistake this check exists to catch before a confusing connection failure.
 */
export function normaliseAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  const withoutScheme = raw.replace(/^https?:\/\//i, "");
  if (withoutScheme.includes("/") || withoutScheme.includes("@") || withoutScheme.includes("?")) return null;

  const [hostPart, portPart, ...rest] = withoutScheme.split(":");
  if (rest.length) return null;
  if (!hostPart || /^localhost$/i.test(hostPart)) return null;
  if (!isLocalHost(hostPart)) return null;

  const port = portPart === undefined ? 3000 : Number(portPart);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return `http://${hostPart.toLowerCase()}:${port}`;
}

/** A random id for this phone, stable across launches so the vault can list it. */
export function newDeviceId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 18);
}

function newNonce() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadPairing() {
  if (pairing) return pairing;
  pairing = await store.get(STORE_KEY);
  return pairing;
}

export async function savePairing(value) {
  pairing = value;
  await store.set(STORE_KEY, value);
}

export async function forgetPairing() {
  pairing = null;
  await store.remove(STORE_KEY);
}

/**
 * A signed request.
 *
 * The signature covers the device id, the method, the path, the timestamp and a
 * nonce. Nothing else, because nothing else is sent on the routes this app uses.
 */
export async function request(path, { method = "GET", pair = pairing } = {}) {
  if (!pair) throw Object.assign(new Error("This phone is not paired."), { code: "unpaired" });

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = newNonce();
  const signature = await sign(pair.secret, { deviceId: pair.deviceId, method, path, timestamp, nonce });

  let res;
  try {
    res = await fetch(`${pair.address}${path}`, {
      method,
      headers: {
        "x-hasp-device": pair.deviceId,
        "x-hasp-time": String(timestamp),
        "x-hasp-nonce": nonce,
        "x-hasp-signature": signature,
      },
    });
  } catch {
    // Distinguish "the phone cannot see the vault" from "the vault said no". The
    // first is the common case and has a different fix.
    throw Object.assign(new Error("The vault did not answer. Are you on the same network?"), {
      code: "offline",
    });
  }

  // 423 means the vault is there and locked. That is not a revoked device, and the
  // app says so rather than asking for a new pairing.
  if (res.status === 423) {
    const body = await res.text();
    throw Object.assign(new Error("The vault is locked. Unlock it on your computer."), { code: "locked", body });
  }
  if (res.status === 401) {
    throw Object.assign(new Error("This device is not paired any more."), { code: "revoked" });
  }

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Something that is not the vault answered, usually a router page.
  }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `The vault answered ${res.status}.`), { code: res.status });
  }
  return data;
}

/**
 * Pair with a code typed from the vault screen.
 *
 * The code is not sent. The phone proves it holds the code by signing a request
 * with it, and the vault checks the signature against the secret it generated. A
 * wrong code therefore fails as a signature mismatch rather than being compared in a
 * form the network could see.
 *
 * Nothing is stored until the vault confirms.
 */
export async function pair(address, typedCode) {
  const clean = normaliseAddress(address);
  if (!clean) {
    throw Object.assign(new Error("That address is not a plain host and port."), { code: "bad_address" });
  }

  // The checksum catches a typo here rather than producing a lifetime of signature
  // failures. The 32 character secret is what is signed with.
  const secret = codeToSecret(typedCode);
  if (!secret) {
    throw Object.assign(new Error("That code is not right. Check the letters and try again."), {
      code: "bad_code",
    });
  }

  const candidate = { address: clean, secret, deviceId: newDeviceId() };
  const result = await request("/api/pair", { method: "POST", pair: candidate });
  await savePairing({ ...candidate, label: result?.label || "This phone" });
  return { address: clean, label: result?.label };
}

/** The current codes, with the time they were read. */
export async function codes() {
  const data = await request("/api/pair/codes");
  return { codes: data?.codes || [], at: Date.now() };
}
