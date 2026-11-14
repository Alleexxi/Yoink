# Yoink

Tool to dump unencrypted romFS and exeFS for Switch 2 games, updates and DLC.

Supports digital games, game cards, Switch 2 Editions, etc.
(For NSO titles, make sure the title has been opened recently before you attempt to mount it, otherwise the mount will fail.)

## Disclaimer

For the love of God, do NOT share any files you rip using this tool. It is to be used with ONLY your own games on your OWN system. This tool doesn't provide system keys or any method to decrypt files. The files are loaded normally by the system, then pulled over FTP.

## Usage

0. Connect your computer and Switch 2 to the same local network. Yoink reads the console's IP address through RPC automatically.

1. Clone the repo: 
``` 
git clone https://github.com/Alleexxi/Yoink.git
```

2. Use kurumuz's fork of the [ns2jb exploit](https://gitlab.com/kurumuz/ns2jb) to get an RPC connection with the system. Use `node run.cjs --rpc`.

3. Run `node yoink.cjs` (or `npm start`). On the first launch, enter the run folder printed by ns2jb, for example `/home/hexa/projects/ns2jb2/runs/switch2-Icu7Jd`. You can also enter its parent `runs` folder.

4. Pick a game, choose Save NUP or Serve FTP, and start the dump.

Interactive terminals open a full-screen interface: use ↑/↓ to browse, `/` to search by name or title ID, and Enter to choose a game. The setup screen lets you save a NUP or serve FTP, edit the output filename, and choose an edition. Use ←/→ to change options and Enter on Start to begin.

During a dump, Yoink shows the current file's progress, transfer speed, ETA, and activity log. PgUp/PgDn scroll the log; `q` or Ctrl+C stops safely and cleans up the console. After completion, press Enter to close. `--no-tui` keeps the numbered menu and ordinary output; piped output and `--probe` use this mode automatically.

Yoink remembers the parent `runs` folder after a successful connection. Later launches check its run folders from newest to oldest and choose the first one with a ready application RPC bridge and a matching filesystem RPC session. Stale or incomplete runs are skipped; if none is live, Yoink asks for a path again. Start ns2jb with `--rpc` before launching Yoink.

You can still provide an explicit run or parent folder with `node yoink.cjs <path>`. Settings live in `%APPDATA%/Yoink/settings.json` on Windows or `$XDG_CONFIG_HOME/yoink/settings.json` (default `~/.config/yoink/settings.json`) elsewhere. `YOINK_CONFIG` overrides the settings file. Non-interactive launches need a saved live run or an explicit path.

5. When Yoink says `FTP up!`, open the FTP address it prints in an FTP client. A username and password is not required. (Make sure your FTP client has its transfer mode set to Binary/Image/TYPE I.)

### Dumping straight to a .nup

Instead of browsing the FTP yourself, Yoink can download everything (base, updates and DLC) and pack it into a single `.nup` file:

```
node yoink.cjs --nup game.nup
```

The console's IP is detected automatically from the active RPC connection. You can still pass `--ip <switch 2 ip>` to override it, or if automatic detection fails.

Each RomFS is pulled as one big image instead of thousands of small files, reducing per-file FTP overhead. Transfer speed still depends on the console's storage and network. Files are hashed, deduplicated across base/updates and zstd compressed on the PC as they come in. Needs Node 22.15 or newer (for zstd).

If the base storage does not start with a valid RomFS header, Yoink can try opening the base with its selected application update through the console. This applies to internal storage, SD and game cards, including nonzero header bytes. The confirmed same-version card combination is preferred when available; otherwise Yoink uses the newest selected update for the game's patch ID. It validates the composed RomFS tree and the `main`/`main.npdm` headers before serving or packing them as one base package at the update version. The standalone base ExeFS is skipped, and the selected update is not packed twice. A missing update or failed validation still stops the dump. Header errors include the storage size and prefix for diagnosis. Composition has been confirmed on a MOUSE: P.I. For Hire card; other layouts still need console testing.

#### Stalled transfers

If a data connection goes quiet for 5 minutes, or drops before the whole file has arrived, Yoink opens a new FTP connection and continues from the last received byte with `REST`. It tries up to 5 times before giving up. Already-received bytes are kept, so a hiccup late in a large RomFS image doesn't start that image over. `YOINK_STALL_SECONDS` changes the quiet period and `YOINK_RESUME_ATTEMPTS` the number of tries.

#### Switch 2 Editions

The game selection list marks `[Switch 2 Edition]` when an installed base or update contains a Switch 2 program at program index 1, or when a game-card update's program 0 is a `0400...` program. This checks installed content, not whether an upgrade is available online or its Upgrade Pack is owned.

