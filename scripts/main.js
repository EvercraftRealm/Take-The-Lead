import { EquipmentSlot, system, world } from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";

const PACK_VERSION = "1.2.1";
const TARGET_MINECRAFT_VERSION = "1.26.60";
const SERVER_API_VERSION = "2.11.0";
const SERVER_UI_API_VERSION = "2.2.0";
const SEARCH_RADIUS = 32;
const CONFIRM_DISTANCE = 8;
const LOG_SOURCE = "Take The Lead";
const CHAT_PREFIX = "§6[Take The Lead]§r";
const PET_OWNER_ID_PROPERTY = "betterpets:owner_id";
const PET_OWNER_NAME_PROPERTY = "betterpets:owner_name";
const PET_OWNER_OVERRIDE_PROPERTY = "betterpets:owner_override";
const HORSE_OWNER_NAME_PROPERTY = "betterpets:horse_owner_name";
const MOUNT_REJECTION_COOLDOWN_TICKS = 40;
const TRANSFER_DIMENSION_ID = "betterpets:transfer_pocket";
const TRANSFER_STAGING_LOCATION = { x: 0.5, y: 8, z: 0.5 };
const TRANSFER_TICKING_AREA_NAME = "betterpets_transfer_pocket";
const activeTransfers = new Set();
const mountRejectionCooldowns = new Map();
const pendingMountClaims = new Map();
let transferPocketUsers = 0;
let transferPocketReady;
const EQUIPMENT_SLOTS = [
  EquipmentSlot.Head,
  EquipmentSlot.Chest,
  EquipmentSlot.Legs,
  EquipmentSlot.Feet,
  EquipmentSlot.Mainhand,
  EquipmentSlot.Offhand,
  EquipmentSlot.Body,
].filter(Boolean);
const MANAGED_DRIVABLE_MOUNTS = new Set([
  "minecraft:horse",
  "minecraft:skeleton_horse",
  "minecraft:zombie_horse",
  "minecraft:donkey",
  "minecraft:mule",
  "minecraft:camel",
  "minecraft:camel_husk",
  "minecraft:nautilus",
  "minecraft:zombie_nautilus",
  "minecraft:happy_ghast",
  "minecraft:strider",
]);
const HORSE_SOUND_MOUNTS = new Set([
  "minecraft:horse",
  "minecraft:skeleton_horse",
  "minecraft:zombie_horse",
  "minecraft:donkey",
  "minecraft:mule",
]);
const GENETIC_MOUNTS = new Set([
  "minecraft:horse",
  "minecraft:skeleton_horse",
  "minecraft:zombie_horse",
  "minecraft:donkey",
  "minecraft:mule",
  "minecraft:camel",
  "minecraft:camel_husk",
]);
const VANILLA_RETAME_EVENTS = {
  "minecraft:cat": {
    adult: "minecraft:spawn_wild_adult",
    baby: "minecraft:spawn_wild_baby",
  },
  "minecraft:wolf": {
    adult: "minecraft:spawn_wild_adult",
    baby: "minecraft:spawn_wild_baby",
  },
  "minecraft:parrot": {
    adult: "minecraft:entity_spawned",
    baby: "minecraft:entity_spawned",
  },
};
const WOLF_VARIANT_EVENTS = {
  0: "minecraft:spawn_wild_pale",
  1: "minecraft:spawn_wild_ashen",
  2: "minecraft:spawn_wild_black",
  3: "minecraft:spawn_wild_chestnut",
  4: "minecraft:spawn_wild_rusty",
  5: "minecraft:spawn_wild_snowy",
  6: "minecraft:spawn_wild_spotted",
  7: "minecraft:spawn_wild_striped",
  8: "minecraft:spawn_wild_woods",
};
const VARIANT_NAMES = {
  "minecraft:wolf": [
    "pale",
    "ashen",
    "black",
    "chestnut",
    "rusty",
    "snowy",
    "spotted",
    "striped",
    "woods",
  ],
  "minecraft:cat": [
    "white",
    "tuxedo",
    "red tabby",
    "siamese",
    "british shorthair",
    "calico",
    "persian",
    "ragdoll",
    "tabby",
    "black",
    "jellie",
  ],
  "minecraft:parrot": ["red", "blue", "green", "cyan", "silver"],
  "minecraft:horse": [
    "white",
    "creamy",
    "chestnut",
    "brown",
    "black",
    "gray",
    "dark brown",
  ],
};
const MARK_VARIANT_NAMES = {
  "minecraft:horse": [
    "none",
    "white details",
    "white fields",
    "white dots",
    "black dots",
  ],
};
const DYE_COLOR_NAMES = [
  "white",
  "orange",
  "magenta",
  "light blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
];

console.info(
  `[Take The Lead] v${PACK_VERSION} loaded; ` +
    `target Minecraft ${TARGET_MINECRAFT_VERSION}; ` +
    `@minecraft/server ${SERVER_API_VERSION}; ` +
    `@minecraft/server-ui ${SERVER_UI_API_VERSION}`
);

// Repair entities left with both their tamed and wild component groups by an
// interrupted or older transfer. A normal vanilla pet never has both.
system.run(repairLoadedVanillaPets);
world.afterEvents.entityLoad.subscribe((event) => {
  system.run(() => {
    repairRetameBridgeState(event.entity);
    rememberCurrentPetOwner(event.entity);
  });
});
world.afterEvents.entityTamed.subscribe((event) => {
  if (isReadableRealPlayer(event.tamingEntity)) {
    clearPetOwnerOverride(event.entity);
    rememberPetOwner(
      event.entity,
      event.tamingEntity.id,
      event.tamingEntity.name
    );
  }
});
world.afterEvents.entityDie.subscribe(reportTrackedEntityDeath);
system.runInterval(enforceMountDrivers, 1);

