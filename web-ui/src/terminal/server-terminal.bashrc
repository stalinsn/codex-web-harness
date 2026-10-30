# Bash configuration used only by the authenticated web terminal.
shopt -s autocd checkwinsize

HISTCONTROL=ignoreboth
HISTSIZE=3000
HISTFILESIZE=6000
LESS='-FRX'
export HISTCONTROL HISTSIZE HISTFILESIZE LESS

if command -v dircolors >/dev/null 2>&1; then
  eval "$(dircolors -b)"
fi

alias ls='ls --color=auto'
alias ll='ls -lah --group-directories-first --color=auto'
alias la='ls -A --color=auto'
alias l='ls -CF --color=auto'
alias grep='grep --color=auto'
alias egrep='egrep --color=auto'
alias fgrep='fgrep --color=auto'
alias c='clear'
alias cls='clear'
alias ..='cd ..'
alias ...='cd ../..'
alias gst='git status --short --branch'
alias glog='git log --oneline --decorate --graph -12'

mkcd() {
  mkdir -p -- "$1" && cd -- "$1"
}

__codex_server_prompt() {
  local last_status=$?
  local branch=''
  local branch_segment=''
  local error_segment=''

  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)"
    if [[ -n "$branch" ]]; then
      if ! git diff --quiet --ignore-submodules HEAD -- 2>/dev/null; then
        branch+='*'
      fi
      branch_segment=" \[\e[38;5;141m\]git:${branch}\[\e[0m\]"
    fi
  fi

  if (( last_status != 0 )); then
    error_segment=" \[\e[1;38;5;203m\]✘ ${last_status}\[\e[0m\]"
  fi

  PS1='\[\e[1;38;5;117m\]\u@\h\[\e[0m\] \[\e[38;5;250m\]\w\[\e[0m\]'"${branch_segment}${error_segment}"$'\n''\[\e[1;38;5;114m\]❯\[\e[0m\] '
}

if [[ -r /usr/share/bash-completion/bash_completion ]]; then
  source /usr/share/bash-completion/bash_completion
fi

PROMPT_COMMAND=__codex_server_prompt

printf '\n\033[1;38;5;117mTerminal do servidor\033[0m · Bash interativo\n'
printf 'Atalhos: \033[38;5;114mll\033[0m lista detalhada · \033[38;5;114m..\033[0m sobe uma pasta · \033[38;5;114mgst\033[0m mostra o Git · \033[38;5;114mmkcd nome\033[0m cria e entra\n\n'
