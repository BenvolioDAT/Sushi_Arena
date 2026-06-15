import { getObjectsByPrototype } from 'game/utils';
import { Creep, Flag, StructureSpawn } from 'game/prototypes';
import { MOVE } from 'game/constants';

const DESIRED_CREEPS = 2;

function assignDifferentFlags(creeps, flags) {
    const usedFlagIds = new Set();

    for (const creep of creeps) {
        const savedTargetIsValid = creep.target &&
            creep.target.exists &&
            flags.some(flag => flag.id === creep.target.id) &&
            !usedFlagIds.has(creep.target.id);

        if (!savedTargetIsValid) {
            creep.target = flags.find(flag => !usedFlagIds.has(flag.id)) || null;
        }

        if (creep.target) {
            usedFlagIds.add(creep.target.id);
        }
    }
}

export function loop() {
    const spawn = getObjectsByPrototype(StructureSpawn).find(structure => structure.my);
    const creeps = getObjectsByPrototype(Creep).filter(creep => creep.my);
    const flags = getObjectsByPrototype(Flag);

    // Spawn one creep at a time until there are two. A MOVE-only body is the
    // cheapest body that can complete this movement tutorial.
    if (spawn && !spawn.spawning && creeps.length < DESIRED_CREEPS) {
        spawn.spawnCreep([MOVE]);
    }

    assignDifferentFlags(creeps, flags);

    for (const creep of creeps) {
        if (!creep.spawning && creep.target) {
            creep.moveTo(creep.target);
        }
    }
}
