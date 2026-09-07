# Terminal safety policy

`TerminalTool` is a deliberately restricted teaching tool, not a general shell.
It **never starts an external process**: there is no command lookup, argv
execution, shell, interpreter, or `PATH` use. Consequently, a hostile `PATH`
cannot change its behavior.

The supported in-process command surface is intentionally small:

- `cat <filename>` reads one regular, direct child of the workspace.
- `ls` lists the current workspace directory and accepts no arguments.
- `pwd` reports the current workspace directory and accepts no arguments.
- `echo [text...]` returns its literal arguments.

All other commands, options, path-bearing `ls` arguments, shell syntax,
control characters, and `cd` are rejected. `cat` rejects absolute paths,
directory traversal, separators, and links. On macOS and Linux it opens the
resolved direct-child path using `O_NOFOLLOW`, validates the opened descriptor
is a regular file with no extra hard links, and reads that descriptor without
re-opening the supplied pathname. Platforms that cannot provide this no-follow
behavior reject file reads rather than weakening containment.

This deliberately narrow policy avoids both executable lookup and the common
validate-then-reopen race. It is stricter than the upstream teaching
implementation; use the file tools when an application needs broader,
explicitly reviewed filesystem behavior.