world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
  const player = event.player;
  const target = event.target;
  if (!isReadableRealPlayer(player) || !target) {
    return;
  }

  if (
    target.typeId === "minecraft:player" &&
    !isReadableRealPlayer(target)
  ) {
    return;
  }

  if (isManagedDrivableMount(target)) {
    // Leave lead, saddle, harness, and inventory interactions alone. Empty-hand
    // use is the normal mount gesture, so reject an unauthorized driver before
    // they are attached. Passengers may board while the owner is driving.
    if (
      !event.itemStack &&
      !player.isSneaking &&
      isMountOwnedByAnotherPlayer(target, player) &&
      !hasOwnerDriverWithOpenPassengerSeat(target)
    ) {
      event.cancel = true;
      const mount = target;
      system.run(() => rejectMountDriver(player, mount));
    }
    return;
  }

  if (
    target.typeId !== "minecraft:player" ||
    target.id === player.id
  ) {
    return;
  }

  const owner = player;
  const recipient = target;

  system.run(() => beginTransfer(owner, recipient));
});

function enforceMountDrivers() {
  for (const player of world.getAllPlayers().filter(Boolean)) {
    try {
      if (!isReadableRealPlayer(player)) {
        continue;
      }

      const mount = player.getComponent("minecraft:riding")?.entityRidingOn;
      if (!isManagedDrivableMount(mount)) {
        continue;
      }

      // Multi-seat mounts are restricted only in their controlling seat.
      // Happy Ghast and camel passengers remain unrestricted.
      if (getControllingRider(mount)?.id !== player.id) {
        continue;
      }

      if (isMountOwnedByAnotherPlayer(mount, player)) {
        mount.getComponent("minecraft:rideable")?.ejectRider(player);
        rejectMountDriver(player, mount);
        continue;
      }

      if (!getPetOwner(mount) && isClaimableMount(mount)) {
        beginMountClaim(player, mount);
      }
    } catch {
      // A rider or mount can become invalid between the component reads.
    }
  }
}

function isManagedDrivableMount(entity) {
  return Boolean(entity && MANAGED_DRIVABLE_MOUNTS.has(entity.typeId));
}

function getControllingRider(mount) {
  try {
    const rideable = mount.getComponent("minecraft:rideable");
    const riders = rideable?.getRiders() ?? [];
    return riders[rideable?.controllingSeat ?? 0];
  } catch {
    return undefined;
  }
}

function hasOwnerDriverWithOpenPassengerSeat(mount) {
  try {
    const owner = getPetOwner(mount);
    const rideable = mount.getComponent("minecraft:rideable");
    if (!owner || !rideable || rideable.seatCount <= 1) {
      return false;
    }

    const riders = rideable.getRiders();
    const driver = riders[rideable.controllingSeat ?? 0];
    return driver?.id === owner.id && riders.length < rideable.seatCount;
  } catch {
    return false;
  }
}

function isClaimableMount(mount) {
  try {
    if (mount.getComponent("minecraft:is_tamed")) {
      return true;
    }

    const tameable = mount.getComponent("minecraft:tameable");
    if (tameable?.isTamed === true) {
      return true;
    }

    const tameMount = mount.getComponent("minecraft:tamemount");
    if (tameMount?.isTamedToPlayer || tameMount?.isTamed) {
      return true;
    }

    // Striders have no tame owner. Riding implies their controllable, saddled
    // state, which is represented by this marker.
    return Boolean(mount.getComponent("minecraft:is_saddled"));
  } catch {
    return false;
  }
}

function beginMountClaim(player, mount) {
  if (!isReadableRealPlayer(player)) {
    return;
  }

  const mountId = mount.id;
  if (pendingMountClaims.has(mountId)) {
    return;
  }

  pendingMountClaims.set(mountId, player.id);
  system.run(() => confirmMountClaim(player, mount, mountId));
}

async function confirmMountClaim(player, mount, mountId) {
  try {
    const mountName = displayName(mount);
    const response = await new MessageFormData()
      .title("Claim unowned mount?")
      .body(
        `${mountName} can be driven but has no recorded owner. ` +
          "Do you want to become its owner?"
      )
      .button1("§aClaim mount")
      .button2("§cNo")
      .show(player);

    const stillRiding =
      player.getComponent("minecraft:riding")?.entityRidingOn?.id === mountId;
    const canClaim =
      !response.canceled &&
      response.selection === 0 &&
      stillRiding &&
      getControllingRider(mount)?.id === player.id &&
      isClaimableMount(mount) &&
      !getPetOwner(mount);

    if (canClaim) {
      setPetOwnerOverride(mount, player.id, player.name);
      const owner = getPetOwner(mount);
      if (owner?.id !== player.id) {
        throw new Error("mount ownership could not be saved");
      }
      player.sendMessage(`§aYou now own ${mountName}.`);
      return;
    }

    if (stillRiding) {
      mount.getComponent("minecraft:rideable")?.ejectRider(player);
    }
  } catch (error) {
    try {
      if (
        player.getComponent("minecraft:riding")?.entityRidingOn?.id === mountId
      ) {
        mount.getComponent("minecraft:rideable")?.ejectRider(player);
      }
      player.sendMessage("§cThat mount could not be claimed.");
    } catch {
      // The player or mount may have left the world while the form was open.
    }
    console.warn(`[Take The Lead] Mount claim failed: ${error}`);
  } finally {
    if (pendingMountClaims.get(mountId) === player.id) {
      pendingMountClaims.delete(mountId);
    }
  }
}

function isMountOwnedByAnotherPlayer(mount, player) {
  const owner = getPetOwner(mount);
  return owner?.id !== undefined && owner.id !== player.id;
}

