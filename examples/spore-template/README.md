# Spore Template

Copy this directory to author a new spore:

```bash
cp -r examples/spore-template ~/.myceliate/skills/<your-spore-name>
cd ~/.myceliate/skills/<your-spore-name>
```

Then edit:
1. `myceliate.yaml` — set `name` (must match your directory name), `description`, `accent_color` (6-digit hex), `keywords`, `agents` list.
2. `SKILL.md` — sector-level overview.
3. `agents/<persona>/SKILL.md` — persona body. Add more personas by creating new `agents/<name>/` directories and listing them in `agents:` in the manifest.

After editing, `myceliate` will discover the spore on next launch. Verify with `/spore list`.

For an interactive authoring path, instead use the meta-spore:
1. `myceliate /spore pin meta`
2. Ask: "Make me a new spore for <your sector>"
3. The `spore-creator` persona will interview you and write the files.
