#!/bin/sh
# Append exactly one public key using the account's existing authenticated session.
set -eu
umask 077
public_key=${1:?Missing deployment public key}
case "$public_key" in
  'ssh-ed25519 '*) ;;
  *) printf '%s\n' 'Expected an Ed25519 public key.' >&2; exit 1 ;;
esac
key_data=${public_key#ssh-ed25519 }
case "$key_data" in
  ''|*[!A-Za-z0-9+/=]*) printf '%s\n' 'Invalid public key.' >&2; exit 1 ;;
esac
cd "$HOME"
if [ -L .ssh ] || [ -L .ssh/authorized_keys ]; then
  printf '%s\n' 'Use regular .ssh and authorized_keys paths before setup.' >&2
  exit 1
fi
if [ ! -e .ssh ]; then mkdir -m 700 .ssh; fi
[ -d .ssh ] && [ -w .ssh ] || { printf '%s\n' 'The account needs a writable .ssh directory.' >&2; exit 1; }
mkdir .ssh/.with-scripts-key-lock || { printf '%s\n' 'Another key setup is in progress. Inspect .ssh/.with-scripts-key-lock before retrying.' >&2; exit 1; }
trap 'rmdir .ssh/.with-scripts-key-lock' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -e .ssh/authorized_keys ]; then
  [ -f .ssh/authorized_keys ] && [ -r .ssh/authorized_keys ] && [ -w .ssh/authorized_keys ] || exit 1
  if awk -v key="$key_data" '{ for (i=1; i<NF; i++) if ($i == "ssh-ed25519" && $(i+1) == key) found=1 } END { exit !found }' .ssh/authorized_keys; then
    printf '%s\n' 'Deployment public key already authorized.'
    exit 0
  fi
  # Keep all existing bytes, including a final line without a newline.
  if [ -s .ssh/authorized_keys ] && [ -n "$(tail -c 1 .ssh/authorized_keys)" ]; then
    printf '\n' >> .ssh/authorized_keys
  fi
fi
printf '%s\n' "$public_key" >> .ssh/authorized_keys
printf '%s\n' 'Deployment public key appended; existing keys and permissions preserved.'