function getPetOwner(entity) {
  const savedOwnerId = getDynamicPropertySafely(
    entity,
    PET_OWNER_ID_PROPERTY
  );
  const savedName = getDynamicPropertySafely(
    entity,
    PET_OWNER_NAME_PROPERTY
  );
  if (
    getDynamicPropertySafely(entity, PET_OWNER_OVERRIDE_PROPERTY) === true &&
    typeof savedOwnerId === "string"
  ) {
    return {
      id: savedOwnerId,
      name: typeof savedName === "string" ? savedName : undefined,
    };
  }

  const components = [
    getComponentSafely(entity, "minecraft:is_tamed"),
    getComponentSafely(entity, "minecraft:tameable"),
    getComponentSafely(entity, "minecraft:tamemount"),
  ];
  let isOwnedPet = Boolean(components[0]) || typeof savedOwnerId === "string";
  try {
    isOwnedPet =
      isOwnedPet ||
      components[1]?.isTamed === true ||
      Boolean(components[2]?.isTamedToPlayer || components[2]?.isTamed);
  } catch {
    // Cached ownership can still identify a pet after component invalidation.
  }
  if (!isOwnedPet) {
    return undefined;
  }

  let ownerPlayer;
  let componentOwnerId;
  for (const component of components) {
    try {
      if (ownerPlayer === undefined) {
        ownerPlayer = component?.tamedToPlayer;
      }
      if (componentOwnerId === undefined) {
        componentOwnerId = component?.tamedToPlayerId;
      }
    } catch {
      // A dying entity can invalidate one component before another.
    }
  }

  const ownerId =
    componentOwnerId ??
    ownerPlayer?.id ??
    (typeof savedOwnerId === "string" ? savedOwnerId : undefined);
  if (ownerId === undefined) {
    return undefined;
  }

  const legacyHorseName = getDynamicPropertySafely(
    entity,
    HORSE_OWNER_NAME_PROPERTY
  );
  return {
    id: ownerId,
    name:
      ownerPlayer?.name ??
      (typeof savedName === "string" ? savedName : undefined) ??
      (typeof legacyHorseName === "string" ? legacyHorseName : undefined),
  };
}

function getComponentSafely(entity, componentId) {
  try {
    return entity.getComponent(componentId);
  } catch {
    return undefined;
  }
}

function getDynamicPropertySafely(entity, propertyId) {
  try {
    return entity.getDynamicProperty(propertyId);
  } catch {
    return undefined;
  }
}

function rememberPetOwner(entity, ownerId, ownerName) {
  try {
    entity.setDynamicProperty(PET_OWNER_ID_PROPERTY, ownerId);
    if (ownerName) {
      entity.setDynamicProperty(PET_OWNER_NAME_PROPERTY, ownerName);
    }
  } catch {
    // Vanilla ownership remains authoritative if metadata cannot be cached.
  }
}

function setPetOwnerOverride(entity, ownerId, ownerName) {
  rememberPetOwner(entity, ownerId, ownerName);
  try {
    entity.setDynamicProperty(PET_OWNER_OVERRIDE_PROPERTY, true);
  } catch {
    // The caller verifies the override before accepting the transfer.
  }
}

function clearPetOwnerOverride(entity) {
  try {
    entity.setDynamicProperty(PET_OWNER_OVERRIDE_PROPERTY, undefined);
  } catch {
    // A vanilla owner remains valid if there is no Take The Lead override.
  }
}

function rememberCurrentPetOwner(entity) {
  const owner = getPetOwner(entity);
  if (owner) {
    rememberPetOwner(entity, owner.id, owner.name);
  }
}

function rejectMountDriver(player, mount) {
  try {
    const lastRejection = mountRejectionCooldowns.get(mount.id);
    if (
      lastRejection !== undefined &&
      system.currentTick - lastRejection < MOUNT_REJECTION_COOLDOWN_TICKS
    ) {
      return;
    }
    const mountId = mount.id;
    const rejectionTick = system.currentTick;
    mountRejectionCooldowns.set(mountId, rejectionTick);
    system.runTimeout(() => {
      if (mountRejectionCooldowns.get(mountId) === rejectionTick) {
        mountRejectionCooldowns.delete(mountId);
      }
    }, MOUNT_REJECTION_COOLDOWN_TICKS);

    const owner = getPetOwner(mount);
    const ownerName = owner?.name ?? "the owner";
    if (owner?.name) {
      rememberPetOwner(mount, owner.id, owner.name);
    }

    if (HORSE_SOUND_MOUNTS.has(mount.typeId)) {
      try {
        mount.dimension.playSound("mob.horse.angry", mount.location);
      } catch {
        // The driver rejection must not depend on sound playback.
      }
    }

    const mountType = formatIdentifier(mount.typeId).toLowerCase();
    const action = mount.typeId === "minecraft:horse" ? "ride" : "drive";
    player.sendMessage(
      `§cOnly "${ownerName}" can ${action} this ${mountType}.`
    );
  } catch {
    // The player or mount may have become invalid during the rejection.
  }
}

function reportTrackedEntityDeath(event) {
  try {
    const entity = event.deadEntity;
    if (entity.typeId === "minecraft:player") {
      return;
    }

    const killer = findResponsiblePlayer(event.damageSource);
    const owner = getPetOwner(entity);
    const entityType = formatIdentifier(entity.typeId);
    const customName = entity.nameTag?.trim();
    const cause = describeDamageSource(event.damageSource);
    const location = formatDeathLocation(entity);

    if (owner) {
      if (killer?.id === owner.id) {
        return;
      }

      const petLabel = customName
        ? `"${customName}" (${entityType})`
        : entityType;
      const ownerName = owner.name ?? `Unknown owner (${owner.id})`;
      const summary = killer
        ? `${killer.name} killed ${petLabel}, owned by ${ownerName}, at ${location}.`
        : `${petLabel}, owned by ${ownerName}, died from ${cause} at ${location}.`;

      world.sendMessage(`${CHAT_PREFIX} ${summary}`);
      sendRelayDeathEmbed({
        title: "Pet death",
        summary,
        subjectLabel: "Pet",
        subject: petLabel,
        owner: ownerName,
        killer: killer?.name ?? "Not attributed to a player",
        cause,
        location,
      });
      return;
    }

    if (!customName) {
      return;
    }

    const mobLabel = `"${customName}" (${entityType})`;
    const summary = killer
      ? `${killer.name} killed ${mobLabel} at ${location}.`
      : `${mobLabel} died from ${cause} at ${location}.`;

    world.sendMessage(`${CHAT_PREFIX} ${summary}`);
    sendRelayDeathEmbed({
      title: "Named mob death",
      summary,
      subjectLabel: "Mob",
      subject: mobLabel,
      killer: killer?.name ?? "Not attributed to a player",
      cause,
      location,
    });
  } catch {
    // Death reporting must never affect the world or another add-on.
  }
}

function findResponsiblePlayer(damageSource) {
  try {
    const attacker = damageSource?.damagingEntity;
    if (attacker?.typeId === "minecraft:player") {
      return isReadableRealPlayer(attacker) ? attacker : undefined;
    }

    if (attacker) {
      const attackerOwner = getPetOwner(attacker);
      if (attackerOwner) {
        const owningPlayer = world
          .getAllPlayers()
          .filter(Boolean)
          .find(
            (player) =>
              isReadableRealPlayer(player) && player.id === attackerOwner.id
          );
        if (owningPlayer) {
          return owningPlayer;
        }
      }
    }

    for (const projectile of [
      damageSource?.damagingProjectile,
      attacker,
    ]) {
      const projectileOwner = projectile
        ?.getComponent("minecraft:projectile")
        ?.owner;
      if (projectileOwner?.typeId === "minecraft:player") {
        return isReadableRealPlayer(projectileOwner)
          ? projectileOwner
          : undefined;
      }
    }
  } catch {
    // Fall through to an unattributed death report.
  }
  return undefined;
}

function describeDamageSource(damageSource) {
  const cause = formatIdentifier(String(damageSource?.cause ?? "unknown"));
  try {
    const attacker = damageSource?.damagingEntity;
    if (attacker && attacker.typeId !== "minecraft:player") {
      return `${cause} by ${displayName(attacker)}`;
    }
  } catch {
    // The source entity may already have been removed.
  }
  return cause;
}

function formatDeathLocation(entity) {
  const { x, y, z } = entity.location;
  const dimension = formatIdentifier(entity.dimension.id);
  return `${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)} in ${dimension}`;
}

function formatIdentifier(identifier) {
  const value = identifier.split(":").pop() ?? identifier;
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sendRelayDeathEmbed(report) {
  try {
    const fields = [
      { name: report.subjectLabel, value: report.subject, inline: true },
    ];
    if (report.owner) {
      fields.push({ name: "Owner", value: report.owner, inline: true });
    }
    fields.push(
      { name: "Killer", value: report.killer, inline: true },
      { name: "Cause", value: report.cause, inline: true },
      { name: "Location", value: report.location, inline: false }
    );

    system.sendScriptEvent(
      "discord:embed",
      JSON.stringify({
        author: "Take The Lead",
        embed: {
          title: report.title,
          description: report.summary,
          color: 0xe74c3c,
          fields,
        },
      })
    );
  } catch {
    // BedrockRelay is optional; Discord delivery cannot affect the game.
  }
}

async function beginTransfer(owner, recipient) {
  if (!isReadableRealPlayer(owner) || !isReadableRealPlayer(recipient)) {
    return;
  }

  const ownerId = owner.id;
  const ownerName = owner.name;
  const recipientName = recipient.name;
  if (activeTransfers.has(ownerId)) {
    return;
  }

  // Interacting with another player is only a transfer gesture while the
  // initiator actually has an eligible pet leashed. Otherwise it is ignored.
  const candidates = findTransferablePets(owner);
  if (candidates.length === 0) {
    const diagnostic = describeNearbyLeashedEntities(owner);
    if (diagnostic) {
      bedLog(
        "warn",
        `Transfer from ${ownerName} to ${recipientName} failed: ` +
          `no eligible pet; ${diagnostic}`
      );
    }
    return;
  }

  activeTransfers.add(ownerId);
  let logLevel = "error";
  let logMessage =
    `Transfer from ${ownerName} to ${recipientName} ` +
    "failed without a result";
  let transferActionBarRunId;

  try {
    if (!playersCanTransfer(owner, recipient)) {
      logLevel = "warn";
      logMessage =
        `Transfer from ${ownerName} to ${recipientName} failed: ` +
        "players were unavailable or too far apart";
      owner.sendMessage("§cStay near the player you want to give your pet to.");
      return;
    }

    let pet = await choosePet(owner, recipient, candidates);
    if (!pet) {
      logLevel = "info";
      logMessage =
        `${ownerName} canceled a pet transfer to ${recipientName} ` +
        "during pet selection";
      return;
    }

    const petName = displayName(pet);
    const petDetails = describePet(pet);
    const response = await new MessageFormData()
      .title("Transfer pet?")
      .body(
        `Give ${petName} to ${recipientName}?\n\n` +
          "The pet will immediately belong and be leashed to the new owner."
      )
      .button1("§aTransfer")
      .button2("§cCancel")
      .show(owner);

    if (response.canceled || response.selection !== 0) {
      logLevel = "info";
      logMessage =
        `${ownerName} canceled transfer of ${petDetails} ` +
        `to ${recipientName}`;
      return;
    }

    const validationError = validateTransfer(pet, owner, recipient);
    if (validationError) {
      logLevel = "warn";
      logMessage =
        `Transfer of ${petDetails} from ${ownerName} to ${recipientName} ` +
        `failed: ${validationError}`;
      owner.sendMessage(`§cTransfer canceled: ${validationError}`);
      return;
    }

    transferActionBarRunId = startTransferActionBar(
      owner,
      "§6Transfer started..."
    );
    const transferredPet = await setPetOwner(pet, recipient);
    if (!transferredPet) {
      logLevel = "error";
      logMessage =
        `Transfer of ${petDetails} from ${ownerName} to ${recipientName} ` +
        "failed: ownership reassignment was rejected";
      owner.sendMessage("§cThat entity could not be assigned to the new owner.");
      return;
    }
    pet = transferredPet;
    rememberPetOwner(pet, recipient.id, recipient.name);

    let leashWarning;
    // Hand the physical lead over too. Ownership has already transferred, so a
    // leash failure does not roll back the successful ownership change.
    try {
      pet.getComponent("minecraft:leashable")?.leashTo(recipient);
    } catch (error) {
      // Some entity definitions can break a leash as their state changes.
      leashWarning = `; leash handoff failed: ${error}`;
    }

    stopTransferActionBar(transferActionBarRunId);
    transferActionBarRunId = undefined;
    setTransferActionBar(owner, "§aTransfer complete!");
    owner.sendMessage(`§a${petName} now belongs to ${recipientName}.`);
    recipient.sendMessage(`§a${ownerName} transferred ${petName} to you.`);
    logLevel = leashWarning ? "warn" : "info";
    logMessage =
      `${ownerName} transferred ${petDetails} to ${recipientName}` +
      (leashWarning ?? "");
  } catch (error) {
    // Closing a form, leaving the world, or another add-on invalidating an
    // entity should fail safely without changing ownership.
    try {
      owner.sendMessage("§cThe pet transfer could not be completed.");
    } catch {
      // The initiating player may have disconnected.
    }
    logLevel = "error";
    logMessage =
      `Transfer from ${safePlayerName(owner)} to ` +
      `${safePlayerName(recipient)} failed: ${error}`;
    console.warn(`[Take The Lead] Transfer failed: ${error}`);
  } finally {
    stopTransferActionBar(transferActionBarRunId);
    bedLog(logLevel, logMessage);
    activeTransfers.delete(ownerId);
  }
}

function findTransferablePets(owner) {
  const pets = [];

  for (const entity of owner.dimension.getEntities({
    location: owner.location,
    maxDistance: SEARCH_RADIUS,
  })) {
    if (isTransferablePet(entity, owner)) {
      pets.push(entity);
    }
  }

  pets.sort(
    (left, right) =>
      distanceSquared(left.location, owner.location) -
      distanceSquared(right.location, owner.location)
  );
  return pets;
}

function isTransferablePet(entity, owner) {
  try {
    const leashable = entity.getComponent("minecraft:leashable");
    if (!leashable?.isLeashed) {
      return false;
    }

    // leashHolderEntityId can contain the holder's type identifier
    // ("minecraft:player") on some runtimes. The holder entity's id is the
    // unique value that can be compared with Player.id.
    const leashHolderId =
      leashable.leashHolder?.id ?? leashable.leashHolderEntityId;
    if (leashHolderId !== undefined && leashHolderId !== owner.id) {
      return false;
    }

    const recordedOwner = getPetOwner(entity);
    if (recordedOwner) {
      return recordedOwner.id === owner.id;
    }

    // Managed mounts without an exposed vanilla owner must be claimed by a
    // confirmed driver before a leash can be used to transfer them.
    if (isManagedDrivableMount(entity)) {
      return false;
    }

    // Mounts expose their official owner through tamemount. Check this before
    // the generic is_tamed marker so a player cannot transfer someone else's
    // horse merely by holding its lead.
    const tameMount = entity.getComponent("minecraft:tamemount");
    const mountOwnerId =
      tameMount?.tamedToPlayerId ?? tameMount?.tamedToPlayer?.id;
    if (mountOwnerId !== undefined) {
      return mountOwnerId === owner.id;
    }

    if (tameMount?.isTamedToPlayer || tameMount?.isTamed) {
      return true;
    }

    const isTamed = entity.getComponent("minecraft:is_tamed");
    const tamedOwnerId =
      isTamed?.tamedToPlayerId ?? isTamed?.tamedToPlayer?.id;
    if (tamedOwnerId !== undefined) {
      return tamedOwnerId === owner.id;
    }

    // Some vanilla pets expose the tamed marker without exposing its owner.
    // In that case, the active leash held by the initiating player is the
    // strongest ownership signal available to script.
    if (isTamed) {
      return true;
    }

    const tameable = entity.getComponent("minecraft:tameable");
    const tameableOwnerId =
      tameable?.tamedToPlayerId ?? tameable?.tamedToPlayer?.id;
    if (tameableOwnerId !== undefined) {
      return tameable?.isTamed === true && tameableOwnerId === owner.id;
    }

    return tameable?.isTamed === true;
  } catch {
    return false;
  }
}

function describeNearbyLeashedEntities(owner) {
  const descriptions = [];

  try {
    for (const entity of owner.dimension.getEntities({
      location: owner.location,
      maxDistance: SEARCH_RADIUS,
    })) {
      try {
        const leashable = entity.getComponent("minecraft:leashable");
        if (!leashable?.isLeashed) {
          continue;
        }

        const holderId =
          leashable.leashHolder?.id ?? leashable.leashHolderEntityId;
        const isTamed = Boolean(entity.getComponent("minecraft:is_tamed"));
        const tameable = entity.getComponent("minecraft:tameable");
        const tameMount = entity.getComponent("minecraft:tamemount");
        const tameableState = tameable?.isTamed === true;
        const tameMountState = Boolean(
          tameMount?.isTamedToPlayer || tameMount?.isTamed
        );
        descriptions.push(
          `${entity.typeId}[holder=${holderId ?? "unknown"}, ` +
            `expected=${owner.id}, is_tamed=${isTamed}, ` +
            `tameable=${tameableState}, tamemount=${tameMountState}]`
        );
      } catch (error) {
        descriptions.push(`${entity.typeId}[inspection error: ${error}]`);
      }

      if (descriptions.length === 4) {
        break;
      }
    }
  } catch (error) {
    return `candidate scan error: ${error}`;
  }

  return descriptions.length > 0
    ? `nearby leashed entities: ${descriptions.join(", ")}`
    : undefined;
}

async function setPetOwner(entity, recipient) {
  if (isManagedDrivableMount(entity)) {
    // Keep every controllable mount in place. Vanilla ownership is read-only or
    // absent for several mount types, while replacing one would risk losing its
    // inventory, equipment, attributes, harness, or variant.
    setPetOwnerOverride(entity, recipient.id, recipient.name);
    return getPetOwner(entity)?.id === recipient.id ? entity : undefined;
  }

  const tameMount = entity.getComponent("minecraft:tamemount");
  if (tameMount) {
    if (!tameMount.tameToPlayer(true, recipient)) {
      return undefined;
    }

    await nextTick();
    const updatedMount = entity.getComponent("minecraft:tamemount");
    const updatedOwnerId =
      updatedMount?.tamedToPlayerId ?? updatedMount?.tamedToPlayer?.id;
    if (updatedOwnerId !== recipient.id) {
      throw new Error(
        `mount owner verification failed; expected ${recipient.id}, ` +
          `received ${updatedOwnerId ?? "no owner"}`
      );
    }

    clearPetOwnerOverride(entity);
    return entity;
  }

  const tameable = entity.getComponent("minecraft:tameable");
  if (tameable && !entity.getComponent("minecraft:is_tamed")) {
    return tameable.tame(recipient) ? entity : undefined;
  }

  if (
    VANILLA_RETAME_EVENTS[entity.typeId] &&
    entity.getComponent("minecraft:is_tamed")
  ) {
    return replaceVanillaPet(entity, recipient);
  }

  return undefined;
}

async function replaceVanillaPet(original, recipient) {
  const snapshot = capturePetState(original);
  let replacement;
  let stagingDimension;

  if (
    original.typeId === "minecraft:wolf" &&
    snapshot.soundVariant === undefined
  ) {
    throw new Error("could not read the wolf's sound variant");
  }

  try {
    stagingDimension = await acquireTransferPocket();
    replacement = await spawnMatchingReplacement(
      original,
      snapshot,
      stagingDimension
    );

    await prepareReplacementAppearance(replacement, snapshot);

    const tameable = replacement.getComponent("minecraft:tameable");
    if (!tameable?.tame(recipient)) {
      replacement.remove();
      return undefined;
    }

    await nextTick();
    restorePetState(replacement, snapshot);
    await waitTicks(5);
    restoreLatePetState(replacement, snapshot);
    await restoreEquipmentWhenReady(replacement, snapshot);
    await nextTick();

    const restoredSoundVariant = getEntityProperty(
      replacement,
      "minecraft:sound_variant"
    );
    if (
      snapshot.soundVariant !== undefined &&
      restoredSoundVariant !== snapshot.soundVariant
    ) {
      throw new Error(
        `sound variant verification failed; expected ${snapshot.soundVariant}, ` +
          `received ${restoredSoundVariant}`
      );
    }

    const restoredVariant =
      replacement.getComponent("minecraft:variant")?.value;
    if (
      snapshot.variant !== undefined &&
      restoredVariant !== snapshot.variant
    ) {
      throw new Error(
        `variant verification failed; expected ${snapshot.variant}, ` +
          `received ${restoredVariant ?? "unavailable"}`
      );
    }

    const replacementAge = getEntityAgeState(replacement);
    const replacementIsBaby = replacementAge === "baby";
    if (replacementAge === "mixed" || replacementIsBaby !== snapshot.isBaby) {
      const expectedAge = snapshot.isBaby ? "baby" : "adult";
      throw new Error(
        `age verification failed; expected ${expectedAge}, ` +
          `received ${replacementAge}`
      );
    }

    replacement.teleport(original.location, {
      dimension: original.dimension,
    });
    replacement.setRotation(snapshot.rotation);
    original.remove();
    return replacement;
  } catch (error) {
    try {
      replacement?.remove();
    } catch {
      // The replacement may already be invalid.
    }
    throw error;
  } finally {
    if (stagingDimension) {
      releaseTransferPocket(stagingDimension);
    }
  }
}

function nextTick() {
  return new Promise((resolve) => system.run(resolve));
}

function waitTicks(ticks) {
  return new Promise((resolve) => system.runTimeout(resolve, ticks));
}

async function acquireTransferPocket() {
  const stagingDimension = world.getDimension(TRANSFER_DIMENSION_ID);
  transferPocketUsers += 1;

  if (transferPocketUsers === 1) {
    transferPocketReady = prepareTransferPocket(stagingDimension);
  }

  try {
    await transferPocketReady;
    return stagingDimension;
  } catch (error) {
    transferPocketUsers = Math.max(0, transferPocketUsers - 1);
    if (transferPocketUsers === 0) {
      try {
        stagingDimension.runCommand(
          `tickingarea remove ${TRANSFER_TICKING_AREA_NAME}`
        );
      } catch {
        // The area may not have been created before preparation failed.
      }
      transferPocketReady = undefined;
    }
    throw error;
  }
}

async function prepareTransferPocket(stagingDimension) {
  // Clean up a stale area left behind if a prior session ended mid-transfer.
  try {
    stagingDimension.runCommand(
      `tickingarea remove ${TRANSFER_TICKING_AREA_NAME}`
    );
  } catch {
    // No stale area exists.
  }

  stagingDimension.runCommand(
    `tickingarea add circle 0 8 0 1 ${TRANSFER_TICKING_AREA_NAME} true`
  );

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (stagingDimension.isChunkLoaded(TRANSFER_STAGING_LOCATION)) {
      return;
    }
    await nextTick();
  }

  throw new Error("the transfer pocket did not finish loading");
}

function releaseTransferPocket(stagingDimension) {
  transferPocketUsers = Math.max(0, transferPocketUsers - 1);
  if (transferPocketUsers !== 0) {
    return;
  }

  try {
    stagingDimension.runCommand(
      `tickingarea remove ${TRANSFER_TICKING_AREA_NAME}`
    );
  } catch {
    // Cleanup failure must not turn a completed transfer into a failure.
  } finally {
    transferPocketReady = undefined;
  }
}

async function spawnMatchingReplacement(original, snapshot, stagingDimension) {
  // Variant is read-only in the stable API. Keep vanilla's random selection
  // isolated in a private void dimension, then return only the verified pet.
  const mustMatchVariant =
    (original.typeId === "minecraft:cat" ||
      original.typeId === "minecraft:parrot") &&
    snapshot.variant !== undefined;
  const mustSpawnAtCorrectAge =
    original.typeId === "minecraft:cat" ||
    (original.typeId === "minecraft:wolf" && snapshot.isBaby);
  const maximumAttempts =
    original.typeId === "minecraft:cat"
      ? 256
      : mustMatchVariant || mustSpawnAtCorrectAge
        ? 64
        : 1;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const candidate = stagingDimension.spawnEntity(
      original.typeId,
      TRANSFER_STAGING_LOCATION
    );
    await nextTick();

    const variantMatches =
      !mustMatchVariant ||
      candidate.getComponent("minecraft:variant")?.value === snapshot.variant;
    const ageMatches =
      !mustSpawnAtCorrectAge ||
      getEntityAgeState(candidate) === (snapshot.isBaby ? "baby" : "adult");

    if (variantMatches && ageMatches) {
      return candidate;
    }

    candidate.remove();
  }

  throw new Error("could not create a replacement with the original age and appearance");
}

