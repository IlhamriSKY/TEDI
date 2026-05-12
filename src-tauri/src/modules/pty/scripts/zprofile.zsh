# cmdan-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _cmdan_user_zdotdir="${CMDAN_USER_ZDOTDIR:-$HOME}"
  [ -f "$_cmdan_user_zdotdir/.zprofile" ] && source "$_cmdan_user_zdotdir/.zprofile"
  unset _cmdan_user_zdotdir
}
:
