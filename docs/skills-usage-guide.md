# Skills usage guide

Use the `Skill` tool as a progressive knowledge boundary. The loader exposes
descriptions for tool schema construction, then returns body and resource paths
on demand. `$ARGUMENTS` in a skill body is replaced by the tool's `args` value.

```ts
const response = await tools.execute('Skill', {
  skill: 'pdf',
  args: 'extract the first page'
});
if (response.status === 'success') console.log(response.text);
```

Call `loader.reload()` after adding or updating a skill directory. Invalid or
duplicate frontmatter raises `SkillError`, while a missing skill returns a
structured `NOT_FOUND` response listing available names.