Switch 2 Editions can put the enhanced program at program index 1 in the base or update, alongside the original Switch 1 program. Some game cards, including Pikmin 4 Switch 2 Edition, instead publish the Switch 2 program as the update's program 0, with no program 1. Yoink reads the NCA's runtime ProgramId to recognize either layout. `--edition` chooses how the `.nup` is packed:

```
node yoink.cjs --nup game.nup --edition switch2
```

- `switch2` (the default) packs a self-contained Switch 2 Edition base package with the Switch 2 `0400...` title ID, the Switch 2 ExeFS, and a flattened RomFS combining the primary program RomFS + Switch 2 Upgrade Pack DLC + any program 1 layer. For a program 0 edition, the update's own RomFS is the primary and is included once. Unused original base data and dummy unlock DLCs are omitted.
- `switch1` packs the original Switch 1 program (base + Switch 1 updates + DLC). An update whose program 0 is a Switch 2 program is excluded.
- `both` writes two files in one run — `game.nup` (Switch 1) and `game-switch2.nup` (Switch 2) — sharing the common RomFS downloads so shared layers are only pulled once.
- `all` keeps every dumped package in one file, the way the NUP spec lays a dump out: base, program 0 update, the Switch 2 program as an update with its own `0400...` id, the Upgrade Pack and its data patch. The emulator picks the program and layers the RomFS.

For a game that isn't a Switch 2 Edition, `--edition` makes no difference: there's only one program to pack.

To test merging Pikmin 4's companion Unreal chunk into its Switch 2 base, enable
the experimental option in PowerShell before dumping:

```powershell
$env:YOINK_FLATTEN_UNREAL_CHUNKS = '1'
node yoink.cjs <path-to-ns2jb-run> 0100B7C00933A000 --nup pikmin4-switch2-merged.nup --edition switch2 --no-tui
```

This copies the four-file `__chunks_1` / `pakchunk1-Sage` add-on into the edition's
primary RomFS alongside `pakchunk0-Sage`. It retains the original add-on package
for games that query add-on availability. The DLC image is downloaded once and
identical payloads share stored data within the NUP. A matching project/platform,
chunk marker and complete `.pak`/`.ucas`/`.utoc` set are required; unrelated DLC
is left separate. This applies to the Switch 2 output of `switch2` and `both`;
`switch1` and `all` retain their normal package layouts. Debug's package plan
honors the same option. Set it to `'0'` to return to normal packing. Whether this
restores the in-game edition banner/options still needs an emulator test.

Switch 2 output uses the edition's own name, icon, localized NACP and display version from
`/Acd_1` in shared Control content. A program 0 edition also prefers `/Acd_1` when
present: its executable index and metadata directory index can differ, as on
Pikmin 4. If that directory is unavailable, the update's root Control is tried.
If edition Control content is unavailable, base metadata is used;
the display version may therefore remain `1.0.0` even though the package has the update's
numeric version and `0400...` title ID. Switch 1 output retains its own Control data.
With `all`, the edition metadata is carried on its program package.
Control filesystem opens use the selected NCA's own ProgramId, which can be
`0400...` even when NCM lists the update under a `0100...` owner. The complete
official NACP is preserved, including its add-on-content base ID and save owner;
these identifiers are not rewritten to match the package title ID.

Yoink opens and checks the Switch 2 executable before its RomFS and the DLC mounts.
An installed edition whose executable cannot be opened stops preparation; it is not
packed without its code. `--edition switch1` skips opening the Switch 2 program when
writing a NUP. FTP browsing still prepares both programs.

If opening content times out, restart the console application and the RPC run before
retrying. On Linux, `export YOINK_TRACE=1` enables operation timing, the retained mount
counts, and the program ID/storage/attributes sent to CodeFS. The failed operation's
name is included in errors even without tracing. These diagnostics distinguish content
selection failures from resource pressure; a timeout alone does not establish a mount limit.

#### Add-on data patches

An add-on can be updated by a data patch (content meta type `0x84`). Yoink reads its original add-on ID and application owner from content metadata, checks the add-on's matching patch reference when present, and pins the selected DLC version and content. Upgrade Packs use this: Tears of the Kingdom's Upgrade Pack `0100F2C0115B7001` v0 was built for an older Switch 2 program, and data patch `0100F2C0115B7801` brings it in line with the current one. Without it the Switch 2 program can't find its resource tables and crashes at boot.

Data patches are served next to their add-on at `/dlc/<data patch id>/<version>/romfs`. `--edition switch2` layers them over the Upgrade Pack; the other editions pack them as an `addon_update` package (NUP kind 3) under the id of the add-on they update. `YOINK_NO_DATA_PATCHES=1` leaves them out.

DLC metadata discovery and patch matching are adapted from [misshexa66's upstream DLC work](https://github.com/misshexa66/OunceCake/commit/9a5e8c0b11f4c75b8553c2ee641c6225af80ec5b), retaining Yoink's NUP layout and restoration of previous single-path or two-path DLC registrations.

To see what a title has installed, and whether its data patches open:

```
node yoink.cjs <path-to-ns2jb-run> <title id> --probe
```

For a fuller read-only diagnostic, use the `debug` subcommand:

```bash
node yoink.cjs debug <path-to-ns2jb-run> <title id>
```

It prints installed content metadata and attempts the same base, update, DLC, and
Switch 2 edition mounts used by a dump. The JSON report includes each layer's
storage, content ID, NCA path, size, file counts, and available Control/NACP/icon
details. Debug report version 2 also includes:

- SHA-256 hashes of the running source files, Node/platform details and active content-selection overrides, so captures from older builds can be identified.
- Independent program 0/1 runtime ID probes for the installed base and updates, even if later game mounts fail.
- Per-storage Control attempts at the root, `/Acd_0` and `/Acd_1`, plus a separate Control NCA at content index 1. These additional paths are diagnostic probes; they do not change which metadata a normal dump selects.
- Exact failing stages and native result codes, Control NCA identities, directory listings, available icon filenames, NACP sizes and NACP/icon hashes. A missing icon can be distinguished from an unreadable NACP or an unavailable Control NCA.
- The ProgramId actually supplied to the Control open, NACP add-on/save identifiers, and the planned Switch 2 packages and RomFS layers. This shows when DLC is retained as its own package rather than merged into the primary RomFS.
- Completed layers retained after a later preparation error, file samples (up to 64 files per layer), DLC enhancement markers and overlap counts against the edition's primary RomFS.

It does not start FTP or write a NUP. Leave out the title ID to select a game from
the library. Debug probes open extra metadata files and can take longer than a
normal launch. Cancellation still releases the console attachment.
Control file/directory opens check the console result before decoding a returned
handle. Missing optional edition paths therefore retain their native error and
do not stop the remaining metadata probes. Directory inventories follow the
edition directories actually listed at the root.

For a Pikmin 4 capture in PowerShell, use your current ns2jb run path:

```powershell
node yoink.cjs debug "C:\path\to\ns2jb\runs\switch2-YOUR-RUN" 0100B7C00933A000 2>&1 | Tee-Object -FilePath debug.txt
```

Share the complete text capture, including the JSON report at the end. If an
extra Control path succeeds while the normal path fails, its NCA and directory
details can guide the next metadata fix.

### Batch dumps

In the library, press **Space** to mark each game you want, then **Enter** to open
batch setup. Marks stay selected while you search. Choose an output folder and
edition, then start the queue. Enter without marking any games keeps the normal
single-game setup.

You can also launch the picker in batch mode explicitly:

```bash
node yoink.cjs --batch --output-dir ./dumps
```

With `--no-tui`, enter game numbers separated by commas or spaces, such as `1,3,5`.
The default batch folder is `./dumps`; missing folders are created. Each file is
named `Game name [TITLE_ID].nup`, so games with the same name get separate outputs.
`--edition both` writes the usual `-switch2.nup` companion for each game.

Games run one at a time, with a fresh console attachment and FTP cleanup between
them. The queue stops on the first dump or cleanup error, or when you press `q` /
Ctrl+C. Completed files are kept. Existing NUPs or partial files cause the batch
to stop rather than overwrite them; choose a different folder or move those files
before retrying. The game card must remain inserted for any selected card game.

The FTP listener enables address reuse for sequential restarts on the same port.
Startup failures report the failing stage and socket errno when available, rather
than assuming every failure means a port conflict.

## Development

Run `npm test` for the local FTP and NUP packing tests; no console is needed.
The native FTP restart regression test also runs when a host C compiler (`cc`,
`gcc` or `clang`) is available; otherwise that test is skipped.
Run `npm run build` to rebuild the bundled native FTP server. This needs either the
AArch64 GNU toolchain or Clang, LLD and llvm-objcopy on PATH.

## Licensing

Yoink is licensed under the terms of the GPLv2 (because it borrows a tiny bit of code from [Atmosphere](https://github.com/Atmosphere-NX/Atmosphere))

You can find a copy of the license in the LICENSE file.
