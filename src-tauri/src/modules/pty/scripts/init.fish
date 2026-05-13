# tedi-shell-integration (fish)
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D so the host tracks cwd and prompt
# boundaries without re-parsing the prompt.

if set -q __TEDI_HOOKS_LOADED
    exit 0
end
set -g __TEDI_HOOKS_LOADED 1

# URL-encode a path keeping `/` intact so it stays valid inside file://.
function __tedi_urlencode_path
    set -l parts (string split '/' -- $argv[1])
    set -l out
    for p in $parts
        if test -n "$p"
            set out $out (string escape --style=url -- $p)
        else
            set out $out ""
        end
    end
    string join '/' $out
end

function __tedi_restore_status
    return $argv[1]
end

if functions -q fish_prompt
    functions -c fish_prompt __tedi_user_prompt
end

function fish_prompt
    set -l __tedi_status $status
    printf '\e]133;D;%d\e\\' $__tedi_status
    set -l host (hostname 2>/dev/null; or echo localhost)
    printf '\e]7;file://%s%s\e\\' "$host" (__tedi_urlencode_path "$PWD")
    printf '\e]133;A\e\\'
    __tedi_restore_status $__tedi_status
    if functions -q __tedi_user_prompt
        __tedi_user_prompt
    else
        printf '%s > ' (prompt_pwd)
    end
    printf '\e]133;B\e\\'
end

function __tedi_preexec --on-event fish_preexec
    printf '\e]133;C\e\\'
end