function getEntityAgeState(entity) {
  const hasBabyGroup = Boolean(entity.getComponent("minecraft:is_baby"));
  const hasAdultGroup = Boolean(entity.getComponent("minecraft:breedable"));

  if (hasBabyGroup && hasAdultGroup) {
    return "mixed";
  }
  return hasBabyGroup ? "baby" : "adult";
}

function capturePetState(entity) {
  const equippable = entity.getComponent("minecraft:equippable");
  const equipment = [];
  for (const slot of EQUIPMENT_SLOTS) {
    try {
      const item = equippable?.getEquipment(slot);
      if (item) {
        equipment.push([slot, item]);
      }
    } catch {
      // The entity does not support this equipment slot.
    }
  }

  const dynamicProperties = [];
  for (const propertyId of entity.getDynamicPropertyIds()) {
    dynamicProperties.push([propertyId, entity.getDynamicProperty(propertyId)]);
  }

  return {
    nameTag: entity.nameTag,
    rotation: entity.getRotation(),
    tags: entity.getTags(),
    dynamicProperties,
    equipment,
    // A prior broken transfer may have stacked both groups. Treat that known
    // corrupt state as adult so the next transfer repairs it cleanly.
    isBaby: getEntityAgeState(entity) === "baby",
    variant: entity.getComponent("minecraft:variant")?.value,
    color: entity.getComponent("minecraft:color")?.value,
    color2: entity.getComponent("minecraft:color2")?.value,
    health: entity.getComponent("minecraft:health")?.currentValue,
    soundVariant: getEntityProperty(entity, "minecraft:sound_variant"),
  };
}

async function prepareReplacementAppearance(entity, snapshot) {
  if (
    entity.typeId === "minecraft:wolf" &&
    snapshot.variant !== undefined &&
    entity.getComponent("minecraft:variant")?.value !== snapshot.variant
  ) {
    const variantEvent = WOLF_VARIANT_EVENTS[snapshot.variant];
    if (variantEvent) {
      entity.triggerEvent(variantEvent);
      await nextTick();
    }
  }

  if (
    !snapshot.isBaby &&
    entity.getComponent("minecraft:is_baby") &&
    (entity.typeId === "minecraft:cat" || entity.typeId === "minecraft:wolf")
  ) {
    entity.triggerEvent("minecraft:ageable_grow_up");
    await nextTick();
  }
}

function restorePetState(entity, snapshot) {
  entity.nameTag = snapshot.nameTag;
  entity.setRotation(snapshot.rotation);

  for (const tag of snapshot.tags) {
    entity.addTag(tag);
  }
  for (const [propertyId, value] of snapshot.dynamicProperties) {
    entity.setDynamicProperty(propertyId, value);
  }

  const health = entity.getComponent("minecraft:health");
  if (health && snapshot.health !== undefined) {
    health.setCurrentValue(Math.min(snapshot.health, health.effectiveMax));
  }

  const color = entity.getComponent("minecraft:color");
  if (color && snapshot.color !== undefined) {
    color.value = snapshot.color;
  }
  const color2 = entity.getComponent("minecraft:color2");
  if (color2 && snapshot.color2 !== undefined) {
    color2.value = snapshot.color2;
  }
  if (snapshot.soundVariant !== undefined) {
    entity.setProperty("minecraft:sound_variant", snapshot.soundVariant);
  }

}

function restoreLatePetState(entity, snapshot) {
  // Spawn, variant, age, and tame events can update these after the initial
  // restore. Apply them again after those component changes have settled.
  if (snapshot.soundVariant !== undefined) {
    entity.setProperty("minecraft:sound_variant", snapshot.soundVariant);
  }

  const color = entity.getComponent("minecraft:color");
  if (color && snapshot.color !== undefined) {
    color.value = snapshot.color;
  }
  const color2 = entity.getComponent("minecraft:color2");
  if (color2 && snapshot.color2 !== undefined) {
    color2.value = snapshot.color2;
  }
}

async function restoreEquipmentWhenReady(entity, snapshot) {
  if (snapshot.equipment.length === 0) {
    return;
  }

  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const equippable = entity.getComponent("minecraft:equippable");
      if (!equippable) {
        throw new Error("replacement has no equippable component yet");
      }

      for (const [slot, item] of snapshot.equipment) {
        if (!equippable.setEquipment(slot, item)) {
          throw new Error(`equipment slot ${slot} rejected ${item.typeId}`);
        }
        const restoredItem = equippable.getEquipment(slot);
        if (
          !restoredItem ||
          restoredItem.typeId !== item.typeId ||
          restoredItem.amount !== item.amount
        ) {
          throw new Error(`equipment verification failed for slot ${slot}`);
        }
      }
      return;
    } catch (error) {
      lastError = error;
      await nextTick();
    }
  }

  throw new Error(`equipment restoration failed: ${lastError}`);
}

function getEntityProperty(entity, propertyId) {
  try {
    return entity.getProperty(propertyId);
  } catch {
    return undefined;
  }
}

function repairLoadedVanillaPets() {
  for (const dimensionId of ["overworld", "nether", "the_end"]) {
    try {
      for (const entity of world.getDimension(dimensionId).getEntities()) {
        repairRetameBridgeState(entity);
      }
    } catch {
      // A dimension may not be available yet during initial world load.
    }
  }
}

function repairRetameBridgeState(entity) {
  try {
    if (
      VANILLA_RETAME_EVENTS[entity.typeId] &&
      entity.getComponent("minecraft:is_tamed") &&
      entity.getComponent("minecraft:tameable")
    ) {
      entity.triggerEvent("minecraft:on_tame");
    }
  } catch {
    // Invalid or unloading entities are safe to ignore.
  }
}

async function choosePet(owner, recipient, candidates) {
  if (candidates.length === 1) {
    return candidates[0];
  }

  const form = new ActionFormData().title(`Pet for ${recipient.name}`);
  for (const pet of candidates) {
    form.button(displayName(pet));
  }

  const response = await form.show(owner);
  if (response.canceled || response.selection === undefined) {
    return undefined;
  }

  return candidates[response.selection];
}

function validateTransfer(pet, owner, recipient) {
  try {
    if (!playersCanTransfer(owner, recipient)) {
      return "the recipient moved too far away.";
    }

    if (pet.dimension.id !== owner.dimension.id) {
      return "the pet is no longer nearby.";
    }

    if (distanceSquared(pet.location, owner.location) > SEARCH_RADIUS * SEARCH_RADIUS) {
      return "the pet moved too far away.";
    }

    if (!isTransferablePet(pet, owner)) {
      return "you no longer own and hold the leash for that pet.";
    }

    return undefined;
  } catch {
    return "the pet or player is no longer available.";
  }
}

function setTransferActionBar(player, message) {
  try {
    player.onScreenDisplay.setActionBar(message);
  } catch {
    // A disconnected player must not interrupt an ownership transfer.
  }
}

function startTransferActionBar(player, message) {
  setTransferActionBar(player, message);
  return system.runInterval(() => setTransferActionBar(player, message), 20);
}

function stopTransferActionBar(runId) {
  if (runId !== undefined) {
    system.clearRun(runId);
  }
}

function playersCanTransfer(owner, recipient) {
  try {
    return (
      owner.isValid &&
      recipient.isValid &&
      owner.dimension.id === recipient.dimension.id &&
      distanceSquared(owner.location, recipient.location) <=
        CONFIRM_DISTANCE * CONFIRM_DISTANCE
    );
  } catch {
    return false;
  }
}

function displayName(entity) {
  if (entity.nameTag?.trim()) {
    return entity.nameTag.trim();
  }

  const identifier = entity.typeId.split(":").pop() ?? "pet";
  return identifier
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function describePet(entity) {
  const details = [`name="${displayName(entity)}"`, `type=${entity.typeId}`];
  const variant = entity.getComponent("minecraft:variant")?.value;
  if (variant !== undefined) {
    const variantName = VARIANT_NAMES[entity.typeId]?.[variant];
    details.push(`coat=${variantName ?? variant}`);
  } else {
    const propertyVariant = getEntityProperty(entity, "minecraft:variant");
    if (propertyVariant !== undefined) {
      details.push(`variant=${propertyVariant}`);
    }
  }

  const markVariant = entity.getComponent("minecraft:mark_variant")?.value;
  if (markVariant !== undefined) {
    const markName = MARK_VARIANT_NAMES[entity.typeId]?.[markVariant];
    details.push(`markings=${markName ?? markVariant}`);
  }

  const soundVariant = getEntityProperty(entity, "minecraft:sound_variant");
  if (soundVariant !== undefined) {
    details.push(`personality=${soundVariant}`);
  }

  details.push(`age=${getEntityAgeState(entity)}`);

  const color = entity.getComponent("minecraft:color")?.value;
  if (color !== undefined) {
    details.push(`collar=${DYE_COLOR_NAMES[color] ?? color}`);
  }

  const health = entity.getComponent("minecraft:health");
  if (health) {
    details.push(`health=${health.currentValue}/${health.effectiveMax}`);
  }

  if (GENETIC_MOUNTS.has(entity.typeId)) {
    const movement = getAttributeValue(entity, "minecraft:movement");
    details.push(
      `genetics=maxHealth:${health?.effectiveMax ?? "unknown"},speed:${movement ?? "unknown"}`
    );
  }

  const equippable = entity.getComponent("minecraft:equippable");
  const equippedItems = [];
  for (const slot of EQUIPMENT_SLOTS) {
    try {
      const item = equippable?.getEquipment(slot);
      if (item) {
        equippedItems.push(`${slot}:${item.typeId}`);
      }
    } catch {
      // Unsupported equipment slots are omitted from the summary.
    }
  }
  if (equippedItems.length > 0) {
    details.push(`equipment=${equippedItems.join("+")}`);
  }

  const inventoryItems = describeInventory(entity);
  if (inventoryItems) {
    details.push(`inventory=${inventoryItems}`);
  }

  return details.join(", ");
}

function getAttributeValue(entity, componentIds) {
  const identifiers = Array.isArray(componentIds)
    ? componentIds
    : [componentIds];

  for (const componentId of identifiers) {
    try {
      const component = entity.getComponent(componentId);
      const value = component?.currentValue ?? component?.value;
      if (typeof value === "number") {
        return value;
      }
    } catch {
      // Some data-driven attributes are omitted from the typed component map.
    }
  }

  try {
    for (const component of entity.getComponents()) {
      if (!identifiers.includes(component.typeId)) {
        continue;
      }
      const value = component.currentValue ?? component.value;
      if (typeof value === "number") {
        return value;
      }
    }
  } catch {
    // The runtime may not expose this data-driven attribute to Script API.
  }
  return undefined;
}

function describeInventory(entity) {
  try {
    const container = entity.getComponent("minecraft:inventory")?.container;
    if (!container) {
      return undefined;
    }

    const items = [];
    for (let slot = 0; slot < container.size; slot += 1) {
      const item = container.getItem(slot);
      if (item) {
        items.push(`${slot}:${item.typeId}x${item.amount}`);
      }
    }
    return items.length > 0 ? items.join("+") : "empty";
  } catch {
    return "unavailable";
  }
}

function distanceSquared(left, right) {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return x * x + y * y + z * z;
}

function safePlayerName(player) {
  try {
    return player.name;
  } catch {
    return "unknown player";
  }
}

function isReadableRealPlayer(player) {
  if (!player) {
    return false;
  }

  try {
    return (
      player.isValid &&
      player.typeId === "minecraft:player" &&
      !player.hasTag("unplugged.bot")
    );
  } catch {
    return false;
  }
}

function bedLog(level, message) {
  try {
    system.sendScriptEvent(
      "blf:log",
      JSON.stringify({
        source: LOG_SOURCE,
        level,
        message: String(message).slice(0, 1000),
      })
    );
  } catch {
    // BedLog is optional; logging must never affect pet transfers.
  }
}
