# cmdan-shell-integration (fish)
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D so the host tracks cwd and prompt
# boundaries without re-parsing the prompt.

if set -q __CMDAN_HOOKS_LOADED
    exit 0
end
set -g __CMDAN_HOOKS_LOADED 1

# URL-encode a path keeping `/` intact so it stays valid inside file://.
function __cmdan_urlencode_path
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

function __cmdan_restore_status
    return $argv[1]
end

if functions -q fish_prompt
    functions -c fish_prompt __cmdan_user_prompt
end

function fish_prompt
    set -l __cmdan_status $status
    printf '\e]133;D;%d\e\\' $__cmdan_status
    set -l host (hostname 2>/dev/null; or echo localhost)
    printf '\e]7;file://%s%s\e\\' "$host" (__cmdan_urlencode_path "$PWD")
    printf '\e]133;A\e\\'
    __cmdan_restore_status $__cmdan_status
    if functions -q __cmdan_user_prompt
        __cmdan_user_prompt
    else
        printf '%s > ' (prompt_pwd)
    end
    printf '\e]133;B\e\\'
end

function __cmdan_preexec --on-event fish_preexec
    printf '\e]133;C\e\\'
end
