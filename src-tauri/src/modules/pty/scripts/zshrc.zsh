# tedi-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) so the host can detect command boundaries and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_tedi_ret`.

{
  _tedi_user_zdotdir="${TEDI_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tedi_user_zdotdir/.zshrc" ] && source "$_tedi_user_zdotdir/.zshrc"
  unset _tedi_user_zdotdir
}

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks — desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__TEDI_HOOKS_LOADED" ]]; then
  __TEDI_HOOKS_LOADED=1
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _tedi_urlencode() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [a-zA-Z0-9/._~-]) printf '%s' "$byte" ;;
        *) printf '%%%02X' "'$byte" ;;
      esac
    done
  }

  _tedi_precmd() {
    local _tedi_ret=$?
    printf '\e]133;D;%s\e\\' "$_tedi_ret"
    printf '\e]7;file://%s%s\e\\' "${HOST}" "$(_tedi_urlencode "$PWD")"
    # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
    if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A\e\\'
  }

  _tedi_preexec() {
    printf '\e]133;C\e\\'
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _tedi_precmd
    add-zsh-hook preexec _tedi_preexec
  fi

  # tedi_open: open file in editor tab via OSC 8888.
  # Usage: tedi_open <file>
  tedi_open() {
    local file="$1"

    if [[ -z "$file" ]]; then
      printf "usage: tedi_open <file>\n" >&2
      return 1
    fi

    # Resolve relative paths relative to PWD.
    if [[ "$file" != /* ]]; then
      file="$PWD/$file"
    fi

    # Check that the path exists and is a regular file.
    if [[ ! -f "$file" ]]; then
      printf "tedi_open: not a file: %s\n" "$file" >&2
      return 1
    fi

    # Emit OSC 8888 with URL-encoded file path.
    printf '\e]8888;file=%s\e\\' "$(_tedi_urlencode "$file")"
  }

  # Shorthand alias.
  alias tp='tedi_open'

  _tedi_precmd
fi
:
