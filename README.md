Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
# Take The Lead

Version 1.2.1 is compatible with BedrockUnplugged: unreadable simulated-player
entries are skipped, and players tagged `unplugged.bot` cannot trigger pet
transfers, mount ownership, driving enforcement, or player-attributed deaths.

A Minecraft Bedrock behavior pack that lets a pet owner hand a tamed pet to
another player without commands, cheats, or experimental toggles.

## Requirements

- Minecraft Bedrock Edition 1.26.60 or newer
- A world in which the player activating the pack is allowed to use add-ons

The pack uses only stable Script API modules (`@minecraft/server` 2.11.0 and
`@minecraft/server-ui` 2.2.0), along with the stable custom-dimension format.
It does not change game mode, enable cheats, or require any experimental world
setting.

## Install

1. Activate or reload the `TakeTheLead` development behavior pack.
2. Edit the desired world.
3. Activate **Take The Lead** under Behavior Packs.
4. Leave every experimental toggle off.

Make a backup before adding any behavior pack to an important world.

## Use

1. Tame a leashable pet or mount.
2. Attach a lead to the pet.
3. Use/interact with the player who should receive the pet. It does not matter
   what item you are holding; the attached animal leash starts the transfer.
4. If more than one eligible pet is leashed to you, choose one.
5. Confirm **Transfer** in the dialog.

The pet's tame owner changes to the recipient, and the pet's leash is attached
to them. Both players receive a chat notification. The transfer is canceled if
either player moves more than 8 blocks apart, the pet moves too far away, its
leash is removed, or its ownership changes while the dialog is open.

Only a pet's current owner can transfer it. Untamed entities and pets belonging
to someone else are ignored. Interacting with another player when no eligible
pet is leashed does nothing and produces no message.

## Supported entities

Take The Lead supports wolves, cats, parrots, and these controllable mounts:

- horses, skeleton horses, and zombie horses;
- donkeys and mules;
- camels and camel husks;
- nautiluses and zombie nautiluses;
- Happy Ghasts; and
- striders.

Llamas are not managed as drivable mounts because a player can sit on one but
cannot steer it. Pigs are intentionally not managed.

All supported mounts transfer in place. Take The Lead changes only its saved
owner, leaving the same entity and preserving its name, health, attributes,
variant, saddle, armor or harness, inventory, tags, and dynamic properties.
Only the recorded owner may occupy the controlling seat. On a multi-seat mount,
including a Happy Ghast or camel, anyone may use a passenger seat once the
owner is seated as the driver.

Vanilla does not expose a usable historical owner for every controllable mount.
When a supported mount has no recorded owner, its next driver receives a
confirmation dialog before ownership is assigned. Declining or closing the
dialog ejects that driver, and the next driving attempt prompts again. This
also migrates legacy mounts that existed before Take The Lead.

Anyone may leash or lead a supported mount, but only its recorded owner can
transfer it. Unauthorized drivers are immediately rejected and shown the
owner's name. Horse-family mounts also play the vanilla angry sound. Feedback
has a two-second per-mount cooldown to prevent spam.

Other leashable tamed pets remain supported through Bedrock's
`minecraft:tameable` and `minecraft:tamemount` ownership components.

## Pet death reports

When an owned pet dies, Take The Lead broadcasts one `[Take The Lead]` chat message
with the pet, owner, death location, and either the responsible player's name
or the unattributed cause. A player killing their own pet is ignored. The same
report is sent as a rich BedrockRelay embed through the optional
`discord:embed` Script Event; BedrockRelay does not need to be installed for
the in-game report or the rest of Take The Lead to work.

Named non-pet mobs receive the same chat and BedrockRelay death reporting,
including their nametag, entity type, killer or cause, and death location.

## BedLog integration

Take The Lead sends optional operator logs through BedLog's native `blf:log`
Script Event interface. Each transfer gesture made while a leashed entity is
nearby produces one summary entry under the `Take The Lead` source: success,
cancellation, or failure with its error details. A pet-detection failure
includes the nearby entity's leash and tame state for diagnosis. Ordinary
player interactions and add-on startup are not logged. Take The Lead continues
working when BedLog is not installed.

## Development layout

- `manifest.json` — behavior-pack manifest
- `scripts/main.js` — transfer detection, validation, dialogs, and reassignment
- `tools/validate-pack.ps1` — local structural validation and packaging helper

## License

MIT

