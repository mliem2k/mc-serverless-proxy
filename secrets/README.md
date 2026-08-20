# Secrets

This repo's only secret material is the WireGuard private keys, the two peers'
public keys, and the frp auth token. They live here encrypted with
[age](https://github.com/FiloSottile/age), so the encrypted file is safe to
commit and the only thing that needs to survive outside git is one small age
identity file.

If a box dies, the recovery path is: clone this repo, decrypt
`wireguard.env.age` with your age identity, and re-run
`scripts/provision_wireguard.sh` with the resulting values.

## What goes in the plaintext file

Before encrypting, the plaintext file holds these five values as shell
`export` lines, nothing else:

- `CATCHER_WG_PRIVATE_KEY`, catcher's WireGuard private key
- `HOME_WG_PRIVATE_KEY`, home's WireGuard private key
- `WG_PEER_PUBLIC_KEY_CATCHER`, catcher's WireGuard public key (what home's
  config lists as its peer)
- `WG_PEER_PUBLIC_KEY_HOME`, home's WireGuard public key (what catcher's
  config lists as its peer)
- `FRP_AUTH_TOKEN`, the shared frp auth token used by both `frps.toml` on
  catcher and `frpc-catcher.toml` on home

`secrets/wireguard.env.plaintext.example` has the exact format with
placeholder values only, never real ones. Copy it, rename the copy to
`secrets/wireguard.env.plaintext`, and fill in the real values by hand.

## Generating your age identity

One time, on any machine you'll use to decrypt secrets from:

```
age-keygen -o ~/.age/mc-serverless-proxy.txt
```

This prints a public key that starts with `age1`. Put that public key, and
nothing else, into `secrets/.age-recipient` (create the file if it doesn't
exist yet). That file is safe to commit, it's the public half only.

Keep `~/.age/mc-serverless-proxy.txt` itself somewhere durable outside this
repo (a password manager, a second device). It is the only thing standing
between you and an unreadable `wireguard.env.age` if this checkout is lost.

If more than one person or machine needs to decrypt, age supports multiple
`-r` recipients, but `scripts/secrets.sh` as written here only reads a single
key from `secrets/.age-recipient`. Extend it (one recipient per line, loop
over them) if you actually need that; don't build it ahead of needing it.

## Encrypting

```
cp secrets/wireguard.env.plaintext.example secrets/wireguard.env.plaintext
# fill in secrets/wireguard.env.plaintext with real values
scripts/secrets.sh encrypt secrets/wireguard.env.plaintext secrets/wireguard.env.age
rm secrets/wireguard.env.plaintext
```

Commit `secrets/wireguard.env.age`. That file, encrypted, is the whole point
of using age here, it's meant to sit in git.

## Decrypting and using

```
eval "$(scripts/secrets.sh decrypt secrets/wireguard.env.age)"
scripts/provision_wireguard.sh --role catcher   # or --role home
```

`scripts/secrets.sh decrypt` prints the plaintext export lines to stdout and
nothing else, so `eval` is enough to load them into your current shell.
If you'd rather inspect the values first, redirect to a file instead of
piping straight into `eval`, just remember to delete that file afterward, it
is exactly as sensitive as `secrets/wireguard.env.plaintext` was.

`scripts/secrets.sh` looks for your identity file at
`~/.age/mc-serverless-proxy.txt` by default. Set `AGE_IDENTITY_FILE` to
override that path if yours lives somewhere else.

## What must never be committed

- `secrets/wireguard.env.plaintext` (or any renamed copy of the example with
  real values filled in), the whole reason it's encrypted before it reaches
  git is that this plaintext form must not exist in the repo, not even in
  history
- `~/.age/mc-serverless-proxy.txt` (or wherever your age identity actually
  lives), it should never be inside this repo at all
- any other raw `.env` file with real credentials in it

`.gitignore` at the repo root covers the plaintext secrets file pattern and
raw `.env` files, but treat that as a backstop, not a substitute for checking
`git status` before you commit.

## What's safe to commit

- `secrets/wireguard.env.age`, the encrypted file, this is the point of the
  whole setup
- `secrets/.age-recipient`, the public key, it grants nobody the ability to
  decrypt anything
- `secrets/wireguard.env.plaintext.example`, placeholder values only
