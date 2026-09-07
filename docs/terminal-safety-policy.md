# Terminal safety policy

`TerminalTool` is a deliberately restricted teaching tool, not a general shell.
It invokes an argv directly with `shell: false` and permits only a small set of
read-only inspection commands. Shell syntax, command options, interpreters,
pagers, `sed`, `awk`, and `find` are rejected. In particular, dynamic `find`
forms such as `-exec` are never accepted.

The workspace and every existing positional path operand are resolved with
`realpath`. The resolved path must remain within the resolved workspace, so a
symlink cannot escape the sandbox. `cd` follows the same check. Nonexistent
operands receive a lexical containment check; because the allowlist has no
write-capable command, they cannot be used to create an escape.

This is intentionally stricter than the upstream teaching implementation:
options such as `ls -la` are rejected because options can introduce command-
specific path, execution, or write behavior. Use direct file paths and the
supported commands only.
