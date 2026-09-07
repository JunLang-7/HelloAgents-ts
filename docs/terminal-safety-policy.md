# Terminal safety policy

`TerminalTool` is a deliberately restricted teaching tool, not a general shell.
It **never starts an external process**: there is no command lookup, argv
execution, shell, interpreter, or `PATH` use. Consequently, a hostile `PATH`
cannot change its behavior.

The supported in-process command surface is intentionally limited to:

- `echo [text...]` returns its literal arguments.
- `pwd` reports the lexical workspace label captured when the tool is
  constructed and accepts no arguments.

`cat`, `ls`, `cd`, and every other command are rejected. No terminal command
reads, lists, resolves, or navigates the filesystem, so command operands cannot
be used as filesystem paths. Shell syntax and control characters are also
rejected.

The construction-time workspace label is not a filesystem capability. After
construction, `pwd` returns that captured string without touching the
filesystem. Therefore, replacing the workspace directory with a symlink or
another directory cannot cause `TerminalTool` to disclose content outside the
original workspace.

This is a deliberate teaching safety divergence from the upstream
filesystem-capable terminal behavior. Portable Node APIs cannot safely preserve
workspace ancestry across root-directory replacement, so this tool does not
offer filesystem operations. Use explicitly reviewed file tools when an
application needs filesystem behavior.
