import { getObjectsByPrototype, findClosestByRange } from 'game/utils';
import {
    Creep,
    Source,
    StructureSpawn,
    StructureExtension,
    StructureTower,
} from 'game/prototypes';
import {
    ERR_INVALID_TARGET,
    ERR_NOT_IN_RANGE,
    RESOURCE_ENERGY,
} from 'game/constants';

export function getMyCreeps() {
    return getObjectsByPrototype(Creep).filter(creep => creep.my);
}

export function getEnemyCreeps() {
    return getObjectsByPrototype(Creep).filter(creep => creep.my === false);
}

export function getMySpawns() {
    return getObjectsByPrototype(StructureSpawn).filter(spawn => spawn.my);
}

export function getNearestActiveSource(creep) {
    if (!creep) {
        return null;
    }

    const sources = getObjectsByPrototype(Source).filter(source => source.energy > 0);
    return sources.length > 0 ? findClosestByRange(creep, sources) : null;
}

export function getNearestEnergyReceiver(creep) {
    if (!creep) {
        return null;
    }

    const receivers = [
        ...getObjectsByPrototype(StructureSpawn),
        ...getObjectsByPrototype(StructureExtension),
        ...getObjectsByPrototype(StructureTower),
    ].filter(structure => structure.my &&
        structure.store &&
        structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0);

    return receivers.length > 0 ? findClosestByRange(creep, receivers) : null;
}

export function harvestOrMove(creep, source) {
    if (!creep || !source) {
        return ERR_INVALID_TARGET;
    }

    const result = creep.harvest(source);
    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(source);
    }
    return result;
}

export function transferOrMove(creep, target) {
    if (!creep || !target) {
        return ERR_INVALID_TARGET;
    }

    const result = creep.transfer(target, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
    }
    return result;
}

export function buildOrMove(creep, site) {
    if (!creep || !site) {
        return ERR_INVALID_TARGET;
    }

    const result = creep.build(site);
    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(site);
    }
    return result;
}

export function attackOrMove(creep, target) {
    if (!creep || !target) {
        return ERR_INVALID_TARGET;
    }

    const result = creep.attack(target);
    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
    }
    return result;
}

export function spawnIfNeeded(spawn, body, namePrefix, currentCount, desiredCount) {
    if (!spawn || spawn.spawning || !Array.isArray(body) || body.length === 0) {
        return null;
    }
    if (currentCount >= desiredCount) {
        return null;
    }

    const result = spawn.spawnCreep(body);
    if (result.object) {
        // Arena creeps have no custom names. The prefix is only a useful log label.
        console.log(`${namePrefix}: started spawning a ${body.length}-part creep`);
    }
    return result;
}

export function hasBodyPart(creep, partType) {
    return countBodyParts(creep, partType) > 0;
}

export function countBodyParts(creep, partType) {
    if (!creep || !Array.isArray(creep.body)) {
        return 0;
    }

    return creep.body.filter(part => part.type === partType && part.hits > 0).length;
}
