# Mobile

A reader for the one-time codes in a vault running on your machine. Pair once, on
the same network, and it shows codes.

It is not a second vault. It holds no master password and no vault key, and it
cannot read a stored secret, a backup code set, or the vault file.

## What it does, and what it does not

| | |
| --- | --- |
| Read the current one-time codes | Yes |
| Read a stored secret value | No |
| Read a backup code set | No |
| Search the vault | No |
| Add or edit an item | No |
| Work when the vault is off | No |
| Work when the vault is locked | No, it asks you to unlock it |

The list is short on purpose. A phone is the device most likely to be lost, so it
carries the smallest useful slice of the vault, and every entry that expires in 30
seconds is less useful to a thief than a stored password.

## Running it

The vault has to answer on your network, which is off by default:

    HASP_HOST=0.0.0.0 npm start

Then, in the mobile folder:

    npm install
    npx cap add ios       # or: npx cap add android
    npx cap sync
    npx cap open ios

Pairing codes are shown in the vault on the Devices screen.

## The cost, stated plainly

The pairing channel is **plain http over your local network**. The requests are
signed with a pairing secret, so nobody can change one in flight, and the codes are
short lived. But an observer on the network who is watching at the right moment sees
the codes as they travel. That sentence is on the pairing screen in the app, not
only here.

Two other limits worth knowing:

- **The pairing secret is stored without encryption.** Capacitor Preferences is a
  plain store. On a rooted or jailbroken phone the secret can be read, which lets
  someone read codes while the vault is unlocked and on the same network. The fix is
  a keychain bridge, which is a platform dependency this app does not have.
- **Anyone can see the pairing code on your screen.** That is why it is drawn once
  and disappears after two minutes.

## Verifying the two sides agree

The phone and the server have to compute the same signature and the same checksum,
or every request is rejected with an unhelpful message. Both are checked against the
server implementation in `test/mobile.test.mjs`, and against node's own SHA-256
across message lengths.

That test found a real bug in the phone's SHA-256: at a 55 byte message it padded to
two blocks where one is correct, which produced a wrong checksum for a length a
real message can have.
