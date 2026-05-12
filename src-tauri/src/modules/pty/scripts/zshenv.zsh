# cmdan-shell-integration (zshenv)
#
# Trailing `:` is load-bearing — without it, a missing user .zshenv leaves $?=1,
# which propagates through the rest of init and ultimately into the first
# prompt's `%?` (rendering robbyrussell's `➜` red on a clean shell start).
{
  _cmdan_user_zdotdir="${CMDAN_USER_ZDOTDIR:-$HOME}"
  [ -f "$_cmdan_user_zdotdir/.zshenv" ] && source "$_cmdan_user_zdotdir/.zshenv"
  unset _cmdan_user_zdotdir
}
:
