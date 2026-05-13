# tedi-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _tedi_user_zdotdir="${TEDI_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tedi_user_zdotdir/.zprofile" ] && source "$_tedi_user_zdotdir/.zprofile"
  unset _tedi_user_zdotdir
}
:
