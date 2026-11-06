# Merging a PC's EngRem data into the hosted box

For the situation where EngRem ran in local mode (`EngRem.bat`) on a PC for a
while and that PC's words, levels and caches should be folded into the data
the hosted box already has. Nothing is overwritten on the box: the box's copy
wins, the PC's copy only adds (see the rules at the top of `merge-data.js`).

What you need: the box's SSH address and user (the owner tells you), its sudo
password (the owner types it; never put it in a file or a command line), and
the PC's EngRem folder, which contains:

| File / folder | Holds |
|---|---|
| `state.json` | the imported words, study position, Known / Acquainted marks |
| `examples-cache.json` | example sentences per word |
| `phonetic-cache.json` | IPA per word |
| `audio-cache/` | pronunciation files + `index.json` |
| `image-cache/` | pictures + `index.json` |
| `*.xml` | Youdao wordbook exports (not `sample_wordbook.xml`) |

If the PC's browser was used more recently than its `state.json` was written
(the mirror is updated within seconds of every change while the server runs,
so this is rare), start `EngRem.bat` once and open the app, so the browser
mirrors its latest state, then close it.

## Steps

1. **On the PC, pack the data** (Git Bash or any shell with `tar`; from the
   EngRem folder):

   ```bash
   tar czf engrem-data.tgz state.json examples-cache.json phonetic-cache.json audio-cache image-cache $(ls *.xml | grep -v sample_wordbook.xml)
   ```

   Missing files are fine to leave out of the list; the merge handles an
   archive with only some of them.

2. **Copy it to the box** (asks for the box user's password):

   ```bash
   scp engrem-data.tgz <user>@<host>:/tmp/
   ```

3. **Preview, then merge, on the box** (asks for the sudo password; the
   service is stopped for a few seconds and the previous data folder is
   backed up to `/var/backups/engrem-<date>.tgz` first):

   ```bash
   ssh -t <user>@<host> 'sudo bash /opt/engrem/deploy/merge-data.sh /tmp/engrem-data.tgz --dry-run'
   ssh -t <user>@<host> 'sudo bash /opt/engrem/deploy/merge-data.sh /tmp/engrem-data.tgz && rm /tmp/engrem-data.tgz'
   ```

   The summary lists how many words, levels, examples, phonetics, audio
   files, pictures and wordbooks were taken from the PC.

4. **Check** at the public address: the word count in the header counter
   grew by the number of added words, and a word that only the PC had shows
   its picture and examples. Every signed-in device adopts the merged state
   at its next visit ("Progress updated from another device").

## Notes

- A wordbook export with the same name as one on the box but different
  content is stored as `<name> (merged).xml`, so the automatic "re-exported
  under the same name" refresh never replaces the merged word list with one
  PC's export. Re-importing an export by hand from the import screen *does*
  replace the word list with that file's words (levels are kept); don't do
  that unless that is what you want.
- To undo a merge: stop the service, extract the backup over
  `/var/lib/engrem`, `chown -R engrem:engrem /var/lib/engrem`, start it.
- The PC's local copy is untouched; after the merge the PC can simply use the
  public address like every other device (first sign-in from the home
  network).
